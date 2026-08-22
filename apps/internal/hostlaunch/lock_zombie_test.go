package hostlaunch

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestAcquireLockReclaimsZombieOwner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host.lock")
	// 写入一个必然不存在的 PID，模拟崩溃后残留的启动锁。
	deadPID := 1
	for processAlive(deadPID) && deadPID < 1_000_000 {
		deadPID++
	}
	if err := os.WriteFile(path, []byte(strconv.Itoa(deadPID)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	lock, err := acquireLock(context.Background(), path, 50*time.Millisecond, time.Millisecond)
	if err != nil {
		t.Fatalf("expected zombie lock to be reclaimed, got %v", err)
	}
	t.Cleanup(func() { _ = lock.Close() })
	if owner := readLockOwner(path); owner != os.Getpid() {
		t.Fatalf("expected lock owner %d after reclaim, got %d", os.Getpid(), owner)
	}
}
