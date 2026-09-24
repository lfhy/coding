package instance

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestLockPathSeparatesDevelopment(t *testing.T) {
	setSocketTemp(t)
	production, err := lockPath(false)
	if err != nil {
		t.Fatal(err)
	}
	development, err := lockPath(true)
	if err != nil {
		t.Fatal(err)
	}
	if production == development {
		t.Fatalf("development and production share lock path %q", production)
	}
}

// 第二个实例应转发失败后接管残留 socket，说明清理逻辑可达。
func TestAcquireTakesOverStaleSocket(t *testing.T) {
	setSocketTemp(t)
	path, err := lockPath(false)
	if err != nil {
		t.Fatal(err)
	}
	// 写一个既不是有效 socket 也无人监听的文件，模拟持锁进程崩溃残留。
	if err := os.WriteFile(path, []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	lock, primary, err := Acquire([]string{}, false)
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	if !primary {
		t.Fatalf("expected to take over stale socket")
	}
	lock.Close()
	// Close 后再次获得应仍为主实例。
	again, primary, err := Acquire([]string{}, false)
	if err != nil || !primary {
		t.Fatalf("re-acquire after Close: primary=%v err=%v", primary, err)
	}
	again.Close()
}

// 已有实例必须消费转发请求，否则第二次启动只会静默退出。
func TestServeForwardsActivation(t *testing.T) {
	setSocketTemp(t)
	lock, primary, err := Acquire([]string{}, false)
	if err != nil || !primary {
		t.Fatalf("Acquire: primary=%v err=%v", primary, err)
	}
	t.Cleanup(lock.Close)

	activated := make(chan struct{}, 1)
	go lock.Serve(func() {
		activated <- struct{}{}
	})

	_, primary, err = Acquire([]string{"activate"}, false)
	if err != nil {
		t.Fatalf("second Acquire: %v", err)
	}
	if primary {
		t.Fatal("second instance must forward activation")
	}

	select {
	case <-activated:
	case <-time.After(time.Second):
		t.Fatal("activation was not delivered to the primary instance")
	}
}

func TestDevelopmentAndProductionAcquireDistinctLocks(t *testing.T) {
	setSocketTemp(t)
	production, primary, err := Acquire([]string{}, false)
	if err != nil || !primary {
		t.Fatalf("production Acquire: primary=%v err=%v", primary, err)
	}
	t.Cleanup(production.Close)
	development, primary, err := Acquire([]string{}, true)
	if err != nil || !primary {
		t.Fatalf("development Acquire: primary=%v err=%v", primary, err)
	}
	t.Cleanup(development.Close)
	if production.socket == development.socket {
		t.Fatalf("development and production share socket %q", production.socket)
	}
}

func TestAcquireCreatesWindowsLockDirectory(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows profile layout only")
	}
	localAppData, err := os.MkdirTemp("", "ci-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(localAppData) })
	t.Setenv("LOCALAPPDATA", localAppData)
	lock, primary, err := Acquire([]string{}, true)
	if err != nil || !primary {
		t.Fatalf("Acquire with clean LOCALAPPDATA: primary=%v err=%v", primary, err)
	}
	t.Cleanup(lock.Close)
	if info, err := os.Stat(filepath.Join(localAppData, "Coding")); err != nil || !info.IsDir() {
		t.Fatalf("Coding lock directory: info=%v err=%v", info, err)
	}
}

// Unix socket 路径有长度上限，Windows 上过长的 t.TempDir 使用短名替代。
func setSocketTemp(t *testing.T) {
	t.Helper()
	directory, err := os.MkdirTemp("", "ci-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(directory) })
	t.Setenv("TMPDIR", directory)
	localAppData := t.TempDir()
	if runtime.GOOS == "windows" && len(filepath.Join(localAppData, "Coding", "dev-instance.lock")) >= 100 {
		localAppData, err = os.MkdirTemp("", "ci-")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(localAppData) })
	}
	t.Setenv("LOCALAPPDATA", localAppData)
	if err := os.MkdirAll(filepath.Join(localAppData, "Coding"), 0o700); err != nil {
		t.Fatal(err)
	}
}
