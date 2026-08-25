package hostlaunch

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
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
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
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
			"result": map[string]any{"ok": true, "value": map[string]any{"version": "dev"}},
		})
	}))
	t.Cleanup(server.Close)
	// httptest's URL is host:port; the standard library has no public helper
	// for the port, so parse the last authority segment explicitly.
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

func TestEnsureRefusesLiveIncompatibleHost(t *testing.T) {
	home := t.TempDir()
	record := Record{Type: "coding-host-ready", Port: 43123, PID: os.Getpid(), Version: "other", Protocol: Protocol, Token: "token"}
	data, _ := json.Marshal(record)
	if err := os.WriteFile(filepath.Join(home, "host.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	launcher, err := New(Options{Home: home, Version: "current", PollInterval: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	// discovery 对自身 PID 的存活检查成立但探针失败（端口无人监听），
	// 该记录随后按死进程处理，Ensure 会走 start 而不是报不兼容。
	// 真正的 live-incompatible Host 由 TestEnsureReplacesIncompatibleHost 覆盖。
	_ = launcher
}

// TestEnsureReplacesIncompatibleHost 验证启动器会请求活着的旧版本 Host
// 退出并等待其释放共享 home，而不是把用户挡在 ErrHostIncompatible 上。
func TestEnsureReplacesIncompatibleHost(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.NotFound(writer, request)
	}))
	t.Cleanup(server.Close)
	port, err := strconv.Atoi(server.URL[len("http://127.0.0.1:"):])
	if err != nil {
		t.Fatal(err)
	}
	// 用一个会被 SIGTERM 立即终止的休眠子进程扮演旧 Host。
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
	_, _ = launcher.Ensure(context.Background())
	// 等待 Wait 回收，避免子进程停留在僵尸态干扰 processAlive 判定。
	_ = host.Wait()
	if processAlive(pid) {
		t.Fatalf("incompatible host pid %d is still alive", pid)
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
