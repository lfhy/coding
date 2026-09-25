package remoteagent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"testing"
	"time"

	"github.com/deepseek-ai/coding/apps/desktop/internal/sshfixture"
)

func TestManagerBasicCodeBashBindingRunsThroughSSH(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("loopback SSH Bash fixture requires a POSIX host")
	}
	server, err := sshfixture.StartWithoutForwarding()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	localWorkspace := t.TempDir()
	filename := filepath.Base(t.TempDir()) + "-code-bash.txt"
	localFile := filepath.Join(localWorkspace, filename)
	remoteFile := filepath.Join(server.RemoteRoot, filename)
	deployedAgent := filepath.Join(server.RemoteRoot, ".coding")
	knownHostsDir := t.TempDir()
	if err := os.Chmod(knownHostsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	var assetCalls atomic.Int32
	manager, err := NewManager(ManagerOptions{
		KnownHostsPath: filepath.Join(knownHostsDir, "known_hosts"),
		AgentPathFor: func(platform RemotePlatform) (string, error) {
			assetCalls.Add(1)
			if platform != (RemotePlatform{OS: runtime.GOOS, Arch: runtime.GOARCH}) {
				return "", fmt.Errorf("isolate requested for %s/%s, want local platform", platform.OS, platform.Arch)
			}
			return os.Executable()
		},
		ConnectTimeout: time.Second, StartupTimeout: 2 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	request := ConnectRequest{
		Mode: ModeBasic, Host: server.Host, Port: server.Port, User: server.Username,
		Auth: SSHAuth{Password: server.Password},
	}
	_, err = manager.Connect(ctx, request)
	var unknown *ErrUnknownHostKey
	if !errors.As(err, &unknown) || unknown.ConfirmationID == "" || unknown.Fingerprint == "" {
		t.Fatalf("first connection must require host key confirmation: %v", err)
	}
	info, err := manager.ConfirmHostKey(ctx, unknown.ConfirmationID, request, unknown.Fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := manager.Close(context.Background(), info.ID); err != nil {
			t.Errorf("close basic connection: %v", err)
		}
	})
	if info.Mode != ModeBasic || info.RemoteHome != server.RemoteRoot || info.RemoteInstallDir != "" || assetCalls.Load() != 0 {
		t.Fatalf("basic connection = %+v; premature isolate asset calls = %d", info, assetCalls.Load())
	}
	if _, err := os.Stat(deployedAgent); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("basic connection deployed an agent: %v", err)
	}

	// Code 仅在本机隔离；binding 的回包必须来自这个禁用端口转发的 SSH 服务。
	command := fmt.Sprintf("printf 'ssh-only' > %q; pwd; cat %q", filename, filename)
	program := fmt.Sprintf("const result = await tools.bash({ command: %q, timeout: 1000 }); return result;", command)
	proxy := func(route string, request any, result any) {
		t.Helper()
		body, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		response, err := manager.Proxy(ctx, info.ID, http.MethodPost, route, body)
		if err != nil || response.Status != http.StatusOK {
			t.Fatalf("%s response = %+v, %v", route, response, err)
		}
		if err := json.Unmarshal(response.Body, result); err != nil {
			t.Fatalf("decode %s response: %v", route, err)
		}
	}
	var started CodeRunStartResponse
	proxy("/v1/code/start", CodeRunStartRequest{
		Root: server.RemoteRoot, Program: program,
		Bindings:  []CodeBindingNamespace{{Global: "tools", Names: []string{"bash"}}},
		ComputeMs: 1_000, MemoryLimitBytes: defaultCodeMemoryLimitBytes,
		StartNonce: "30000000000000000000000000000001",
	}, &started)
	if started.ID == "" || assetCalls.Load() != 1 {
		t.Fatalf("code session = %#v; isolate asset calls = %d", started, assetCalls.Load())
	}
	var first CodeRunNextResponse
	proxy("/v1/code/next", CodeRunNextRequest{Root: server.RemoteRoot, ID: started.ID, WaitMs: 5_000}, &first)
	if first.Done || len(first.Events) != 1 || first.Events[0].Type != "tool_call" {
		t.Fatalf("bash binding events = %#v", first)
	}
	call := first.Events[0]
	if call.Global != "tools" || call.Name != "bash" || call.CallID == 0 {
		t.Fatalf("bash binding = %#v", call)
	}
	var arguments struct {
		Command string `json:"command"`
		Timeout int    `json:"timeout"`
	}
	if err := json.Unmarshal(call.Arguments, &arguments); err != nil || arguments.Command != command || arguments.Timeout != 1_000 {
		t.Fatalf("bash arguments = %s, %v", call.Arguments, err)
	}
	var executed ExecResponse
	proxy("/v1/exec", ExecRequest{
		Root: server.RemoteRoot, Path: server.RemoteRoot, Shell: "bash",
		Command: arguments.Command, TimeoutMs: arguments.Timeout,
	}, &executed)
	if executed.ExitCode == nil || *executed.ExitCode != 0 || executed.TimedOut || executed.Stderr != "" ||
		executed.Stdout != server.RemoteRoot+"\nssh-only" {
		t.Fatalf("remote Bash result = %#v", executed)
	}
	remoteContent, err := os.ReadFile(remoteFile)
	if err != nil || string(remoteContent) != "ssh-only" {
		t.Fatalf("remote output file = %q, %v", remoteContent, err)
	}
	var acknowledged map[string]any
	value, err := json.Marshal(executed)
	if err != nil {
		t.Fatal(err)
	}
	proxy("/v1/code/reply", CodeRunReplyRequest{
		Root: server.RemoteRoot, ID: started.ID, CallID: call.CallID, OK: true, Value: value,
	}, &acknowledged)
	var finished CodeRunNextResponse
	proxy("/v1/code/next", CodeRunNextRequest{
		Root: server.RemoteRoot, ID: started.ID, After: first.Cursor, WaitMs: 5_000,
	}, &finished)
	if !finished.Done || len(finished.Events) != 1 || finished.Events[0].Type != "done" || finished.Events[0].Error != nil {
		t.Fatalf("code completion = %#v", finished)
	}
	var returned ExecResponse
	if err := json.Unmarshal(finished.Events[0].Value, &returned); err != nil ||
		returned.ExitCode == nil || *returned.ExitCode != 0 || returned.Stdout != executed.Stdout {
		t.Fatalf("code result = %s, %v", finished.Events[0].Value, err)
	}
	if assetCalls.Load() != 1 {
		t.Fatalf("isolate asset requested more than once: %d", assetCalls.Load())
	}
	if _, err := os.Stat(localFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("local workspace was modified: %v", err)
	}
	if _, err := os.Stat(deployedAgent); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("basic Code deployed a remote agent: %v", err)
	}
}
