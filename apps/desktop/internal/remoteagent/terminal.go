package remoteagent

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
)

const (
	defaultTerminalPollWait       = 25 * time.Second
	maxTerminalPollWait           = 60 * time.Second
	defaultTerminalRetention      = 2 * time.Minute
	defaultTerminalGrace          = 2 * time.Second
	maxTerminalGrace              = 60 * time.Second
	maxTerminalRows               = 1_000
	maxTerminalCols               = 1_000
	maxTerminalArgv               = 256
	maxTerminalArgvBytes          = 64 << 10
	maxTerminalEnvironmentEntries = 256
	maxTerminalEnvironmentBytes   = 128 << 10
	maxTerminalSessions           = 32
	maxTerminalOutputBytes        = 8 << 20
	maxTerminalWriteBytes         = 64 << 10
	terminalInputQueueSize        = 16
	terminalReadBufferSize        = 32 << 10
	terminalDrainTimeout          = time.Second
)

// ErrTerminalNotFound 表示终端不存在、已过期或服务已关闭。
var ErrTerminalNotFound = errors.New("remote terminal: terminal not found")

// ErrTerminalClosed 表示顶层进程已退出，不能继续写入或控制。
var ErrTerminalClosed = errors.New("remote terminal: terminal is closed")

// ErrTerminalUnavailable 表示当前平台没有安全可用的真实 PTY 实现。
var ErrTerminalUnavailable = errors.New("remote terminal: PTY is unavailable on this platform")

// ErrTerminalNoForeground 表示控制终端尚未公布可操作的前台进程组。
var ErrTerminalNoForeground = errors.New("remote terminal: foreground process group is unavailable")

// ErrTerminalRootKillRefused 防止 signal API 销毁其管理的根 shell。
var ErrTerminalRootKillRefused = errors.New("remote terminal: refusing to SIGKILL the terminal root")

// ErrTerminalInputBackpressure 表示远端输入队列已满，调用方应稍后重试。
var ErrTerminalInputBackpressure = errors.New("remote terminal: input queue is full")

// ErrTerminalStartConflict 表示同一 root+startNonce 被不同启动载荷复用。
var ErrTerminalStartConflict = errors.New("remote terminal: start nonce conflicts with an existing request")

// terminalBackend 把平台相关的 PTY 分配、前台组和终止动作与 HTTP 会话分开。
// Wait 只等待顶层进程；调用者负责在 drain 输出后关闭主端。
type terminalBackend interface {
	io.ReadWriteCloser
	PID() int
	Wait() terminalExit
	Foreground() (int, error)
	SignalForeground(signal string) (int, error)
	Terminate() error
	ForceTerminate() error
}

type terminalExit struct {
	exitCode *int
	signal   string
}

// TerminalSessionsOptions 配置远端 PTY 的总量、长轮询、输出保留和清理时间。
type TerminalSessionsOptions struct {
	PollWait       time.Duration
	Retention      time.Duration
	MaxSessions    int
	MaxOutputBytes int
}

// TerminalSessions 维护一台 remote agent 内所有实际 PTY 的所有权。
// 它独立于 HTTP，可由 Server 的 shutdown 路径统一终止。
type TerminalSessions struct {
	pollWait       time.Duration
	retention      time.Duration
	maxSessions    int
	maxOutputBytes int
	startBackend   func(string, TerminalStartRequest) (terminalBackend, error)

	mu       sync.Mutex
	sessions map[string]*terminalSession
	starts   map[terminalStartKey]*terminalStart
	starting map[*terminalStart]struct{}
	closed   bool
	changed  chan struct{}

	closeOnce sync.Once
	closeDone chan struct{}
	closing   []*terminalSession
}

// terminalStart 记录尚未发布到 sessions 表的 PTY 分配和带 nonce 的首个启动
// 结果。关闭截止时间也会把它标记为 force，这样分配在稍后返回时仍会立即强杀，
// 不能绕开 Close 的回收。
type terminalStart struct {
	backend     terminalBackend
	force       bool
	fingerprint [sha256.Size]byte
	done        chan struct{}
	response    TerminalStartResponse
	err         error
}

// terminalStartKey 把启动重试限制在同一个启动时固化的工作区 owner key 内。
type terminalStartKey struct {
	root  string
	nonce string
}

type terminalSession struct {
	backend     terminalBackend
	onClosed    func()
	root        string
	grace       time.Duration
	startKey    *terminalStartKey
	startRecord *terminalStart

	mu               sync.Mutex
	chunks           []terminalOutputChunk
	outputBytes      int
	cursor           uint64
	discardedThrough uint64
	exited           bool
	exit             terminalExit
	closed           bool
	inputFailed      bool
	notify           chan struct{}
	processDone      chan struct{}
	readerDone       chan struct{}
	closedDone       chan struct{}
	input            chan []byte

	terminateOnce sync.Once
	terminateDone chan struct{}
	terminateErr  error
}

type terminalOutputChunk struct {
	sequence uint64
	data     []byte
}

// NewTerminalSessions 创建一个会话表。Windows 仍可创建该表，但 start 会以
// ErrTerminalUnavailable 安全失败，不会退化为普通 pipe 子进程。
func NewTerminalSessions(options TerminalSessionsOptions) *TerminalSessions {
	if options.PollWait <= 0 {
		options.PollWait = defaultTerminalPollWait
	}
	if options.PollWait > maxTerminalPollWait {
		options.PollWait = maxTerminalPollWait
	}
	if options.Retention <= 0 {
		options.Retention = defaultTerminalRetention
	}
	if options.MaxSessions <= 0 {
		options.MaxSessions = maxTerminalSessions
	}
	if options.MaxOutputBytes <= 0 {
		options.MaxOutputBytes = maxTerminalOutputBytes
	}
	return &TerminalSessions{
		pollWait: options.PollWait, retention: options.Retention,
		maxSessions: options.MaxSessions, maxOutputBytes: options.MaxOutputBytes,
		startBackend: startTerminalBackend,
		sessions:     make(map[string]*terminalSession), starts: make(map[terminalStartKey]*terminalStart),
		starting: make(map[*terminalStart]struct{}), changed: make(chan struct{}),
		closeDone: make(chan struct{}),
	}
}

// Start 在已验证的远端目录中分配真实 PTY。相同 root+startNonce 的重试等待
// 首个启动并返回同一会话引用；不同载荷不能借 nonce 启动另一台终端。
func (sessions *TerminalSessions) Start(request TerminalStartRequest) (response TerminalStartResponse, returned error) {
	if err := validateTerminalStart(request); err != nil {
		return TerminalStartResponse{}, err
	}
	root, err := canonicalSessionRoot(request.Root)
	if err != nil {
		return TerminalStartResponse{}, err
	}
	ownerRoot, err := sessionOwnerRoot(request.Root)
	if err != nil {
		return TerminalStartResponse{}, err
	}
	fingerprint, err := terminalStartFingerprint(request)
	if err != nil {
		return TerminalStartResponse{}, err
	}
	startKey := terminalStartKey{root: ownerRoot, nonce: request.StartNonce}
	starting, owner, err := sessions.claimStart(startKey, fingerprint)
	if err != nil {
		return TerminalStartResponse{}, err
	}
	if !owner {
		return waitTerminalStart(starting)
	}
	defer func() { sessions.finishStart(startKey, starting, response, returned) }()

	path, err := resolveScopedPath(request.Root, request.Path, false)
	if err != nil {
		return TerminalStartResponse{}, err
	}
	if root != "" && !pathWithin(root, path) {
		return TerminalStartResponse{}, fail(403, "outside-root", "terminal path is outside the requested root")
	}
	backend, err := sessions.startBackend(path, request)
	if err != nil {
		return TerminalStartResponse{}, err
	}
	if sessions.attachStartingBackend(starting, backend) {
		discardUnpublishedTerminal(backend)
		return TerminalStartResponse{}, ErrTerminalNotFound
	}
	id, err := newTerminalID()
	if err != nil {
		discardUnpublishedTerminal(backend)
		return TerminalStartResponse{}, err
	}
	session := &terminalSession{
		backend: backend, root: ownerRoot, grace: terminalGrace(request), input: make(chan []byte, terminalInputQueueSize),
		notify: make(chan struct{}), processDone: make(chan struct{}), readerDone: make(chan struct{}),
		closedDone: make(chan struct{}), terminateDone: make(chan struct{}),
	}
	session.startKey = &startKey
	session.startRecord = starting
	session.onClosed = func() {
		time.AfterFunc(sessions.retention, func() { sessions.remove(id, session) })
	}
	if err := sessions.publish(id, session); err != nil {
		discardUnpublishedTerminal(backend)
		return TerminalStartResponse{}, err
	}
	session.start(sessions.maxOutputBytes)
	return TerminalStartResponse{ID: id, PID: backend.PID()}, nil
}

// Read 长轮询 after 之后仍保留的输出。连接中断只结束本次 poll，PTY 继续运行。
func (sessions *TerminalSessions) Read(ctx context.Context, request TerminalReadRequest) (TerminalReadResponse, error) {
	session, err := sessions.sessionForRoot(request.ID, request.Root)
	if err != nil {
		return TerminalReadResponse{}, err
	}
	wait, err := sessions.pollDuration(request.WaitMs)
	if err != nil {
		return TerminalReadResponse{}, err
	}
	return session.read(ctx, request.After, wait), nil
}

// Write 将已验证的原始字节放入终端的有界输入队列。
func (sessions *TerminalSessions) Write(request TerminalWriteRequest) error {
	session, err := sessions.sessionForRoot(request.ID, request.Root)
	if err != nil {
		return err
	}
	if len(request.DataBase64) > base64.StdEncoding.EncodedLen(maxTerminalWriteBytes) {
		return fail(413, "terminal-input-too-large", "terminal input exceeds the byte limit")
	}
	data, err := base64.StdEncoding.DecodeString(request.DataBase64)
	if err != nil {
		return errors.New("remote terminal: input must be valid base64")
	}
	if len(data) > maxTerminalWriteBytes {
		return fail(413, "terminal-input-too-large", "terminal input exceeds the byte limit")
	}
	return session.write(data)
}

// Foreground 返回控制终端当前公布的前台进程组。
func (sessions *TerminalSessions) Foreground(request TerminalForegroundRequest) (TerminalForegroundResponse, error) {
	session, err := sessions.sessionForRoot(request.ID, request.Root)
	if err != nil {
		return TerminalForegroundResponse{}, err
	}
	return session.foreground()
}

// SignalForeground 向控制终端当前公布的前台进程组发送一个受限 POSIX 信号。
func (sessions *TerminalSessions) SignalForeground(request TerminalSignalRequest) (TerminalSignalResponse, error) {
	session, err := sessions.sessionForRoot(request.ID, request.Root)
	if err != nil {
		return TerminalSignalResponse{}, err
	}
	group, err := session.signalForeground(request.Signal)
	if err != nil {
		return TerminalSignalResponse{}, err
	}
	return TerminalSignalResponse{ProcessGroupID: group}, nil
}

// Terminate 幂等终止会话并等待其输出 drain 和顶层进程退出。
func (sessions *TerminalSessions) Terminate(ctx context.Context, request TerminalTerminateRequest) error {
	session, err := sessions.sessionForRoot(request.ID, request.Root)
	if err != nil {
		return err
	}
	return session.terminate(ctx)
}

// Close 关闭注册表、终止全部 PTY 并等待它们收敛。context 到期时强制杀掉
// 会话树并关闭 PTY 主端；后台 worker 仍会等待 Wait 路径回收子进程。
func (sessions *TerminalSessions) Close(ctx context.Context) {
	sessions.closeOnce.Do(func() {
		sessions.mu.Lock()
		sessions.closed = true
		sessions.wakeChangedLocked()
		sessions.mu.Unlock()
		go sessions.closeWorker()
	})
	select {
	case <-sessions.closeDone:
	case <-ctx.Done():
		sessions.forceClosing()
	}
}

func (sessions *TerminalSessions) session(id string) *terminalSession {
	if id == "" {
		return nil
	}
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	return sessions.sessions[id]
}

// sessionForRoot 不区分未知 id 与不匹配的根，防止一个 marker 工作区控制另一
// 个 marker 工作区已发布的 PTY。
func (sessions *TerminalSessions) sessionForRoot(id, root string) (*terminalSession, error) {
	ownerRoot, err := sessionOwnerRoot(root)
	if err != nil {
		return nil, err
	}
	session := sessions.session(id)
	if session == nil || session.root != ownerRoot {
		return nil, ErrTerminalNotFound
	}
	return session, nil
}

func (sessions *TerminalSessions) remove(id string, expected *terminalSession) {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	if sessions.sessions[id] == expected {
		delete(sessions.sessions, id)
		if expected.startKey != nil && sessions.starts[*expected.startKey] == expected.startRecord {
			delete(sessions.starts, *expected.startKey)
		}
	}
}

// claimStart 为首次带 nonce 的启动预留 PTY 容量；相同指纹加入首个启动的结果，
// 冲突指纹立即拒绝。它沿用 starting 集合，故 Close 也会等待或强杀未发布 PTY。
func (sessions *TerminalSessions) claimStart(
	key terminalStartKey,
	fingerprint [sha256.Size]byte,
) (*terminalStart, bool, error) {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	if sessions.closed {
		return nil, false, ErrTerminalNotFound
	}
	if existing := sessions.starts[key]; existing != nil {
		if existing.fingerprint != fingerprint {
			return nil, false, ErrTerminalStartConflict
		}
		return existing, false, nil
	}
	if len(sessions.sessions)+len(sessions.starting) >= sessions.maxSessions {
		return nil, false, fail(429, "too-many-terminals", "remote terminal limit is reached")
	}
	starting := &terminalStart{fingerprint: fingerprint, done: make(chan struct{})}
	sessions.starts[key] = starting
	sessions.starting[starting] = struct{}{}
	return starting, true, nil
}

// attachStartingBackend 将一个已创建但尚未发布的 PTY 纳入关闭截止时间的强杀
// 集合。返回 true 时 Close 已要求强杀，调用方不得再把它发布给 HTTP 调用方。
func (sessions *TerminalSessions) attachStartingBackend(starting *terminalStart, backend terminalBackend) bool {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	if _, exists := sessions.starting[starting]; !exists {
		return true
	}
	starting.backend = backend
	return starting.force
}

// finishStart 发布首个终端启动的稳定结果。没有会话的失败不保留 nonce，成功
// 记录与已发布 session 一同保留到 retention 结束。
func (sessions *TerminalSessions) finishStart(
	key terminalStartKey,
	starting *terminalStart,
	response TerminalStartResponse,
	err error,
) {
	sessions.mu.Lock()
	starting.response = response
	starting.err = err
	close(starting.done)
	if err != nil && sessions.starts[key] == starting {
		delete(sessions.starts, key)
	}
	delete(sessions.starting, starting)
	sessions.wakeChangedLocked()
	sessions.mu.Unlock()
}

// waitTerminalStart 等待同一个 nonce 的首个启动完成，并返回首个分配得到的
// session id/PID；它不读取动态状态，避免响应断开后的 retry 看到另一台 PTY。
func waitTerminalStart(starting *terminalStart) (TerminalStartResponse, error) {
	<-starting.done
	if starting.err != nil {
		return TerminalStartResponse{}, starting.err
	}
	return starting.response, nil
}

func (sessions *TerminalSessions) publish(id string, session *terminalSession) error {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	if sessions.closed {
		return ErrTerminalNotFound
	}
	sessions.sessions[id] = session
	sessions.wakeChangedLocked()
	return nil
}

func (sessions *TerminalSessions) wakeChangedLocked() {
	close(sessions.changed)
	sessions.changed = make(chan struct{})
}

func (sessions *TerminalSessions) closeWorker() {
	sessions.mu.Lock()
	for len(sessions.starting) > 0 {
		changed := sessions.changed
		sessions.mu.Unlock()
		<-changed
		sessions.mu.Lock()
	}
	all := make([]*terminalSession, 0, len(sessions.sessions))
	for _, session := range sessions.sessions {
		all = append(all, session)
	}
	sessions.sessions = make(map[string]*terminalSession)
	sessions.closing = all
	sessions.mu.Unlock()
	for _, session := range all {
		session.startTermination()
	}
	var group sync.WaitGroup
	group.Add(len(all))
	for _, session := range all {
		go func(session *terminalSession) {
			defer group.Done()
			<-session.closedDone
		}(session)
	}
	group.Wait()
	close(sessions.closeDone)
}

func (sessions *TerminalSessions) forceClosing() {
	sessions.mu.Lock()
	all := append([]*terminalSession(nil), sessions.closing...)
	for _, session := range sessions.sessions {
		all = append(all, session)
	}
	unpublished := make([]terminalBackend, 0, len(sessions.starting))
	for starting := range sessions.starting {
		starting.force = true
		if starting.backend != nil {
			unpublished = append(unpublished, starting.backend)
		}
	}
	sessions.mu.Unlock()
	for _, session := range all {
		session.forceTerminate()
	}
	for _, backend := range unpublished {
		_ = backend.ForceTerminate()
		_ = backend.Close()
	}
}

func (sessions *TerminalSessions) pollDuration(waitMs int64) (time.Duration, error) {
	if waitMs == 0 {
		return sessions.pollWait, nil
	}
	if waitMs < 0 {
		return 0, errors.New("remote terminal: waitMs cannot be negative")
	}
	if waitMs > maxTerminalPollWait.Milliseconds() {
		return 0, fmt.Errorf("remote terminal: waitMs exceeds %s", maxTerminalPollWait)
	}
	return time.Duration(waitMs) * time.Millisecond, nil
}

func discardUnpublishedTerminal(backend terminalBackend) {
	// 已经无法向调用方发布的 PTY 没有保留输出或宽限退出的价值。直接强杀并关闭
	// 主端，再等待其顶层进程被 reap；这也覆盖 Close 与 Start 之间的竞态。
	_ = backend.ForceTerminate()
	_ = backend.Close()
	_ = backend.Wait()
}

func (session *terminalSession) start(maxOutputBytes int) {
	go session.readLoop(maxOutputBytes)
	go session.writeLoop()
	go session.waitLoop()
}

func (session *terminalSession) readLoop(maxOutputBytes int) {
	defer close(session.readerDone)
	buffer := make([]byte, terminalReadBufferSize)
	for {
		count, err := session.backend.Read(buffer)
		if count > 0 {
			session.appendOutput(buffer[:count], maxOutputBytes)
		}
		if err != nil {
			return
		}
	}
}

func (session *terminalSession) writeLoop() {
	for {
		select {
		case data, open := <-session.input:
			if !open {
				return
			}
			if err := writeTerminalAll(session.backend, data); err != nil {
				session.mu.Lock()
				session.inputFailed = true
				session.wakeLocked()
				session.mu.Unlock()
				return
			}
		case <-session.closedDone:
			return
		}
	}
}

func (session *terminalSession) waitLoop() {
	exit := session.backend.Wait()
	session.mu.Lock()
	session.exited = true
	session.exit = exit
	session.wakeLocked()
	session.mu.Unlock()
	close(session.processDone)
	select {
	case <-session.readerDone:
	case <-time.After(terminalDrainTimeout):
		_ = session.backend.Close()
		<-session.readerDone
	}
	_ = session.backend.Close()
	session.mu.Lock()
	if !session.closed {
		session.closed = true
		session.wakeLocked()
	}
	session.mu.Unlock()
	// 与 write() 共用 mutex 后再关闭输入队列，避免一个已经通过 closed 检查的
	// 写入与 close(input) 竞态并触发 send-on-closed-channel。
	session.mu.Lock()
	close(session.input)
	close(session.closedDone)
	session.mu.Unlock()
	if session.onClosed != nil {
		session.onClosed()
	}
}

func (session *terminalSession) appendOutput(data []byte, maxOutputBytes int) {
	copyData := append([]byte(nil), data...)
	session.mu.Lock()
	defer session.mu.Unlock()
	session.cursor++
	session.chunks = append(session.chunks, terminalOutputChunk{sequence: session.cursor, data: copyData})
	session.outputBytes += len(copyData)
	for session.outputBytes > maxOutputBytes && len(session.chunks) > 0 {
		removed := session.chunks[0]
		session.chunks = session.chunks[1:]
		session.outputBytes -= len(removed.data)
		session.discardedThrough = removed.sequence
	}
	session.wakeLocked()
}

func (session *terminalSession) read(ctx context.Context, after uint64, wait time.Duration) TerminalReadResponse {
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		session.mu.Lock()
		response := session.responseAfterLocked(after)
		notify := session.notify
		ready := len(response.Chunks) > 0 || response.Closed || response.Truncated
		session.mu.Unlock()
		if ready {
			return response
		}
		select {
		case <-ctx.Done():
			return response
		case <-timer.C:
			return response
		case <-notify:
		}
	}
}

func (session *terminalSession) responseAfterLocked(after uint64) TerminalReadResponse {
	first := len(session.chunks)
	for index, chunk := range session.chunks {
		if chunk.sequence > after {
			first = index
			break
		}
	}
	chunks := make([]TerminalOutputChunk, 0, len(session.chunks)-first)
	for _, chunk := range session.chunks[first:] {
		chunks = append(chunks, TerminalOutputChunk{
			Sequence: chunk.sequence, DataBase64: base64.StdEncoding.EncodeToString(chunk.data),
		})
	}
	response := TerminalReadResponse{
		Chunks: chunks, Cursor: session.cursor, Closed: session.closed,
		Truncated: after < session.discardedThrough,
	}
	if session.closed {
		if session.exit.exitCode != nil {
			value := *session.exit.exitCode
			response.ExitCode = &value
		}
		response.Signal = session.exit.signal
	}
	return response
}

func (session *terminalSession) write(data []byte) error {
	session.mu.Lock()
	if session.closed || session.exited || session.inputFailed {
		session.mu.Unlock()
		return ErrTerminalClosed
	}
	copyData := append([]byte(nil), data...)
	select {
	case session.input <- copyData:
		session.mu.Unlock()
		return nil
	default:
		session.mu.Unlock()
		return ErrTerminalInputBackpressure
	}
}

func (session *terminalSession) foreground() (TerminalForegroundResponse, error) {
	session.mu.Lock()
	closed := session.closed || session.exited
	session.mu.Unlock()
	if closed {
		return TerminalForegroundResponse{}, ErrTerminalClosed
	}
	group, err := session.backend.Foreground()
	if err != nil {
		return TerminalForegroundResponse{}, err
	}
	return TerminalForegroundResponse{ProcessGroupID: group, InputWaiting: false}, nil
}

func (session *terminalSession) signalForeground(signal string) (int, error) {
	session.mu.Lock()
	closed := session.closed || session.exited
	session.mu.Unlock()
	if closed {
		return 0, ErrTerminalClosed
	}
	return session.backend.SignalForeground(signal)
}

func (session *terminalSession) terminate(ctx context.Context) error {
	session.startTermination()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-session.terminateDone:
		session.mu.Lock()
		err := session.terminateErr
		session.mu.Unlock()
		return err
	}
}

func (session *terminalSession) startTermination() {
	session.terminateOnce.Do(func() {
		go func() {
			err := session.backend.Terminate()
			if err == nil {
				select {
				case <-session.closedDone:
				case <-time.After(session.grace + terminalDrainTimeout):
					// 终止后顶层进程未报告退出时，关闭 PTY 主端解除 read/write
					// 阻塞；后台 Wait 仍负责记录最终退出事实。
					_ = session.backend.Close()
				}
			}
			if err == nil {
				select {
				case <-session.processDone:
				case <-session.closedDone:
				}
			}
			session.mu.Lock()
			session.terminateErr = err
			session.mu.Unlock()
			close(session.terminateDone)
		}()
	})
}

// forceTerminate 在关闭截止时间到达时立即升级为树级强杀，并关闭 PTY 主端以
// 解除可能阻塞的 reader；waitLoop 仍是唯一记录并回收顶层子进程的一方。
func (session *terminalSession) forceTerminate() {
	_ = session.backend.ForceTerminate()
	_ = session.backend.Close()
}

func (session *terminalSession) wakeLocked() {
	close(session.notify)
	session.notify = make(chan struct{})
}

func writeTerminalAll(writer io.Writer, data []byte) error {
	for len(data) > 0 {
		count, err := writer.Write(data)
		if count > 0 {
			data = data[count:]
		}
		if err != nil {
			return err
		}
		if count == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

func validateTerminalStart(request TerminalStartRequest) error {
	if !validStartNonce(request.StartNonce) {
		return fail(400, "invalid-start-nonce", "startNonce must be 32 lowercase hexadecimal characters")
	}
	if len(request.Argv) == 0 || len(request.Argv) > maxTerminalArgv {
		return errors.New("remote terminal: argv must contain a bounded program and arguments")
	}
	argvBytes := 0
	for _, argument := range request.Argv {
		if argument == "" || len(argument) > maxTerminalArgvBytes || containsNUL(argument) {
			return errors.New("remote terminal: argv contains an invalid argument")
		}
		argvBytes += len(argument)
		if argvBytes > maxTerminalArgvBytes {
			return errors.New("remote terminal: argv exceeds the byte limit")
		}
	}
	if request.Rows < 1 || request.Rows > maxTerminalRows || request.Cols < 1 || request.Cols > maxTerminalCols {
		return fmt.Errorf("remote terminal: rows and cols must be within 1..%d", maxTerminalRows)
	}
	if request.GraceMs < 0 || request.GraceMs > maxTerminalGrace.Milliseconds() {
		return fmt.Errorf("remote terminal: graceMs must be within 0..%d", maxTerminalGrace.Milliseconds())
	}
	if len(request.Env) > maxTerminalEnvironmentEntries {
		return errors.New("remote terminal: environment has too many entries")
	}
	environmentBytes := 0
	for key, value := range request.Env {
		if key == "" || containsNUL(key) || strings.ContainsRune(key, '=') || containsNUL(value) {
			return errors.New("remote terminal: environment contains an invalid name or value")
		}
		environmentBytes += len(key) + len(value) + 1
		if environmentBytes > maxTerminalEnvironmentBytes {
			return errors.New("remote terminal: environment exceeds the byte limit")
		}
	}
	return nil
}

// terminalStartFingerprint 保留同一 root+nonce 下会影响 PTY 语义的原始请求。
// encoding/json 对 map key 稳定排序，因此等价环境映射不会受解码顺序影响。
func terminalStartFingerprint(request TerminalStartRequest) ([sha256.Size]byte, error) {
	payload := struct {
		Path    string            `json:"path"`
		Argv    []string          `json:"argv"`
		Env     map[string]string `json:"env"`
		Rows    int               `json:"rows"`
		Cols    int               `json:"cols"`
		GraceMs int64             `json:"graceMs"`
	}{
		Path: request.Path, Argv: request.Argv, Env: request.Env,
		Rows: request.Rows, Cols: request.Cols, GraceMs: request.GraceMs,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return [sha256.Size]byte{}, fmt.Errorf("remote terminal: encode start fingerprint: %w", err)
	}
	return sha256.Sum256(encoded), nil
}

func terminalGrace(request TerminalStartRequest) time.Duration {
	if request.GraceMs <= 0 {
		return defaultTerminalGrace
	}
	return time.Duration(request.GraceMs) * time.Millisecond
}

func newTerminalID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("remote terminal: terminal id: %w", err)
	}
	return hex.EncodeToString(bytes), nil
}

func containsNUL(value string) bool {
	for _, character := range value {
		if character == '\x00' {
			return true
		}
	}
	return false
}
