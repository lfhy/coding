package instance

import (
	"os"
	"path/filepath"
	"testing"
	"time"
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

// 已有实例必须消费转发请求，否则第二次启动只会静默退出。
func TestServeForwardsActivation(t *testing.T) {
	path := filepath.Join(os.TempDir(), "coding-instance.sock")
	_ = os.Remove(path)
	lock, primary, err := Acquire([]string{})
	if err != nil || !primary {
		t.Fatalf("Acquire: primary=%v err=%v", primary, err)
	}
	t.Cleanup(lock.Close)

	activated := make(chan struct{}, 1)
	go lock.Serve(func() {
		activated <- struct{}{}
	})

	_, primary, err = Acquire([]string{"activate"})
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
