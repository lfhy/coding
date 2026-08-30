// Package remoteagent 同时承载远端 agent 协议和桌面端 SSH 生命周期管理。
package remoteagent

import (
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"time"
)

// SSHAuth 是一次 SSH 握手所需的临时认证材料。调用结束后 Manager 不保存它。
type SSHAuth struct {
	Password             string
	PrivateKey           string
	PrivateKeyPassphrase string
}

// ConnectRequest 描述一次 Remote-SSH 连接与 remote agent 部署。
type ConnectRequest struct {
	Host             string
	Port             int
	User             string
	Auth             SSHAuth
	AgentPath        string
	RemoteInstallDir string
	OnProgress       func(Progress)
}

// Progress 是连接向导可展示的无敏感部署进度。
type Progress struct {
	Stage     string `json:"stage"`
	Completed int64  `json:"completed,omitempty"`
	Total     int64  `json:"total,omitempty"`
}

// RemotePlatform 是经远端探测确认的 Go 目标平台。
type RemotePlatform struct {
	OS   string `json:"os"`
	Arch string `json:"arch"`
}

// ConnectionInfo 是供 Wails bridge 和本地工作区 marker 使用的无凭据连接摘要。
type ConnectionInfo struct {
	ID string `json:"id"`
	// Endpoint 保留给 Go 内部兼容调用，始终为空且不跨 Wails/marker 边界公开。
	// 远端访问只能经 Proxy 的 SSH direct-tcpip 通道。
	Endpoint         string         `json:"-"`
	Platform         RemotePlatform `json:"platform"`
	RemoteHome       string         `json:"remoteHome"`
	RemoteInstallDir string         `json:"remoteInstallDir"`
	TargetHost       string         `json:"-"`
	TargetPort       int            `json:"-"`
	TargetUser       string         `json:"-"`
}

// ProxyResponse 是 bridge 转发 remote agent HTTP 请求的完整受限响应。
type ProxyResponse struct {
	Status      int    `json:"status"`
	ContentType string `json:"contentType"`
	Body        []byte `json:"body"`
}

// RemoteWorkspaceMarker 是可落盘的远端工作区引用。connectionId 是仅在桌面进程
// 内有效的随机标识；它不携带地址、认证材料、host key 或 agent token。
type RemoteWorkspaceMarker struct {
	Version      int    `json:"version"`
	RemoteRoot   string `json:"remoteRoot"`
	ConnectionID string `json:"connectionId"`
}

// RemoteDirectory 是远端目录选择器的一层结果，不暴露 SSH 或 agent 凭据。
type RemoteDirectory struct {
	Path    string           `json:"path"`
	Entries []DirectoryEntry `json:"entries"`
}

// ManagerOptions 配置本地 app 专用 known_hosts 与打包 agent 查找器。
type ManagerOptions struct {
	KnownHostsPath string
	AgentPathFor   func(RemotePlatform) (string, error)
	ConnectTimeout time.Duration
	StartupTimeout time.Duration
}

// ErrUnknownHostKey 要求 UI 显式确认第一次看见的 host key。
type ErrUnknownHostKey struct {
	ConfirmationID string
	Fingerprint    string
	Algorithm      string
	Address        string
}

func (err *ErrUnknownHostKey) Error() string { return "SSH host key is unknown for " + err.Address }

// ErrHostKeyChanged 表示已有 known_hosts 记录与本次 key 冲突，绝不可确认覆盖。
type ErrHostKeyChanged struct {
	Address     string
	Fingerprint string
}

func (err *ErrHostKeyChanged) Error() string { return "SSH host key changed for " + err.Address }

// ErrConnectionNotFound 表示 marker 引用的连接不存在或已经关闭。
var ErrConnectionNotFound = errors.New("remote SSH connection is not active")

// Manager 的完整实现位于 manager_ssh.go。独立的连接表使 bridge 必须按 marker
// 中的 connectionId 路由，不会把任意远端工作区降级为“当前连接”。
type Manager struct {
	options  ManagerOptions
	mu       sync.RWMutex
	states   map[string]*connectionState
	starting map[string]*connectionState
	pending  map[string]*pendingHostKey
}

// NewManager 创建仅使用 app 私有 known_hosts 的 Remote-SSH 管理器。
func NewManager(options ManagerOptions) (*Manager, error) {
	if options.KnownHostsPath == "" {
		return nil, errors.New("remote SSH known_hosts path is required")
	}
	absoluteKnownHosts, err := filepath.Abs(options.KnownHostsPath)
	if err != nil {
		return nil, fmt.Errorf("resolve remote SSH known_hosts path: %w", err)
	}
	options.KnownHostsPath = absoluteKnownHosts
	if options.ConnectTimeout <= 0 {
		options.ConnectTimeout = 15 * time.Second
	}
	if options.StartupTimeout <= 0 {
		options.StartupTimeout = 45 * time.Second
	}
	return &Manager{
		options:  options,
		states:   map[string]*connectionState{},
		starting: map[string]*connectionState{},
		pending:  map[string]*pendingHostKey{},
	}, nil
}

// Connection 返回仍然活跃的连接摘要。
func (m *Manager) Connection(id string) (ConnectionInfo, error) {
	state := m.state(id)
	if state == nil {
		return ConnectionInfo{}, ErrConnectionNotFound
	}
	return state.info, nil
}

// Marker 为已连接远端根目录生成可落盘、不含凭据的 marker。
func (m *Manager) Marker(connectionID, remoteRoot string) (RemoteWorkspaceMarker, error) {
	if remoteRoot == "" {
		return RemoteWorkspaceMarker{}, errors.New("remote root is required")
	}
	if _, err := m.Connection(connectionID); err != nil {
		return RemoteWorkspaceMarker{}, err
	}
	return RemoteWorkspaceMarker{Version: 1, RemoteRoot: remoteRoot, ConnectionID: connectionID}, nil
}
