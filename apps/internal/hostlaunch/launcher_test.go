package hostlaunch

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// sleepBinary 返回当前平台的休眠命令二进制。
func sleepBinary() string {
	if runtime.GOOS == "windows" {
		return "ping"
	}
	return "sleep"
}

func TestEnsureAttachesToCompatibleHost(t *testing.T) {
	server := httptest.NewServer(hostDescribeHandler("dev", "token"))
	t.Cleanup(server.Close)
	// httptest 的 URL 固定使用 host:port，标准库没有公开端口辅助函数，故直接
	// 解析已知的回环地址前缀。
	port, err := strconv.Atoi(server.URL[len("http://127.0.0.1:"):])
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	record := Record{Type: "coding-host-ready", Port: port, PID: os.Getpid(), Version: "dev", Protocol: Protocol, Token: "token"}
	data, _ := json.Marshal(record)
	if err := os.WriteFile(filepath.Join(home, "host.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	launcher, err := New(Options{Home: home, Version: "dev", PollInterval: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := launcher.Ensure(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if endpoint.Started || endpoint.Record != record || endpoint.BaseURL != "http://127.0.0.1:"+strconv.Itoa(port) {
		t.Fatalf("unexpected endpoint: %#v", endpoint)
	}
}

// TestEnsureReplacesVerifiedIncompatibleHost 验证启动器只在 API 回显同一记录的
// 所有权 token 后，才会停止活着的旧版本 Host 并等待其释放共享 home。
func TestEnsureReplacesVerifiedIncompatibleHost(t *testing.T) {
	server := httptest.NewServer(hostDescribeHandler("other", "token"))
	t.Cleanup(server.Close)
	port, err := strconv.Atoi(server.URL[len("http://127.0.0.1:"):])
	if err != nil {
		t.Fatal(err)
	}
	// 用一个会被 SIGTERM 立即终止的休眠子进程扮演已通过端口探针的旧 Host。
	host := execSleepProcess(t)
	pid := host.Process.Pid
	home := t.TempDir()
	record := Record{Type: "coding-host-ready", Port: port, PID: pid, Version: "other", Protocol: Protocol, Token: "token"}
	data, _ := json.Marshal(record)
	if err := os.WriteFile(filepath.Join(home, "host.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	launcher, err := New(Options{Home: home, Version: "current", PollInterval: 5 * time.Millisecond, Command: []string{"false"}})
	if err != nil {
		t.Fatal(err)
	}
	hostDone := make(chan error, 1)
	go func() { hostDone <- host.Wait() }()
	_, _ = launcher.Ensure(context.Background())
	// 等待 Wait 回收，避免子进程停留在僵尸态干扰 processAlive 判定。
	_ = <-hostDone
	if processAlive(pid) {
		t.Fatalf("incompatible host pid %d is still alive", pid)
	}
}

func TestEnsureDoesNotTerminateUnverifiedLivePID(t *testing.T) {
	host := execSleepProcess(t)
	home := t.TempDir()
	record := Record{Type: "coding-host-ready", Port: 43123, PID: host.Process.Pid, Version: "current", Protocol: Protocol, Token: "token"}
	data, _ := json.Marshal(record)
	if err := os.WriteFile(filepath.Join(home, "host.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	launcher, err := New(Options{Home: home, Version: "current", PollInterval: time.Millisecond, Command: []string{"false"}, ReplaceCompatibleHost: true})
	if err != nil {
		t.Fatal(err)
	}
	_, err = launcher.Ensure(context.Background())
	if !errors.Is(err, ErrHostNotReplaceable) {
		t.Fatalf("Ensure error = %v, want %v", err, ErrHostNotReplaceable)
	}
	if !processAlive(host.Process.Pid) {
		t.Fatal("unverified live PID was terminated")
	}
}

func TestEnsureDoesNotTerminateLivePIDWithMismatchedHostRecordToken(t *testing.T) {
	server := httptest.NewServer(hostDescribeHandler("current", "different-token"))
	t.Cleanup(server.Close)
	port, err := strconv.Atoi(server.URL[len("http://127.0.0.1:"):])
	if err != nil {
		t.Fatal(err)
	}
	host := execSleepProcess(t)
	home := t.TempDir()
	record := Record{Type: "coding-host-ready", Port: port, PID: host.Process.Pid, Version: "current", Protocol: Protocol, Token: "token"}
	data, _ := json.Marshal(record)
	if err := os.WriteFile(filepath.Join(home, "host.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	launcher, err := New(Options{Home: home, Version: "current", PollInterval: time.Millisecond, Command: []string{"false"}, ReplaceCompatibleHost: true})
	if err != nil {
		t.Fatal(err)
	}
	_, err = launcher.Ensure(context.Background())
	if !errors.Is(err, ErrHostNotReplaceable) {
		t.Fatalf("Ensure error = %v, want %v", err, ErrHostNotReplaceable)
	}
	if !processAlive(host.Process.Pid) {
		t.Fatal("PID with a mismatched Host record token was terminated")
	}
}

func TestEnsureDoesNotStartBesideResponsiveHostWithStalePID(t *testing.T) {
	server := httptest.NewServer(hostDescribeHandler("current", "token"))
	t.Cleanup(server.Close)
	port, err := strconv.Atoi(server.URL[len("http://127.0.0.1:"):])
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	record := Record{Type: "coding-host-ready", Port: port, PID: 999_999_999, Version: "current", Protocol: Protocol, Token: "token"}
	data, _ := json.Marshal(record)
	if err := os.WriteFile(filepath.Join(home, "host.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	launcher, err := New(Options{Home: home, Version: "current", PollInterval: time.Millisecond, Command: []string{"false"}, ReplaceCompatibleHost: true})
	if err != nil {
		t.Fatal(err)
	}
	_, err = launcher.Ensure(context.Background())
	if !errors.Is(err, ErrHostNotReplaceable) {
		t.Fatalf("Ensure error = %v, want %v", err, ErrHostNotReplaceable)
	}
}

func TestEnsureReplacesCompatibleHostForEphemeralEnvironment(t *testing.T) {
	server := httptest.NewServer(hostDescribeHandler("current", "token"))
	t.Cleanup(server.Close)
	port, err := strconv.Atoi(server.URL[len("http://127.0.0.1:"):])
	if err != nil {
		t.Fatal(err)
	}
	host := execSleepProcess(t)
	pid := host.Process.Pid
	home := t.TempDir()
	record := Record{Type: "coding-host-ready", Port: port, PID: pid, Version: "current", Protocol: Protocol, Token: "token"}
	data, _ := json.Marshal(record)
	if err := os.WriteFile(filepath.Join(home, "host.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	launcher, err := New(Options{
		Home: home, Version: "current", PollInterval: 5 * time.Millisecond, Command: []string{"false"},
		Environment: map[string]string{"DSH_REMOTE_BRIDGE_TOKEN": "window-token"}, ReplaceCompatibleHost: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	hostDone := make(chan error, 1)
	go func() { hostDone <- host.Wait() }()
	_, _ = launcher.Ensure(context.Background())
	_ = <-hostDone
	if processAlive(pid) {
		t.Fatalf("compatible host pid %d is still alive", pid)
	}
}

func TestEnsureDoesNotReplaceUntilPreviousCompatibleHostExits(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows terminates a process without a TERM-ignore equivalent")
	}
	server := httptest.NewServer(hostDescribeHandler("current", "token"))
	t.Cleanup(server.Close)
	port, err := strconv.Atoi(server.URL[len("http://127.0.0.1:"):])
	if err != nil {
		t.Fatal(err)
	}
	host := execIgnoringTERMProcess(t)
	home := t.TempDir()
	record := Record{Type: "coding-host-ready", Port: port, PID: host.Process.Pid, Version: "current", Protocol: Protocol, Token: "token"}
	data, _ := json.Marshal(record)
	if err := os.WriteFile(filepath.Join(home, "host.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	previousTicks := hostExitWaitTicks
	hostExitWaitTicks = 1
	t.Cleanup(func() { hostExitWaitTicks = previousTicks })
	launcher, err := New(Options{
		Home: home, Version: "current", PollInterval: time.Millisecond, Command: []string{"false"}, ReplaceCompatibleHost: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = launcher.Ensure(context.Background())
	if !errors.Is(err, ErrHostNotReplaceable) {
		t.Fatalf("Ensure error = %v, want %v", err, ErrHostNotReplaceable)
	}
	if !processAlive(host.Process.Pid) {
		t.Fatal("previous Host exited despite ignoring TERM")
	}
}

// execSleepProcess 启动一个会被 SIGTERM 终止的子进程；未调用 Wait 时进程
// 可能停留在僵尸态，调用方负责在断言前 Wait 回收。
func execSleepProcess(t *testing.T) *exec.Cmd {
	t.Helper()
	command := exec.Command(sleepBinary())
	if runtime.GOOS == "windows" {
		command.Args = append(command.Args, "-n", "30", "127.0.0.1")
	} else {
		command.Args = append(command.Args, "30")
	}
	if err := command.Start(); err != nil {
		t.Fatalf("start sleep process: %v", err)
	}
	t.Cleanup(func() { _ = command.Process.Kill(); _ = command.Wait() })
	return command
}

// execIgnoringTERMProcess 启动一个忽略 SIGTERM 的 Unix 子进程，覆盖旧 Host
// 已失去响应却仍存活时不能抢先启动新 Host 的替换路径。
func execIgnoringTERMProcess(t *testing.T) *exec.Cmd {
	t.Helper()
	command := exec.Command("sh", "-c", `trap '' TERM; printf ready; while :; do sleep 1; done`)
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	ready := make([]byte, len("ready"))
	if _, err := io.ReadFull(stdout, ready); err != nil || string(ready) != "ready" {
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatalf("start TERM-ignoring process: ready = %q, error = %v", ready, err)
	}
	t.Cleanup(func() { _ = command.Process.Kill(); _ = command.Wait() })
	return command
}

func hostDescribeHandler(version, token string) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/api/host.describe" {
			http.NotFound(writer, request)
			return
		}
		var message map[string]any
		if err := json.NewDecoder(request.Body).Decode(&message); err != nil || message["method"] != "host.describe" {
			http.Error(writer, "bad request", http.StatusBadRequest)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"type": "server-response", "rpcId": message["rpcId"],
			"result": map[string]any{"ok": true, "value": map[string]any{
				"version": version, "managedHostToken": token,
			}},
		})
	}
}

func TestAcquireLockTimesOutWithoutRemovingOwner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host.lock")
	owner, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	_, err = acquireLock(context.Background(), path, 5*time.Millisecond, time.Millisecond)
	if err == nil {
		t.Fatal("expected lock timeout")
	}
	if _, statErr := os.Stat(path); statErr != nil {
		t.Fatalf("owner lock was removed: %v", statErr)
	}
}

func TestCommandUsesPreexpandedPackagedRuntime(t *testing.T) {
	root := t.TempDir()
	executable := filepath.Join(root, runtimeHostExecutableName())
	if err := os.WriteFile(executable, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	entry := packagedHostEntry(root)
	if err := os.MkdirAll(filepath.Dir(entry), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(entry, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	launcher, err := New(Options{RuntimeRoot: root})
	if err != nil {
		t.Fatal(err)
	}
	command, err := launcher.command()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{executable, entry, "web", "--coding-host"}
	if !slices.Equal(command, want) {
		t.Fatalf("command = %#v, want %#v", command, want)
	}
}

func TestCommandRejectsPackagedRuntimeWithoutEntry(t *testing.T) {
	root := t.TempDir()
	executable := filepath.Join(root, runtimeHostExecutableName())
	if err := os.WriteFile(executable, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	launcher, err := New(Options{RuntimeRoot: root})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := launcher.command(); err == nil {
		t.Fatal("expected missing packaged Host entry error")
	}
}

func TestChildEnvironmentKeepsLauncherOwnership(t *testing.T) {
	t.Setenv("DSH_HOME", "parent-home")
	launcher, err := New(Options{
		Home: "/tmp/home", CWD: "/tmp/workspace", Version: "test",
		Environment: map[string]string{
			"DSH_HOME": "must-not-win", "DSH_REMOTE_BRIDGE_TOKEN": "window-token",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	values := make(map[string]string)
	homeEntries := 0
	for _, entry := range launcher.childEnvironment() {
		key, value, _ := strings.Cut(entry, "=")
		values[key] = value
		if environmentKey(key) == environmentKey("DSH_HOME") {
			homeEntries++
		}
	}
	if values["DSH_HOME"] != "/tmp/home" || values["DSH_CWD"] != "/tmp/workspace" || values["DSH_APP_VERSION"] != "test" {
		t.Fatalf("launcher variables = %#v", values)
	}
	if values["DSH_REMOTE_BRIDGE_TOKEN"] != "window-token" {
		t.Fatalf("remote bridge token was not forwarded: %#v", values)
	}
	if homeEntries != 1 {
		t.Fatalf("DSH_HOME entries = %d, want 1", homeEntries)
	}
}

func TestNewRejectsInvalidEnvironment(t *testing.T) {
	if _, err := New(Options{Environment: map[string]string{"BAD=KEY": "value"}}); err == nil {
		t.Fatal("expected invalid environment key to be rejected")
	}
}
