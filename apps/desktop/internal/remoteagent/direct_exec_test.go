package remoteagent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/deepseek-ai/coding/apps/desktop/internal/sshfixture"
	"golang.org/x/crypto/ssh"
)

func TestDirectExecCommandValidatesAndQuotes(t *testing.T) {
	t.Parallel()
	root := "/tmp/work'; touch /tmp/pwn; #"
	cases := []struct {
		name    string
		request ExecRequest
		status  int
		code    string
	}{
		{name: "outside root", request: ExecRequest{Root: "/tmp/work", Path: "../other", Shell: "bash"}, status: 403, code: "outside-root"},
		{name: "sibling prefix", request: ExecRequest{Root: "/tmp/work", Path: "/tmp/work-other", Shell: "bash"}, status: 403, code: "outside-root"},
		{name: "invalid root", request: ExecRequest{Root: "relative", Path: "here", Shell: "bash"}, status: 400, code: "invalid-path"},
		{name: "relative without root", request: ExecRequest{Path: "here", Shell: "bash"}, status: 400, code: "invalid-path"},
		{name: "unsupported shell", request: ExecRequest{Root: root, Path: root, Shell: "powershell"}, status: 400, code: "unsupported-shell"},
		{name: "negative timeout", request: ExecRequest{Root: root, Path: root, Shell: "bash", TimeoutMs: -1}, status: 400, code: "invalid-timeout"},
		{name: "invalid env name", request: ExecRequest{Root: root, Path: root, Shell: "bash", Env: map[string]string{"BAD-NAME": "value"}}, status: 400, code: "invalid-environment"},
		{name: "nul in command", request: ExecRequest{Root: root, Path: root, Shell: "bash", Command: "echo\x00bad"}, status: 400, code: "invalid-command"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			_, _, err := directExecCommand(tc.request)
			var failure *agentFailure
			if !errors.As(err, &failure) || failure.status != tc.status || failure.code != tc.code {
				t.Fatalf("validation error = %v, want %d %s", err, tc.status, tc.code)
			}
		})
	}
	command, _, err := directExecCommand(ExecRequest{Root: root, Path: root, Shell: "bash", Command: "echo 'literal'", Env: map[string]string{"VALUE": "quote'; touch /tmp/pwn; #"}})
	if err != nil || !strings.HasPrefix(command, "bash -c ") {
		t.Fatalf("quoted command = %q, %v", command, err)
	}
}

func TestProxyDirectExec(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake SSH command server requires POSIX shell")
	}
	client := directExecSSHClient(t, nil)
	root := t.TempDir()
	workspace := filepath.Join(root, "workspace';touch pwn;#")
	if err := os.Mkdir(workspace, 0o700); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	request := ExecRequest{
		Root: root, Path: workspace, Shell: "bash",
		Command: "printf '%s|%s|%s' \"$PWD\" \"$VALUE\" \"$(cat)\"; printf 'warning' >&2; exit 17",
		Env:     map[string]string{"VALUE": "'$(touch pwn); echo unsafe"}, Stdin: "stdin-value",
	}
	response := directExecRequest(t, client, request)
	if response.Status != 200 {
		t.Fatalf("response = %#v", response)
	}
	var result ExecResponse
	if err := json.Unmarshal(response.Body, &result); err != nil {
		t.Fatal(err)
	}
	if result.ExitCode == nil || *result.ExitCode != 17 || result.Signal != "" || result.TimedOut ||
		result.Stdout != workspace+"|'$(touch pwn); echo unsafe|stdin-value" || result.Stderr != "warning" {
		t.Fatalf("exec result = %#v", result)
	}
	if _, err := os.Stat(filepath.Join(workspace, "pwn")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("shell injection created file: %v", err)
	}
	response = directExecRequest(t, client, ExecRequest{Root: "/", Path: workspace, Shell: "bash", Command: "printf 'ok'", Env: map[string]string{"PATH": "/nonexistent"}})
	result = ExecResponse{}
	if err := json.Unmarshal(response.Body, &result); err != nil || result.ExitCode == nil || *result.ExitCode != 0 || result.Stdout != "ok" {
		t.Fatalf("root directory and explicit PATH result = %#v, %v", result, err)
	}

	response = directExecRequest(t, client, ExecRequest{Root: root, Path: "escape", Shell: "bash", Command: "touch escaped"})
	if err := json.Unmarshal(response.Body, &result); err != nil {
		t.Fatal(err)
	}
	if result.ExitCode == nil || *result.ExitCode != 125 || result.TimedOut || !strings.Contains(result.Stderr, "outside root") {
		t.Fatalf("symlink escape result = %#v", result)
	}
	if _, err := os.Stat(filepath.Join(outside, "escaped")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("symlink escaped root: %v", err)
	}

	response = directExecRequest(t, client, ExecRequest{Root: root, Path: root, Shell: "bash", Command: "head -c 1100000 /dev/zero | tr '\\000' x; head -c 1100000 /dev/zero | tr '\\000' y >&2"})
	if err := json.Unmarshal(response.Body, &result); err != nil {
		t.Fatal(err)
	}
	if result.ExitCode == nil || *result.ExitCode != 0 || !result.StdoutTruncated || !result.StderrTruncated ||
		len(result.Stdout) != maxOutputBytes || len(result.Stderr) != maxOutputBytes {
		t.Fatalf("bounded result: exit=%v stdout=%d stderr=%d truncated=%v,%v", result.ExitCode, len(result.Stdout), len(result.Stderr), result.StdoutTruncated, result.StderrTruncated)
	}
}

func TestProxyDirectExecTimeoutAndCancellation(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake SSH command server requires POSIX shell")
	}
	client := directExecSSHClient(t, nil)
	root := t.TempDir()
	request := ExecRequest{Root: root, Path: root, Shell: "bash", Command: "while :; do :; done", TimeoutMs: 25}
	response := directExecRequest(t, client, request)
	var result ExecResponse
	if err := json.Unmarshal(response.Body, &result); err != nil {
		t.Fatal(err)
	}
	if !result.TimedOut || result.ExitCode != nil || result.Signal != "" {
		t.Fatalf("timeout asserted unobserved remote exit: %#v", result)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	body, _ := json.Marshal(request)
	if _, err := proxyDirectExec(ctx, client, body); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled request = %v", err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	finished := make(chan error, 1)
	request.TimeoutMs = 1000
	body, _ = json.Marshal(request)
	go func() {
		_, err := proxyDirectExec(ctx, client, body)
		finished <- err
	}()
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case err := <-finished:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("in-flight canceled request = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("in-flight cancellation did not close the SSH session")
	}
}

func TestProxyDirectExecRejectsInvalidJSON(t *testing.T) {
	t.Parallel()
	for _, body := range []string{`{`, `{ "path": "/", "shell": "bash", "unexpected": true }`, `{} {}`} {
		t.Run(body, func(t *testing.T) {
			t.Parallel()
			response, err := proxyDirectExec(context.Background(), nil, []byte(body))
			if err != nil || response.Status != 400 {
				t.Fatalf("invalid JSON result = %#v, %v", response, err)
			}
			var wrapped struct {
				Error AgentError `json:"error"`
			}
			if err := json.Unmarshal(response.Body, &wrapped); err != nil || wrapped.Error.Code != "invalid-json" {
				t.Fatalf("invalid JSON error = %#v, %v", wrapped, err)
			}
		})
	}
}

func TestProxyDirectExecKeepsSecretsOutOfSSHCommand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake SSH command server requires POSIX shell")
	}
	commands := make(chan string, 1)
	client := directExecSSHClient(t, func(command string) { commands <- command })
	secret := "api-key-should-never-appear-in-ssh-exec-command"
	commandSecret := "command-secret-should-not-be-in-process-argv"
	root := t.TempDir()
	response := directExecRequest(t, client, ExecRequest{
		Root: root, Path: root, Shell: "bash", Command: ": '" + commandSecret + "'; printf 'ok'",
		Env: map[string]string{"DEEPSEEK_API_KEY": secret},
	})
	var result ExecResponse
	if err := json.Unmarshal(response.Body, &result); err != nil || result.ExitCode == nil || *result.ExitCode != 0 || result.Stdout != "ok" {
		t.Fatalf("secret-bearing request = %#v, %v", result, err)
	}
	if command := <-commands; strings.Contains(command, secret) || strings.Contains(command, commandSecret) || strings.Contains(command, root) || strings.Contains(command, "DEEPSEEK_API_KEY") {
		t.Fatalf("SSH exec command exposed request fields: %q", command)
	}
	_, _, err := directExecCommand(ExecRequest{Root: root, Path: root, Shell: "bash", Env: map[string]string{"INVALID-NAME": secret}})
	if err == nil || strings.Contains(err.Error(), secret) {
		t.Fatalf("validation error exposed secret: %v", err)
	}
}

func directExecSSHClient(t *testing.T, capture func(string)) *ssh.Client {
	t.Helper()
	fixture, err := sshfixture.StartWithHooks(sshfixture.Hooks{
		Authenticate: func(string, []byte) bool { return true },
		Session: func(channel ssh.Channel, requests <-chan *ssh.Request) {
			serveDirectExecTestSession(channel, requests, capture)
		},
		Forward: func(channel ssh.Channel) { _ = channel.Close() },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(fixture.Close)
	client, err := ssh.Dial("tcp", net.JoinHostPort(fixture.Host, fmt.Sprint(fixture.Port)), &ssh.ClientConfig{
		User: fixture.Username, Auth: []ssh.AuthMethod{ssh.Password(fixture.Password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func serveDirectExecTestSession(channel ssh.Channel, requests <-chan *ssh.Request, capture func(string)) {
	defer channel.Close()
	for request := range requests {
		if request.Type != "exec" {
			_ = request.Reply(false, nil)
			continue
		}
		var payload struct{ Command string }
		if ssh.Unmarshal(request.Payload, &payload) != nil {
			_ = request.Reply(false, nil)
			return
		}
		if capture != nil {
			capture(payload.Command)
		}
		ctx, cancel := context.WithCancel(context.Background())
		cmd := exec.CommandContext(ctx, "/bin/sh", "-c", payload.Command)
		cmd.Stdin = channel
		cmd.Stdout = channel
		cmd.Stderr = channel.Stderr()
		if err := cmd.Start(); err != nil {
			cancel()
			_ = request.Reply(false, nil)
			return
		}
		_ = request.Reply(true, nil)
		settled := make(chan struct{})
		go func() {
			select {
			case <-requests:
				cancel()
			case <-settled:
			}
		}()
		err := cmd.Wait()
		close(settled)
		cancel()
		code := uint32(0)
		if err != nil {
			code = uint32(cmd.ProcessState.ExitCode())
		}
		_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{code}))
		return
	}
}

func directExecRequest(t *testing.T, client *ssh.Client, request ExecRequest) ProxyResponse {
	t.Helper()
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	response, err := proxyDirectExec(context.Background(), client, body)
	if err != nil {
		t.Fatal(err)
	}
	return response
}
