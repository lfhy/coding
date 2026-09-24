// Package instance 实现 Coding 桌面端的跨平台单实例行为。
package instance

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
)

// Listener 是已获得的单实例锁：持锁进程提供激活服务，未持锁进程退出。
type Listener struct {
	listener net.Listener
	socket   string
}

// lockPath 返回平台对应的 Unix socket 路径；Windows 放在 LOCALAPPDATA/Coding，
// macOS 和 Linux 放在系统临时目录。
func lockPath(development bool) (string, error) {
	name := "coding-instance.sock"
	if development {
		name = "coding-dev-instance.sock"
	}
	if runtime.GOOS == "windows" {
		temp := os.Getenv("LOCALAPPDATA")
		if temp == "" {
			return "", errors.New("LOCALAPPDATA is not set")
		}
		if development {
			return filepath.Join(temp, "Coding", "dev-instance.lock"), nil
		}
		return filepath.Join(temp, "Coding", "instance.lock"), nil
	}
	temp := os.TempDir()
	return temp + "/" + name, nil
}

// Acquire 尝试获得应用级单实例锁。第二个实例把 argv 作为一行激活请求
// 发给持锁进程后返回 false；激活失败的传输错误按未持锁处理，由调用方
// 接管锁并继续启动。
func Acquire(args []string, development bool) (*Listener, bool, error) {
	path, err := lockPath(development)
	if err != nil {
		return nil, false, err
	}
	if runtime.GOOS == "windows" {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, false, fmt.Errorf("instance lock directory %q: %w", filepath.Dir(path), err)
		}
	}
	listener, err := net.Listen("unix", path)
	if err == nil {
		return &Listener{listener: listener, socket: path}, true, nil
	}
	// 已有持锁进程：把参数转发过去，请求它聚焦窗口。
	if err := forward(path, args); err == nil {
		return nil, false, nil
	}
	// 持锁进程死亡但 socket 文件残留：清理后重试一次。
	_ = os.Remove(path)
	listener, err = net.Listen("unix", path)
	if err != nil {
		return nil, false, fmt.Errorf("instance lock: %w", err)
	}
	return &Listener{listener: listener, socket: path}, true, nil
}

// forward 发送一行激活请求。请求体只是提示性的，持锁方不解析语义。
func forward(socket string, args []string) error {
	connection, err := net.Dial("unix", socket)
	if err != nil {
		return err
	}
	defer connection.Close()
	line := ""
	for _, arg := range args {
		line += arg + "\t"
	}
	if len(line) == 0 {
		line = "activate\n"
	}
	_, err = connection.Write([]byte(line))
	return err
}

// Serve 开始接受激活请求；每条连接调用一次 activate。关闭由 Close 负责。
func (lock *Listener) Serve(activate func()) {
	for {
		connection, err := lock.listener.Accept()
		if err != nil {
			return
		}
		go func() {
			defer connection.Close()
			buffer := make([]byte, 256)
			_, _ = connection.Read(buffer)
			if activate != nil {
				activate()
			}
		}()
	}
}

// Close 释放单实例锁并移除 socket 文件。
func (lock *Listener) Close() {
	_ = lock.listener.Close()
	_ = os.Remove(lock.socket)
}
