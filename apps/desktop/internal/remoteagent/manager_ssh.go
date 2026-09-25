package remoteagent

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf16"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

const (
	maxAgentArtifactBytes = 64 << 20
	maxProxyRequestBytes  = 40 << 20
	maxProxyResponseBytes = 40 << 20
	pendingHostKeyTTL     = 5 * time.Minute
	maxPendingHostKeys    = 32
	remoteShutdownTimeout = 3 * time.Second
	maxSSHHostBytes       = 255
	maxSSHUserBytes       = 255
	maxSSHPasswordBytes   = 4 << 10
	maxSSHPrivateKeyBytes = 1 << 20
	maxRemotePathBytes    = 4 << 10
	maxAgentVersionBytes  = 128
)

// ErrPortForwardingDenied 仅表示 agent 健康检查的 SSH direct-tcpip 通道被服务端策略拒绝。
var ErrPortForwardingDenied = errors.New("SSH port forwarding denied by server policy")

type connectionState struct {
	info ConnectionInfo

	client       *ssh.Client
	agentSession *ssh.Session
	agentPort    int
	agentVersion string
	token        string
	http         *http.Client

	mu        sync.Mutex
	closed    bool
	done      chan struct{}
	closeOnce sync.Once
}

type pendingHostKey struct {
	address     string
	key         ssh.PublicKey
	fingerprint string
	algorithm   string
	createdAt   time.Time
	expiresAt   time.Time
}

// Connect 建立经严格 known_hosts 校验的 SSH 连接并启动 agent。
func (m *Manager) Connect(ctx context.Context, request ConnectRequest) (ConnectionInfo, error) {
	if err := validateConnectRequest(request); err != nil {
		return ConnectionInfo{}, err
	}
	targetHost, targetPort := normalizedSSHTarget(request.Host, request.Port)
	emitProgress(request.OnProgress, "connecting", 0, 0)
	_, client, err := m.dial(ctx, request)
	if err != nil {
		return ConnectionInfo{}, err
	}
	keepClient := false
	defer func() {
		if !keepClient {
			_ = client.Close()
		}
	}()

	emitProgress(request.OnProgress, "detecting-platform", 0, 0)
	platform, home, err := probeRemotePlatform(ctx, client, m.options.StartupTimeout)
	if err != nil {
		return ConnectionInfo{}, err
	}
	agentPath, err := m.agentPath(request, platform)
	if err != nil {
		return ConnectionInfo{}, err
	}
	installDir := remoteInstallDir(request.RemoteInstallDir, platform, home)

	emitProgress(request.OnProgress, "uploading-agent", 0, 0)
	remoteAgentPath, err := uploadRemoteAgent(ctx, client, agentPath, installDir, platform, request.OnProgress)
	if err != nil {
		return ConnectionInfo{}, err
	}

	emitProgress(request.OnProgress, "starting-agent", 0, 0)
	ready, token, session, err := startRemoteAgent(ctx, client, remoteAgentPath, platform, m.options.StartupTimeout)
	if err != nil {
		return ConnectionInfo{}, err
	}
	connectionID, err := randomID()
	if err != nil {
		_ = session.Close()
		_ = session.Wait()
		return ConnectionInfo{}, fmt.Errorf("create remote SSH connection id: %w", err)
	}
	state := &connectionState{
		info: ConnectionInfo{
			ID:               connectionID,
			Platform:         platform,
			RemoteHome:       home,
			RemoteInstallDir: installDir,
			TargetHost:       targetHost,
			TargetPort:       targetPort,
			TargetUser:       request.User,
		},
		client:       client,
		agentSession: session,
		agentPort:    ready.Port,
		agentVersion: ready.Version,
		token:        token,
		done:         make(chan struct{}),
	}
	state.http = state.newHTTPClient()
	m.mu.Lock()
	m.starting[connectionID] = state
	m.mu.Unlock()
	go m.monitor(connectionID, state)

	emitProgress(request.OnProgress, "checking-agent", 0, 0)
	if err := state.health(ctx); err != nil {
		m.stopUnpublished(connectionID, state)
		return ConnectionInfo{}, err
	}
	if err := ctx.Err(); err != nil {
		m.stopUnpublished(connectionID, state)
		return ConnectionInfo{}, err
	}

	m.mu.Lock()
	state.mu.Lock()
	stopped := m.starting[connectionID] != state
	cancelled := ctx.Err()
	if state.closed || stopped || cancelled != nil {
		state.mu.Unlock()
		m.mu.Unlock()
		m.stopUnpublished(connectionID, state)
		if cancelled != nil {
			return ConnectionInfo{}, cancelled
		}
		return ConnectionInfo{}, errors.New("remote agent exited during startup")
	}
	delete(m.starting, connectionID)
	m.states[connectionID] = state
	state.mu.Unlock()
	m.mu.Unlock()
	keepClient = true
	emitProgress(request.OnProgress, "ready", 1, 1)
	return state.info, nil
}

// ConfirmHostKey 使用当前调用提供的新鲜认证材料完成一次待确认握手。Manager
// 只保存地址与公钥，并在写入 known_hosts 前同时核对地址和 UI 展示过的指纹。
func (m *Manager) ConfirmHostKey(ctx context.Context, confirmationID string, request ConnectRequest, expectedFingerprint string) (ConnectionInfo, error) {
	if err := validateConnectRequest(request); err != nil {
		return ConnectionInfo{}, err
	}
	if confirmationID == "" || len(confirmationID) > 128 || expectedFingerprint == "" || len(expectedFingerprint) > 256 {
		return ConnectionInfo{}, errors.New("SSH host-key confirmation is incomplete")
	}
	host, port := normalizedSSHTarget(request.Host, request.Port)
	address := net.JoinHostPort(host, fmt.Sprint(port))
	now := time.Now()
	m.mu.Lock()
	m.cleanupPendingHostKeysLocked(now)
	pending := m.pending[confirmationID]
	if pending == nil {
		m.mu.Unlock()
		return ConnectionInfo{}, errors.New("unknown or expired SSH host-key confirmation")
	}
	if pending.address != address || pending.fingerprint != expectedFingerprint {
		m.mu.Unlock()
		return ConnectionInfo{}, errors.New("SSH host-key confirmation does not match the current request")
	}
	if err := confirmKnownHost(m.options.KnownHostsPath, pending.address, pending.key); err != nil {
		m.mu.Unlock()
		return ConnectionInfo{}, err
	}
	// 确认和写入在同一把锁内完成，避免两个并发 UI 确认把不同 key 接受为同一 host。
	delete(m.pending, confirmationID)
	m.mu.Unlock()
	return m.Connect(ctx, request)
}

// RejectHostKey 取消未知 host key 的待确认状态。
func (m *Manager) RejectHostKey(confirmationID string) {
	m.mu.Lock()
	delete(m.pending, confirmationID)
	m.mu.Unlock()
}

// Close 停止一个指定 connectionId 的 agent 和 SSH 隧道。
func (m *Manager) Close(ctx context.Context, connectionID string) error {
	state := m.take(connectionID)
	if state == nil {
		return ErrConnectionNotFound
	}
	return closeConnection(ctx, state)
}

// CloseAll 清空待确认公钥并并发停止已发布和正在启动的连接；返回前等待每个
// SSH session 结算或调用方 context 到期。
func (m *Manager) CloseAll(ctx context.Context) error {
	m.mu.Lock()
	states := make([]*connectionState, 0, len(m.states)+len(m.starting))
	for id, state := range m.states {
		delete(m.states, id)
		states = append(states, state)
	}
	for id, state := range m.starting {
		delete(m.starting, id)
		states = append(states, state)
	}
	clear(m.pending)
	m.mu.Unlock()

	results := make(chan error, len(states))
	for _, state := range states {
		go func() { results <- closeConnection(ctx, state) }()
	}
	errorsFound := make([]error, 0, len(states))
	for range states {
		if err := <-results; err != nil {
			errorsFound = append(errorsFound, err)
		}
	}
	return errors.Join(errorsFound...)
}

// Proxy 只代理已知连接的 agent 相对 API 路径，永不接受远端 URL。
func (m *Manager) Proxy(ctx context.Context, connectionID, method, requestPath string, body []byte) (ProxyResponse, error) {
	if !isAgentRoute(method, requestPath) {
		return ProxyResponse{}, errors.New("unsupported remote agent route")
	}
	if len(body) > maxProxyRequestBytes {
		return ProxyResponse{}, errors.New("remote agent request exceeds byte limit")
	}
	state := m.state(connectionID)
	if state == nil {
		return ProxyResponse{}, ErrConnectionNotFound
	}
	return state.proxy(ctx, method, requestPath, body)
}

// ResolvePath 将目录选择器输入规范化为远端绝对路径。
func (m *Manager) ResolvePath(ctx context.Context, connectionID, remotePath string) (ResolveResponse, error) {
	state := m.state(connectionID)
	if state == nil {
		return ResolveResponse{}, ErrConnectionNotFound
	}
	var response ResolveResponse
	if err := state.agentRequest(ctx, http.MethodPost, "/v1/resolve", ResolveRequest{Path: remotePath}, &response); err != nil {
		return ResolveResponse{}, err
	}
	return response, nil
}

// ListDirectories 返回远端目录的一层子项，用于选择工作区根目录。
func (m *Manager) ListDirectories(ctx context.Context, connectionID, remotePath string) (RemoteDirectory, error) {
	state := m.state(connectionID)
	if state == nil {
		return RemoteDirectory{}, ErrConnectionNotFound
	}
	var response ListResponse
	if err := state.agentRequest(ctx, http.MethodPost, "/v1/directories", ListRequest{Path: remotePath}, &response); err != nil {
		return RemoteDirectory{}, err
	}
	return RemoteDirectory{Path: response.Path, Entries: response.Entries}, nil
}

func (m *Manager) state(id string) *connectionState {
	if id == "" {
		return nil
	}
	m.mu.RLock()
	state := m.states[id]
	m.mu.RUnlock()
	if state != nil && state.isClosed() {
		return nil
	}
	return state
}

func (m *Manager) take(id string) *connectionState {
	if id == "" {
		return nil
	}
	m.mu.Lock()
	state := m.states[id]
	delete(m.states, id)
	m.mu.Unlock()
	return state
}

// stopUnpublished 取消尚未暴露给 bridge 的会话。它先从启动表摘除，因此
// CloseAll 与 Connect 的任意交错都只会关闭同一状态一次。
func (m *Manager) stopUnpublished(connectionID string, state *connectionState) {
	m.mu.Lock()
	if m.starting[connectionID] == state {
		delete(m.starting, connectionID)
	}
	m.mu.Unlock()
	state.close()
	_ = waitForConnectionSettlement(state)
}

// monitor 是 agentSession.Wait 的唯一调用者。session 无论主动退出还是被
// Close 中断，都会先从连接表摘除，再释放隧道并关闭 done。
func (m *Manager) monitor(connectionID string, state *connectionState) {
	_ = state.agentSession.Wait()
	m.mu.Lock()
	state.mu.Lock()
	state.closed = true
	if m.states[connectionID] == state {
		delete(m.states, connectionID)
	}
	if m.starting[connectionID] == state {
		delete(m.starting, connectionID)
	}
	state.mu.Unlock()
	m.mu.Unlock()
	state.close()
	close(state.done)
}

func closeConnection(ctx context.Context, state *connectionState) error {
	if state.isClosed() {
		return waitForConnectionSettlement(state)
	}
	shutdownCtx, cancel := context.WithTimeout(ctx, remoteShutdownTimeout)
	_ = state.agentRequest(shutdownCtx, http.MethodPost, "/v1/shutdown", nil, nil)
	cancel()
	graceful := time.NewTimer(remoteShutdownTimeout)
	defer graceful.Stop()
	select {
	case <-state.done:
		return nil
	case <-ctx.Done():
		state.close()
		return errors.Join(ctx.Err(), waitForConnectionSettlement(state))
	case <-graceful.C:
		state.close()
	}
	return waitForConnectionSettlement(state)
}

func waitForConnectionSettlement(state *connectionState) error {
	timer := time.NewTimer(remoteShutdownTimeout)
	defer timer.Stop()
	select {
	case <-state.done:
		return nil
	case <-timer.C:
		return errors.New("remote SSH session did not settle after close")
	}
}

func (state *connectionState) newHTTPClient() *http.Client {
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			default:
			}
			return state.client.Dial("tcp", net.JoinHostPort("127.0.0.1", fmt.Sprint(state.agentPort)))
		},
	}
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func (state *connectionState) health(ctx context.Context) error {
	response, err := state.proxy(ctx, http.MethodGet, "/v1/health", nil)
	if err != nil {
		var channelError *ssh.OpenChannelError
		if errors.As(err, &channelError) && channelError.Reason == ssh.Prohibited {
			return fmt.Errorf("check remote agent health: %w (%w)", ErrPortForwardingDenied, err)
		}
		return fmt.Errorf("check remote agent health: %w", err)
	}
	if response.Status != http.StatusOK {
		return decodeAgentFailure(response)
	}
	var health struct {
		Type     string `json:"type"`
		Protocol int    `json:"protocol"`
		Version  string `json:"version"`
		Platform string `json:"platform"`
		Arch     string `json:"arch"`
	}
	if err := decodeStrictJSON(response.Body, &health); err != nil {
		return err
	}
	if health.Type != "coding-remote-agent-health" || health.Protocol != ProtocolVersion || health.Version != state.agentVersion || health.Platform != state.info.Platform.OS || health.Arch != state.info.Platform.Arch {
		return errors.New("remote agent health does not match the SSH target or readiness")
	}
	return nil
}

func (state *connectionState) proxy(ctx context.Context, method, requestPath string, body []byte) (ProxyResponse, error) {
	state.mu.Lock()
	closed := state.closed
	state.mu.Unlock()
	if closed {
		return ProxyResponse{}, ErrConnectionNotFound
	}
	endpoint := "http://coding-remote-agent" + requestPath
	request, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		return ProxyResponse{}, err
	}
	if len(body) != 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	request.Header.Set("Authorization", "Bearer "+state.token)
	response, err := state.http.Do(request)
	if err != nil {
		return ProxyResponse{}, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, maxProxyResponseBytes+1))
	if err != nil {
		return ProxyResponse{}, err
	}
	if len(data) > maxProxyResponseBytes {
		return ProxyResponse{}, errors.New("remote agent response exceeds byte limit")
	}
	return ProxyResponse{Status: response.StatusCode, ContentType: response.Header.Get("Content-Type"), Body: data}, nil
}

func (state *connectionState) agentRequest(ctx context.Context, method, requestPath string, payload, out any) error {
	var data []byte
	var err error
	if payload != nil {
		data, err = json.Marshal(payload)
		if err != nil {
			return err
		}
	}
	response, err := state.proxy(ctx, method, requestPath, data)
	if err != nil {
		return err
	}
	if response.Status < 200 || response.Status >= 300 {
		return decodeAgentFailure(response)
	}
	if out == nil {
		return nil
	}
	return decodeStrictJSON(response.Body, out)
}

func (state *connectionState) close() {
	state.closeOnce.Do(func() {
		state.mu.Lock()
		state.closed = true
		state.mu.Unlock()
		if transport, ok := state.http.Transport.(*http.Transport); ok {
			transport.CloseIdleConnections()
		}
		_ = state.agentSession.Close()
		_ = state.client.Close()
	})
}

func (state *connectionState) isClosed() bool {
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.closed
}

func isAgentRoute(method, requestPath string) bool {
	if requestPath == "" || strings.Contains(requestPath, "?") || strings.Contains(requestPath, "#") {
		return false
	}
	parsed, err := url.ParseRequestURI(requestPath)
	if err != nil || parsed.IsAbs() || parsed.Host != "" || parsed.Path != requestPath {
		return false
	}
	allowed := map[string]string{
		"/v1/resolve":              http.MethodPost,
		"/v1/stat":                 http.MethodPost,
		"/v1/directories":          http.MethodPost,
		"/v1/read_file":            http.MethodPost,
		"/v1/read_bytes":           http.MethodPost,
		"/v1/update_file":          http.MethodPost,
		"/v1/edit_file":            http.MethodPost,
		"/v1/exec":                 http.MethodPost,
		"/v1/search":               http.MethodPost,
		"/v1/code/start":           http.MethodPost,
		"/v1/code/next":            http.MethodPost,
		"/v1/code/reply":           http.MethodPost,
		"/v1/code/cancel":          http.MethodPost,
		"/v1/terminals/start":      http.MethodPost,
		"/v1/terminals/read":       http.MethodPost,
		"/v1/terminals/write":      http.MethodPost,
		"/v1/terminals/resize":     http.MethodPost,
		"/v1/terminals/foreground": http.MethodPost,
		"/v1/terminals/signal":     http.MethodPost,
		"/v1/terminals/terminate":  http.MethodPost,
		"/v1/processes/resolve":    http.MethodPost,
		"/v1/processes/start":      http.MethodPost,
		"/v1/processes/read":       http.MethodPost,
		"/v1/processes/write":      http.MethodPost,
		"/v1/processes/wait":       http.MethodPost,
		"/v1/processes/kill":       http.MethodPost,
	}
	return allowed[requestPath] == method
}

func decodeAgentFailure(response ProxyResponse) error {
	var envelope struct {
		Error AgentError `json:"error"`
	}
	if json.Unmarshal(response.Body, &envelope) == nil && envelope.Error.Code != "" {
		return fmt.Errorf("remote agent %s: %s", envelope.Error.Code, envelope.Error.Message)
	}
	return fmt.Errorf("remote agent returned HTTP %d", response.Status)
}

func decodeStrictJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return fmt.Errorf("decode remote agent response: %w", err)
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("remote agent response has trailing JSON")
	}
	return nil
}

func validateConnectRequest(request ConnectRequest) error {
	if strings.TrimSpace(request.Host) == "" || len(request.Host) > maxSSHHostBytes {
		return errors.New("SSH host is required")
	}
	if strings.Contains(request.Host, "://") || strings.ContainsAny(request.Host, "\\/@?#\x00") || strings.IndexFunc(request.Host, unicode.IsSpace) >= 0 {
		return errors.New("SSH host contains an invalid character")
	}
	if (strings.HasPrefix(request.Host, "[") || strings.HasSuffix(request.Host, "]")) &&
		!(strings.HasPrefix(request.Host, "[") && strings.HasSuffix(request.Host, "]") && net.ParseIP(request.Host[1:len(request.Host)-1]) != nil) {
		return errors.New("SSH host has invalid IPv6 brackets")
	}
	normalizedHost, _ := normalizedSSHTarget(request.Host, request.Port)
	if strings.ContainsRune(normalizedHost, ':') && net.ParseIP(normalizedHost) == nil {
		return errors.New("SSH host contains an invalid colon")
	}
	if strings.TrimSpace(request.User) == "" || len(request.User) > maxSSHUserBytes ||
		strings.ContainsRune(request.User, '\x00') || strings.IndexFunc(request.User, unicode.IsSpace) >= 0 {
		return errors.New("SSH user is required")
	}
	if request.Port < 0 || request.Port > 65535 {
		return errors.New("SSH port is invalid")
	}
	if request.Auth.Password == "" && request.Auth.PrivateKey == "" {
		return errors.New("SSH password or private key is required")
	}
	if len(request.Auth.Password) > maxSSHPasswordBytes {
		return errors.New("SSH password exceeds byte limit")
	}
	if len(request.Auth.PrivateKey) > maxSSHPrivateKeyBytes {
		return errors.New("SSH private key exceeds byte limit")
	}
	if len(request.Auth.PrivateKeyPassphrase) > maxSSHPasswordBytes {
		return errors.New("SSH private key passphrase exceeds byte limit")
	}
	if len(request.AgentPath) > maxRemotePathBytes {
		return errors.New("remote agent artifact path exceeds byte limit")
	}
	if len(request.RemoteInstallDir) > maxRemotePathBytes || strings.ContainsAny(request.RemoteInstallDir, "\r\n\x00") {
		return errors.New("remote agent install directory contains an invalid character")
	}
	return nil
}

func (m *Manager) dial(ctx context.Context, request ConnectRequest) (string, *ssh.Client, error) {
	host, port := normalizedSSHTarget(request.Host, request.Port)
	address := net.JoinHostPort(host, fmt.Sprint(port))
	callback, err := m.hostKeyCallback(address)
	if err != nil {
		return "", nil, err
	}
	auth, err := sshAuthMethods(request.Auth)
	if err != nil {
		return "", nil, err
	}
	config := &ssh.ClientConfig{User: request.User, Auth: auth, HostKeyCallback: callback, Timeout: m.options.ConnectTimeout}
	dialer := &net.Dialer{Timeout: m.options.ConnectTimeout}
	connection, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return "", nil, fmt.Errorf("connect SSH %s: %w", address, err)
	}
	closeConnection := true
	defer func() {
		if closeConnection {
			_ = connection.Close()
		}
	}()
	deadline := time.Now().Add(m.options.ConnectTimeout)
	if contextDeadline, ok := ctx.Deadline(); ok && contextDeadline.Before(deadline) {
		deadline = contextDeadline
	}
	_ = connection.SetDeadline(deadline)
	raw, channels, requests, err := ssh.NewClientConn(connection, address, config)
	if err != nil {
		var unknown *ErrUnknownHostKey
		var changed *ErrHostKeyChanged
		if errors.As(err, &unknown) || errors.As(err, &changed) {
			return "", nil, err
		}
		if strings.Contains(err.Error(), "unable to authenticate") || strings.Contains(err.Error(), "permission denied") {
			return "", nil, errors.New("SSH authentication failed")
		}
		return "", nil, fmt.Errorf("SSH handshake: %w", err)
	}
	_ = connection.SetDeadline(time.Time{})
	closeConnection = false
	return address, ssh.NewClient(raw, channels, requests), nil
}

func sshAuthMethods(auth SSHAuth) ([]ssh.AuthMethod, error) {
	methods := make([]ssh.AuthMethod, 0, 2)
	if auth.PrivateKey != "" {
		key := []byte(auth.PrivateKey)
		signer, err := ssh.ParsePrivateKey(key)
		if err != nil {
			var requiresPassphrase *ssh.PassphraseMissingError
			if !errors.As(err, &requiresPassphrase) {
				return nil, fmt.Errorf("parse SSH private key: %w", err)
			}
			if auth.PrivateKeyPassphrase == "" {
				return nil, errors.New("SSH private key requires a passphrase")
			}
			signer, err = ssh.ParsePrivateKeyWithPassphrase(key, []byte(auth.PrivateKeyPassphrase))
			if err != nil {
				return nil, fmt.Errorf("parse SSH private key passphrase: %w", err)
			}
		}
		methods = append(methods, ssh.PublicKeys(signer))
	}
	if auth.Password != "" {
		methods = append(methods, ssh.Password(auth.Password))
	}
	return methods, nil
}

func (m *Manager) hostKeyCallback(address string) (ssh.HostKeyCallback, error) {
	if err := ensureKnownHosts(m.options.KnownHostsPath); err != nil {
		return nil, err
	}
	callback, err := knownhosts.New(m.options.KnownHostsPath)
	if err != nil {
		return nil, fmt.Errorf("load remote SSH known_hosts: %w", err)
	}
	return func(hostname string, remote net.Addr, publicKey ssh.PublicKey) error {
		err := callback(hostname, remote, publicKey)
		if err == nil {
			return nil
		}
		var keyError *knownhosts.KeyError
		if errors.As(err, &keyError) {
			fingerprint := ssh.FingerprintSHA256(publicKey)
			if len(keyError.Want) > 0 {
				return &ErrHostKeyChanged{Address: address, Fingerprint: fingerprint}
			}
			id, randomErr := m.rememberPendingHostKey(address, publicKey, fingerprint)
			if randomErr != nil {
				return randomErr
			}
			return &ErrUnknownHostKey{ConfirmationID: id, Fingerprint: fingerprint, Algorithm: publicKey.Type(), Address: address}
		}
		var revoked *knownhosts.RevokedError
		if errors.As(err, &revoked) {
			return fmt.Errorf("SSH host key is revoked for %s", address)
		}
		return fmt.Errorf("verify SSH host key: %w", err)
	}, nil
}

func (m *Manager) rememberPendingHostKey(address string, publicKey ssh.PublicKey, fingerprint string) (string, error) {
	now := time.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cleanupPendingHostKeysLocked(now)
	if len(m.pending) >= maxPendingHostKeys {
		var oldestID string
		var oldest time.Time
		for id, pending := range m.pending {
			if oldestID == "" || pending.createdAt.Before(oldest) {
				oldestID = id
				oldest = pending.createdAt
			}
		}
		delete(m.pending, oldestID)
	}
	id, err := randomID()
	if err != nil {
		return "", err
	}
	m.pending[id] = &pendingHostKey{
		address: address, key: publicKey, fingerprint: fingerprint, algorithm: publicKey.Type(),
		createdAt: now, expiresAt: now.Add(pendingHostKeyTTL),
	}
	return id, nil
}

func (m *Manager) cleanupPendingHostKeysLocked(now time.Time) {
	for id, pending := range m.pending {
		if !now.Before(pending.expiresAt) {
			delete(m.pending, id)
		}
	}
}

func normalizedSSHTarget(host string, port int) (string, int) {
	host = strings.TrimSpace(host)
	if strings.HasPrefix(host, "[") && strings.HasSuffix(host, "]") {
		host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	}
	if ip := net.ParseIP(host); ip != nil {
		host = ip.String()
	} else {
		host = strings.ToLower(host)
	}
	if port == 0 {
		port = 22
	}
	return host, port
}

func ensureKnownHosts(filename string) error {
	directory := filepath.Dir(filename)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create remote SSH state directory: %w", err)
	}
	directoryInfo, err := os.Lstat(directory)
	if err != nil || !directoryInfo.IsDir() || directoryInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("remote SSH state directory must be a real directory")
	}
	if runtime.GOOS != "windows" && directoryInfo.Mode().Perm()&0o077 != 0 {
		return errors.New("remote SSH state directory permissions are too broad")
	}
	info, err := os.Lstat(filename)
	if errors.Is(err, os.ErrNotExist) {
		file, createErr := os.OpenFile(filename, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if createErr != nil {
			return fmt.Errorf("create remote SSH known_hosts: %w", createErr)
		}
		return file.Close()
	}
	if err != nil {
		return fmt.Errorf("inspect remote SSH known_hosts: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("remote SSH known_hosts must be a regular file")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return errors.New("remote SSH known_hosts permissions are too broad")
	}
	return nil
}

func confirmKnownHost(filename, address string, publicKey ssh.PublicKey) error {
	if err := ensureKnownHosts(filename); err != nil {
		return err
	}
	callback, err := knownhosts.New(filename)
	if err != nil {
		return err
	}
	err = callback(address, &net.TCPAddr{IP: net.IPv4zero, Port: 22}, publicKey)
	if err == nil {
		return nil
	}
	var keyError *knownhosts.KeyError
	if !errors.As(err, &keyError) || len(keyError.Want) > 0 {
		return &ErrHostKeyChanged{Address: address, Fingerprint: ssh.FingerprintSHA256(publicKey)}
	}
	file, err := os.OpenFile(filename, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return fmt.Errorf("append remote SSH known_hosts: %w", err)
	}
	defer file.Close()
	if _, err := io.WriteString(file, knownhosts.Line([]string{address}, publicKey)+"\n"); err != nil {
		return fmt.Errorf("write remote SSH known_hosts: %w", err)
	}
	return nil
}

func randomID() (string, error) {
	data := make([]byte, 24)
	if _, err := rand.Read(data); err != nil {
		return "", err
	}
	return "r" + base64.RawURLEncoding.EncodeToString(data), nil
}

func probeRemotePlatform(ctx context.Context, client *ssh.Client, timeout time.Duration) (RemotePlatform, string, error) {
	unixOutput, unixErr := runRemoteCommand(ctx, client, "printf '%s %s\\n' \"$(uname -s)\" \"$(uname -m)\"; printf 'HOME=%s\\n' \"$HOME\"", timeout)
	if unixErr == nil {
		if platform, home, ok := parsePlatformOutput(unixOutput); ok {
			return platform, home, nil
		}
	}
	windowsScript := "Write-Output ('Windows ' + $env:PROCESSOR_ARCHITECTURE); Write-Output ('HOME=' + [Environment]::GetFolderPath('UserProfile'))"
	windowsOutput, windowsErr := runRemoteCommand(ctx, client, powershellCommand(windowsScript), timeout)
	if windowsErr == nil {
		if platform, home, ok := parsePlatformOutput(windowsOutput); ok {
			return platform, home, nil
		}
	}
	return RemotePlatform{}, "", errors.New("unsupported remote operating system or architecture")
}

func parsePlatformOutput(output string) (RemotePlatform, string, bool) {
	var osName, archName, home string
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "HOME=") {
			home = strings.TrimSpace(strings.TrimPrefix(line, "HOME="))
			continue
		}
		parts := strings.Fields(line)
		if len(parts) >= 2 {
			osName, archName = parts[0], parts[1]
		}
	}
	platform := RemotePlatform{OS: normalizeRemoteOS(osName), Arch: normalizeRemoteArch(archName)}
	if platform.OS == "" || platform.Arch == "" || home == "" || strings.ContainsAny(home, "\r\n\x00") {
		return RemotePlatform{}, "", false
	}
	return platform, home, true
}

func normalizeRemoteOS(value string) string {
	switch strings.ToLower(value) {
	case "linux":
		return "linux"
	case "darwin":
		return "darwin"
	case "windows", "windows_nt":
		return "windows"
	default:
		return ""
	}
}

func normalizeRemoteArch(value string) string {
	switch strings.ToLower(value) {
	case "x86_64", "amd64":
		return "amd64"
	case "aarch64", "arm64":
		return "arm64"
	default:
		return ""
	}
}

func (m *Manager) agentPath(request ConnectRequest, platform RemotePlatform) (string, error) {
	filename := request.AgentPath
	if filename == "" && m.options.AgentPathFor != nil {
		var err error
		filename, err = m.options.AgentPathFor(platform)
		if err != nil {
			return "", err
		}
	}
	if filename == "" {
		return "", fmt.Errorf("remote agent asset is missing for %s-%s", platform.OS, platform.Arch)
	}
	info, err := os.Stat(filename)
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
		return "", fmt.Errorf("remote agent asset is unavailable for %s-%s", platform.OS, platform.Arch)
	}
	return filename, nil
}

func remoteInstallDir(value string, platform RemotePlatform, home string) string {
	if value != "" {
		if platform.OS == "windows" {
			return strings.ReplaceAll(value, "\\", "/")
		}
		return value
	}
	if platform.OS == "windows" {
		return strings.TrimRight(strings.ReplaceAll(home, "\\", "/"), "/") + "/.coding/remote-agent"
	}
	return path.Join(home, ".coding", "remote-agent")
}

func uploadRemoteAgent(ctx context.Context, client *ssh.Client, localPath, installDir string, platform RemotePlatform, progress func(Progress)) (string, error) {
	info, err := os.Stat(localPath)
	if err != nil {
		return "", fmt.Errorf("inspect remote agent asset: %w", err)
	}
	if info.Size() > maxAgentArtifactBytes {
		return "", errors.New("remote agent asset exceeds byte limit")
	}
	file, err := os.Open(localPath)
	if err != nil {
		return "", fmt.Errorf("open remote agent asset: %w", err)
	}
	defer file.Close()

	sftpClient, err := sftp.NewClient(client)
	if err != nil {
		return "", fmt.Errorf("open SFTP deployment channel: %w", err)
	}
	defer sftpClient.Close()
	if err := sftpClient.MkdirAll(installDir); err != nil {
		return "", fmt.Errorf("create remote agent directory: %w", err)
	}
	name := "coding-remote-agent"
	deploymentID, err := randomID()
	if err != nil {
		return "", fmt.Errorf("create remote agent deployment id: %w", err)
	}
	name += "-" + deploymentID
	if platform.OS == "windows" {
		name += ".exe"
	}
	remotePath := path.Join(strings.ReplaceAll(installDir, "\\", "/"), name)
	temporaryPath := remotePath + ".upload"
	remoteFile, err := sftpClient.OpenFile(temporaryPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		return "", fmt.Errorf("create remote agent upload: %w", err)
	}
	copyErr := copyWithProgress(ctx, remoteFile, file, info.Size(), progress)
	closeErr := remoteFile.Close()
	if copyErr != nil {
		_ = sftpClient.Remove(temporaryPath)
		return "", fmt.Errorf("upload remote agent: %w", copyErr)
	}
	if closeErr != nil {
		_ = sftpClient.Remove(temporaryPath)
		return "", fmt.Errorf("finish remote agent upload: %w", closeErr)
	}
	if platform.OS != "windows" {
		if err := sftpClient.Chmod(temporaryPath, 0o700); err != nil {
			_ = sftpClient.Remove(temporaryPath)
			return "", fmt.Errorf("set remote agent permissions: %w", err)
		}
	}
	if err := sftpClient.Rename(temporaryPath, remotePath); err != nil {
		_ = sftpClient.Remove(temporaryPath)
		return "", fmt.Errorf("publish remote agent: %w", err)
	}
	emitProgress(progress, "uploading-agent", info.Size(), info.Size())
	return remotePath, nil
}

func copyWithProgress(ctx context.Context, destination io.WriteCloser, source io.Reader, total int64, progress func(Progress)) error {
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = destination.Close()
		case <-done:
		}
	}()
	// 取消分支不能在这里等待 Close：SFTP Close 可能要等调用方随后关闭 client
	// 才返回；done 只负责让正常复制的 watcher 立即退出。
	defer close(done)
	buffer := make([]byte, 64<<10)
	var completed int64
	for {
		read, readErr := source.Read(buffer)
		if read > 0 {
			written, writeErr := destination.Write(buffer[:read])
			completed += int64(written)
			emitProgress(progress, "uploading-agent", completed, total)
			if writeErr != nil {
				return writeErr
			}
			if written != read {
				return io.ErrShortWrite
			}
		}
		if readErr == io.EOF {
			return nil
		}
		if readErr != nil {
			return readErr
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
	}
}

func startRemoteAgent(ctx context.Context, client *ssh.Client, remotePath string, platform RemotePlatform, timeout time.Duration) (ReadyRecord, string, *ssh.Session, error) {
	token, err := randomID()
	if err != nil {
		return ReadyRecord{}, "", nil, fmt.Errorf("create remote agent token: %w", err)
	}
	session, err := client.NewSession()
	if err != nil {
		return ReadyRecord{}, "", nil, fmt.Errorf("open remote agent SSH session: %w", err)
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = session.Close()
			_ = client.Close()
			settled := make(chan struct{})
			go func() {
				_ = session.Wait()
				close(settled)
			}()
			select {
			case <-settled:
			case <-time.After(remoteShutdownTimeout):
			}
		}
	}()
	stdout, err := session.StdoutPipe()
	if err != nil {
		return ReadyRecord{}, "", nil, fmt.Errorf("capture remote agent stdout: %w", err)
	}
	stderr, err := session.StderrPipe()
	if err != nil {
		return ReadyRecord{}, "", nil, fmt.Errorf("capture remote agent stderr: %w", err)
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		return ReadyRecord{}, "", nil, fmt.Errorf("capture remote agent stdin: %w", err)
	}
	command := "exec " + shellQuote(remotePath) + " --token-stdin"
	if platform.OS == "windows" {
		command = powershellCommand("& " + powershellQuote(remotePath) + " --token-stdin")
	}
	if err := session.Start(command); err != nil {
		return ReadyRecord{}, "", nil, fmt.Errorf("start remote agent: %w", err)
	}
	if _, err := io.WriteString(stdin, token+"\n"); err != nil {
		return ReadyRecord{}, "", nil, fmt.Errorf("send remote agent token: %w", err)
	}
	if err := stdin.Close(); err != nil {
		return ReadyRecord{}, "", nil, fmt.Errorf("finish remote agent token input: %w", err)
	}

	ready := make(chan ReadyRecord, 1)
	readFailure := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(io.LimitReader(stdout, 64<<10))
		for scanner.Scan() {
			var record ReadyRecord
			if json.Unmarshal(scanner.Bytes(), &record) == nil && record.Type == "coding-remote-agent-ready" {
				ready <- record
				return
			}
		}
		if err := scanner.Err(); err != nil {
			readFailure <- err
			return
		}
		readFailure <- errors.New("remote agent exited before readiness")
	}()
	// stderr 不写日志；远端可控输出不得携带到诊断、URL 或持久化状态。
	go func() { _, _ = io.Copy(io.Discard, io.LimitReader(stderr, 64<<10)) }()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ReadyRecord{}, "", nil, ctx.Err()
	case <-timer.C:
		return ReadyRecord{}, "", nil, errors.New("remote agent readiness timeout")
	case err := <-readFailure:
		return ReadyRecord{}, "", nil, err
	case record := <-ready:
		if record.Protocol != ProtocolVersion || record.Port < 1 || record.Port > 65535 || strings.TrimSpace(record.Version) == "" || len(record.Version) > maxAgentVersionBytes {
			return ReadyRecord{}, "", nil, errors.New("remote agent returned invalid readiness")
		}
		cleanup = false
		return record, token, session, nil
	}
}

func runRemoteCommand(ctx context.Context, client *ssh.Client, command string, timeout time.Duration) (string, error) {
	session, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer session.Close()
	type outcome struct {
		output []byte
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		output, err := session.CombinedOutput(command)
		done <- outcome{output: output, err: err}
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		_ = session.Close()
		return "", ctx.Err()
	case <-timer.C:
		_ = session.Close()
		return "", errors.New("remote command timeout")
	case result := <-done:
		if result.err != nil {
			return "", errors.New("remote command failed")
		}
		if len(result.output) > 64<<10 {
			return "", errors.New("remote command output exceeds byte limit")
		}
		return string(result.output), nil
	}
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

func powershellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

func powershellCommand(script string) string {
	encoded := utf16.Encode([]rune(script))
	data := make([]byte, len(encoded)*2)
	for index, value := range encoded {
		binary.LittleEndian.PutUint16(data[index*2:], value)
	}
	return "powershell.exe -NoProfile -NonInteractive -EncodedCommand " + base64.StdEncoding.EncodeToString(data)
}

func emitProgress(callback func(Progress), stage string, completed, total int64) {
	if callback == nil {
		return
	}
	callback(Progress{Stage: stage, Completed: completed, Total: total})
}
