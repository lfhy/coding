package instance

import (
	"os"
	"path/filepath"
	"testing"
)

// 第二个实例应转发失败后接管残留 socket，说明清理逻辑可达。
func TestAcquireTakesOverStaleSocket(t *testing.T) {
	path := filepath.Join(os.TempDir(), "coding-instance.sock")
	_ = os.Remove(path)
	// 写一个既不是有效 socket 也无人监听的文件，模拟持锁进程崩溃残留。
	if err := os.WriteFile(path, []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	lock, primary, err := Acquire([]string{})
	if err != nil {
		t.Fatalf("Acquire: %v", err)
	}
	if !primary {
		t.Fatalf("expected to take over stale socket")
	}
	lock.Close()
	// Close 后再次获得应仍为主实例。
	again, primary, err := Acquire([]string{})
	if err != nil || !primary {
		t.Fatalf("re-acquire after Close: primary=%v err=%v", primary, err)
	}
	again.Close()
}
