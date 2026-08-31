package remoteagent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func requireProcessShell(t *testing.T) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("process shell tests require a POSIX shell")
	}
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh is unavailable")
	}
	return shell
}

func newProcessServer(t *testing.T) *Server {
	t.Helper()
	server, err := NewServer(strings.Repeat("p", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
	})
	return server
}

func processStartRequest(root string, argv ...string) ProcessStartRequest {
	return ProcessStartRequest{
		Root: root, Path: root, Argv: argv,
		Stdin:      ProcessInputSpec{Mode: "ignore"},
		Stdout:     ProcessOutputSpec{Mode: "collect", MaxBytes: 64},
		Stderr:     ProcessOutputSpec{Mode: "collect", MaxBytes: 64},
		GraceMs:    50,
		StartNonce: strings.Repeat("0", 32),
	}
}

func startProcessRoute(t *testing.T, server *Server, request ProcessStartRequest) ProcessSnapshot {
	t.Helper()
	response := agentJSONRequest(t, server, "/v1/processes/start", request)
	if response.Code != http.StatusOK {
		t.Fatalf("process start = %d %s", response.Code, response.Body.String())
	}
	var started ProcessStartResponse
	if err := json.Unmarshal(response.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	if started.Process.ID == "" || started.Process.PID <= 0 {
		t.Fatalf("invalid process start snapshot: %#v", started.Process)
	}
	return started.Process
}

func waitProcessRoute(t *testing.T, server *Server, root, id string) ProcessSnapshot {
	t.Helper()
	response := agentJSONRequest(t, server, "/v1/processes/wait", ProcessWaitRequest{
		Root: root, ID: id, TimeoutMs: 2_000,
	})
	if response.Code != http.StatusOK {
		t.Fatalf("process wait = %d %s", response.Code, response.Body.String())
	}
	var waited ProcessWaitResponse
	if err := json.Unmarshal(response.Body.Bytes(), &waited); err != nil {
		t.Fatal(err)
	}
	if !waited.Completed {
		t.Fatalf("process did not complete: %#v", waited)
	}
	return waited.Process
}

func readProcessAll(t *testing.T, server *Server, root, id, stream string, maxBytes int64) []byte {
	t.Helper()
	var result []byte
	var offset int64
	for attempts := 0; attempts < 64; attempts++ {
		response := agentJSONRequest(t, server, "/v1/processes/read", ProcessReadRequest{
			Root: root, ID: id, Stream: stream, From: offset, MaxBytes: maxBytes,
		})
		if response.Code != http.StatusOK {
			t.Fatalf("process read = %d %s", response.Code, response.Body.String())
		}
		var read ProcessReadResponse
		if err := json.Unmarshal(response.Body.Bytes(), &read); err != nil {
			t.Fatal(err)
		}
		data, err := base64.StdEncoding.DecodeString(read.DataBase64)
		if err != nil {
			t.Fatal(err)
		}
		if int64(len(data)) > maxBytes || read.NextOffset < offset || read.NextOffset-int64(len(data)) < offset {
			t.Fatalf("invalid output page from %d: %#v", offset, read)
		}
		if read.Lossy || read.Truncated {
			t.Fatalf("small output unexpectedly lost: %#v", read)
		}
		result = append(result, data...)
		offset = read.NextOffset
		if read.EOF {
			return result
		}
	}
	t.Fatal("process output did not reach EOF")
	return nil
}

func TestProcessRoutesPreserveBinaryOutputAndBytePages(t *testing.T) {
	shell := requireProcessShell(t)
	server := newProcessServer(t)
	root := t.TempDir()
	started := startProcessRoute(t, server, processStartRequest(root, shell, "-c", "printf '\\001\\377A'; printf '\\002\\376B' >&2"))
	if !started.StdinClosed || started.ExitCode != nil || started.Signal != nil {
		t.Fatalf("initial process snapshot = %#v", started)
	}
	finished := waitProcessRoute(t, server, root, started.ID)
	if finished.Running || !finished.Closed || finished.ExitCode == nil || *finished.ExitCode != 0 || finished.Signal != nil {
		t.Fatalf("finished process snapshot = %#v", finished)
	}
	if got := readProcessAll(t, server, root, started.ID, "stdout", 2); string(got) != string([]byte{1, 255, 'A'}) {
		t.Fatalf("stdout = %v", got)
	}
	if got := readProcessAll(t, server, root, started.ID, "stderr", 2); string(got) != string([]byte{2, 254, 'B'}) {
		t.Fatalf("stderr = %v", got)
	}
}

func TestProcessReadPagesLossyRetainedWindow(t *testing.T) {
	session := &processSession{
		notify: make(chan struct{}),
		stdout: processStream{limit: 8},
	}
	session.appendOutput(true, []byte("0123456789abcdef"))
	session.mu.Lock()
	session.stdout.eof = true
	session.mu.Unlock()

	first := session.read(context.Background(), "stdout", 0, 3)
	if data, _ := base64.StdEncoding.DecodeString(first.DataBase64); string(data) != "89a" ||
		first.NextOffset != 11 || !first.Lossy || !first.Truncated || first.EOF {
		t.Fatalf("first retained page = %#v", first)
	}
	second := session.read(context.Background(), "stdout", first.NextOffset, 3)
	if data, _ := base64.StdEncoding.DecodeString(second.DataBase64); string(data) != "bcd" ||
		second.NextOffset != 14 || second.Lossy || !second.Truncated || second.EOF {
		t.Fatalf("second retained page = %#v", second)
	}
	last := session.read(context.Background(), "stdout", second.NextOffset, 3)
	if data, _ := base64.StdEncoding.DecodeString(last.DataBase64); string(data) != "ef" ||
		last.NextOffset != 16 || last.Lossy || !last.Truncated || !last.EOF {
		t.Fatalf("last retained page = %#v", last)
	}
}

func TestProcessStreamsKeepIndependentRetentionLimits(t *testing.T) {
	session := &processSession{
		notify: make(chan struct{}),
		stdout: processStream{limit: 2},
		stderr: processStream{limit: 4},
	}
	session.appendOutput(true, []byte("abcdef"))
	session.appendOutput(false, []byte("abcdef"))
	stdout := session.read(context.Background(), "stdout", 4, 64)
	stderr := session.read(context.Background(), "stderr", 2, 64)
	stdoutData, _ := base64.StdEncoding.DecodeString(stdout.DataBase64)
	stderrData, _ := base64.StdEncoding.DecodeString(stderr.DataBase64)
	if string(stdoutData) != "ef" || stdout.Lossy || !stdout.Truncated || stdout.NextOffset != 6 {
		t.Fatalf("stdout retention = %#v", stdout)
	}
	if string(stderrData) != "cdef" || stderr.Lossy || !stderr.Truncated || stderr.NextOffset != 6 {
		t.Fatalf("stderr retention = %#v", stderr)
	}
}

func TestProcessRoutesPipeStdinAndRejectCrossRootControl(t *testing.T) {
	shell := requireProcessShell(t)
	server := newProcessServer(t)
	root := t.TempDir()
	foreignRoot := t.TempDir()
	request := processStartRequest(root, shell, "-c", "IFS= read -r value; printf 'got:%s' \"$value\"")
	request.Stdin = ProcessInputSpec{Mode: "pipe"}
	started := startProcessRoute(t, server, request)
	input := []byte("hello\n")
	written := agentJSONRequest(t, server, "/v1/processes/write", ProcessWriteRequest{
		Root: root, ID: started.ID, DataBase64: base64.StdEncoding.EncodeToString(input), CloseStdin: true,
	})
	if written.Code != http.StatusOK {
		t.Fatalf("process write = %d %s", written.Code, written.Body.String())
	}
	var write ProcessWriteResponse
	if err := json.Unmarshal(written.Body.Bytes(), &write); err != nil {
		t.Fatal(err)
	}
	if write.Written != len(input) || !write.StdinClosed {
		t.Fatalf("process write response = %#v", write)
	}
	_ = waitProcessRoute(t, server, root, started.ID)
	if got := string(readProcessAll(t, server, root, started.ID, "stdout", 64)); got != "got:hello" {
		t.Fatalf("process stdout = %q", got)
	}
	for _, request := range []struct {
		path string
		body any
	}{
		{"/v1/processes/read", ProcessReadRequest{Root: foreignRoot, ID: started.ID, Stream: "stdout", MaxBytes: 1}},
		{"/v1/processes/write", ProcessWriteRequest{Root: foreignRoot, ID: started.ID}},
		{"/v1/processes/wait", ProcessWaitRequest{Root: foreignRoot, ID: started.ID, TimeoutMs: 1}},
		{"/v1/processes/kill", ProcessKillRequest{Root: foreignRoot, ID: started.ID, Signal: "SIGKILL"}},
	} {
		response := agentJSONRequest(t, server, request.path, request.body)
		if response.Code != http.StatusNotFound || responseErrorCode(t, response) != "process-not-found" {
			t.Fatalf("cross-root %s = %d %s", request.path, response.Code, response.Body.String())
		}
	}
}

func TestProcessRoutesKeepLaunchOwnerAfterRootAliasChanges(t *testing.T) {
	shell := requireProcessShell(t)
	server := newProcessServer(t)
	realRoot := t.TempDir()
	aliasParent := t.TempDir()
	aliasRoot := filepath.Join(aliasParent, "workspace")
	if err := os.Symlink(realRoot, aliasRoot); err != nil {
		t.Fatal(err)
	}
	started := startProcessRoute(t, server, processStartRequest(aliasRoot, shell, "-c", "sleep 30"))
	for _, request := range []struct {
		path string
		body any
	}{
		{"/v1/processes/read", ProcessReadRequest{Root: realRoot, ID: started.ID, Stream: "stdout", MaxBytes: 1}},
		{"/v1/processes/kill", ProcessKillRequest{Root: realRoot, ID: started.ID, Signal: "SIGKILL"}},
	} {
		got := agentJSONRequest(t, server, request.path, request.body)
		if got.Code != http.StatusNotFound || responseErrorCode(t, got) != "process-not-found" {
			t.Fatalf("canonical-root %s = %d %s", request.path, got.Code, got.Body.String())
		}
	}
	if err := os.Remove(aliasRoot); err != nil {
		t.Fatal(err)
	}
	read := agentJSONRequest(t, server, "/v1/processes/read", ProcessReadRequest{
		Root: aliasRoot, ID: started.ID, Stream: "stdout", MaxBytes: 1,
	})
	if read.Code != http.StatusOK {
		t.Fatalf("owner read after alias removal = %d %s", read.Code, read.Body.String())
	}
	killed := agentJSONRequest(t, server, "/v1/processes/kill", ProcessKillRequest{
		Root: aliasRoot, ID: started.ID, Signal: "SIGKILL",
	})
	if killed.Code != http.StatusOK {
		t.Fatalf("owner kill after alias removal = %d %s", killed.Code, killed.Body.String())
	}
	_ = waitProcessRoute(t, server, aliasRoot, started.ID)
	rejected := agentJSONRequest(t, server, "/v1/processes/start", processStartRequest(aliasRoot, shell, "-c", "true"))
	if rejected.Code == http.StatusOK {
		t.Fatal("process start accepted a removed workspace root")
	}
}

func TestProcessRoutesBatchStdinClosesBeforePublication(t *testing.T) {
	shell := requireProcessShell(t)
	server := newProcessServer(t)
	root := t.TempDir()
	request := processStartRequest(root, shell, "-c", "cat")
	request.Stdin = ProcessInputSpec{
		Mode: "data", DataBase64: base64.StdEncoding.EncodeToString([]byte("batch\x00input")),
	}
	started := startProcessRoute(t, server, request)
	if !started.StdinClosed {
		t.Fatalf("batch process stdin is still writable: %#v", started)
	}
	_ = waitProcessRoute(t, server, root, started.ID)
	if got := string(readProcessAll(t, server, root, started.ID, "stdout", 64)); got != "batch\x00input" {
		t.Fatalf("batch stdout = %q", got)
	}
	closed := agentJSONRequest(t, server, "/v1/processes/write", ProcessWriteRequest{Root: root, ID: started.ID})
	if closed.Code != http.StatusConflict || responseErrorCode(t, closed) != "process-closed" {
		t.Fatalf("write batch stdin = %d %s", closed.Code, closed.Body.String())
	}
}

func TestProcessResolveUsesExplicitPathAndRejectsInvalidModes(t *testing.T) {
	shell := requireProcessShell(t)
	server := newProcessServer(t)
	root := t.TempDir()
	path := filepath.Dir(shell)
	response := agentJSONRequest(t, server, "/v1/processes/resolve", ProcessResolveRequest{
		Root: root, Path: root, Command: filepath.Base(shell), Env: map[string]*string{"PATH": &path},
	})
	if response.Code != http.StatusOK {
		t.Fatalf("process resolve = %d %s", response.Code, response.Body.String())
	}
	var resolved ProcessResolveResponse
	if err := json.Unmarshal(response.Body.Bytes(), &resolved); err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(resolved.Path) {
		t.Fatalf("resolved process path = %q", resolved.Path)
	}
	rejected := agentJSONRequest(t, server, "/v1/processes/resolve", ProcessResolveRequest{
		Root: root, Path: root, Command: "bin/tool",
	})
	if rejected.Code != http.StatusBadRequest || responseErrorCode(t, rejected) != "invalid-command" {
		t.Fatalf("relative command = %d %s", rejected.Code, rejected.Body.String())
	}
	removedPath := agentJSONRequest(t, server, "/v1/processes/resolve", ProcessResolveRequest{
		Root: root, Path: root, Command: filepath.Base(shell), Env: map[string]*string{"PATH": nil},
	})
	if removedPath.Code != http.StatusNotFound || responseErrorCode(t, removedPath) != "executable-not-found" {
		t.Fatalf("tombstoned PATH = %d %s", removedPath.Code, removedPath.Body.String())
	}
	request := processStartRequest(root, shell, "-c", "true")
	request.Stdout = ProcessOutputSpec{Mode: "inherit"}
	unsupported := agentJSONRequest(t, server, "/v1/processes/start", request)
	if unsupported.Code != http.StatusBadRequest || responseErrorCode(t, unsupported) != "unsupported-stdio" {
		t.Fatalf("inherit output = %d %s", unsupported.Code, unsupported.Body.String())
	}
	if wrongMethod := agentRequest(server, http.MethodGet, "/v1/processes/start", ""); wrongMethod.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET process start = %d", wrongMethod.Code)
	}
}

func TestProcessSessionsReserveTheirCapacityBeforeSpawn(t *testing.T) {
	shell := requireProcessShell(t)
	sessions := NewProcessSessions(ProcessSessionsOptions{MaxSessions: 1, Retention: time.Millisecond})
	t.Cleanup(func() { sessions.Close(context.Background()) })
	root := t.TempDir()
	request := processStartRequest(root, shell, "-c", "sleep 30")
	first, err := sessions.Start(request)
	if err != nil {
		t.Fatal(err)
	}
	secondRequest := request
	secondRequest.StartNonce = strings.Repeat("1", 32)
	_, err = sessions.Start(secondRequest)
	var failure *agentFailure
	if !errors.As(err, &failure) || failure.status != http.StatusTooManyRequests || failure.code != "too-many-processes" {
		t.Fatalf("second process start = %v", err)
	}
	if _, err := sessions.Kill(ProcessKillRequest{Root: root, ID: first.Process.ID, Signal: "SIGKILL"}); err != nil {
		t.Fatal(err)
	}
	if _, err := sessions.Wait(context.Background(), ProcessWaitRequest{Root: root, ID: first.Process.ID, TimeoutMs: 2_000}); err != nil {
		t.Fatal(err)
	}
}

func TestProcessStartNonceReusesOneProcessAndRejectsConflicts(t *testing.T) {
	shell := requireProcessShell(t)
	server := newProcessServer(t)
	root := t.TempDir()
	request := processStartRequest(root, shell, "-c", "sleep 30")
	request.StartNonce = strings.Repeat("a", 32)
	first := startProcessRoute(t, server, request)

	retriedResponse := agentJSONRequest(t, server, "/v1/processes/start", request)
	if retriedResponse.Code != http.StatusOK {
		t.Fatalf("process start retry = %d %s", retriedResponse.Code, retriedResponse.Body.String())
	}
	var retried ProcessStartResponse
	if err := json.Unmarshal(retriedResponse.Body.Bytes(), &retried); err != nil {
		t.Fatal(err)
	}
	if retried.Process.ID != first.ID || retried.Process.PID != first.PID || retried.Process.StartedAt != first.StartedAt {
		t.Fatalf("retry published another process: first=%#v retry=%#v", first, retried.Process)
	}

	conflict := request
	conflict.Argv = append([]string(nil), request.Argv...)
	conflict.Argv[len(conflict.Argv)-1] = "sleep 29"
	conflictingResponse := agentJSONRequest(t, server, "/v1/processes/start", conflict)
	if conflictingResponse.Code != http.StatusConflict || responseErrorCode(t, conflictingResponse) != "process-start-conflict" {
		t.Fatalf("conflicting process start = %d %s", conflictingResponse.Code, conflictingResponse.Body.String())
	}

	if _, err := server.processes.Kill(ProcessKillRequest{Root: root, ID: first.ID, Signal: "SIGKILL"}); err != nil {
		t.Fatal(err)
	}
	_ = waitProcessRoute(t, server, root, first.ID)
	retriedAfterExit := agentJSONRequest(t, server, "/v1/processes/start", request)
	if retriedAfterExit.Code != http.StatusOK {
		t.Fatalf("process start retry after exit = %d %s", retriedAfterExit.Code, retriedAfterExit.Body.String())
	}
	if err := json.Unmarshal(retriedAfterExit.Body.Bytes(), &retried); err != nil {
		t.Fatal(err)
	}
	if retried.Process.ID != first.ID || retried.Process.PID != first.PID || retried.Process.StartedAt != first.StartedAt {
		t.Fatalf("retry after exit published another process: first=%#v retry=%#v", first, retried.Process)
	}
}

func TestProcessStartRejectsMalformedNonce(t *testing.T) {
	shell := requireProcessShell(t)
	server := newProcessServer(t)
	root := t.TempDir()
	request := processStartRequest(root, shell, "-c", "true")
	for _, nonce := range []string{"", "not-a-lowercase-hex-nonce", strings.Repeat("A", 32)} {
		request.StartNonce = nonce
		response := agentJSONRequest(t, server, "/v1/processes/start", request)
		if response.Code != http.StatusBadRequest || responseErrorCode(t, response) != "invalid-start-nonce" {
			t.Fatalf("invalid process start nonce %q = %d %s", nonce, response.Code, response.Body.String())
		}
	}
}

func TestProcessServerShutdownTerminatesLiveTree(t *testing.T) {
	shell := requireProcessShell(t)
	server, err := NewServer(strings.Repeat("s", 32))
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	request := processStartRequest(root, shell, "-c", "while :; do sleep 1; done")
	request.GraceMs = 20
	started := startProcessRoute(t, server, request)
	session := server.processes.session(started.ID)
	if session == nil {
		t.Fatal("process session was not registered")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-session.done:
	case <-time.After(time.Second):
		t.Fatal("server shutdown did not reap process")
	}
	select {
	case <-server.Done():
	default:
		t.Fatal("server Done closed before shutdown result was observed")
	}
}
