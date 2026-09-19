package remoteagent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func requireTerminalPTY(t *testing.T) string {
	t.Helper()
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skipf("real terminal test is unsupported on %s", runtime.GOOS)
	}
	shell, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("sh is unavailable")
	}
	return shell
}

func readTerminalRoute(t *testing.T, server *Server, root, id string, after uint64) TerminalReadResponse {
	t.Helper()
	response := agentJSONRequest(t, server, "/v1/terminals/read", TerminalReadRequest{
		Root: root, ID: id, After: after, WaitMs: 1_000,
	})
	if response.Code != http.StatusOK {
		t.Fatalf("terminal read status = %d: %s", response.Code, response.Body.String())
	}
	var result TerminalReadResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func terminalOutputText(t *testing.T, response TerminalReadResponse) string {
	t.Helper()
	var result strings.Builder
	for _, chunk := range response.Chunks {
		data, err := base64.StdEncoding.DecodeString(chunk.DataBase64)
		if err != nil {
			t.Fatal(err)
		}
		result.Write(data)
	}
	return result.String()
}

func readTerminalUntil(t *testing.T, server *Server, root, id string, after uint64, contains string) TerminalReadResponse {
	t.Helper()
	var output strings.Builder
	for attempts := 0; attempts < 4; attempts++ {
		response := readTerminalRoute(t, server, root, id, after)
		output.WriteString(terminalOutputText(t, response))
		if strings.Contains(output.String(), contains) || response.Closed {
			return response
		}
		after = response.Cursor
	}
	t.Fatalf("terminal output did not contain %q", contains)
	return TerminalReadResponse{}
}

func TestTerminalRoutesAllocatePTYDeliverBytesAndTerminate(t *testing.T) {
	shell := requireTerminalPTY(t)
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })
	root := t.TempDir()
	startedResponse := agentJSONRequest(t, server, "/v1/terminals/start", TerminalStartRequest{
		Root: root, Path: root,
		Argv: []string{shell, "-c", `printf 'ready\n'; IFS= read -r value; printf 'got:%s\n' "$value"`},
		Rows: 24, Cols: 80, GraceMs: 100, StartNonce: strings.Repeat("0", 32),
	})
	if startedResponse.Code != http.StatusOK {
		t.Fatalf("terminal start status = %d: %s", startedResponse.Code, startedResponse.Body.String())
	}
	var started TerminalStartResponse
	if err := json.Unmarshal(startedResponse.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	if started.ID == "" || started.PID <= 0 {
		t.Fatalf("terminal start = %#v", started)
	}
	resizeResponse := agentJSONRequest(t, server, "/v1/terminals/resize", TerminalResizeRequest{
		Root: root, ID: started.ID, Cols: 100, Rows: 30,
	})
	if resizeResponse.Code != http.StatusOK || resizeResponse.Body.String() != "{\"accepted\":true}\n" {
		t.Fatalf("terminal resize = %d %s", resizeResponse.Code, resizeResponse.Body.String())
	}
	for _, size := range []TerminalResizeRequest{
		{Root: root, ID: started.ID, Cols: 1, Rows: 24},
		{Root: root, ID: started.ID, Cols: 80, Rows: 0},
		{Root: root, ID: started.ID, Cols: maxTerminalCols + 1, Rows: 24},
		{Root: root, ID: started.ID, Cols: 80, Rows: maxTerminalRows + 1},
	} {
		invalid := agentJSONRequest(t, server, "/v1/terminals/resize", size)
		if invalid.Code != http.StatusBadRequest || responseErrorCode(t, invalid) != "invalid-terminal-request" {
			t.Fatalf("invalid terminal resize %#v = %d %s", size, invalid.Code, invalid.Body.String())
		}
	}
	unknownField := agentRequest(server, http.MethodPost, "/v1/terminals/resize", fmt.Sprintf(
		`{"root":%q,"id":%q,"cols":80,"rows":24,"unknown":true}`,
		root,
		started.ID,
	))
	if unknownField.Code != http.StatusBadRequest || responseErrorCode(t, unknownField) != "invalid-json" {
		t.Fatalf("terminal resize unknown field = %d %s", unknownField.Code, unknownField.Body.String())
	}
	fractional := agentRequest(server, http.MethodPost, "/v1/terminals/resize", fmt.Sprintf(
		`{"root":%q,"id":%q,"cols":80.5,"rows":24}`,
		root,
		started.ID,
	))
	if fractional.Code != http.StatusBadRequest || responseErrorCode(t, fractional) != "invalid-json" {
		t.Fatalf("fractional terminal resize = %d %s", fractional.Code, fractional.Body.String())
	}

	first := readTerminalRoute(t, server, root, started.ID, 0)
	if !strings.Contains(terminalOutputText(t, first), "ready") {
		t.Fatalf("initial terminal output = %q", terminalOutputText(t, first))
	}
	writeResponse := agentJSONRequest(t, server, "/v1/terminals/write", TerminalWriteRequest{
		Root: root, ID: started.ID, DataBase64: base64.StdEncoding.EncodeToString([]byte("hello\n")),
	})
	if writeResponse.Code != http.StatusOK || writeResponse.Body.String() != "{\"accepted\":true}\n" {
		t.Fatalf("terminal write = %d %s", writeResponse.Code, writeResponse.Body.String())
	}
	second := readTerminalUntil(t, server, root, started.ID, first.Cursor, "got:hello")
	if !second.Closed {
		second = readTerminalRoute(t, server, root, started.ID, second.Cursor)
	}
	if !second.Closed || second.ExitCode == nil || *second.ExitCode != 0 {
		t.Fatalf("terminal close = %#v", second)
	}
	lateResize := agentJSONRequest(t, server, "/v1/terminals/resize", TerminalResizeRequest{
		Root: root, ID: started.ID, Cols: 80, Rows: 24,
	})
	if lateResize.Code != http.StatusConflict || responseErrorCode(t, lateResize) != "terminal-closed" {
		t.Fatalf("late terminal resize = %d %s", lateResize.Code, lateResize.Body.String())
	}
	terminated := agentJSONRequest(t, server, "/v1/terminals/terminate", TerminalTerminateRequest{Root: root, ID: started.ID})
	if terminated.Code != http.StatusOK || terminated.Body.String() != "{\"accepted\":true}\n" {
		t.Fatalf("idempotent terminal terminate = %d %s", terminated.Code, terminated.Body.String())
	}

	missing := agentJSONRequest(t, server, "/v1/terminals/read", TerminalReadRequest{ID: "missing", WaitMs: 1})
	if missing.Code != http.StatusNotFound || responseErrorCode(t, missing) != "terminal-not-found" {
		t.Fatalf("missing terminal = %d %s", missing.Code, missing.Body.String())
	}
	if response := agentRequest(server, http.MethodGet, "/v1/terminals/start", ""); response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET terminal start status = %d, want %d", response.Code, http.StatusMethodNotAllowed)
	}
	if response := agentRequest(server, http.MethodGet, "/v1/terminals/resize", ""); response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET terminal resize status = %d, want %d", response.Code, http.StatusMethodNotAllowed)
	}
}

func TestTerminalStartNonceReusesOnePTYAndRejectsConflicts(t *testing.T) {
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })
	backend := &unpublishedTerminalBackend{forced: make(chan struct{}), waited: make(chan struct{})}
	starts := 0
	server.terminals.startBackend = func(_ string, _ TerminalStartRequest) (terminalBackend, error) {
		starts++
		return backend, nil
	}
	root := t.TempDir()
	request := TerminalStartRequest{
		Root: root, Path: root, Argv: []string{"nonce-terminal"}, Rows: 24, Cols: 80,
		StartNonce: strings.Repeat("a", 32),
	}
	firstResponse := agentJSONRequest(t, server, "/v1/terminals/start", request)
	if firstResponse.Code != http.StatusOK {
		t.Fatalf("terminal start = %d %s", firstResponse.Code, firstResponse.Body.String())
	}
	var first TerminalStartResponse
	if err := json.Unmarshal(firstResponse.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	retriedResponse := agentJSONRequest(t, server, "/v1/terminals/start", request)
	if retriedResponse.Code != http.StatusOK {
		t.Fatalf("terminal start retry = %d %s", retriedResponse.Code, retriedResponse.Body.String())
	}
	var retried TerminalStartResponse
	if err := json.Unmarshal(retriedResponse.Body.Bytes(), &retried); err != nil {
		t.Fatal(err)
	}
	if starts != 1 || retried != first {
		t.Fatalf("terminal retry starts=%d first=%#v retry=%#v", starts, first, retried)
	}

	conflict := request
	conflict.Cols = 81
	conflictingResponse := agentJSONRequest(t, server, "/v1/terminals/start", conflict)
	if conflictingResponse.Code != http.StatusConflict || responseErrorCode(t, conflictingResponse) != "terminal-start-conflict" {
		t.Fatalf("conflicting terminal start = %d %s", conflictingResponse.Code, conflictingResponse.Body.String())
	}
	for _, nonce := range []string{"", "not-a-lowercase-hex-nonce", strings.Repeat("A", 32)} {
		invalid := request
		invalid.StartNonce = nonce
		response := agentJSONRequest(t, server, "/v1/terminals/start", invalid)
		if response.Code != http.StatusBadRequest || responseErrorCode(t, response) != "invalid-start-nonce" {
			t.Fatalf("invalid terminal start nonce %q = %d %s", nonce, response.Code, response.Body.String())
		}
	}
}

func TestTerminalRoutesResolveBareCommandFromExplicitPath(t *testing.T) {
	shell := requireTerminalPTY(t)
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })
	root := t.TempDir()
	bin := filepath.Join(root, "bin")
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	command := filepath.Join(bin, "remote-sh")
	if err := os.Symlink(shell, command); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	startedResponse := agentJSONRequest(t, server, "/v1/terminals/start", TerminalStartRequest{
		Root: root, Path: root, Argv: []string{"remote-sh", "-c", "printf explicit-path"},
		Env: map[string]string{"PATH": bin}, Rows: 24, Cols: 80, GraceMs: 50, StartNonce: strings.Repeat("0", 32),
	})
	if startedResponse.Code != http.StatusOK {
		t.Fatalf("terminal explicit PATH start = %d %s", startedResponse.Code, startedResponse.Body.String())
	}
	var started TerminalStartResponse
	if err := json.Unmarshal(startedResponse.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	read := readTerminalRoute(t, server, root, started.ID, 0)
	if !strings.Contains(terminalOutputText(t, read), "explicit-path") {
		t.Fatalf("terminal explicit PATH output = %q", terminalOutputText(t, read))
	}
}

func TestTerminalRoutesInspectAndSignalForegroundThenShutdown(t *testing.T) {
	shell := requireTerminalPTY(t)
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })
	root := t.TempDir()
	startedResponse := agentJSONRequest(t, server, "/v1/terminals/start", TerminalStartRequest{
		Root: root, Path: root,
		Argv: []string{shell, "-c", `printf 'waiting\n'; while :; do sleep 1; done`},
		Rows: 24, Cols: 80, GraceMs: 100, StartNonce: strings.Repeat("0", 32),
	})
	if startedResponse.Code != http.StatusOK {
		t.Fatalf("terminal start status = %d: %s", startedResponse.Code, startedResponse.Body.String())
	}
	var started TerminalStartResponse
	if err := json.Unmarshal(startedResponse.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	_ = readTerminalRoute(t, server, root, started.ID, 0)
	foregroundResponse := agentJSONRequest(t, server, "/v1/terminals/foreground", TerminalForegroundRequest{Root: root, ID: started.ID})
	if foregroundResponse.Code != http.StatusOK {
		t.Fatalf("terminal foreground status = %d: %s", foregroundResponse.Code, foregroundResponse.Body.String())
	}
	var foreground TerminalForegroundResponse
	if err := json.Unmarshal(foregroundResponse.Body.Bytes(), &foreground); err != nil {
		t.Fatal(err)
	}
	if foreground.ProcessGroupID <= 0 {
		t.Fatalf("terminal foreground = %#v", foreground)
	}
	signalResponse := agentJSONRequest(t, server, "/v1/terminals/signal", TerminalSignalRequest{
		Root: root, ID: started.ID, Signal: "SIGINT",
	})
	if signalResponse.Code != http.StatusOK {
		t.Fatalf("terminal signal status = %d: %s", signalResponse.Code, signalResponse.Body.String())
	}
	var signaled TerminalSignalResponse
	if err := json.Unmarshal(signalResponse.Body.Bytes(), &signaled); err != nil {
		t.Fatal(err)
	}
	if signaled.ProcessGroupID != foreground.ProcessGroupID {
		t.Fatalf("signal group = %#v, foreground = %#v", signaled, foreground)
	}
	session := server.terminals.session(started.ID)
	if session == nil {
		t.Fatal("terminal session was not registered")
	}
	if err := server.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-session.closedDone:
	case <-time.After(2 * time.Second):
		t.Fatal("server shutdown did not terminate the PTY")
	}
}

func TestTerminalRoutesRejectCrossRootControl(t *testing.T) {
	shell := requireTerminalPTY(t)
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })
	ownerRoot := t.TempDir()
	foreignRoot := t.TempDir()
	startedResponse := agentJSONRequest(t, server, "/v1/terminals/start", TerminalStartRequest{
		Root: ownerRoot, Path: ownerRoot, Argv: []string{shell, "-c", `while :; do sleep 1; done`}, Rows: 24, Cols: 80, StartNonce: strings.Repeat("0", 32),
	})
	if startedResponse.Code != http.StatusOK {
		t.Fatalf("terminal start = %d %s", startedResponse.Code, startedResponse.Body.String())
	}
	var started TerminalStartResponse
	if err := json.Unmarshal(startedResponse.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	for _, request := range []struct {
		path string
		body any
	}{
		{"/v1/terminals/read", TerminalReadRequest{Root: foreignRoot, ID: started.ID, WaitMs: 1}},
		{"/v1/terminals/write", TerminalWriteRequest{Root: foreignRoot, ID: started.ID, DataBase64: base64.StdEncoding.EncodeToString([]byte("ignored"))}},
		{"/v1/terminals/resize", TerminalResizeRequest{Root: foreignRoot, ID: started.ID, Cols: 100, Rows: 30}},
		{"/v1/terminals/foreground", TerminalForegroundRequest{Root: foreignRoot, ID: started.ID}},
		{"/v1/terminals/signal", TerminalSignalRequest{Root: foreignRoot, ID: started.ID, Signal: "SIGINT"}},
		{"/v1/terminals/terminate", TerminalTerminateRequest{Root: foreignRoot, ID: started.ID}},
	} {
		got := agentJSONRequest(t, server, request.path, request.body)
		if got.Code != http.StatusNotFound || responseErrorCode(t, got) != "terminal-not-found" {
			t.Fatalf("cross-root %s = %d %s", request.path, got.Code, got.Body.String())
		}
	}
	if stopped := agentJSONRequest(t, server, "/v1/terminals/terminate", TerminalTerminateRequest{Root: ownerRoot, ID: started.ID}); stopped.Code != http.StatusOK {
		t.Fatalf("owner terminate = %d %s", stopped.Code, stopped.Body.String())
	}
}

func TestTerminalRoutesKeepLaunchOwnerAfterRootAliasChanges(t *testing.T) {
	shell := requireTerminalPTY(t)
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })
	realRoot := t.TempDir()
	aliasParent := t.TempDir()
	aliasRoot := filepath.Join(aliasParent, "workspace")
	if err := os.Symlink(realRoot, aliasRoot); err != nil {
		t.Fatal(err)
	}
	startedResponse := agentJSONRequest(t, server, "/v1/terminals/start", TerminalStartRequest{
		Root: aliasRoot, Path: aliasRoot, Argv: []string{shell, "-c", `while :; do sleep 1; done`},
		Rows: 24, Cols: 80, StartNonce: strings.Repeat("0", 32),
	})
	if startedResponse.Code != http.StatusOK {
		t.Fatalf("terminal start = %d %s", startedResponse.Code, startedResponse.Body.String())
	}
	var started TerminalStartResponse
	if err := json.Unmarshal(startedResponse.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	for _, request := range []struct {
		path string
		body any
	}{
		{"/v1/terminals/read", TerminalReadRequest{Root: realRoot, ID: started.ID, WaitMs: 1}},
		{"/v1/terminals/resize", TerminalResizeRequest{Root: realRoot, ID: started.ID, Cols: 100, Rows: 30}},
		{"/v1/terminals/terminate", TerminalTerminateRequest{Root: realRoot, ID: started.ID}},
	} {
		got := agentJSONRequest(t, server, request.path, request.body)
		if got.Code != http.StatusNotFound || responseErrorCode(t, got) != "terminal-not-found" {
			t.Fatalf("canonical-root %s = %d %s", request.path, got.Code, got.Body.String())
		}
	}
	if err := os.Remove(aliasRoot); err != nil {
		t.Fatal(err)
	}
	if read := readTerminalRoute(t, server, aliasRoot, started.ID, 0); read.Closed {
		t.Fatalf("owner terminal closed after alias removal: %#v", read)
	}
	terminated := agentJSONRequest(t, server, "/v1/terminals/terminate", TerminalTerminateRequest{Root: aliasRoot, ID: started.ID})
	if terminated.Code != http.StatusOK {
		t.Fatalf("owner terminate after alias removal = %d %s", terminated.Code, terminated.Body.String())
	}
}

func TestTerminalCloseForceTerminatesUnpublishedStart(t *testing.T) {
	sessions := NewTerminalSessions(TerminalSessionsOptions{})
	backend := &unpublishedTerminalBackend{forced: make(chan struct{}), waited: make(chan struct{})}
	entered := make(chan struct{})
	release := make(chan struct{})
	sessions.startBackend = func(_ string, _ TerminalStartRequest) (terminalBackend, error) {
		close(entered)
		<-release
		return backend, nil
	}

	started := make(chan error, 1)
	root := t.TempDir()
	go func() {
		_, err := sessions.Start(TerminalStartRequest{
			Root: root, Path: root, Argv: []string{"unpublished-terminal"}, Rows: 24, Cols: 80, StartNonce: strings.Repeat("0", 32),
		})
		started <- err
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("terminal start did not enter backend allocation")
	}

	ctx, cancel := context.WithCancel(context.Background())
	closeReturned := make(chan struct{})
	go func() {
		sessions.Close(ctx)
		close(closeReturned)
	}()
	deadline := time.After(time.Second)
	for {
		sessions.mu.Lock()
		closed := sessions.closed
		sessions.mu.Unlock()
		if closed {
			break
		}
		select {
		case <-deadline:
			t.Fatal("terminal Close did not mark the registry closed")
		case <-time.After(time.Millisecond):
		}
	}
	cancel()
	select {
	case <-closeReturned:
	case <-time.After(time.Second):
		t.Fatal("deadline-bound terminal Close did not return")
	}
	close(release)

	select {
	case <-backend.forced:
	case <-time.After(time.Second):
		t.Fatal("close deadline did not force-terminate the unpublished PTY")
	}
	select {
	case err := <-started:
		if !errors.Is(err, ErrTerminalNotFound) {
			t.Fatalf("unpublished start error = %v, want %v", err, ErrTerminalNotFound)
		}
	case <-time.After(time.Second):
		t.Fatal("unpublished terminal start did not settle")
	}
	select {
	case <-sessions.closeDone:
	case <-time.After(time.Second):
		t.Fatal("terminal registry did not finish reaping the unpublished PTY")
	}
}

func TestTerminalTerminateWaitsForConfiguredGrace(t *testing.T) {
	backend := &blockingTerminalBackend{closed: make(chan struct{})}
	session := &terminalSession{
		backend: backend, grace: 40 * time.Millisecond,
		processDone: make(chan struct{}), readerDone: make(chan struct{}), closedDone: make(chan struct{}),
		terminateDone: make(chan struct{}), notify: make(chan struct{}), input: make(chan []byte),
	}
	go func() {
		<-backend.closed
		close(session.processDone)
	}()
	started := time.Now()
	session.startTermination()
	select {
	case <-session.terminateDone:
		t.Fatal("termination returned before the configured grace elapsed")
	case <-time.After(20 * time.Millisecond):
	}
	select {
	case <-session.terminateDone:
		if elapsed := time.Since(started); elapsed < session.grace {
			t.Fatalf("termination waited %s, want at least %s", elapsed, session.grace)
		}
	case <-time.After(1500 * time.Millisecond):
		t.Fatal("termination did not settle after configured grace")
	}
}

func TestTerminalTerminateDrainsInFlightResize(t *testing.T) {
	sessions := NewTerminalSessions(TerminalSessionsOptions{})
	t.Cleanup(func() { sessions.Close(context.Background()) })
	backend := &resizeRaceTerminalBackend{
		resizeStarted: make(chan struct{}),
		releaseResize: make(chan struct{}),
		terminated:    make(chan struct{}),
		waitDone:      make(chan struct{}),
	}
	sessions.startBackend = func(_ string, _ TerminalStartRequest) (terminalBackend, error) {
		return backend, nil
	}
	root := t.TempDir()
	started, err := sessions.Start(TerminalStartRequest{
		Root: root, Path: root, Argv: []string{"resize-race-terminal"}, Rows: 24, Cols: 80,
		StartNonce: strings.Repeat("0", 32),
	})
	if err != nil {
		t.Fatal(err)
	}

	resizeResult := make(chan error, 1)
	go func() {
		resizeResult <- sessions.Resize(TerminalResizeRequest{Root: root, ID: started.ID, Cols: 100, Rows: 30})
	}()
	select {
	case <-backend.resizeStarted:
	case <-time.After(time.Second):
		t.Fatal("resize did not enter the PTY backend")
	}

	terminateResult := make(chan error, 1)
	go func() {
		terminateResult <- sessions.Terminate(context.Background(), TerminalTerminateRequest{Root: root, ID: started.ID})
	}()
	session := sessions.session(started.ID)
	if session == nil {
		t.Fatal("terminal session was not registered")
	}
	deadline := time.After(time.Second)
	for {
		session.mu.Lock()
		stopping := session.stopping
		session.mu.Unlock()
		if stopping {
			break
		}
		select {
		case <-deadline:
			t.Fatal("termination did not close admission for terminal operations")
		case <-time.After(time.Millisecond):
		}
	}
	select {
	case <-backend.terminated:
		t.Fatal("terminate reached the PTY before the in-flight resize drained")
	default:
	}
	lateResize := make(chan error, 1)
	go func() {
		lateResize <- sessions.Resize(TerminalResizeRequest{Root: root, ID: started.ID, Cols: 120, Rows: 40})
	}()

	close(backend.releaseResize)
	if err := <-resizeResult; err != nil {
		t.Fatalf("in-flight resize = %v", err)
	}
	select {
	case <-backend.terminated:
	case <-time.After(time.Second):
		t.Fatal("terminate did not reach the PTY after resize drained")
	}
	if err := <-lateResize; !errors.Is(err, ErrTerminalClosed) {
		t.Fatalf("resize admitted after termination started: %v", err)
	}
	if err := <-terminateResult; err != nil {
		t.Fatalf("terminal terminate = %v", err)
	}
}

type resizeRaceTerminalBackend struct {
	resizeStarted chan struct{}
	releaseResize chan struct{}
	terminated    chan struct{}
	waitDone      chan struct{}

	resizeOnce    sync.Once
	terminateOnce sync.Once
}

func (backend *resizeRaceTerminalBackend) Read([]byte) (int, error) {
	return 0, errors.New("resize race reader closed")
}
func (backend *resizeRaceTerminalBackend) Write(data []byte) (int, error) { return len(data), nil }
func (backend *resizeRaceTerminalBackend) Close() error                   { return nil }
func (backend *resizeRaceTerminalBackend) PID() int                       { return 1 }
func (backend *resizeRaceTerminalBackend) Wait() terminalExit {
	<-backend.waitDone
	code := 0
	return terminalExit{exitCode: &code}
}
func (backend *resizeRaceTerminalBackend) Resize(int, int) error {
	backend.resizeOnce.Do(func() { close(backend.resizeStarted) })
	<-backend.releaseResize
	return nil
}
func (backend *resizeRaceTerminalBackend) Foreground() (int, error)             { return 1, nil }
func (backend *resizeRaceTerminalBackend) SignalForeground(string) (int, error) { return 1, nil }
func (backend *resizeRaceTerminalBackend) Terminate() error {
	backend.terminateOnce.Do(func() {
		close(backend.terminated)
		close(backend.waitDone)
	})
	return nil
}
func (backend *resizeRaceTerminalBackend) ForceTerminate() error { return backend.Terminate() }

type blockingTerminalBackend struct {
	closed chan struct{}
	once   sync.Once
}

func (backend *blockingTerminalBackend) Read([]byte) (int, error) {
	return 0, errors.New("unavailable")
}
func (backend *blockingTerminalBackend) Write(data []byte) (int, error) { return len(data), nil }
func (backend *blockingTerminalBackend) Close() error {
	backend.once.Do(func() { close(backend.closed) })
	return nil
}
func (backend *blockingTerminalBackend) PID() int                             { return 1 }
func (backend *blockingTerminalBackend) Wait() terminalExit                   { return terminalExit{} }
func (backend *blockingTerminalBackend) Resize(int, int) error                { return nil }
func (backend *blockingTerminalBackend) Foreground() (int, error)             { return 1, nil }
func (backend *blockingTerminalBackend) SignalForeground(string) (int, error) { return 1, nil }
func (backend *blockingTerminalBackend) Terminate() error                     { return nil }
func (backend *blockingTerminalBackend) ForceTerminate() error                { return backend.Close() }

type unpublishedTerminalBackend struct {
	forced    chan struct{}
	waited    chan struct{}
	forceOnce sync.Once
	closeOnce sync.Once
}

func (backend *unpublishedTerminalBackend) Read([]byte) (int, error) {
	return 0, errors.New("unavailable")
}
func (backend *unpublishedTerminalBackend) Write(data []byte) (int, error) { return len(data), nil }
func (backend *unpublishedTerminalBackend) Close() error {
	backend.closeOnce.Do(func() {})
	return nil
}
func (backend *unpublishedTerminalBackend) PID() int { return 1 }
func (backend *unpublishedTerminalBackend) Wait() terminalExit {
	<-backend.waited
	return terminalExit{}
}
func (backend *unpublishedTerminalBackend) Resize(int, int) error                { return nil }
func (backend *unpublishedTerminalBackend) Foreground() (int, error)             { return 1, nil }
func (backend *unpublishedTerminalBackend) SignalForeground(string) (int, error) { return 1, nil }
func (backend *unpublishedTerminalBackend) Terminate() error                     { return backend.ForceTerminate() }
func (backend *unpublishedTerminalBackend) ForceTerminate() error {
	backend.forceOnce.Do(func() {
		close(backend.forced)
		close(backend.waited)
	})
	return nil
}

func TestTerminalOutputCursorReportsRingLoss(t *testing.T) {
	session := &terminalSession{notify: make(chan struct{})}
	session.appendOutput([]byte("one"), 4)
	session.appendOutput([]byte("two"), 4)
	session.mu.Lock()
	response := session.responseAfterLocked(0)
	session.mu.Unlock()
	if !response.Truncated || len(response.Chunks) != 1 || response.Chunks[0].Sequence != 2 {
		t.Fatalf("lossy terminal response = %#v", response)
	}
	if output := terminalOutputText(t, response); output != "two" {
		t.Fatalf("retained output = %q", output)
	}
}

func TestTerminalStartFailsClosedWithoutRealPTY(t *testing.T) {
	if runtime.GOOS == "darwin" || runtime.GOOS == "linux" || runtime.GOOS == "windows" {
		t.Skip("real PTY is available on this platform")
	}
	sessions := NewTerminalSessions(TerminalSessionsOptions{})
	root := t.TempDir()
	_, err := sessions.Start(TerminalStartRequest{
		Path: root, Argv: []string{"ignored"}, Rows: 24, Cols: 80, StartNonce: strings.Repeat("0", 32),
	})
	if !errors.Is(err, ErrTerminalUnavailable) {
		t.Fatalf("unsupported PTY start = %v", err)
	}
}
