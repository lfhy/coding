package remoteagent

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultProcessGrace          = 2 * time.Second
	maxProcessGrace              = 60 * time.Second
	defaultProcessRetention      = 2 * time.Minute
	maxProcessSessions           = 64
	maxProcessArgv               = 256
	maxProcessArgvBytes          = 128 << 10
	maxProcessEnvironmentEntries = 256
	maxProcessEnvironmentBytes   = 128 << 10
	defaultProcessOutputBytes    = 8 << 20
	maxProcessOutputBytes        = 32 << 20
	minProcessOutputBytes        = 1
	maxProcessInputBytes         = 1 << 20
	maxProcessQueuedInputBytes   = 1 << 20
	maxProcessReadBytes          = 64 << 10
	processInputQueueSize        = 16
	maxProcessWait               = 60 * time.Second
	startNonceLength             = 32
)

// ErrProcessNotFound 表示进程不存在、已过期或服务已关闭。
var ErrProcessNotFound = errors.New("remote process: process not found")

// ErrProcessClosed 表示进程 stdin 已关闭或进程已退出，不能再写入。
var ErrProcessClosed = errors.New("remote process: process is closed")

// ErrProcessInputBackpressure 表示输入队列已满，调用方应稍后重试。
var ErrProcessInputBackpressure = errors.New("remote process: input queue is full")

// ErrProcessStartConflict 表示同一 root+startNonce 被不同启动载荷复用。
var ErrProcessStartConflict = errors.New("remote process: start nonce conflicts with an existing request")

// ProcessSessionsOptions 配置进程并发数量、单流输出保留和完成后的保留时间。
type ProcessSessionsOptions struct {
	MaxSessions    int
	MaxOutputBytes int
	Retention      time.Duration
}

// ProcessSessions 维护 agent 内所有非 PTY 子进程的所有权。
type ProcessSessions struct {
	maxSessions    int
	maxOutputBytes int
	retention      time.Duration

	mu       sync.Mutex
	sessions map[string]*processSession
	starts   map[processStartKey]*processStartRecord
	starting int
	closed   bool
	changed  chan struct{}

	closeOnce sync.Once
	closeDone chan struct{}
	closing   []*processSession
}

// processStartKey 把启动重试限制在同一个启动时固化的工作区 owner key 内。
type processStartKey struct {
	root  string
	nonce string
}

// processStartRecord 在首个 start 完成前收敛并发重试，完成后保留初始快照，
// 直到对应会话的 retention 到期。
type processStartRecord struct {
	fingerprint [sha256.Size]byte
	done        chan struct{}
	response    ProcessStartResponse
	err         error
}

type processSession struct {
	id          string
	root        string
	cwd         string
	grace       time.Duration
	startedAt   int64
	startKey    *processStartKey
	startRecord *processStartRecord

	command   *exec.Cmd
	stdin     io.WriteCloser
	stdinMode string
	notify    chan struct{}
	done      chan struct{}

	input       chan processInputMessage
	mu          sync.Mutex
	stdout      processStream
	stderr      processStream
	queuedInput int
	exited      bool
	exitCode    *int
	exitSignal  *string
	stdinClosed bool
	stdinError  bool
	closed      bool
	exitedAt    *int64
	onClosed    func()

	terminateOnce sync.Once
	terminateErr  error
}

type processStream struct {
	mode      string
	limit     int
	total     int64
	window    []byte
	truncated bool
	eof       bool
}

type processInputMessage struct {
	data  []byte
	close bool
}

// NewProcessSessions 创建一个进程会话表。
func NewProcessSessions(options ProcessSessionsOptions) *ProcessSessions {
	if options.MaxSessions <= 0 {
		options.MaxSessions = maxProcessSessions
	}
	if options.MaxSessions > maxProcessSessions {
		options.MaxSessions = maxProcessSessions
	}
	if options.MaxOutputBytes <= 0 {
		options.MaxOutputBytes = defaultProcessOutputBytes
	}
	if options.MaxOutputBytes > maxProcessOutputBytes {
		options.MaxOutputBytes = maxProcessOutputBytes
	}
	if options.Retention <= 0 {
		options.Retention = defaultProcessRetention
	}
	return &ProcessSessions{
		maxSessions: options.MaxSessions, maxOutputBytes: options.MaxOutputBytes,
		retention: options.Retention, sessions: make(map[string]*processSession),
		starts:  make(map[processStartKey]*processStartRecord),
		changed: make(chan struct{}), closeDone: make(chan struct{}),
	}
}

// Resolve 在远端受清理环境中解析可执行文件。
func (sessions *ProcessSessions) Resolve(request ProcessResolveRequest) (ProcessResolveResponse, error) {
	_, path, err := processRootAndPath(request.Root, request.Path)
	if err != nil {
		return ProcessResolveResponse{}, err
	}
	environment, err := processEnvironment(request.Env)
	if err != nil {
		return ProcessResolveResponse{}, err
	}
	executable, err := processLookPath(request.Command, environment, path)
	if err != nil {
		return ProcessResolveResponse{}, err
	}
	return ProcessResolveResponse{Path: executable}, nil
}

// Start 启动一个受管进程并返回初始快照。带 startNonce 的重试复用首个已发布
// 会话；同 nonce 的不同载荷被拒绝，不能把重试变成另一棵进程树。
func (sessions *ProcessSessions) Start(request ProcessStartRequest) (response ProcessStartResponse, returned error) {
	if err := validateProcessStart(request); err != nil {
		return ProcessStartResponse{}, err
	}
	if _, err := canonicalSessionRoot(request.Root); err != nil {
		return ProcessStartResponse{}, err
	}
	ownerRoot, err := sessionOwnerRoot(request.Root)
	if err != nil {
		return ProcessStartResponse{}, err
	}
	fingerprint, err := processStartFingerprint(request)
	if err != nil {
		return ProcessStartResponse{}, err
	}
	startKey := processStartKey{root: ownerRoot, nonce: request.StartNonce}
	start, owner, err := sessions.claimStart(startKey, fingerprint)
	if err != nil {
		return ProcessStartResponse{}, err
	}
	if !owner {
		return waitProcessStart(start)
	}
	defer func() { sessions.finishStart(startKey, start, response, returned) }()

	inputData, err := decodeProcessInput(request.Stdin.DataBase64)
	if err != nil {
		return ProcessStartResponse{}, err
	}
	_, path, err := processRootAndPath(request.Root, request.Path)
	if err != nil {
		return ProcessStartResponse{}, err
	}
	environment, err := processEnvironment(request.Env)
	if err != nil {
		return ProcessStartResponse{}, err
	}
	executable, err := processLookPath(request.Argv[0], environment, path)
	if err != nil {
		return ProcessStartResponse{}, err
	}
	command := exec.Command(executable, request.Argv[1:]...)
	configureCommand(command)
	command.Dir = path
	command.Env = environment
	session := &processSession{
		root: ownerRoot, cwd: path, grace: processGrace(request),
		startedAt: time.Now().UnixMilli(), command: command, stdinMode: request.Stdin.Mode,
		notify: make(chan struct{}), done: make(chan struct{}),
	}
	session.stdout = processStream{mode: request.Stdout.Mode, limit: sessions.processOutputLimit(request.Stdout)}
	session.stderr = processStream{mode: request.Stderr.Mode, limit: sessions.processOutputLimit(request.Stderr)}
	command.Stdout = &processStreamWriter{session: session, stdout: true}
	command.Stderr = &processStreamWriter{session: session, stdout: false}
	if request.Stdin.Mode == "pipe" {
		session.input = make(chan processInputMessage, processInputQueueSize)
		if session.stdin, err = command.StdinPipe(); err != nil {
			return ProcessStartResponse{}, err
		}
	} else if request.Stdin.Mode == "data" {
		// 批量 stdin 由 exec 在后台复制并以 EOF 关闭；启动响应不应因一个不读取
		// stdin 的子进程而被同步写管道阻塞。
		command.Stdin = bytes.NewReader(inputData)
		session.stdinClosed = true
	} else {
		session.stdinClosed = true
	}
	if err := command.Start(); err != nil {
		return ProcessStartResponse{}, processStartFailure(err)
	}
	id, err := newProcessID()
	if err != nil {
		_ = signalProcessTree(command, "SIGKILL")
		_ = command.Wait()
		return ProcessStartResponse{}, err
	}
	session.id = id
	session.startKey = &startKey
	session.startRecord = start
	session.onClosed = func() {
		time.AfterFunc(sessions.retention, func() { sessions.remove(id, session) })
	}
	if !sessions.publish(id, session) {
		_ = signalProcessTree(command, "SIGKILL")
		_ = command.Wait()
		return ProcessStartResponse{}, ErrProcessNotFound
	}
	if request.Stdin.Mode == "pipe" {
		go session.writeLoop()
	}
	go session.waitLoop()
	return ProcessStartResponse{Process: session.snapshot()}, nil
}

// Read 返回一个输出流从 from 开始的原始字节。
func (sessions *ProcessSessions) Read(ctx context.Context, request ProcessReadRequest) (ProcessReadResponse, error) {
	session, err := sessions.sessionForRoot(request.ID, request.Root)
	if err != nil {
		return ProcessReadResponse{}, err
	}
	if request.Stream != "stdout" && request.Stream != "stderr" {
		return ProcessReadResponse{}, fail(http.StatusBadRequest, "invalid-stream", "stream must be stdout or stderr")
	}
	if request.From < 0 {
		return ProcessReadResponse{}, fail(http.StatusBadRequest, "invalid-offset", "from cannot be negative")
	}
	limit := maxProcessReadBytes
	if request.MaxBytes > 0 {
		if request.MaxBytes > maxProcessReadBytes {
			return ProcessReadResponse{}, fail(http.StatusBadRequest, "invalid-read-limit", "maxBytes exceeds the process read limit")
		}
		limit = int(request.MaxBytes)
	}
	return session.read(ctx, request.Stream, request.From, limit), nil
}

// Write 向 stdin 写入原始字节或关闭 stdin。
func (sessions *ProcessSessions) Write(request ProcessWriteRequest) (ProcessWriteResponse, error) {
	session, err := sessions.sessionForRoot(request.ID, request.Root)
	if err != nil {
		return ProcessWriteResponse{}, err
	}
	data, err := decodeProcessInput(request.DataBase64)
	if err != nil {
		return ProcessWriteResponse{}, err
	}
	written, err := session.write(data, request.CloseStdin)
	if err != nil {
		return ProcessWriteResponse{}, err
	}
	return ProcessWriteResponse{Written: written, StdinClosed: session.stdinClosedState(), Process: session.snapshot()}, nil
}

// Wait 等待进程退出，最长等待 timeoutMs。
func (sessions *ProcessSessions) Wait(ctx context.Context, request ProcessWaitRequest) (ProcessWaitResponse, error) {
	session, err := sessions.sessionForRoot(request.ID, request.Root)
	if err != nil {
		return ProcessWaitResponse{}, err
	}
	if request.TimeoutMs < 0 || request.TimeoutMs > maxProcessWait.Milliseconds() {
		return ProcessWaitResponse{}, fail(http.StatusBadRequest, "invalid-timeout", fmt.Sprintf("timeoutMs must be within 0..%d", maxProcessWait.Milliseconds()))
	}
	timeout := time.Duration(request.TimeoutMs) * time.Millisecond
	if timeout == 0 {
		timeout = maxProcessWait
	}
	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	select {
	case <-waitCtx.Done():
		return ProcessWaitResponse{Completed: false, Process: session.snapshot()}, nil
	case <-session.done:
		return ProcessWaitResponse{Completed: true, Process: session.snapshot()}, nil
	}
}

// Kill 发送受限信号；SIGTERM 会按会话 grace 升级为 SIGKILL。
func (sessions *ProcessSessions) Kill(request ProcessKillRequest) (ProcessKillResponse, error) {
	session, err := sessions.sessionForRoot(request.ID, request.Root)
	if err != nil {
		return ProcessKillResponse{}, err
	}
	if request.Signal != "" && request.Signal != "SIGTERM" && request.Signal != "SIGKILL" {
		return ProcessKillResponse{}, fail(http.StatusBadRequest, "invalid-signal", "signal must be SIGTERM or SIGKILL")
	}
	signal := request.Signal
	if signal == "" {
		signal = "SIGTERM"
	}
	if err := session.kill(signal); err != nil {
		return ProcessKillResponse{}, err
	}
	return ProcessKillResponse{Process: session.snapshot()}, nil
}

// Close 关闭注册表、终止全部活动进程，并等待它们被回收。context 到期时立即
// 升级 SIGKILL；后台回收仍继续，后续 Close 可继续等待同一个结果。
func (sessions *ProcessSessions) Close(ctx context.Context) {
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
		sessions.killClosing()
	}
}

// claimStart 为首次带 nonce 的启动预留容量；相同指纹加入首个启动的结果，冲突
// 指纹被拒绝。登记发生在任何可能阻塞的进程初始化之前，避免并发重试各自启动。
func (sessions *ProcessSessions) claimStart(
	key processStartKey,
	fingerprint [sha256.Size]byte,
) (*processStartRecord, bool, error) {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	if sessions.closed {
		return nil, false, ErrProcessNotFound
	}
	if existing := sessions.starts[key]; existing != nil {
		if existing.fingerprint != fingerprint {
			return nil, false, ErrProcessStartConflict
		}
		return existing, false, nil
	}
	if len(sessions.sessions)+sessions.starting >= sessions.maxSessions {
		return nil, false, fail(http.StatusTooManyRequests, "too-many-processes", "remote process limit is reached")
	}
	start := &processStartRecord{fingerprint: fingerprint, done: make(chan struct{})}
	sessions.starts[key] = start
	sessions.starting++
	return start, true, nil
}

// finishStart 发布首个启动的稳定结果；没有会话的失败不保留 nonce，成功记录由
// session retention 清理。关闭 done 让等待中的重试同时看到同一个结果。
func (sessions *ProcessSessions) finishStart(
	key processStartKey,
	start *processStartRecord,
	response ProcessStartResponse,
	err error,
) {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	start.response = response
	start.err = err
	close(start.done)
	if err != nil && sessions.starts[key] == start {
		delete(sessions.starts, key)
	}
	sessions.starting--
	sessions.wakeChangedLocked()
}

// waitProcessStart 等待同一个 nonce 的首个启动完成；它返回首个响应快照，而非
// 重读后的动态状态，使收到响应前断开的 retry 可得到同一已发布句柄身份。
func waitProcessStart(start *processStartRecord) (ProcessStartResponse, error) {
	<-start.done
	if start.err != nil {
		return ProcessStartResponse{}, start.err
	}
	return start.response, nil
}

func (sessions *ProcessSessions) publish(id string, session *processSession) bool {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	if sessions.closed {
		return false
	}
	sessions.sessions[id] = session
	sessions.wakeChangedLocked()
	return true
}

func (sessions *ProcessSessions) remove(id string, expected *processSession) {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	if sessions.sessions[id] == expected {
		delete(sessions.sessions, id)
		if expected.startKey != nil && sessions.starts[*expected.startKey] == expected.startRecord {
			delete(sessions.starts, *expected.startKey)
		}
	}
}

func (sessions *ProcessSessions) session(id string) *processSession {
	if id == "" {
		return nil
	}
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	return sessions.sessions[id]
}

// sessionForRoot 不区分未知 id 与不匹配的根，防止一个工作区控制另一个工作区。
func (sessions *ProcessSessions) sessionForRoot(id, root string) (*processSession, error) {
	if id == "" {
		return nil, ErrProcessNotFound
	}
	ownerRoot, err := sessionOwnerRoot(root)
	if err != nil {
		// 无效根和陌生根同样不能暴露某个已发布进程的存在。
		return nil, ErrProcessNotFound
	}
	session := sessions.session(id)
	if session == nil || session.root != ownerRoot {
		return nil, ErrProcessNotFound
	}
	return session, nil
}

func (sessions *ProcessSessions) processOutputLimit(spec ProcessOutputSpec) int {
	if spec.Mode == "collect" {
		return int(spec.MaxBytes)
	}
	return sessions.maxOutputBytes
}

func (sessions *ProcessSessions) wakeChangedLocked() {
	close(sessions.changed)
	sessions.changed = make(chan struct{})
}

func (sessions *ProcessSessions) closeWorker() {
	sessions.mu.Lock()
	for sessions.starting > 0 {
		changed := sessions.changed
		sessions.mu.Unlock()
		<-changed
		sessions.mu.Lock()
	}
	all := make([]*processSession, 0, len(sessions.sessions))
	for _, session := range sessions.sessions {
		all = append(all, session)
	}
	sessions.sessions = make(map[string]*processSession)
	sessions.closing = all
	sessions.mu.Unlock()

	for _, session := range all {
		_ = session.kill("SIGTERM")
	}
	var group sync.WaitGroup
	group.Add(len(all))
	for _, session := range all {
		go func(session *processSession) {
			defer group.Done()
			<-session.done
		}(session)
	}
	group.Wait()
	close(sessions.closeDone)
}

func (sessions *ProcessSessions) killClosing() {
	sessions.mu.Lock()
	all := append([]*processSession(nil), sessions.closing...)
	for _, session := range sessions.sessions {
		all = append(all, session)
	}
	sessions.mu.Unlock()
	for _, session := range all {
		_ = session.kill("SIGKILL")
	}
}

type processStreamWriter struct {
	session *processSession
	stdout  bool
}

func (writer *processStreamWriter) Write(data []byte) (int, error) {
	writer.session.appendOutput(writer.stdout, data)
	return len(data), nil
}

func (session *processSession) appendOutput(stdout bool, data []byte) {
	if len(data) == 0 {
		return
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	stream := &session.stderr
	if stdout {
		stream = &session.stdout
	}
	stream.total += int64(len(data))
	if len(data) >= stream.limit {
		if len(stream.window) > 0 || len(data) > stream.limit {
			stream.truncated = true
		}
		stream.window = append(stream.window[:0], data[len(data)-stream.limit:]...)
	} else {
		stream.window = append(stream.window, data...)
		if overflow := len(stream.window) - stream.limit; overflow > 0 {
			stream.window = append([]byte(nil), stream.window[overflow:]...)
			stream.truncated = true
		}
	}
	session.wakeLocked()
}

func (session *processSession) wakeLocked() {
	close(session.notify)
	session.notify = make(chan struct{})
}

func (session *processSession) read(ctx context.Context, streamName string, from int64, limit int) ProcessReadResponse {
	for {
		session.mu.Lock()
		stream := &session.stderr
		if streamName == "stdout" {
			stream = &session.stdout
		}
		windowStart := stream.total - int64(len(stream.window))
		lossy := from < windowStart
		start := from
		if lossy {
			start = windowStart
		}
		nextOffset := from
		data := []byte{}
		if start < stream.total {
			end := start + int64(limit)
			if end > stream.total {
				end = stream.total
			}
			begin := int(start - windowStart)
			finish := int(end - windowStart)
			data = append(data, stream.window[begin:finish]...)
			nextOffset = end
		}
		eof := stream.eof && nextOffset >= stream.total
		response := ProcessReadResponse{
			DataBase64: base64.StdEncoding.EncodeToString(data), NextOffset: nextOffset,
			Lossy: lossy, Truncated: stream.truncated, EOF: eof, Closed: session.closed,
			Process: session.snapshotLocked(),
		}
		notify := session.notify
		ready := len(data) > 0 || lossy || eof
		session.mu.Unlock()
		if ready {
			return response
		}
		select {
		case <-ctx.Done():
			return response
		case <-notify:
		}
	}
}

func (session *processSession) write(data []byte, closeAfter bool) (int, error) {
	session.mu.Lock()
	if session.stdinMode != "pipe" {
		session.mu.Unlock()
		return 0, ErrProcessClosed
	}
	if session.stdinClosed || session.stdinError || session.closed {
		session.mu.Unlock()
		return 0, ErrProcessClosed
	}
	if session.queuedInput+len(data) > maxProcessQueuedInputBytes {
		session.mu.Unlock()
		return 0, ErrProcessInputBackpressure
	}
	message := processInputMessage{data: append([]byte(nil), data...), close: closeAfter}
	if closeAfter {
		session.stdinClosed = true
	}
	select {
	case session.input <- message:
		session.queuedInput += len(message.data)
		session.wakeLocked()
		session.mu.Unlock()
		return len(data), nil
	default:
		if closeAfter {
			session.stdinClosed = false
		}
		session.mu.Unlock()
		return 0, ErrProcessInputBackpressure
	}
}

func (session *processSession) writeLoop() {
	for {
		select {
		case <-session.done:
			return
		case message := <-session.input:
			session.mu.Lock()
			session.queuedInput -= len(message.data)
			closed := session.closed || session.stdinError
			session.mu.Unlock()
			if closed {
				return
			}
			if len(message.data) > 0 {
				if err := writeAll(session.stdin, message.data); err != nil {
					session.mu.Lock()
					session.stdinError = true
					session.stdinClosed = true
					session.wakeLocked()
					session.mu.Unlock()
					return
				}
			}
			if !message.close {
				continue
			}
			if err := session.stdin.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
				session.mu.Lock()
				session.stdinError = true
				session.stdinClosed = true
				session.wakeLocked()
				session.mu.Unlock()
			}
			return
		}
	}
}

func (session *processSession) waitLoop() {
	_ = session.command.Wait()
	now := time.Now().UnixMilli()
	exitCode := 0
	signal := ""
	if session.command.ProcessState != nil {
		if value := commandSignal(session.command.ProcessState); value != "" {
			signal = value
		} else if code := session.command.ProcessState.ExitCode(); code >= 0 {
			exitCode = code
		}
	} else {
		exitCode = 1
	}
	session.mu.Lock()
	session.exited = true
	session.closed = true
	session.stdinClosed = true
	session.exitedAt = &now
	if signal != "" {
		session.exitSignal = &signal
	} else {
		session.exitCode = &exitCode
	}
	session.stdout.eof = true
	session.stderr.eof = true
	session.wakeLocked()
	session.mu.Unlock()
	close(session.done)
	if session.stdin != nil {
		_ = session.stdin.Close()
	}
	if session.onClosed != nil {
		session.onClosed()
	}
}

func (session *processSession) kill(signal string) error {
	session.mu.Lock()
	exited := session.exited
	session.mu.Unlock()
	if exited {
		return nil
	}
	if signal == "SIGKILL" {
		return signalProcessTree(session.command, signal)
	}
	session.terminateOnce.Do(func() {
		session.terminateErr = signalProcessTree(session.command, signal)
		if session.terminateErr != nil {
			return
		}
		go func() {
			timer := time.NewTimer(session.grace)
			defer timer.Stop()
			select {
			case <-session.done:
			case <-timer.C:
				_ = signalProcessTree(session.command, "SIGKILL")
			}
		}()
	})
	return session.terminateErr
}

func (session *processSession) stdinClosedState() bool {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.stdinClosed || session.closed || session.stdinMode != "pipe"
}

func (session *processSession) snapshot() ProcessSnapshot {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.snapshotLocked()
}

func (session *processSession) snapshotLocked() ProcessSnapshot {
	pid := 0
	if session.command != nil && session.command.Process != nil {
		pid = session.command.Process.Pid
	}
	return ProcessSnapshot{
		ID: session.id, PID: pid, Running: !session.exited, Closed: session.closed,
		ExitCode: session.exitCode, Signal: session.exitSignal,
		StdinClosed: session.stdinClosed || session.closed || session.stdinMode != "pipe",
		StartedAt:   session.startedAt, ExitedAt: session.exitedAt,
	}
}

func writeAll(writer io.Writer, data []byte) error {
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

func decodeProcessInput(encoded string) ([]byte, error) {
	if encoded == "" {
		return nil, nil
	}
	if len(encoded) > base64.StdEncoding.EncodedLen(maxProcessInputBytes) {
		return nil, fail(http.StatusRequestEntityTooLarge, "process-input-too-large", "process input exceeds the byte limit")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fail(http.StatusBadRequest, "invalid-base64", "process input must be valid base64")
	}
	if len(data) > maxProcessInputBytes {
		return nil, fail(http.StatusRequestEntityTooLarge, "process-input-too-large", "process input exceeds the byte limit")
	}
	return data, nil
}

func processRootAndPath(root string, path string) (string, string, error) {
	canonicalRoot, err := canonicalSessionRoot(root)
	if err != nil {
		return "", "", err
	}
	canonicalPath, err := resolveScopedPath(root, path, false)
	if err != nil {
		return "", "", err
	}
	if canonicalRoot != "" && !pathWithin(canonicalRoot, canonicalPath) {
		return "", "", fail(http.StatusForbidden, "outside-root", "process path is outside the requested root")
	}
	info, err := os.Stat(canonicalPath)
	if err != nil {
		return "", "", err
	}
	if !info.IsDir() {
		return "", "", fail(http.StatusBadRequest, "not-directory", "process path is not a directory")
	}
	return canonicalRoot, canonicalPath, nil
}

func validateProcessStart(request ProcessStartRequest) error {
	if !validStartNonce(request.StartNonce) {
		return fail(http.StatusBadRequest, "invalid-start-nonce", "startNonce must be 32 lowercase hexadecimal characters")
	}
	if request.Stdin.Mode != "ignore" && request.Stdin.Mode != "pipe" && request.Stdin.Mode != "data" {
		return fail(http.StatusBadRequest, "invalid-stdio", "stdin mode must be ignore, pipe or data")
	}
	if request.Stdin.Mode != "data" && request.Stdin.DataBase64 != "" {
		return fail(http.StatusBadRequest, "invalid-stdio", "dataBase64 requires stdin mode data")
	}
	if err := validateProcessOutputSpec("stdout", request.Stdout); err != nil {
		return err
	}
	if err := validateProcessOutputSpec("stderr", request.Stderr); err != nil {
		return err
	}
	if request.GraceMs < 0 || request.GraceMs > maxProcessGrace.Milliseconds() {
		return fail(http.StatusBadRequest, "invalid-grace", fmt.Sprintf("graceMs must be within 0..%d", maxProcessGrace.Milliseconds()))
	}
	if len(request.Argv) == 0 || len(request.Argv) > maxProcessArgv {
		return fail(http.StatusBadRequest, "invalid-argv", "argv must contain a bounded program and arguments")
	}
	argvBytes := 0
	for _, argument := range request.Argv {
		if argument == "" || len(argument) > maxProcessArgvBytes || containsNUL(argument) {
			return fail(http.StatusBadRequest, "invalid-argv", "argv contains an invalid argument")
		}
		argvBytes += len(argument)
		if argvBytes > maxProcessArgvBytes {
			return fail(http.StatusBadRequest, "invalid-argv", "argv exceeds the byte limit")
		}
	}
	if _, err := decodeProcessInput(request.Stdin.DataBase64); err != nil {
		return err
	}
	return nil
}

// processStartFingerprint 保留同一 root+nonce 下所有影响进程语义的原始请求
// 字段。encoding/json 对 map key 稳定排序，因此等价环境映射不会受解码顺序影响。
func processStartFingerprint(request ProcessStartRequest) ([sha256.Size]byte, error) {
	payload := struct {
		Path    string             `json:"path"`
		Argv    []string           `json:"argv"`
		Env     map[string]*string `json:"env"`
		Stdin   ProcessInputSpec   `json:"stdin"`
		Stdout  ProcessOutputSpec  `json:"stdout"`
		Stderr  ProcessOutputSpec  `json:"stderr"`
		GraceMs int64              `json:"graceMs"`
	}{
		Path: request.Path, Argv: request.Argv, Env: request.Env,
		Stdin: request.Stdin, Stdout: request.Stdout, Stderr: request.Stderr, GraceMs: request.GraceMs,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return [sha256.Size]byte{}, fmt.Errorf("remote process: encode start fingerprint: %w", err)
	}
	return sha256.Sum256(encoded), nil
}

func validStartNonce(value string) bool {
	if len(value) != startNonceLength {
		return false
	}
	for index := 0; index < len(value); index++ {
		character := value[index]
		if !(character >= '0' && character <= '9') && !(character >= 'a' && character <= 'f') {
			return false
		}
	}
	return true
}

func validateProcessOutputSpec(name string, spec ProcessOutputSpec) error {
	if spec.Mode == "inherit" {
		return fail(http.StatusBadRequest, "unsupported-stdio", name+" cannot inherit a descriptor across Remote-SSH")
	}
	if spec.Mode != "pipe" && spec.Mode != "collect" {
		return fail(http.StatusBadRequest, "invalid-stdio", name+" mode must be pipe or collect")
	}
	if spec.Mode != "collect" && spec.MaxBytes != 0 {
		return fail(http.StatusBadRequest, "invalid-stdio", name+" maxBytes requires collect mode")
	}
	if spec.Mode == "collect" && (spec.MaxBytes < minProcessOutputBytes || spec.MaxBytes > maxProcessOutputBytes) {
		return fail(http.StatusBadRequest, "invalid-stdio", name+" maxBytes is outside the supported range")
	}
	return nil
}

func validateProcessCommand(command string) error {
	if command == "" || len(command) > maxProcessArgvBytes || containsNUL(command) {
		return fail(http.StatusBadRequest, "invalid-command", "command must be a non-empty executable name")
	}
	if strings.ContainsRune(command, '/') || (runtime.GOOS == "windows" && strings.ContainsRune(command, '\\')) {
		if !filepath.IsAbs(command) {
			return fail(http.StatusBadRequest, "invalid-command", "command paths must be absolute or a bare PATH name")
		}
	}
	return nil
}

func processEnvironment(explicit map[string]*string) ([]string, error) {
	if len(explicit) > maxProcessEnvironmentEntries {
		return nil, fail(http.StatusBadRequest, "invalid-environment", "environment has too many entries")
	}
	type entry struct{ key, value string }
	values := make(map[string]entry)
	canonicalKey := func(key string) string {
		if runtime.GOOS == "windows" {
			return strings.ToUpper(key)
		}
		return key
	}
	environmentBytes := 0
	for _, pair := range os.Environ() {
		key, value, found := strings.Cut(pair, "=")
		if !found || sensitiveEnvironmentKey(key) {
			continue
		}
		values[canonicalKey(key)] = entry{key: key, value: value}
	}
	for key, value := range explicit {
		if key == "" || strings.ContainsAny(key, "=\x00") {
			return nil, fail(http.StatusBadRequest, "invalid-environment", "environment contains an invalid name or value")
		}
		environmentBytes += len(key) + 1
		if value != nil {
			if containsNUL(*value) {
				return nil, fail(http.StatusBadRequest, "invalid-environment", "environment contains an invalid name or value")
			}
			environmentBytes += len(*value)
		}
		if environmentBytes > maxProcessEnvironmentBytes {
			return nil, fail(http.StatusBadRequest, "invalid-environment", "environment exceeds the byte limit")
		}
		if value == nil {
			delete(values, canonicalKey(key))
			continue
		}
		values[canonicalKey(key)] = entry{key: key, value: *value}
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		value := values[key]
		result = append(result, value.key+"="+value.value)
	}
	return result, nil
}

// processLookPath 使用请求的有效 PATH 和执行目录解析裸命令。相对 PATH 项按
// 子进程工作目录解释，避免错误地从 agent 自己的 cwd 解析。
func processLookPath(command string, environment []string, cwd string) (string, error) {
	if err := validateProcessCommand(command); err != nil {
		return "", err
	}
	if filepath.IsAbs(command) {
		candidate := filepath.Clean(command)
		info, err := os.Stat(candidate)
		if err != nil {
			return "", err
		}
		if !processExecutable(info) {
			return "", fail(http.StatusForbidden, "permission-denied", "command is not executable")
		}
		return candidate, nil
	}
	pathValue, found := processEnvironmentValue(environment, "PATH")
	if !found {
		return "", fail(http.StatusNotFound, "executable-not-found", "command was not found on PATH")
	}
	var denied bool
	for _, directory := range filepath.SplitList(pathValue) {
		if directory == "" {
			directory = cwd
		} else if !filepath.IsAbs(directory) {
			directory = filepath.Join(cwd, directory)
		}
		for _, candidateName := range processExecutableCandidates(command, environment) {
			candidate := filepath.Join(directory, candidateName)
			info, err := os.Stat(candidate)
			if err == nil {
				if processExecutable(info) {
					return filepath.Clean(candidate), nil
				}
				denied = true
			} else if errors.Is(err, os.ErrPermission) {
				denied = true
			}
		}
	}
	if denied {
		return "", fail(http.StatusForbidden, "permission-denied", "command is not executable")
	}
	return "", fail(http.StatusNotFound, "executable-not-found", "command was not found on PATH")
}

func processEnvironmentValue(environment []string, wanted string) (string, bool) {
	for _, pair := range environment {
		key, value, found := strings.Cut(pair, "=")
		if !found {
			continue
		}
		if key == wanted || (runtime.GOOS == "windows" && strings.EqualFold(key, wanted)) {
			return value, true
		}
	}
	return "", false
}

func processExecutableCandidates(command string, environment []string) []string {
	result := []string{command}
	if runtime.GOOS != "windows" || filepath.Ext(command) != "" {
		return result
	}
	extensions, found := processEnvironmentValue(environment, "PATHEXT")
	if !found || extensions == "" {
		extensions = ".COM;.EXE;.BAT;.CMD"
	}
	for _, extension := range strings.Split(extensions, ";") {
		if extension != "" {
			result = append(result, command+extension)
		}
	}
	return result
}

func processExecutable(info os.FileInfo) bool {
	if !info.Mode().IsRegular() {
		return false
	}
	return runtime.GOOS == "windows" || info.Mode()&0o111 != 0
}

func processStartFailure(err error) error {
	switch {
	case errors.Is(err, exec.ErrDot):
		return fail(http.StatusBadRequest, "invalid-command", err.Error())
	case errors.Is(err, syscall.ENOEXEC):
		return fail(http.StatusBadRequest, "invalid-command", "process executable has an invalid format")
	case errors.Is(err, os.ErrNotExist):
		return fail(http.StatusNotFound, "executable-not-found", "process executable was not found")
	case errors.Is(err, os.ErrPermission):
		return fail(http.StatusForbidden, "permission-denied", "process executable is not executable")
	default:
		return err
	}
}

func processGrace(request ProcessStartRequest) time.Duration {
	if request.GraceMs <= 0 {
		return defaultProcessGrace
	}
	return time.Duration(request.GraceMs) * time.Millisecond
}

func newProcessID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("remote process: process id: %w", err)
	}
	return hex.EncodeToString(bytes), nil
}
