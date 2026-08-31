package main

import (
	"context"
	"crypto/subtle"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	remoteBridgeMaxPayloadBytes        int64 = 40 << 20
	remoteBridgeRetiredMarkerLimit           = 128
	remoteBridgeMarkerRootHeader             = "X-Coding-Remote-Marker-Root"
	remoteBridgeMarkerGenerationHeader       = "X-Coding-Remote-Marker-Generation"
	remoteBridgeRemoteRootHeader             = "X-Coding-Remote-Root"
	remoteBridgeCleanupHeader                = "X-Coding-Remote-Cleanup"
)

var remoteConnectionIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// remoteBridgeProxy 是本地 bridge 交给 SSH manager 的单个无状态请求。返回体
// 必须已是远端 agent 的 JSON；bridge 不解释业务字段，以免丢失文件工具的错误码。
type remoteBridgeProxy func(ctx context.Context, connectionID, method, path string, body []byte) (status int, response []byte, err error)

// remoteBridgeMarkerRoute 是桌面进程已发布 marker 的内存身份。generation 与
// marker 文件一同替换；它不是跨进程锁，只为本进程的官方重绑路径建立 dispatch
// 栅栏。
type remoteBridgeMarkerRoute struct {
	connectionID string
	remoteRoot   string
	generation   uint64
}

// remoteBridgeMarkerIdentity 是 Host 在 bridge 请求中带回的 marker 快照。
// 旧 identity 只能用于已发布句柄的显式终止/取消，不可恢复普通 I/O。
type remoteBridgeMarkerIdentity struct {
	markerRoot   string
	connectionID string
	remoteRoot   string
	generation   uint64
}

// remoteBridge 仅监听本机回环地址，供本地 Node Host 转发 marker 工作区的 I/O。
// SSH bearer token 由 manager 保留；Node 仅持有此桥接器的窗口私有 token。
type remoteBridge struct {
	token    string
	proxy    remoteBridgeProxy
	listener net.Listener
	server   *http.Server
	close    sync.Once

	// markerMu 在整个 Proxy 调用期间保持读锁。这样 marker 写入在获得写锁前
	// 不会改变路由，而写锁释放后旧 generation 也无法再开始 dispatch。
	// markerAdmissionMu 让 writer 能在等待既有读者时先阻止新读者；配合
	// TryLock+ctx 轮询，选择超时不会被一个未取消的 RWMutex.Lock 永久吞掉。
	markerAdmissionMu   sync.Mutex
	markerMu            sync.RWMutex
	markerRoutes        map[string]remoteBridgeMarkerRoute
	retiredMarkerRoutes map[remoteBridgeMarkerIdentity]struct{}
	retiredMarkerOrder  []remoteBridgeMarkerIdentity
}

// newRemoteBridge 启动一个随机回环端口的 HTTP bridge。
func newRemoteBridge(token string, proxy remoteBridgeProxy) (*remoteBridge, error) {
	if len(token) < 32 {
		return nil, errors.New("coding: remote bridge token is too short")
	}
	if proxy == nil {
		return nil, errors.New("coding: remote bridge proxy is required")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	bridge := &remoteBridge{
		token: token, proxy: proxy, listener: listener,
		markerRoutes:        map[string]remoteBridgeMarkerRoute{},
		retiredMarkerRoutes: map[remoteBridgeMarkerIdentity]struct{}{},
	}
	bridge.server = &http.Server{
		Handler:           http.HandlerFunc(bridge.serveHTTP),
		ReadHeaderTimeout: 10 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
	go func() {
		_ = bridge.server.Serve(listener)
	}()
	return bridge, nil
}

// publishMarker 将 marker 文件替换和 bridge 路由切换串行化。调用方仍须用
// App.remoteMarkerMu 串行化同一 marker 的选择事务；本方法不把 marker 文件当作
// 可供任意进程使用的锁。文件替换失败时内存路由保持旧值。
func (b *remoteBridge) publishMarker(
	ctx context.Context,
	markerRoot, remoteRoot, connectionID string,
	previousGeneration uint64,
	write func(generation uint64) error,
) (uint64, error) {
	if !validBridgeMarkerRoot(markerRoot) || !validCanonicalRemotePath(remoteRoot) || !remoteConnectionIDPattern.MatchString(connectionID) {
		return 0, errors.New("coding: remote bridge marker identity is invalid")
	}
	if write == nil {
		return 0, errors.New("coding: remote bridge marker writer is required")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := lockRemoteBridgeMarker(ctx, &b.markerAdmissionMu); err != nil {
		return 0, err
	}
	defer b.markerAdmissionMu.Unlock()
	if err := lockRemoteBridgeRoute(ctx, &b.markerMu); err != nil {
		return 0, err
	}
	defer b.markerMu.Unlock()
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	current, exists := b.markerRoutes[markerRoot]
	next := previousGeneration
	if exists && current.generation > next {
		next = current.generation
	}
	if next >= remoteWorkspaceMarkerMaxGeneration {
		return 0, errors.New("coding: remote bridge marker generation is exhausted")
	}
	next++
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	// 从 writer 开始到路由赋值是一笔不可中断的提交；不能在文件已替换后因
	// context 取消而留下“新 marker、旧 route”的可路由性裂缝。
	if err := write(next); err != nil {
		return 0, err
	}
	if exists {
		b.rememberRetiredMarkerLocked(remoteBridgeMarkerIdentity{
			markerRoot: markerRoot, connectionID: current.connectionID,
			remoteRoot: current.remoteRoot, generation: current.generation,
		})
	}
	b.markerRoutes[markerRoot] = remoteBridgeMarkerRoute{
		connectionID: connectionID, remoteRoot: remoteRoot, generation: next,
	}
	return next, nil
}

func lockRemoteBridgeMarker(ctx context.Context, mutex *sync.Mutex) error {
	for {
		if mutex.TryLock() {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func lockRemoteBridgeRoute(ctx context.Context, mutex *sync.RWMutex) error {
	for {
		if mutex.TryLock() {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func (b *remoteBridge) rememberRetiredMarkerLocked(identity remoteBridgeMarkerIdentity) {
	if _, exists := b.retiredMarkerRoutes[identity]; exists {
		return
	}
	if len(b.retiredMarkerOrder) >= remoteBridgeRetiredMarkerLimit {
		oldest := b.retiredMarkerOrder[0]
		delete(b.retiredMarkerRoutes, oldest)
		b.retiredMarkerOrder = b.retiredMarkerOrder[1:]
	}
	b.retiredMarkerRoutes[identity] = struct{}{}
	b.retiredMarkerOrder = append(b.retiredMarkerOrder, identity)
}

// URL 返回 Node Host 专用的回环 URL；调用方不可把它展示或持久化给浏览器。
func (b *remoteBridge) URL() string {
	return "http://" + b.listener.Addr().String()
}

// Close 停止本地 bridge，不等待远端会话本身；manager 负责随后关闭 SSH。
func (b *remoteBridge) Close() error {
	var result error
	b.close.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		result = b.server.Shutdown(ctx)
		if result != nil {
			_ = b.server.Close()
		}
	})
	return result
}

func (b *remoteBridge) serveHTTP(writer http.ResponseWriter, request *http.Request) {
	if !bridgeAuthorized(request, b.token) {
		writeBridgeError(writer, http.StatusUnauthorized, "unauthorized")
		return
	}
	if !allowedBridgeRoute(request.Method, request.URL.Path) {
		writeBridgeError(writer, http.StatusNotFound, "not-found")
		return
	}
	connectionID, connectionIDOK := requiredBridgeHeader(request, "X-Coding-Remote-Connection")
	if !connectionIDOK || !remoteConnectionIDPattern.MatchString(connectionID) {
		writeBridgeError(writer, http.StatusBadRequest, "invalid-connection")
		return
	}
	if request.Method == http.MethodPost {
		mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
		if err != nil || mediaType != "application/json" {
			writeBridgeError(writer, http.StatusUnsupportedMediaType, "invalid-content-type")
			return
		}
	}
	body, err := io.ReadAll(http.MaxBytesReader(writer, request.Body, remoteBridgeMaxPayloadBytes))
	if err != nil {
		writeBridgeError(writer, http.StatusRequestEntityTooLarge, "too-large")
		return
	}
	identity, cleanup, markerError := bridgeMarkerIdentity(request, connectionID)
	if markerError != "" {
		writeBridgeError(writer, http.StatusBadRequest, markerError)
		return
	}
	// 保持读锁直到 Proxy 返回：若重绑先取得写锁，旧 identity 会在这里被
	// 拒绝；若本请求先取得读锁，它已经在重绑之前开始向旧连接 dispatch。
	// 不能在校验后立即解锁，否则写锁可在真正 Proxy 调用前插入。
	b.markerAdmissionMu.Lock()
	b.markerMu.RLock()
	b.markerAdmissionMu.Unlock()
	if !b.authorizesMarkerLocked(identity, cleanup, request.Method, request.URL.Path) {
		b.markerMu.RUnlock()
		writeBridgeError(writer, http.StatusConflict, "stale-marker")
		return
	}
	// 普通文件 I/O 没有 provider 层 deadline；保持 Host 请求自身 context，不能
	// 因 marker 互斥人为截断合法的大响应。publishMarker 的可取消 admission 会让
	// 重绑在自己的 selection deadline 内失败且不改变旧路由。
	status, response, err := b.proxy(request.Context(), connectionID, request.Method, request.URL.Path, body)
	b.markerMu.RUnlock()
	if err != nil {
		writeBridgeError(writer, http.StatusServiceUnavailable, "bridge-unavailable")
		return
	}
	if status < http.StatusOK || status > 599 || len(response) > int(remoteBridgeMaxPayloadBytes) {
		writeBridgeError(writer, http.StatusBadGateway, "invalid-agent-response")
		return
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_, _ = writer.Write(response)
}

func validBridgeMarkerRoot(value string) bool {
	return value != "" && len(value) <= remoteSSHMaxPathBytes && !strings.ContainsRune(value, '\x00') &&
		!strings.ContainsAny(value, "\r\n") && filepath.IsAbs(value) && filepath.Clean(value) == value
}

func requiredBridgeHeader(request *http.Request, name string) (string, bool) {
	values := request.Header.Values(name)
	return request.Header.Get(name), len(values) == 1 && values[0] != ""
}

func bridgeMarkerIdentity(request *http.Request, connectionID string) (remoteBridgeMarkerIdentity, bool, string) {
	markerRoot, markerRootOK := requiredBridgeHeader(request, remoteBridgeMarkerRootHeader)
	remoteRoot, remoteRootOK := requiredBridgeHeader(request, remoteBridgeRemoteRootHeader)
	generationText, generationOK := requiredBridgeHeader(request, remoteBridgeMarkerGenerationHeader)
	if !markerRootOK || !remoteRootOK || !generationOK || !validBridgeMarkerRoot(markerRoot) || !validCanonicalRemotePath(remoteRoot) {
		return remoteBridgeMarkerIdentity{}, false, "invalid-marker-identity"
	}
	generation, err := strconv.ParseUint(generationText, 10, 64)
	if err != nil || generation == 0 || strconv.FormatUint(generation, 10) != generationText {
		return remoteBridgeMarkerIdentity{}, false, "invalid-marker-identity"
	}
	cleanupValues := request.Header.Values(remoteBridgeCleanupHeader)
	cleanup := len(cleanupValues) == 1 && cleanupValues[0] == "1"
	if len(cleanupValues) > 0 && !cleanup {
		return remoteBridgeMarkerIdentity{}, false, "invalid-cleanup"
	}
	return remoteBridgeMarkerIdentity{
		markerRoot: markerRoot, connectionID: connectionID, remoteRoot: remoteRoot, generation: generation,
	}, cleanup, ""
}

func (b *remoteBridge) authorizesMarkerLocked(identity remoteBridgeMarkerIdentity, cleanup bool, method, requestPath string) bool {
	current, exists := b.markerRoutes[identity.markerRoot]
	if exists && current.connectionID == identity.connectionID && current.remoteRoot == identity.remoteRoot && current.generation == identity.generation {
		return true
	}
	if !cleanup || !isRetiredCleanupRoute(method, requestPath) {
		return false
	}
	_, retired := b.retiredMarkerRoutes[identity]
	return retired
}

// isRetiredCleanupRoute 保持最小化：旧 owner 只能终止已发布资源，不能读取、
// 写入、分配或继续执行。agent 仍会校验资源 id 是否属于该连接。
func isRetiredCleanupRoute(method, requestPath string) bool {
	if method != http.MethodPost {
		return false
	}
	switch requestPath {
	case "/v1/processes/kill", "/v1/terminals/terminate", "/v1/code/cancel":
		return true
	default:
		return false
	}
}

func allowedBridgeRoute(method, path string) bool {
	switch path {
	case "/v1/resolve", "/v1/stat", "/v1/directories", "/v1/read_file", "/v1/read_bytes", "/v1/update_file", "/v1/edit_file", "/v1/exec", "/v1/search", "/v1/code/start", "/v1/code/next", "/v1/code/reply", "/v1/code/cancel", "/v1/terminals/start", "/v1/terminals/read", "/v1/terminals/write", "/v1/terminals/foreground", "/v1/terminals/signal", "/v1/terminals/terminate", "/v1/processes/resolve", "/v1/processes/start", "/v1/processes/read", "/v1/processes/write", "/v1/processes/wait", "/v1/processes/kill":
		return method == http.MethodPost
	default:
		return false
	}
}

func bridgeAuthorized(request *http.Request, expected string) bool {
	parts := strings.Fields(request.Header.Get("Authorization"))
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return false
	}
	value := parts[1]
	return len(value) == len(expected) && subtle.ConstantTimeCompare([]byte(value), []byte(expected)) == 1
}

func writeBridgeError(writer http.ResponseWriter, status int, code string) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_, _ = writer.Write([]byte(`{"error":{"code":"` + code + `"}}` + "\n"))
}
