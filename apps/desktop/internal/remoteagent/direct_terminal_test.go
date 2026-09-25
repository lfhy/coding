package remoteagent

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/creack/pty"
	"github.com/deepseek-ai/coding/apps/desktop/internal/sshfixture"
	"golang.org/x/crypto/ssh"
)

type directTerminalFake struct {
	mu                    sync.Mutex
	command               string
	frame                 []string
	resize                [2]uint32
	signals               []string
	denyPTY               bool
	withholdFrameReady    bool
	withholdTerminalReady bool
	frameReceived         chan struct{}
	execCount             int
}

func directTerminalClient(t *testing.T, fake *directTerminalFake) *ssh.Client {
	t.Helper()
	server, err := sshfixture.StartWithHooks(sshfixture.Hooks{
		Authenticate: func(string, []byte) bool { return true },
		Session:      fake.serve,
		Forward:      func(channel ssh.Channel) { _ = channel.Close() },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	client, err := ssh.Dial("tcp", net.JoinHostPort(server.Host, fmt.Sprint(server.Port)), &ssh.ClientConfig{
		User: server.Username, Auth: []ssh.AuthMethod{ssh.Password(server.Password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func (fake *directTerminalFake) serve(channel ssh.Channel, requests <-chan *ssh.Request) {
	defer channel.Close()
	ready := false
	for request := range requests {
		switch request.Type {
		case "pty-req":
			_ = request.Reply(!fake.denyPTY, nil)
		case "exec":
			var value struct{ Command string }
			if ssh.Unmarshal(request.Payload, &value) != nil {
				_ = request.Reply(false, nil)
				return
			}
			fake.mu.Lock()
			fake.command = value.Command
			fake.execCount++
			fake.mu.Unlock()
			_ = request.Reply(true, nil)
			ready = true
			if fake.withholdFrameReady {
				continue
			}
			go func() {
				_, _ = channel.Write([]byte(directTerminalFrameReady))
				reader := bufio.NewReader(channel)
				frame := make([]string, 0, 12)
				for i := 0; i < 3; i++ {
					value, err := reader.ReadString(0)
					if err != nil {
						return
					}
					frame = append(frame, strings.TrimSuffix(value, "\x00"))
				}
				count, err := parseFakeCount(frame[2])
				if err != nil {
					return
				}
				for i := 0; i < count+1; i++ {
					value, err := reader.ReadString(0)
					if err != nil {
						return
					}
					frame = append(frame, strings.TrimSuffix(value, "\x00"))
				}
				envCount, err := parseFakeCount(frame[len(frame)-1])
				if err != nil {
					return
				}
				for i := 0; i < envCount*2; i++ {
					value, err := reader.ReadString(0)
					if err != nil {
						return
					}
					frame = append(frame, strings.TrimSuffix(value, "\x00"))
				}
				fake.mu.Lock()
				fake.frame = frame
				if fake.frameReceived != nil {
					close(fake.frameReceived)
					fake.frameReceived = nil
				}
				fake.mu.Unlock()
				if fake.withholdTerminalReady {
					return
				}
				_, _ = channel.Write([]byte(directTerminalReadyPrefix + "321" + "\x1f" + "hello\x00"))
				buffer := make([]byte, 4096)
				for {
					n, err := reader.Read(buffer)
					if n > 0 {
						_, _ = channel.Write(buffer[:n])
					}
					if err != nil {
						return
					}
				}
			}()
		case "window-change":
			var size struct{ Cols, Rows, Width, Height uint32 }
			if ssh.Unmarshal(request.Payload, &size) == nil {
				fake.mu.Lock()
				fake.resize = [2]uint32{size.Cols, size.Rows}
				fake.mu.Unlock()
			}
			_ = request.Reply(true, nil)
		case "signal":
			var value struct{ Signal string }
			if ssh.Unmarshal(request.Payload, &value) == nil {
				fake.mu.Lock()
				fake.signals = append(fake.signals, value.Signal)
				fake.mu.Unlock()
			}
			_ = request.Reply(true, nil)
			if ready && value.Signal == "TERM" {
				_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{Status: 143}))
				return
			}
		default:
			_ = request.Reply(false, nil)
		}
	}
}

func parseFakeCount(value string) (int, error) {
	var count int
	_, err := fmt.Sscan(value, &count)
	if count < 0 || count > maxTerminalArgv {
		return 0, fmt.Errorf("invalid frame count")
	}
	return count, err
}

func directTerminalRequest(t *testing.T, backend *directTerminalBackend, ctx context.Context, route string, value any) ProxyResponse {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	response, err := backend.Proxy(ctx, route, body)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func startFakeDirectTerminal(t *testing.T, backend *directTerminalBackend, root string) TerminalStartResponse {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	response := directTerminalRequest(t, backend, ctx, "/v1/terminals/start", TerminalStartRequest{
		Root: root, Path: root, Argv: []string{"/bin/sh", "-c", "printf secret"},
		Env: map[string]string{"SECRET": "hidden-token"}, Rows: 24, Cols: 80,
		StartNonce: "0123456789abcdef0123456789abcdef",
	})
	if response.Status != 200 {
		t.Fatalf("start: %s", response.Body)
	}
	var result TerminalStartResponse
	if err := json.Unmarshal(response.Body, &result); err != nil || result.PID != 321 || result.ID == "" {
		t.Fatalf("start = %+v, %v", result, err)
	}
	return result
}

func TestDirectTerminalPTYAndOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("direct SSH PTY is POSIX-only")
	}
	fake := &directTerminalFake{}
	backend := newDirectTerminalBackend(directTerminalClient(t, fake))
	root := t.TempDir()
	started := startFakeDirectTerminal(t, backend, root)
	second := startFakeDirectTerminal(t, backend, root)
	if second != started {
		t.Fatalf("start retry returned another terminal: %+v", second)
	}
	conflict := directTerminalRequest(t, backend, context.Background(), "/v1/terminals/start", TerminalStartRequest{
		Root: root, Path: root, Argv: []string{"/bin/sh", "-c", "different"},
		Rows: 24, Cols: 80, StartNonce: "0123456789abcdef0123456789abcdef",
	})
	if conflict.Status != 409 || !strings.Contains(string(conflict.Body), "terminal-start-conflict") {
		t.Fatalf("nonce conflict = %s", conflict.Body)
	}
	fake.mu.Lock()
	if strings.Contains(fake.command, "secret") || strings.Contains(fake.command, root) || strings.Contains(fake.command, "hidden-token") || len(fake.frame) != 9 || fake.frame[0] != root || fake.frame[7] != "SECRET" || fake.frame[8] != "hidden-token" {
		t.Fatalf("SSH exec frame = %q / %q", fake.command, fake.frame)
	}
	fake.mu.Unlock()
	write := directTerminalRequest(t, backend, context.Background(), "/v1/terminals/write", TerminalWriteRequest{Root: root, ID: started.ID, DataBase64: base64.StdEncoding.EncodeToString([]byte("raw\x00data"))})
	if write.Status != 200 {
		t.Fatalf("write: %s", write.Body)
	}
	response := directTerminalRequest(t, backend, context.Background(), "/v1/terminals/read", TerminalReadRequest{Root: root, ID: started.ID, WaitMs: 1000})
	var output TerminalReadResponse
	if err := json.Unmarshal(response.Body, &output); err != nil || len(output.Chunks) == 0 {
		t.Fatalf("read = %+v, %v", output, err)
	}
	var actual []byte
	for attempt := 0; attempt < 2; attempt++ {
		for _, chunk := range output.Chunks {
			decoded, err := base64.StdEncoding.DecodeString(chunk.DataBase64)
			if err != nil {
				t.Fatal(err)
			}
			actual = append(actual, decoded...)
		}
		if strings.Contains(string(actual), "raw\x00data") {
			break
		}
		response = directTerminalRequest(t, backend, context.Background(), "/v1/terminals/read", TerminalReadRequest{Root: root, ID: started.ID, After: output.Cursor, WaitMs: 1000})
		if err := json.Unmarshal(response.Body, &output); err != nil {
			t.Fatal(err)
		}
	}
	if !strings.Contains(string(actual), "raw\x00data") {
		t.Fatalf("raw PTY output = %q", actual)
	}
	resize := directTerminalRequest(t, backend, context.Background(), "/v1/terminals/resize", TerminalResizeRequest{Root: root, ID: started.ID, Cols: 100, Rows: 30})
	if resize.Status != 200 {
		t.Fatalf("resize: %s", resize.Body)
	}
	var size [2]uint32
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		fake.mu.Lock()
		size = fake.resize
		fake.mu.Unlock()
		if size == [2]uint32{100, 30} {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if size != [2]uint32{100, 30} {
		t.Fatalf("resize = %v", size)
	}
	signal := directTerminalRequest(t, backend, context.Background(), "/v1/terminals/signal", TerminalSignalRequest{Root: root, ID: started.ID, Signal: "SIGINT"})
	if signal.Status != 503 {
		t.Fatalf("unverified foreground signal = %s", signal.Body)
	}
	var signals []string
	deadline = time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		fake.mu.Lock()
		signals = append([]string(nil), fake.signals...)
		fake.mu.Unlock()
		if len(signals) > 0 {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if len(signals) == 0 || signals[0] != "INT" {
		t.Fatalf("SSH signals = %v", signals)
	}
	foreground := directTerminalRequest(t, backend, context.Background(), "/v1/terminals/foreground", TerminalForegroundRequest{Root: root, ID: started.ID})
	if foreground.Status != 501 {
		t.Fatalf("foreground = %s", foreground.Body)
	}
	terminate := directTerminalRequest(t, backend, context.Background(), "/v1/terminals/terminate", TerminalTerminateRequest{Root: root, ID: started.ID})
	if terminate.Status != 503 {
		t.Fatalf("terminate = %s", terminate.Body)
	}
	response = directTerminalRequest(t, backend, context.Background(), "/v1/terminals/read", TerminalReadRequest{Root: root, ID: started.ID, WaitMs: 1})
	if err := json.Unmarshal(response.Body, &output); err != nil || !output.Closed || output.ExitCode == nil || *output.ExitCode != 143 {
		t.Fatalf("exit = %+v, %v", output, err)
	}
}

func TestDirectTerminalRefusalAndValidation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("direct SSH PTY is POSIX-only")
	}
	fake := &directTerminalFake{denyPTY: true}
	backend := newDirectTerminalBackend(directTerminalClient(t, fake))
	root := t.TempDir()
	response := directTerminalRequest(t, backend, context.Background(), "/v1/terminals/start", TerminalStartRequest{Root: root, Path: root, Argv: []string{"/bin/sh"}, Rows: 24, Cols: 80, StartNonce: "0123456789abcdef0123456789abcdef"})
	if response.Status != 501 || !strings.Contains(string(response.Body), "pty-unavailable") {
		t.Fatalf("PTY denied = %s", response.Body)
	}
	response = directTerminalRequest(t, backend, context.Background(), "/v1/terminals/start", TerminalStartRequest{Root: root, Path: "../outside", Argv: []string{"/bin/sh"}, Rows: 24, Cols: 80, StartNonce: "0123456789abcdef0123456789abcdef"})
	if response.Status != 403 {
		t.Fatalf("root escape = %s", response.Body)
	}
	response, err := backend.Proxy(context.Background(), "/v1/terminals/read", []byte(`{"root":"/tmp","id":"x","unknown":true}`))
	if err != nil || response.Status != 400 {
		t.Fatalf("invalid JSON = %s, %v", response.Body, err)
	}
	response = directTerminalRequest(t, backend, context.Background(), "/v1/terminals/read", TerminalReadRequest{Root: root, ID: "unowned", WaitMs: 1})
	if response.Status != 404 {
		t.Fatalf("unknown terminal = %s", response.Body)
	}
}

func TestDirectTerminalCancellationAndLimits(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("direct SSH PTY is POSIX-only")
	}
	fake := &directTerminalFake{}
	backend := newDirectTerminalBackend(directTerminalClient(t, fake))
	root := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	body, _ := json.Marshal(TerminalStartRequest{Root: root, Path: root, Argv: []string{"/bin/sh"}, Rows: 24, Cols: 80, StartNonce: "0123456789abcdef0123456789abcdef"})
	if _, err := backend.Proxy(ctx, "/v1/terminals/start", body); err != context.Canceled {
		t.Fatalf("canceled start = %v", err)
	}
	started := startFakeDirectTerminal(t, backend, root)
	response := directTerminalRequest(t, backend, context.Background(), "/v1/terminals/write", TerminalWriteRequest{Root: root, ID: started.ID, DataBase64: base64.StdEncoding.EncodeToString(make([]byte, maxTerminalWriteBytes+1))})
	if response.Status != 413 {
		t.Fatalf("oversize input = %s", response.Body)
	}
	response = directTerminalRequest(t, backend, context.Background(), "/v1/terminals/read", TerminalReadRequest{Root: root, ID: started.ID, After: 1, WaitMs: 1})
	if response.Status != 200 {
		t.Fatalf("poll = %s", response.Body)
	}
	var current TerminalReadResponse
	if err := json.Unmarshal(response.Body, &current); err != nil {
		t.Fatal(err)
	}
	pollCtx, stopPoll := context.WithCancel(context.Background())
	pollDone := make(chan error, 1)
	go func() {
		body, _ := json.Marshal(TerminalReadRequest{Root: root, ID: started.ID, After: current.Cursor, WaitMs: 5000})
		_, err := backend.Proxy(pollCtx, "/v1/terminals/read", body)
		pollDone <- err
	}()
	stopPoll()
	select {
	case err := <-pollDone:
		if err != context.Canceled {
			t.Fatalf("canceled poll = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled poll remained blocked")
	}
	if err := backend.Close(); err == nil {
		t.Fatal("close falsely proved remote tree termination")
	}
}

func TestDirectTerminalNeverSendsSecretsBeforeNoEchoHandshake(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("direct SSH PTY is POSIX-only")
	}
	fake := &directTerminalFake{withholdFrameReady: true}
	backend := newDirectTerminalBackend(directTerminalClient(t, fake))
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Millisecond)
	defer cancel()
	response := directTerminalRequest(t, backend, ctx, "/v1/terminals/start", TerminalStartRequest{
		Root: "/tmp", Path: "/tmp", Argv: []string{"/bin/sh"}, Env: map[string]string{"SECRET": "do-not-echo"},
		Rows: 24, Cols: 80, StartNonce: "0123456789abcdef0123456789abcdef",
	})
	if response.Status != 503 || !strings.Contains(string(response.Body), "terminal-state-unknown") {
		t.Fatalf("missing no-echo handshake = %s", response.Body)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if len(fake.frame) != 0 || strings.Contains(fake.command, "do-not-echo") {
		t.Fatal("startup revealed the secret before no-echo confirmation")
	}
}

func TestDirectTerminalUnknownStartNonceDoesNotLaunchTwice(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("direct SSH PTY is POSIX-only")
	}
	fake := &directTerminalFake{withholdTerminalReady: true, frameReceived: make(chan struct{})}
	frameReceived := fake.frameReceived
	backend := newDirectTerminalBackend(directTerminalClient(t, fake))
	root := t.TempDir()
	request := TerminalStartRequest{
		Root: root, Path: root, Argv: []string{"/bin/sh"}, Env: map[string]string{"SECRET": "do-not-echo"},
		Rows: 24, Cols: 80, StartNonce: "0123456789abcdef0123456789abcdef",
	}
	ctx, cancel := context.WithCancel(t.Context())
	responseReady := make(chan ProxyResponse, 1)
	go func() {
		responseReady <- directTerminalRequest(t, backend, ctx, "/v1/terminals/start", request)
	}()
	select {
	case <-frameReceived:
		cancel()
	case <-time.After(time.Second):
		cancel()
		t.Fatal("SSH fixture never received the startup frame")
	}
	first := <-responseReady
	if first.Status != 503 || !strings.Contains(string(first.Body), "terminal-state-unknown") {
		t.Fatalf("interrupted start = %s", first.Body)
	}
	retry := directTerminalRequest(t, backend, context.Background(), "/v1/terminals/start", request)
	if retry.Status != 503 || string(retry.Body) != string(first.Body) {
		t.Fatalf("same nonce retry = %s, first = %s", retry.Body, first.Body)
	}
	request.Argv = []string{"/bin/true"}
	conflict := directTerminalRequest(t, backend, context.Background(), "/v1/terminals/start", request)
	if conflict.Status != 409 || !strings.Contains(string(conflict.Body), "terminal-start-conflict") {
		t.Fatalf("unknown nonce conflict = %s", conflict.Body)
	}
	fake.mu.Lock()
	count := fake.execCount
	fake.mu.Unlock()
	if count != 1 {
		t.Fatalf("same nonce issued %d SSH exec requests, want one", count)
	}
}

func TestDirectTerminalCloseDuringUnpublishedStartReportsUnknown(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("direct SSH PTY is POSIX-only")
	}
	fake := &directTerminalFake{withholdTerminalReady: true}
	backend := newDirectTerminalBackend(directTerminalClient(t, fake))
	entered := make(chan struct{})
	release := make(chan struct{})
	releaseStart := sync.OnceFunc(func() { close(release) })
	defer releaseStart()
	backend.afterSessionStart = func() {
		close(entered)
		<-release
	}
	root := t.TempDir()
	request := TerminalStartRequest{Root: root, Path: root, Argv: []string{"/bin/sh"}, Rows: 24, Cols: 80, StartNonce: "0123456789abcdef0123456789abcdef"}
	finished := make(chan error, 1)
	go func() {
		_, err := backend.start(context.Background(), request)
		finished <- err
	}()
	select {
	case <-entered:
	case <-time.After(3 * time.Second):
		t.Fatal("SSH terminal Start did not reach the publication barrier")
	}
	if err := backend.Close(); err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("Close falsely confirmed an unpublished remote terminal: %v", err)
	}
	backend.mu.Lock()
	count := len(backend.sessions)
	backend.mu.Unlock()
	if count != 0 {
		t.Fatalf("terminal was published before barrier release: %d", count)
	}
	releaseStart()
	select {
	case err := <-finished:
		var failure *agentFailure
		if !errors.As(err, &failure) || failure.code != "terminal-state-unknown" {
			t.Fatalf("closed start status = %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("closed terminal start did not finish")
	}
	if err := backend.Close(); err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("repeat Close forgot unknown state: %v", err)
	}
	fake.mu.Lock()
	count = fake.execCount
	fake.mu.Unlock()
	if count != 1 {
		t.Fatalf("expected one remote SSH exec, got %d", count)
	}
}

func TestDirectTerminalEnvironmentIsNotInRemoteArgv(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("direct SSH PTY is POSIX-only")
	}
	if strings.Contains(directTerminalScript, "exec env ") || !strings.Contains(directTerminalScript, `export "$_dsh_key=$_dsh_value"`) {
		t.Fatal("bootstrap must export framed environment with a shell builtin before exec")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(ctx, sh, "-c", directTerminalStartCommand())
	terminal, err := pty.Start(command)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = terminal.Close()
		_ = command.Wait()
	}()
	reader := bufio.NewReader(terminal)
	frameReady, err := reader.ReadString('\x1f')
	if err != nil || !strings.Contains(frameReady, directTerminalFrameReady) {
		t.Fatalf("PTY frame handshake = %q, %v", frameReady, err)
	}
	secret := "private' ; $(printf injected)"
	frame := directTerminalFrame("", t.TempDir(), []string{
		"/bin/bash", "-c", `printf 'ENV=%s\n' "$SECRET"; /bin/ps -p "$$" -o command=`,
	}, map[string]string{"SECRET": secret}, []string{"SECRET"})
	if err := writeTerminalAll(terminal, frame); err != nil {
		t.Fatal(err)
	}
	ready, err := reader.ReadString('\x1f')
	if err != nil || !strings.Contains(ready, directTerminalReadyPrefix) {
		t.Fatalf("PTY terminal handshake = %q, %v", ready, err)
	}
	envLine, err := reader.ReadString('\n')
	if err != nil || !strings.Contains(envLine, "ENV="+secret) {
		t.Fatalf("child environment did not preserve its value: %q, %v", envLine, err)
	}
	argvLine, err := reader.ReadString('\n')
	if err != nil || !strings.Contains(argvLine, "/bin/bash -c") || strings.Contains(argvLine, secret) {
		t.Fatalf("child argv disclosed environment value: %q, %v", argvLine, err)
	}
}

func TestDirectTerminalBootstrapPinsStartupSttyBeforeRequestPATH(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX PTY bootstrap")
	}
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Fatal(err)
	}
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Fatal(err)
	}
	stty, err := exec.LookPath("stty")
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	startup := filepath.Join(directory, "startup")
	attacker := filepath.Join(directory, "request")
	if err := os.Mkdir(startup, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(attacker, 0o700); err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(directory, "stty-argv")
	recordingDirectExecutable(t, startup, "stty", stty, log)
	if err := os.WriteFile(filepath.Join(attacker, "stty"), []byte("#!/bin/sh\nexit 93\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(bash, filepath.Join(startup, "bash")); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, sh, "-c", directTerminalStartCommand())
	command.Env = []string{"PATH=" + startup}
	terminal, err := pty.Start(command)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = terminal.Close()
		_ = command.Wait()
	}()
	reader := bufio.NewReader(terminal)
	frameReady, err := reader.ReadString('\x1f')
	if err != nil || !strings.Contains(frameReady, directTerminalFrameReady) {
		t.Fatalf("PTY frame handshake = %q, %v", frameReady, err)
	}
	frame := directTerminalFrame("", directory, []string{bash, "-c", "printf 'request-ready\\n'"}, map[string]string{"PATH": attacker}, []string{"PATH"})
	if err := writeTerminalAll(terminal, frame); err != nil {
		t.Fatal(err)
	}
	ready, err := reader.ReadString('\x1f')
	if err != nil || !strings.Contains(ready, directTerminalReadyPrefix) {
		t.Fatalf("PTY terminal handshake = %q, %v", ready, err)
	}
	output, err := reader.ReadString('\n')
	if err != nil || !strings.Contains(output, "request-ready") {
		t.Fatalf("PTY command output = %q, %v", output, err)
	}
	args, err := os.ReadFile(log)
	if err != nil || string(args) != "stty raw -echo\nstty sane\n" {
		t.Fatalf("trusted stty invocation = %q, %v", args, err)
	}
	if strings.Contains(directTerminalStartCommand(), "/bin/stty") {
		t.Fatal("SSH PTY bootstrap hardcodes stty")
	}
}

func TestDirectTerminalBootstrapFailsClosedWithoutStty(t *testing.T) {
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
	directory := t.TempDir()
	if err := os.Symlink(bash, filepath.Join(directory, "bash")); err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(t.Context(), sh, "-c", directTerminalStartCommand())
	command.Env = []string{"PATH=" + directory}
	output, err := command.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 125 || strings.Contains(string(output), directTerminalFrameReady) {
		t.Fatalf("missing stty must fail before frame: %q, %v", output, err)
	}
}

func TestDirectTerminalOutputRing(t *testing.T) {
	t.Parallel()
	terminal := &directTerminal{notify: make(chan struct{})}
	terminal.append(make([]byte, maxTerminalOutputBytes+terminalReadBufferSize))
	if terminal.outputBytes > maxTerminalOutputBytes || terminal.discarded == 0 {
		t.Fatalf("unbounded PTY ring: bytes=%d discarded=%d", terminal.outputBytes, terminal.discarded)
	}
	terminal.mu.Lock()
	if terminal.chunks[0].Sequence != terminal.discarded+1 {
		t.Fatal("ring cursor did not advance past discarded output")
	}
	terminal.mu.Unlock()
}
