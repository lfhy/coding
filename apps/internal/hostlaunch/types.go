// Package hostlaunch 发现并启动本地 Coding Node Host。
package hostlaunch

import "time"

const (
	// Protocol 是 host.json 与就绪记录的协议版本。
	Protocol = 1
	// DefaultStartupTimeout 限制未发布就绪记录的启动过程。
	DefaultStartupTimeout = 45 * time.Second
)

// Record 是受管 Host 写入的 JSON 发现约定。
type Record struct {
	Type     string `json:"type"`
	Port     int    `json:"port"`
	PID      int    `json:"pid"`
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
	Token    string `json:"token"`
}

// Endpoint 标识存活的本地 Host，并记录是否由本 Launcher 启动；客户端关闭时
// 不终止该进程，空闲退出由 Host 自己负责。
type Endpoint struct {
	Record  Record
	BaseURL string
	Started bool
}

// Options 配置 Host 发现及找不到兼容实例时的启动行为。
type Options struct {
	Home           string
	Version        string
	CWD            string
	Command        []string
	StartupTimeout time.Duration
	LockTimeout    time.Duration
	PollInterval   time.Duration
	// Environment 仅在本启动器创建 Host 进程时附加的环境变量。调用方用它把
	// 窗口私有的本地 bridge 能力交给 Host；它不会写入 host.json。
	Environment map[string]string
	// ReplaceCompatibleHost 让 Ensure 在启动前停止已有兼容 Host。它只适用于
	// Environment 含窗口私有、不可持久化的能力 token：附着旧进程会使 token
	// 与当前 bridge 不匹配，必须由新进程继承当前环境。
	ReplaceCompatibleHost bool
	// RuntimeRoot 是桌面应用 Resources 目录。设置后，从其中的 Node 可执行文件
	// 和预展开闭包启动 Host，不回退到开发环境命令。
	RuntimeRoot string
	// OnProgress 接收 Host 在就绪前写到 stdout 的可选启动进度；nil 会忽略它。
	OnProgress func(done, total int)
}
