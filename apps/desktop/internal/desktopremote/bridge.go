package desktopremote

import (
	"context"
	"crypto/subtle"
	"encoding/json"
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

	"github.com/deepseek-ai/coding/apps/desktop/internal/remoteagent"
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

// Proxy 是本地 bridge 交给 SSH manager 的单个无状态请求。返回体
// 必须已是远端 agent 的 JSON；bridge 不解释业务字段，以免丢失文件工具的错误码。
type Proxy func(ctx context.Context, connectionID, method, path string, body []byte) (status int, response []byte, err error)

// MarkerIdentity 绑定本次发布的精确路由世代，不包含 bearer 或 SSH 凭据。
type MarkerIdentity struct {
	MarkerRoot   string
	RemoteRoot   string
	ConnectionID string
	Generation   uint64
}

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

// Bridge 仅监听本机回环地址，供本地 Node Host 转发 marker 工作区的 I/O。
// SSH bearer token 由 manager 保留；Node 仅持有此桥接器的窗口私有 token。
type Bridge struct {
	token      string
	proxy      Proxy
	connection func(string) (remoteagent.ConnectionInfo, error)
	listener   net.Listener
	server     *http.Server
	close      sync.Once

	// markerMu 在整个 Proxy 调用期间保持读锁。这样 marker 写入在获得写锁前
	// 不会改变路由，而写锁释放后旧 generation 也无法再开始 dispatch。
	// markerAdmissionMu 让 writer 能在等待既有读者时先阻止新读者；配合
	// TryLock+ctx 轮询，选择超时不会被一个未取消的 RWMutex.Lock 永久吞掉。
	markerAdmissionMu   sync.Mutex
	markerMu            sync.RWMutex
	markerRoutes        map[string]remoteBridgeMarkerRoute
	retiredMarkerRoutes map[remoteBridgeMarkerIdentity]struct{}
	retiredMarkerOrder  []remoteBridgeMarkerIdentity

	// reconnect 让桥接器在连接丢失时按保存的档案自动重连并重新发布 marker。
	// nil 表示该部署不支持自动重连，请求按过期身份直接失败。
	reconnect func(ctx context.Context, markerRoot string) error
	// reconnectMu 序列化同一 marker 根的重连，避免并发请求各发起一轮 SSH 握手。
	reconnectMu  sync.Mutex
	reconnecting map[string]chan struct{}
	// reconnectCool 记录每个 marker 根上一次成功自动重连的时间：一串携带旧身份的
	// 请求在重连后仍可能抵达，冷却期内直接按过期拒绝，不再各触发一轮 SSH 握手。
	reconnectCool map[string]time.Time
}

// NewBridge 启动一个随机回环端口的 HTTP bridge。
func NewBridge(token string, proxy Proxy) (*Bridge, error) {
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
	bridge := &Bridge{
		token: token, proxy: proxy, listener: listener,
		markerRoutes:        map[string]remoteBridgeMarkerRoute{},
		retiredMarkerRoutes: map[remoteBridgeMarkerIdentity]struct{}{},
		reconnecting:        map[string]chan struct{}{},
		reconnectCool:       map[string]time.Time{},
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

// PublishMarker 将 marker 文件替换和 bridge 路由切换串行化。调用方仍须用
// Service.remoteMarkerMu 串行化同一 marker 的选择事务；本方法不把 marker 文件当作
// 可供任意进程使用的锁。文件替换失败时内存路由保持旧值。
func (b *Bridge) PublishMarker(
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

// RevokeMarker 在阻止新代理请求且既有请求结束后，核对当前世代与磁盘身份并撤销。
// 磁盘核对/删除由调用方提供，必须在返回 true 前完成；失败时路由保持不变。
func (b *Bridge) RevokeMarker(ctx context.Context, identity MarkerIdentity, remove func() (bool, error)) (bool, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if remove == nil || !validBridgeMarkerRoot(identity.MarkerRoot) || !validCanonicalRemotePath(identity.RemoteRoot) ||
		!remoteConnectionIDPattern.MatchString(identity.ConnectionID) || identity.Generation == 0 {
		return false, errors.New("coding: invalid marker revocation")
	}
	if err := lockRemoteBridgeMarker(ctx, &b.markerAdmissionMu); err != nil {
		return false, err
	}
	defer b.markerAdmissionMu.Unlock()
	if err := lockRemoteBridgeRoute(ctx, &b.markerMu); err != nil {
		return false, err
	}
	defer b.markerMu.Unlock()
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if !b.currentMarkerLocked(identity) {
		return false, nil
	}
	removed, err := remove()
	if err != nil || !removed {
		return false, err
	}
	delete(b.markerRoutes, identity.MarkerRoot)
	return true, nil
}

// CurrentMarker 核对 bridge 路由与磁盘身份，用于交付确认前拒绝过期选择。
func (b *Bridge) CurrentMarker(ctx context.Context, identity MarkerIdentity, verify func() bool) bool {
	if verify == nil {
		return false
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if lockRemoteBridgeMarker(ctx, &b.markerAdmissionMu) != nil {
		return false
	}
	if lockRemoteBridgeRouteRead(ctx, &b.markerMu) != nil {
		b.markerAdmissionMu.Unlock()
		return false
	}
	b.markerAdmissionMu.Unlock()
	defer b.markerMu.RUnlock()
	return b.currentMarkerLocked(identity) && verify()
}

func lockRemoteBridgeRouteRead(ctx context.Context, mutex *sync.RWMutex) error {
	for {
		if mutex.TryRLock() {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func (b *Bridge) currentMarkerLocked(identity MarkerIdentity) bool {
	current, exists := b.markerRoutes[identity.MarkerRoot]
	return exists && current.connectionID == identity.ConnectionID &&
		current.remoteRoot == identity.RemoteRoot && current.generation == identity.Generation
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

func (b *Bridge) rememberRetiredMarkerLocked(identity remoteBridgeMarkerIdentity) {
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
func (b *Bridge) URL() string {
	return "http://" + b.listener.Addr().String()
}

// Close 停止本地 bridge，不等待远端会话本身；manager 负责随后关闭 SSH。
func (b *Bridge) Close() error {
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

func (b *Bridge) serveHTTP(writer http.ResponseWriter, request *http.Request) {
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
		// 路由表只在内存里：桥接器重启后它为空，而磁盘 marker 仍是上一次发布的身份。
		// 该身份指向一条活连接时按需采纳，恢复出来的会话因此不必先手动重连；已有
		// 路由时绝不采纳，旧文件不能覆盖新一轮重绑。
		if !b.adoptMarker(identity, cleanup) {
			// 连接已经不在（重启、断线或超时）时，用保存的档案自动重连一次并重新
			// 发布 marker，然后在这条新路由上继续这次请求。重连失败仍然快速失败。
			repaired, ok := b.reconnectMarker(request.Context(), identity, cleanup)
			if !ok {
				writeBridgeError(writer, http.StatusConflict, "stale-marker")
				return
			}
			identity = repaired
		}
		b.markerMu.RLock()
	}
	// 采纳或自动重连之后，本请求按路由上的连接继续；请求头里的连接 id 只用于
	// 校验身份，不再参与 dispatch。
	connectionID = identity.connectionID
	if b.connection != nil {
		info, lookupErr := b.connection(connectionID)
		if lookupErr != nil {
			// 身份仍在路由上，但那条连接已经断开（会话中途掉线）：同样自动重连一次，
			// 在这条新连接上继续。重连要发布 marker（写锁），因此先放开本次读锁，
			// 否则两边互等。
			b.markerMu.RUnlock()
			repaired, ok := b.reconnectMarker(request.Context(), identity, cleanup)
			b.markerMu.RLock()
			if ok {
				identity = repaired
				connectionID = identity.connectionID
				info, lookupErr = b.connection(connectionID)
			}
		}
		if lookupErr != nil || info.Mode != remoteagent.ModeAgent && info.Mode != remoteagent.ModeBasic {
			b.markerMu.RUnlock()
			writeBridgeError(writer, http.StatusConflict, "stale-marker")
			return
		}
		if info.Mode == remoteagent.ModeBasic {
			if !remoteagent.IsBasicRoute(request.Method, request.URL.Path) {
				b.markerMu.RUnlock()
				writeBridgeError(writer, http.StatusNotImplemented, "unsupported-capability")
				return
			}
			var payload struct {
				Root string `json:"root"`
			}
			if json.Unmarshal(body, &payload) != nil || payload.Root != identity.remoteRoot {
				b.markerMu.RUnlock()
				writeBridgeError(writer, http.StatusBadRequest, "invalid-root")
				return
			}
		}
	}
	// 普通文件 I/O 没有 provider 层 deadline；保持 Host 请求自身 context，不能
	// 因 marker 互斥人为截断合法的大响应。PublishMarker 的可取消 admission 会让
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

// reconnectMarker 在一个 marker 根因连接丢失而无法路由时自动重连一次。
//
// 只在该身份指向的连接已经不存在时触发：此时请求尚未 dispatch，重连后重试不会
// 重复执行变更。同一 marker 根的并发请求共享同一次重连——等待在途的那一轮，而不是
// 各发起一轮 SSH 握手。重连成功后重新发布 marker，调用方用返回的新身份继续请求。
// @param ctx - 本次请求的 context，用于约束重连等待。
// @param identity - 请求携带的 marker 身份。
// @param cleanup - 清理请求不参与重连。
// @returns 重连后的路由身份；不可重连或重连失败时为 false。
func (b *Bridge) reconnectMarker(
	ctx context.Context,
	identity remoteBridgeMarkerIdentity,
	cleanup bool,
) (remoteBridgeMarkerIdentity, bool) {
	if cleanup || b.reconnect == nil || b.connection == nil {
		return identity, false
	}
	// 只有“这条连接已经不在了”才值得重连：世代不符是真正的过期身份，重连也不该
	// 替它兜底，否则任何旧请求都能触发一轮 SSH 握手。
	if _, err := b.connection(identity.connectionID); !errors.Is(err, remoteagent.ErrConnectionNotFound) {
		return identity, false
	}
	if b.reconnectingRecently(identity.markerRoot) {
		return identity, false
	}
	waited, leader := b.beginReconnect(identity.markerRoot)
	defer b.endReconnect(identity.markerRoot, leader)
	if !leader {
		select {
		case <-waited:
		case <-ctx.Done():
			return identity, false
		}
		return b.currentRoute(identity.markerRoot)
	}
	if err := b.reconnect(ctx, identity.markerRoot); err != nil {
		return identity, false
	}
	b.noteReconnect(identity.markerRoot)
	return b.currentRoute(identity.markerRoot)
}

// reconnectCooldown 是自动重连后的静默期：期间携带旧身份的请求直接按过期拒绝。
const reconnectCooldown = 5 * time.Second

// reconnectingRecently 报告该 marker 根是否还在自动重连的冷却期内。
func (b *Bridge) reconnectingRecently(markerRoot string) bool {
	b.reconnectMu.Lock()
	defer b.reconnectMu.Unlock()
	last, ok := b.reconnectCool[markerRoot]
	return ok && time.Since(last) < reconnectCooldown
}

// noteReconnect 记录一次成功的自动重连时间。
func (b *Bridge) noteReconnect(markerRoot string) {
	b.reconnectMu.Lock()
	defer b.reconnectMu.Unlock()
	b.reconnectCool[markerRoot] = time.Now()
}

// beginReconnect 让同一 marker 根同时只有一个重连，其余调用方等待那一轮。
// @returns 等待完成信号，以及本次调用是否负责执行重连。
func (b *Bridge) beginReconnect(markerRoot string) (chan struct{}, bool) {
	b.reconnectMu.Lock()
	defer b.reconnectMu.Unlock()
	if pending, ok := b.reconnecting[markerRoot]; ok {
		return pending, false
	}
	pending := make(chan struct{})
	b.reconnecting[markerRoot] = pending
	return pending, true
}

// endReconnect 结束一轮重连并唤醒等待者。
func (b *Bridge) endReconnect(markerRoot string, leader bool) {
	if !leader {
		return
	}
	b.reconnectMu.Lock()
	pending := b.reconnecting[markerRoot]
	delete(b.reconnecting, markerRoot)
	b.reconnectMu.Unlock()
	if pending != nil {
		close(pending)
	}
}

// currentRoute 读取该 marker 根当前发布的路由身份。
func (b *Bridge) currentRoute(markerRoot string) (remoteBridgeMarkerIdentity, bool) {
	b.markerMu.RLock()
	defer b.markerMu.RUnlock()
	route, exists := b.markerRoutes[markerRoot]
	if !exists {
		return remoteBridgeMarkerIdentity{}, false
	}
	return remoteBridgeMarkerIdentity{
		markerRoot:   markerRoot,
		connectionID: route.connectionID,
		remoteRoot:   route.remoteRoot,
		generation:   route.generation,
	}, true
}

// adoptMarker 在内存路由缺失时，按请求携带的 marker 身份恢复路由。
//
// 桥接器只把路由保存在内存，进程或 helper 重启后路由为空，磁盘 marker 仍是上一次
// 发布的结果。此时只要该身份仍指向一条活连接，就把它采纳回路由表，让重启后恢复的
// 会话直接可用；`markerRoute` 已存在时一律拒绝，旧文件不能覆盖新一轮重绑，退役清理
// 请求也不参与采纳。连接模式、能力与请求根目录的校验仍由后续常规检查负责。
// @param identity - 请求头携带的 marker 身份。
// @param cleanup - 该请求是否声明为已退役资源的清理路由。
// @returns 采纳成功时为 true。
func (b *Bridge) adoptMarker(identity remoteBridgeMarkerIdentity, cleanup bool) bool {
	if cleanup || b.connection == nil {
		return false
	}
	if _, err := b.connection(identity.connectionID); err != nil {
		return false
	}
	b.markerMu.Lock()
	defer b.markerMu.Unlock()
	if _, exists := b.markerRoutes[identity.markerRoot]; exists {
		return false
	}
	b.markerRoutes[identity.markerRoot] = remoteBridgeMarkerRoute{
		connectionID: identity.connectionID,
		remoteRoot:   identity.remoteRoot,
		generation:   identity.generation,
	}
	return true
}

func (b *Bridge) authorizesMarkerLocked(identity remoteBridgeMarkerIdentity, cleanup bool, method, requestPath string) bool {
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
	case "/v1/resolve", "/v1/stat", "/v1/directories", "/v1/read_file", "/v1/read_bytes", "/v1/update_file", "/v1/edit_file", "/v1/remove_file", "/v1/exec", "/v1/search", "/v1/code/start", "/v1/code/next", "/v1/code/reply", "/v1/code/cancel", "/v1/terminals/start", "/v1/terminals/read", "/v1/terminals/write", "/v1/terminals/resize", "/v1/terminals/foreground", "/v1/terminals/signal", "/v1/terminals/terminate", "/v1/processes/resolve", "/v1/processes/start", "/v1/processes/read", "/v1/processes/write", "/v1/processes/wait", "/v1/processes/kill":
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
