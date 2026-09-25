package remoteagent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func directProcessRequest(t *testing.T, backend *directProcessBackend, route string, request any) ProxyResponse {
	t.Helper()
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	response, err := backend.Proxy(context.Background(), route, body)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func directProcessStartRequest(root string, argv ...string) ProcessStartRequest {
	return ProcessStartRequest{Root: root, Path: root, Argv: argv, StartNonce: "0123456789abcdef0123456789abcdef",
		Stdin: ProcessInputSpec{Mode: "pipe"}, Stdout: ProcessOutputSpec{Mode: "pipe"}, Stderr: ProcessOutputSpec{Mode: "pipe"}}
}

func directProcessStart(t *testing.T, backend *directProcessBackend, request ProcessStartRequest) ProcessSnapshot {
	t.Helper()
	response := directProcessRequest(t, backend, "/v1/processes/start", request)
	if response.Status != 200 {
		t.Fatalf("start: %s", response.Body)
	}
	var result ProcessStartResponse
	if err := json.Unmarshal(response.Body, &result); err != nil {
		t.Fatal(err)
	}
	return result.Process
}

func TestDirectProcessStreamsAndNonce(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fake SSH server")
	}
	commands := make(chan string, 4)
	backend := newDirectProcessBackend(directExecSSHClient(t, func(command string) { commands <- command }))
	t.Cleanup(func() { _ = backend.Close() })
	root := t.TempDir()
	secret := "ssh-process-secret-should-not-appear"
	request := directProcessStartRequest(root, "/bin/sh", "-c", "read line; printf 'out:%s:%s' \"$VALUE\" \"$line\"; printf 'err' >&2")
	request.Env = map[string]*string{"VALUE": &secret}
	const count = 8
	type outcome struct {
		response ProxyResponse
		err      error
	}
	results := make(chan outcome, count)
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	for range count {
		group.Add(1)
		go func() {
			defer group.Done()
			response, err := backend.Proxy(context.Background(), "/v1/processes/start", body)
			results <- outcome{response: response, err: err}
		}()
	}
	group.Wait()
	close(results)
	var process ProcessSnapshot
	for result := range results {
		if result.err != nil || result.response.Status != 200 {
			t.Fatalf("concurrent start: %s, %v", result.response.Body, result.err)
		}
		var current ProcessStartResponse
		if err := json.Unmarshal(result.response.Body, &current); err != nil {
			t.Fatal(err)
		}
		if process.ID != "" && current.Process.ID != process.ID {
			t.Fatalf("nonce created two processes: %q and %q", process.ID, current.Process.ID)
		}
		process = current.Process
	}
	if command := <-commands; strings.Contains(command, secret) || strings.Contains(command, root) || strings.Contains(command, "read line") {
		t.Fatalf("exec exposed request values: %q", command)
	}
	conflict := request
	conflict.Argv = []string{"/bin/sh", "-c", "false"}
	if response := directProcessRequest(t, backend, "/v1/processes/start", conflict); response.Status != 409 {
		t.Fatalf("nonce conflict: %s", response.Body)
	}
	data := base64.StdEncoding.EncodeToString([]byte("hello\n"))
	if response := directProcessRequest(t, backend, "/v1/processes/write", ProcessWriteRequest{Root: root, ID: process.ID, DataBase64: data, CloseStdin: true}); response.Status != 200 {
		t.Fatalf("write: %s", response.Body)
	}
	if response := directProcessRequest(t, backend, "/v1/processes/wait", ProcessWaitRequest{Root: root, ID: process.ID, TimeoutMs: 2000}); response.Status != 200 {
		t.Fatalf("wait: %s", response.Body)
	}
	for stream, expected := range map[string]string{"stdout": "out:" + secret + ":hello", "stderr": "err"} {
		response := directProcessRequest(t, backend, "/v1/processes/read", ProcessReadRequest{Root: root, ID: process.ID, Stream: stream})
		if response.Status != 200 {
			t.Fatalf("read %s: %s", stream, response.Body)
		}
		var read ProcessReadResponse
		if err := json.Unmarshal(response.Body, &read); err != nil {
			t.Fatal(err)
		}
		got, err := base64.StdEncoding.DecodeString(read.DataBase64)
		if err != nil || string(got) != expected || !read.EOF || !read.Closed || read.Process.ExitCode == nil || *read.Process.ExitCode != 0 {
			t.Fatalf("%s: %#v, %q, %v", stream, read, got, err)
		}
	}
}

func recordingDirectExecutable(t *testing.T, directory, name, target, log string) {
	t.Helper()
	// 记录 argv 的实际内容，而非固定的日志标签。
	script := "#!/bin/sh\nprintf '" + name + " %s\\n' \"$*\" >> " + shellQuote(log) + "\nexec " + shellQuote(target) + " \"$@\"\n"
	if err := os.WriteFile(filepath.Join(directory, name), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
}

func TestDirectProcessBootstrapUsesStartupPATHWithoutSecretArgv(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell bootstrap")
	}
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Fatal(err)
	}
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Fatal(err)
	}
	env, err := exec.LookPath("env")
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	log := filepath.Join(directory, "tool-argv")
	recordingDirectExecutable(t, directory, "bash", bash, log)
	recordingDirectExecutable(t, directory, "env", env, log)
	secret := "private-remote-process-value"
	userPATH := filepath.Join(directory, "not-the-startup-path")
	userCommand := `printf 'VALUE=%s|startup=%s' "$VALUE" "${STARTUP_ONLY:-unset}"`
	frame := directProcessFrame("", directory, []string{bash, "-c", userCommand}, map[string]*string{
		"VALUE": &secret, "PATH": &userPATH,
	}, []string{"PATH", "VALUE"})
	command := exec.CommandContext(t.Context(), sh, "-c", directProcessStartCommand())
	command.Env = []string{"PATH=" + directory, "STARTUP_ONLY=must-not-inherit"}
	command.Stdin = bytes.NewReader(frame)
	output, err := command.Output()
	if err != nil || string(output) != "VALUE="+secret+"|startup=unset" {
		t.Fatalf("scrubbed process bootstrap output = %q, %v", output, err)
	}
	argv, err := os.ReadFile(log)
	if err != nil || !bytes.Contains(argv, []byte("env -i ")) || bytes.Count(argv, []byte("bash -c ")) < 2 || bytes.Contains(argv, []byte(secret)) || bytes.Contains(argv, []byte(userCommand)) || bytes.Contains(argv, []byte("STARTUP_ONLY=must-not-inherit")) {
		t.Fatalf("bootstrap tool argv = %q, %v", argv, err)
	}
	if strings.Contains(directProcessStartCommand(), secret) || strings.Contains(directProcessStartCommand(), "/usr/bin/env -i /bin/bash") {
		t.Fatal("SSH exec command must be fixed and path-portable")
	}
}

func TestDirectProcessEnvironmentIsNotInTargetArgv(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("requires /proc process argv")
	}
	backend := newDirectProcessBackend(directExecSSHClient(t, nil))
	t.Cleanup(func() { _ = backend.Close() })
	root := t.TempDir()
	secret := "secret-env-value-must-not-appear-in-argv"
	request := directProcessStartRequest(root, "/bin/sh", "-c", `printf '%s\n' "$VALUE"; tr '\000' ' ' < /proc/$$/cmdline`)
	request.Env = map[string]*string{"VALUE": &secret}
	request.Stdin.Mode = "ignore"
	process := directProcessStart(t, backend, request)
	if response := directProcessRequest(t, backend, "/v1/processes/wait", ProcessWaitRequest{Root: root, ID: process.ID, TimeoutMs: 1000}); response.Status != 200 {
		t.Fatalf("wait: %s", response.Body)
	}
	response := directProcessRequest(t, backend, "/v1/processes/read", ProcessReadRequest{Root: root, ID: process.ID, Stream: "stdout"})
	var result ProcessReadResponse
	if err := json.Unmarshal(response.Body, &result); err != nil {
		t.Fatal(err)
	}
	output, err := base64.StdEncoding.DecodeString(result.DataBase64)
	if err != nil || !strings.HasPrefix(string(output), secret+"\n") || strings.Contains(string(output[len(secret)+1:]), secret) {
		t.Fatalf("secret reached argv or was not exported: %q, %v", output, err)
	}
}

type failingDirectStdin struct {
	writeErr, closeErr error
	closed             bool
}

func (s *failingDirectStdin) Write(data []byte) (int, error) {
	if s.writeErr != nil {
		return 0, s.writeErr
	}
	return len(data), nil
}

func (s *failingDirectStdin) Close() error {
	s.closed = true
	return s.closeErr
}

func TestDirectProcessInitialInputRequiresConfirmedWriteAndClose(t *testing.T) {
	for _, test := range []struct {
		name     string
		writeErr error
		closeErr error
		wantErr  bool
	}{
		{name: "write fails", writeErr: io.ErrClosedPipe, wantErr: true},
		{name: "close fails", closeErr: io.ErrClosedPipe, wantErr: true},
		{name: "delivered and closed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			stdin := &failingDirectStdin{writeErr: test.writeErr, closeErr: test.closeErr}
			process := &directProcess{stdin: stdin}
			err := process.writeInitialInput([]byte("payload"))
			if (err != nil) != test.wantErr || process.stdinClosed != !test.wantErr || stdin.closed != (test.writeErr == nil) {
				t.Fatalf("initial input: error=%v stdinClosed=%v closeAttempted=%v", err, process.stdinClosed, stdin.closed)
			}
		})
	}
}

func TestDirectProcessRootResolveAndValidation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fake SSH server")
	}
	backend := newDirectProcessBackend(directExecSSHClient(t, nil))
	t.Cleanup(func() { _ = backend.Close() })
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	request := directProcessStartRequest(root, "/bin/sh", "-c", "printf safe")
	request.Path = "escape"
	if response := directProcessRequest(t, backend, "/v1/processes/start", request); response.Status != 422 {
		t.Fatalf("symlink escape: %s", response.Body)
	}
	request.Path = "../other"
	if response := directProcessRequest(t, backend, "/v1/processes/start", request); response.Status != 403 {
		t.Fatalf("lexical escape: %s", response.Body)
	}
	request.Path = root
	request.Env = map[string]*string{"BAD-NAME": nil}
	if response := directProcessRequest(t, backend, "/v1/processes/start", request); response.Status != 400 {
		t.Fatalf("invalid env: %s", response.Body)
	}
	resolved := directProcessRequest(t, backend, "/v1/processes/resolve", ProcessResolveRequest{Root: root, Path: root, Command: "sh"})
	if resolved.Status != 200 {
		t.Fatalf("resolve: %s", resolved.Body)
	}
	var path ProcessResolveResponse
	if err := json.Unmarshal(resolved.Body, &path); err != nil || !strings.HasPrefix(path.Path, "/") {
		t.Fatalf("resolve path = %#v, %v", path, err)
	}
	executable := filepath.Join(root, "with trailing space ")
	if err := os.WriteFile(executable, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	spaced := directProcessRequest(t, backend, "/v1/processes/resolve", ProcessResolveRequest{Root: root, Path: root, Command: executable})
	if err := json.Unmarshal(spaced.Body, &path); err != nil || spaced.Status != 200 || path.Path != executable {
		t.Fatalf("space in executable path: %s, %v", spaced.Body, err)
	}
	blocked := filepath.Join(root, "not-executable")
	if err := os.WriteFile(blocked, []byte("#!/bin/sh\nexit 0\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	denied := directProcessRequest(t, backend, "/v1/processes/resolve", ProcessResolveRequest{Root: root, Path: root, Command: blocked})
	if denied.Status != 403 {
		t.Fatalf("non-executable command: %s", denied.Body)
	}
	request.Env = nil
	request.StartNonce = "abcdef0123456789abcdef0123456789"
	started := directProcessStart(t, backend, request)
	foreign := directProcessRequest(t, backend, "/v1/processes/read", ProcessReadRequest{Root: outside, ID: started.ID, Stream: "stdout"})
	if foreign.Status != 404 {
		t.Fatalf("cross-root access: %s", foreign.Body)
	}
}

func TestDirectProcessTimeoutCancelAndUnknownKill(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fake SSH server")
	}
	backend := newDirectProcessBackend(directExecSSHClient(t, nil))
	root := t.TempDir()
	request := directProcessStartRequest(root, "/bin/sh", "-c", "read line")
	process := directProcessStart(t, backend, request)
	wait := directProcessRequest(t, backend, "/v1/processes/wait", ProcessWaitRequest{Root: root, ID: process.ID, TimeoutMs: 5})
	var timed ProcessWaitResponse
	if err := json.Unmarshal(wait.Body, &timed); err != nil || timed.Completed || timed.Process.Closed {
		t.Fatalf("timeout: %#v, %v", timed, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	body, _ := json.Marshal(ProcessReadRequest{Root: root, ID: process.ID, Stream: "stdout"})
	if _, err := backend.Proxy(ctx, "/v1/processes/read", body); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	readCtx, stopRead := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer stopRead()
	readResult := make(chan error, 1)
	go func() {
		response, readErr := backend.Proxy(readCtx, "/v1/processes/read", body)
		if readErr == nil && response.Status != 200 {
			readErr = errors.New("concurrent read returned a non-200 response")
		}
		readResult <- readErr
	}()
	kill := directProcessRequest(t, backend, "/v1/processes/kill", ProcessKillRequest{Root: root, ID: process.ID, Signal: "SIGTERM"})
	if kill.Status != 503 || !strings.Contains(string(kill.Body), "unknown") {
		t.Fatalf("kill claimed process tree termination: %s", kill.Body)
	}
	select {
	case err := <-readResult:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("concurrent read did not finish")
	}
	_ = backend.Close()
	select {
	case <-backend.processes[process.ID].done:
	case <-time.After(time.Second):
		t.Fatal("SSH session did not close")
	}
	if snapshot := backend.processes[process.ID].snapshot(); snapshot.Closed && snapshot.ExitCode == nil && snapshot.Signal == nil {
		t.Fatalf("transport loss fabricated close: %#v", snapshot)
	}
}

func TestDirectProcessBoundedOutputAndReclaim(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fake SSH server")
	}
	backend := newDirectProcessBackend(directExecSSHClient(t, nil))
	backend.retention = 20 * time.Millisecond
	root := t.TempDir()
	request := directProcessStartRequest(root, "/bin/sh", "-c", "printf '123456789' ; printf 'abcdef' >&2")
	request.Stdin.Mode = "ignore"
	request.Stdout = ProcessOutputSpec{Mode: "collect", MaxBytes: 4}
	request.Stderr = ProcessOutputSpec{Mode: "collect", MaxBytes: 3}
	process := directProcessStart(t, backend, request)
	response := directProcessRequest(t, backend, "/v1/processes/wait", ProcessWaitRequest{Root: root, ID: process.ID, TimeoutMs: 1000})
	var completed ProcessWaitResponse
	if err := json.Unmarshal(response.Body, &completed); err != nil || !completed.Completed {
		t.Fatalf("wait: %s, %v", response.Body, err)
	}
	for stream, expected := range map[string]string{"stdout": "6789", "stderr": "def"} {
		response := directProcessRequest(t, backend, "/v1/processes/read", ProcessReadRequest{Root: root, ID: process.ID, Stream: stream, From: 0, MaxBytes: 2})
		var first ProcessReadResponse
		if err := json.Unmarshal(response.Body, &first); err != nil {
			t.Fatal(err)
		}
		part, _ := base64.StdEncoding.DecodeString(first.DataBase64)
		if !first.Lossy || !first.Truncated || string(part) != expected[:2] {
			t.Fatalf("%s first: %#v, %q", stream, first, part)
		}
		response = directProcessRequest(t, backend, "/v1/processes/read", ProcessReadRequest{Root: root, ID: process.ID, Stream: stream, From: first.NextOffset})
		var second ProcessReadResponse
		if err := json.Unmarshal(response.Body, &second); err != nil {
			t.Fatal(err)
		}
		part, _ = base64.StdEncoding.DecodeString(second.DataBase64)
		if string(part) != expected[2:] || !second.EOF {
			t.Fatalf("%s second: %#v, %q", stream, second, part)
		}
	}
	deadline := time.After(time.Second)
	for {
		backend.mu.Lock()
		_, retained := backend.processes[process.ID]
		backend.mu.Unlock()
		if !retained {
			break
		}
		select {
		case <-deadline:
			t.Fatal("completed process was not reclaimed")
		case <-time.After(time.Millisecond):
		}
	}
	if response := directProcessRequest(t, backend, "/v1/processes/read", ProcessReadRequest{Root: root, ID: process.ID, Stream: "stdout"}); response.Status != 404 {
		t.Fatalf("expired process: %s", response.Body)
	}
}

func TestDirectProcessUnknownExitReclaimsSessionWithoutReusingNonce(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fake SSH server")
	}
	commands := make(chan string, 3)
	backend := newDirectProcessBackend(directExecSSHClient(t, func(command string) { commands <- command }))
	backend.retention = 20 * time.Millisecond
	root := t.TempDir()
	request := directProcessStartRequest(root, "/bin/sh", "-c", "read line")
	first := directProcessStart(t, backend, request)
	<-commands
	backend.mu.Lock()
	process := backend.processes[first.ID]
	backend.mu.Unlock()
	if err := process.session.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-process.done:
	case <-time.After(time.Second):
		t.Fatal("unknown SSH wait did not finish")
	}
	if response := directProcessRequest(t, backend, "/v1/processes/wait", ProcessWaitRequest{Root: root, ID: first.ID}); response.Status != 503 {
		t.Fatalf("unknown wait: %s", response.Body)
	}
	deadline := time.After(time.Second)
	for {
		backend.mu.Lock()
		_, exists := backend.processes[first.ID]
		backend.mu.Unlock()
		if !exists {
			break
		}
		select {
		case <-deadline:
			t.Fatal("unknown process session was not reclaimed")
		case <-time.After(time.Millisecond):
		}
	}
	if response := directProcessRequest(t, backend, "/v1/processes/start", request); response.Status != 503 || !strings.Contains(string(response.Body), "process-state-unknown") {
		t.Fatalf("same nonce retry concealed unknown exit: %s", response.Body)
	}
	select {
	case command := <-commands:
		t.Fatalf("same nonce launched another SSH command: %q", command)
	default:
	}
	request.StartNonce = "abcdef0123456789abcdef0123456789"
	second := directProcessStart(t, backend, request)
	if second.ID == first.ID {
		t.Fatal("new nonce reused an old session")
	}
	_ = backend.Close()
}

func TestDirectProcessUnknownNonceLimitFailsClosed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("direct SSH processes require POSIX")
	}
	backend := newDirectProcessBackend(nil)
	root := t.TempDir()
	request := directProcessStartRequest(root, "/bin/sh")
	fingerprint, err := processStartFingerprint(request)
	if err != nil {
		t.Fatal(err)
	}
	backend.mu.Lock()
	for i := range maxProcessSessions {
		key := processStartKey{root: root, nonce: fmt.Sprintf("%032x", i)}
		record := &processStartRecord{fingerprint: fingerprint, done: make(chan struct{})}
		close(record.done)
		backend.starts[key] = record
		backend.unknown[key] = struct{}{}
	}
	backend.mu.Unlock()
	response := directProcessRequest(t, backend, "/v1/processes/start", request)
	if response.Status != 429 || !strings.Contains(string(response.Body), "unknown-process-limit") {
		t.Fatalf("new nonce was accepted despite unknown limit: %s", response.Body)
	}
	request.StartNonce = fmt.Sprintf("%032x", 0)
	response = directProcessRequest(t, backend, "/v1/processes/start", request)
	if response.Status != 503 || !strings.Contains(string(response.Body), "process-state-unknown") {
		t.Fatalf("old nonce lost unknown status: %s", response.Body)
	}
	backend.mu.Lock()
	count := len(backend.unknown)
	backend.mu.Unlock()
	if count != maxProcessSessions {
		t.Fatalf("unknown nonce table grew past limit: %d", count)
	}
}

func TestDirectProcessCloseDuringUnpublishedStartReportsUnknown(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fake SSH server")
	}
	commands := make(chan string, 2)
	backend := newDirectProcessBackend(directExecSSHClient(t, func(command string) { commands <- command }))
	entered := make(chan struct{})
	release := make(chan struct{})
	releaseStart := sync.OnceFunc(func() { close(release) })
	defer releaseStart()
	backend.afterSessionStart = func() {
		close(entered)
		<-release
	}
	root := t.TempDir()
	request := directProcessStartRequest(root, "/bin/sh", "-c", "read line")
	finished := make(chan error, 1)
	go func() {
		_, err := backend.start(context.Background(), request)
		finished <- err
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("SSH process Start did not reach the publication barrier")
	}
	if err := backend.Close(); err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("Close falsely confirmed an unpublished remote process: %v", err)
	}
	backend.mu.Lock()
	count := len(backend.processes)
	backend.mu.Unlock()
	if count != 0 {
		t.Fatalf("process was published before barrier release: %d", count)
	}
	releaseStart()
	select {
	case err := <-finished:
		if err == nil || !strings.Contains(err.Error(), "unknown") {
			t.Fatalf("closed start status = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("closed process start did not finish")
	}
	backend.mu.Lock()
	_, unknown := backend.unknown[processStartKey{root: root, nonce: request.StartNonce}]
	backend.mu.Unlock()
	if !unknown {
		t.Fatal("unconfirmed nonce lost its tombstone")
	}
	if err := backend.Close(); err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("repeat Close forgot unknown state: %v", err)
	}
	if len(commands) != 1 {
		t.Fatalf("expected one remote SSH command, got %d", len(commands))
	}
}

func TestDirectProcessDataStdinAndCanceledRead(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX fake SSH server")
	}
	backend := newDirectProcessBackend(directExecSSHClient(t, nil))
	t.Cleanup(func() { _ = backend.Close() })
	root := t.TempDir()
	request := directProcessStartRequest(root, "/bin/sh", "-c", "cat")
	request.Stdin = ProcessInputSpec{Mode: "data", DataBase64: base64.StdEncoding.EncodeToString([]byte("\x00\xffpayload"))}
	process := directProcessStart(t, backend, request)
	if !process.StdinClosed {
		t.Fatalf("data stdin was not logically closed: %#v", process)
	}
	if response := directProcessRequest(t, backend, "/v1/processes/write", ProcessWriteRequest{Root: root, ID: process.ID}); response.Status != 409 {
		t.Fatalf("data stdin accepted write: %s", response.Body)
	}
	wait := directProcessRequest(t, backend, "/v1/processes/wait", ProcessWaitRequest{Root: root, ID: process.ID, TimeoutMs: 1000})
	var complete ProcessWaitResponse
	if err := json.Unmarshal(wait.Body, &complete); err != nil || !complete.Completed {
		t.Fatalf("data process wait: %s, %v", wait.Body, err)
	}
	read := directProcessRequest(t, backend, "/v1/processes/read", ProcessReadRequest{Root: root, ID: process.ID, Stream: "stdout"})
	var output ProcessReadResponse
	if err := json.Unmarshal(read.Body, &output); err != nil {
		t.Fatal(err)
	}
	data, err := base64.StdEncoding.DecodeString(output.DataBase64)
	if err != nil || string(data) != "\x00\xffpayload" {
		stderr := directProcessRequest(t, backend, "/v1/processes/read", ProcessReadRequest{Root: root, ID: process.ID, Stream: "stderr"})
		t.Fatalf("binary data roundtrip: %q, wait=%s, read=%s, stderr=%s, %v", data, wait.Body, read.Body, stderr.Body, err)
	}

	request = directProcessStartRequest(root, "/bin/sh", "-c", "read line")
	request.StartNonce = "99999999999999999999999999999999"
	process = directProcessStart(t, backend, request)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	body, _ := json.Marshal(ProcessReadRequest{Root: root, ID: process.ID, Stream: "stdout"})
	response, err := backend.Proxy(ctx, "/v1/processes/read", body)
	if err != nil || response.Status != 200 {
		t.Fatalf("canceled read: %s, %v", response.Body, err)
	}
	if err := json.Unmarshal(response.Body, &output); err != nil || output.Closed || output.EOF {
		t.Fatalf("canceled read fabricated close: %#v, %v", output, err)
	}
}
