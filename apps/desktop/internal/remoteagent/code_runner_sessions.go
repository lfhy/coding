package remoteagent

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"
)

const (
	defaultCodePollWait       = 25 * time.Second
	maxCodePollWait           = 60 * time.Second
	defaultCodeSessionKeepFor = 2 * time.Minute
	defaultCodeMaxSessions    = 8
	defaultCodeSessionEvents  = 1_024
	maxCodeSessionEvents      = 4_096
	maxCodePendingBindings    = 128

	// 每个轮询响应和单条事件都故意低于 bridge 的 40 MiB 响应门槛；余量覆盖
	// JSON envelope、cursor 和将来新增的固定诊断字段。
	defaultCodePollResponseBytes = 32 << 20
	maxCodePollResponseBytes     = maxResponseBytes - (1 << 20)
	defaultCodeEventBytes        = defaultCodePollResponseBytes - (64 << 10)
	defaultCodeSessionBytes      = defaultCodePollResponseBytes + (1 << 20)
	codeDoneEventReserve         = 1 << 10
)

// CodeRunStartRequest 是 POST /v1/code/start 的 JSON 请求体。
type CodeRunStartRequest struct {
	// Root 由通用 Remote-SSH bridge 自动附带；代码执行本身不以它作为沙箱边界。
	Root      string                 `json:"root,omitempty"`
	Program   string                 `json:"program"`
	Bindings  []CodeBindingNamespace `json:"namespaces"`
	TimeoutMs int64                  `json:"timeoutMs,omitempty"`
	// ComputeMs 是本地 WorkerThreadCodeRuntime 配置的累计 Goja 忙碌时间
	// 预算；远端等待 Host binding 回包时不消耗它。
	ComputeMs        int64 `json:"computeMs"`
	MemoryLimitBytes int64 `json:"memoryLimitBytes"`
	// StartNonce 由 Client 为一次逻辑 start 生成；相同 root+nonce 的传输重试
	// 必须携带完全相同的运行载荷，才能返回原会话而不再次执行程序。
	StartNonce string `json:"startNonce"`
}

// CodeRunStartResponse 是新建远端代码会话的引用。
type CodeRunStartResponse struct {
	ID string `json:"id"`
}

// CodeRunNextRequest 是 POST /v1/code/next 的 JSON 请求体。
// after 是上次响应的 cursor；省略时从会话开头读取。
type CodeRunNextRequest struct {
	Root   string `json:"root,omitempty"`
	ID     string `json:"id"`
	After  uint64 `json:"after,omitempty"`
	WaitMs int64  `json:"waitMs,omitempty"`
}

// CodeRunNextResponse 是按顺序返回的运行事件。
type CodeRunNextResponse struct {
	Events []CodeRunWireEvent `json:"events"`
	Cursor uint64             `json:"cursor"`
	Done   bool               `json:"done"`
}

// CodeRunWireEvent 是 polling API 的一种可序列化事件。
// type 取 tool_call、log 或 done；done 含最终 value、logs 和 error。
type CodeRunWireEvent struct {
	Type      string          `json:"type"`
	Sequence  uint64          `json:"sequence"`
	CallID    uint64          `json:"callId,omitempty"`
	Global    string          `json:"global,omitempty"`
	Name      string          `json:"name,omitempty"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
	Level     string          `json:"level,omitempty"`
	Text      string          `json:"text,omitempty"`
	Value     json.RawMessage `json:"value,omitempty"`
	Logs      []string        `json:"logs,omitempty"`
	Error     *CodeRunFailure `json:"error,omitempty"`
}

// MarshalJSON 按事件种类输出封闭字段集。客户端以严格 schema 解析每一条事件，
// 因此不能让 Go struct 的零值为另一种事件附带 null 字段。
func (event CodeRunWireEvent) MarshalJSON() ([]byte, error) {
	switch event.Type {
	case "log":
		return json.Marshal(struct {
			Type     string `json:"type"`
			Sequence uint64 `json:"sequence"`
			Level    string `json:"level"`
			Text     string `json:"text"`
		}{Type: event.Type, Sequence: event.Sequence, Level: event.Level, Text: event.Text})
	case "tool_call":
		return json.Marshal(struct {
			Type      string          `json:"type"`
			Sequence  uint64          `json:"sequence"`
			CallID    uint64          `json:"callId"`
			Global    string          `json:"global"`
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}{
			Type: event.Type, Sequence: event.Sequence, CallID: event.CallID,
			Global: event.Global, Name: event.Name, Arguments: event.Arguments,
		})
	case "done":
		if event.Value != nil && event.Error != nil {
			return nil, errors.New("remote code runner: done event cannot contain both value and error")
		}
		return json.Marshal(struct {
			Type     string          `json:"type"`
			Sequence uint64          `json:"sequence"`
			Value    json.RawMessage `json:"value,omitempty"`
			Logs     []string        `json:"logs"`
			Error    *CodeRunFailure `json:"error,omitempty"`
		}{
			Type: event.Type, Sequence: event.Sequence, Value: event.Value,
			Logs: append([]string{}, event.Logs...), Error: event.Error,
		})
	default:
		return nil, fmt.Errorf("remote code runner: unsupported wire event type %q", event.Type)
	}
}

// CodeRunReplyRequest 是 POST /v1/code/reply 的 JSON 请求体。
type CodeRunReplyRequest struct {
	Root    string          `json:"root,omitempty"`
	ID      string          `json:"id"`
	CallID  uint64          `json:"callId"`
	OK      bool            `json:"ok"`
	Value   json.RawMessage `json:"value,omitempty"`
	Message string          `json:"message,omitempty"`
}

// CodeRunCancelRequest 是 POST /v1/code/cancel 的 JSON 请求体。
type CodeRunCancelRequest struct {
	Root string `json:"root,omitempty"`
	ID   string `json:"id"`
}

// ErrCodeRunSessionNotFound 表示会话不存在、已过期或已关闭。
var ErrCodeRunSessionNotFound = errors.New("remote code runner: session not found")

// ErrCodeRunCallNotFound 表示回包引用的工具调用不存在或已结算。
var ErrCodeRunCallNotFound = errors.New("remote code runner: tool call not found")

// ErrCodeRunSessionLimit 表示 agent 已保留的运行会话达到资源上限。
var ErrCodeRunSessionLimit = errors.New("remote code runner: session limit reached")

// ErrCodeRunStartNonceConflict 表示一个已使用 nonce 被用于不同的执行载荷。
var ErrCodeRunStartNonceConflict = errors.New("remote code runner: start nonce conflicts with an existing session")

// CodeRunSessionsOptions 配置 polling 会话的长轮询、完成保留时间和总数上限。
type CodeRunSessionsOptions struct {
	PollWait             time.Duration
	Retention            time.Duration
	MaxSessions          int
	MaxEvents            int
	MaxEventBytes        int
	MaxSessionBytes      int
	MaxPollResponseBytes int
	RunnerOptions        CodeRunnerOptions
}

// CodeRunSessions 是 HTTP route 可复用的远端代码会话表。
// 它不监听端口；server.go 只需把经过认证的 JSON 请求路由到这些方法。
type CodeRunSessions struct {
	runner               *CodeRunner
	pollWait             time.Duration
	retention            time.Duration
	maxSessions          int
	maxEvents            int
	maxEventBytes        int
	maxSessionBytes      int
	maxPollResponseBytes int

	mu       sync.Mutex
	sessions map[string]*codeRunSession
	nonces   map[codeRunNonceKey]codeRunNonceRecord
	closed   bool

	closeOnce sync.Once
	closeDone chan struct{}
	closing   []*codeRunSession
}

type codeRunSession struct {
	run   *CodeRun
	root  string
	nonce codeRunNonceKey

	mu             sync.Mutex
	events         []storedCodeRunEvent
	eventBytes     int
	pending        map[uint64]*CodeToolCall
	cursor         uint64
	done           bool
	notify         chan struct{}
	terminalDone   chan struct{}
	collectorDone  chan struct{}
	retentionTimer *time.Timer

	maxEvents            int
	maxEventBytes        int
	maxSessionBytes      int
	maxPollResponseBytes int
}

type codeRunNonceKey struct {
	root  string
	nonce string
}

type codeRunNonceRecord struct {
	id          string
	fingerprint [sha256.Size]byte
	session     *codeRunSession
}

// storedCodeRunEvent 保存已验证的事件及其准确 JSON 长度。只缓存长度而非另一份
// JSON 字节，避免 done.logs 在两分钟重放期内复制两遍；字节和数量均由
// CodeRunSessionsOptions 约束。
type storedCodeRunEvent struct {
	wire  CodeRunWireEvent
	bytes int
}

// NewCodeRunSessions 创建一个独立于 HTTP 框架的会话表。
//
// @param options 运行器及 polling 生命周期配置。
// @returns 可供 route 调用的会话表。
func NewCodeRunSessions(options CodeRunSessionsOptions) (*CodeRunSessions, error) {
	if options.PollWait <= 0 {
		options.PollWait = defaultCodePollWait
	}
	if options.PollWait > maxCodePollWait {
		return nil, fmt.Errorf("remote code runner: default poll wait exceeds %s", maxCodePollWait)
	}
	if options.Retention <= 0 {
		options.Retention = defaultCodeSessionKeepFor
	}
	if options.MaxSessions == 0 {
		options.MaxSessions = defaultCodeMaxSessions
	}
	if options.MaxSessions < 1 {
		return nil, errors.New("remote code runner: session limit must be positive")
	}
	if options.MaxEvents == 0 {
		options.MaxEvents = defaultCodeSessionEvents
	}
	if options.MaxEvents < 1 || options.MaxEvents > maxCodeSessionEvents {
		return nil, fmt.Errorf("remote code runner: session event limit must be between 1 and %d", maxCodeSessionEvents)
	}
	if options.MaxPollResponseBytes == 0 {
		options.MaxPollResponseBytes = defaultCodePollResponseBytes
	}
	if options.MaxPollResponseBytes < minCodeOutput || options.MaxPollResponseBytes > maxCodePollResponseBytes {
		return nil, fmt.Errorf("remote code runner: poll response budget must be between %d and %d bytes", minCodeOutput, maxCodePollResponseBytes)
	}
	if options.MaxEventBytes == 0 {
		options.MaxEventBytes = defaultCodeEventBytes
	}
	if options.MaxEventBytes < minCodeOutput+codeDoneEventReserve || options.MaxEventBytes > options.MaxPollResponseBytes-(64<<10) {
		return nil, fmt.Errorf("remote code runner: event budget must leave %d bytes for a polling response envelope", 64<<10)
	}
	if options.MaxSessionBytes == 0 {
		options.MaxSessionBytes = defaultCodeSessionBytes
	}
	if options.MaxSessionBytes < options.MaxEventBytes {
		return nil, errors.New("remote code runner: session budget must reserve one terminal event")
	}
	runnerOptions := options.RunnerOptions
	terminalOutputBudget := options.MaxEventBytes - codeDoneEventReserve
	if runnerOptions.MaxOutputBytes == 0 || runnerOptions.MaxOutputBytes > terminalOutputBudget {
		// 终态 event 还需 type、sequence 和 response envelope；远端运行的
		// 输出上限因此不得大于可编码终态的预算。
		runnerOptions.MaxOutputBytes = terminalOutputBudget
	}
	if runnerOptions.MaxEventBytes == 0 || runnerOptions.MaxEventBytes > options.MaxEventBytes {
		runnerOptions.MaxEventBytes = options.MaxEventBytes
	}
	runner, err := NewCodeRunner(runnerOptions)
	if err != nil {
		return nil, err
	}
	return &CodeRunSessions{
		runner: runner, pollWait: options.PollWait, retention: options.Retention, maxSessions: options.MaxSessions,
		maxEvents: options.MaxEvents, maxEventBytes: options.MaxEventBytes,
		maxSessionBytes: options.MaxSessionBytes, maxPollResponseBytes: options.MaxPollResponseBytes,
		sessions: make(map[string]*codeRunSession), nonces: make(map[codeRunNonceKey]codeRunNonceRecord), closeDone: make(chan struct{}),
	}, nil
}

// Start 创建一个后台执行的会话；调用 HTTP 请求结束不会中断程序。
//
// @param request 已解码的 start 请求。
// @returns 不透明会话标识或校验错误。
func (sessions *CodeRunSessions) Start(request CodeRunStartRequest) (CodeRunStartResponse, error) {
	codeRequest, err := codeRunRequestFromWire(request)
	if err != nil {
		return CodeRunStartResponse{}, err
	}
	if _, err := canonicalSessionRoot(request.Root); err != nil {
		return CodeRunStartResponse{}, err
	}
	root, err := sessionOwnerRoot(request.Root)
	if err != nil {
		return CodeRunStartResponse{}, err
	}
	if !validCodeRunStartNonce(request.StartNonce) {
		return CodeRunStartResponse{}, errors.New("remote code runner: startNonce must be 32 lowercase hexadecimal characters")
	}
	fingerprint, err := codeRunStartFingerprint(codeRequest)
	if err != nil {
		return CodeRunStartResponse{}, err
	}
	nonce := codeRunNonceKey{root: root, nonce: request.StartNonce}
	sessions.mu.Lock()
	if sessions.closed {
		sessions.mu.Unlock()
		return CodeRunStartResponse{}, ErrCodeRunSessionNotFound
	}
	if previous, exists := sessions.nonces[nonce]; exists {
		if previous.fingerprint != fingerprint {
			sessions.mu.Unlock()
			return CodeRunStartResponse{}, ErrCodeRunStartNonceConflict
		}
		if sessions.sessions[previous.id] == previous.session {
			sessions.mu.Unlock()
			return CodeRunStartResponse{ID: previous.id}, nil
		}
		// remove() 与 Close() 都会同步清理；保留这一层兜底，避免未来变更
		// 使一个过期 record 永久阻塞同一 nonce 的新开始。
		delete(sessions.nonces, nonce)
	}
	if len(sessions.sessions) >= sessions.maxSessions {
		sessions.mu.Unlock()
		return CodeRunStartResponse{}, ErrCodeRunSessionLimit
	}
	id, err := newCodeSessionID()
	if err != nil {
		sessions.mu.Unlock()
		return CodeRunStartResponse{}, err
	}
	// Start 是非阻塞的；在持有注册表锁时建立并登记 run，避免两个并发
	// start 都观察到同一个空槽位，或 Cancel 在半初始化会话上调用 nil run。
	run := sessions.runner.Start(context.Background(), codeRequest)
	session := &codeRunSession{
		run: run, root: root, nonce: nonce, pending: make(map[uint64]*CodeToolCall), notify: make(chan struct{}),
		terminalDone: make(chan struct{}), collectorDone: make(chan struct{}),
		maxEvents: sessions.maxEvents, maxEventBytes: sessions.maxEventBytes,
		maxSessionBytes: sessions.maxSessionBytes, maxPollResponseBytes: sessions.maxPollResponseBytes,
	}
	sessions.sessions[id] = session
	sessions.nonces[nonce] = codeRunNonceRecord{id: id, fingerprint: fingerprint, session: session}
	sessions.mu.Unlock()
	go sessions.collect(id, session)
	return CodeRunStartResponse{ID: id}, nil
}

// Next 等待并返回 after 之后的事件；调用方应把返回的 cursor 用于下一次请求。
//
// @param ctx 本次 HTTP 请求的取消上下文。
// @param request 会话、cursor 与最长等待时间。
// @returns 有序事件、最新 cursor 和会话是否完成。
func (sessions *CodeRunSessions) Next(ctx context.Context, request CodeRunNextRequest) (CodeRunNextResponse, error) {
	if request.After > maxCodeWireInteger {
		return CodeRunNextResponse{}, errors.New("remote code runner: after must be a safe integer")
	}
	session, err := sessions.sessionForRoot(request.ID, request.Root)
	if err != nil {
		return CodeRunNextResponse{}, err
	}
	wait, err := sessions.pollDuration(request.WaitMs)
	if err != nil {
		return CodeRunNextResponse{}, err
	}
	return session.next(ctx, request.After, wait), nil
}

// Reply 结算一个已通过 tool_call 事件交付的绑定调用。
//
// @param request 回包中的会话、调用标识和值或错误。
// @returns 未知会话、未知调用或无效 JSON 时的原因。
func (sessions *CodeRunSessions) Reply(request CodeRunReplyRequest) error {
	if request.CallID == 0 || request.CallID > maxCodeWireInteger {
		return errors.New("remote code runner: callId must be a safe integer")
	}
	session, err := sessions.sessionForRoot(request.ID, request.Root)
	if err != nil {
		return err
	}
	return session.reply(request)
}

// Cancel 请求中断会话，并等待 collector 已经写入终态 done 事件。HTTP accepted
// 因而表示 Goja 已静默，不会等待可能永远不返回的本地 Host binding。
//
// @param ctx 此次 HTTP 请求的取消上下文。
// @param request 要取消的会话标识和所有权根。
// @returns 会话不存在、请求超时或上下文取消时的原因。
func (sessions *CodeRunSessions) Cancel(ctx context.Context, request CodeRunCancelRequest) error {
	if ctx == nil {
		ctx = context.Background()
	}
	session, err := sessions.sessionForRoot(request.ID, request.Root)
	if err != nil {
		return err
	}
	session.run.Cancel()
	select {
	case <-session.terminalDone:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Close 取消并收敛全部会话，供 agent 服务关闭时调用。它在背景中完成回收；ctx
// 只限制当前调用等待，不会让半关闭的 Goja run 重新逃逸。
//
// @param ctx 等待终态与 collector 停止的上限。
// @returns 上下文取消时返回其原因。
func (sessions *CodeRunSessions) Close(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	sessions.closeOnce.Do(func() {
		sessions.mu.Lock()
		sessions.closed = true
		sessions.closing = make([]*codeRunSession, 0, len(sessions.sessions))
		for _, session := range sessions.sessions {
			sessions.closing = append(sessions.closing, session)
		}
		sessions.sessions = make(map[string]*codeRunSession)
		sessions.nonces = make(map[codeRunNonceKey]codeRunNonceRecord)
		all := append([]*codeRunSession(nil), sessions.closing...)
		sessions.mu.Unlock()
		go func() {
			for _, session := range all {
				session.run.Cancel()
			}
			for _, session := range all {
				<-session.collectorDone
				session.stopRetention()
			}
			close(sessions.closeDone)
		}()
	})
	select {
	case <-sessions.closeDone:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (sessions *CodeRunSessions) collect(id string, session *codeRunSession) {
	defer close(session.collectorDone)
	events := session.run.Events
	done := session.run.Done
	for events != nil || done != nil {
		select {
		case event, open := <-events:
			if !open {
				events = nil
				continue
			}
			session.append(event)
		case result, open := <-done:
			if !open {
				done = nil
				continue
			}
			if events != nil {
				for event := range events {
					session.append(event)
				}
				events = nil
			}
			session.finish(result)
			done = nil
		}
	}
	session.scheduleRetention(sessions.retention, func() { sessions.remove(id, session) })
}

func (sessions *CodeRunSessions) session(id string) *codeRunSession {
	if id == "" {
		return nil
	}
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	return sessions.sessions[id]
}

// sessionForRoot 不区分未知 id 与不匹配的根，避免通过会话 id 探测其它工作区。
func (sessions *CodeRunSessions) sessionForRoot(id, root string) (*codeRunSession, error) {
	ownerRoot, err := sessionOwnerRoot(root)
	if err != nil {
		return nil, err
	}
	session := sessions.session(id)
	if session == nil || session.root != ownerRoot {
		return nil, ErrCodeRunSessionNotFound
	}
	return session, nil
}

func (sessions *CodeRunSessions) remove(id string, expected *codeRunSession) {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	if sessions.sessions[id] == expected {
		delete(sessions.sessions, id)
		if nonce, ok := sessions.nonces[expected.nonce]; ok && nonce.session == expected {
			delete(sessions.nonces, expected.nonce)
		}
	}
}

func (sessions *CodeRunSessions) pollDuration(waitMs int64) (time.Duration, error) {
	if waitMs == 0 {
		return sessions.pollWait, nil
	}
	if waitMs < 0 {
		return 0, errors.New("remote code runner: waitMs cannot be negative")
	}
	if uint64(waitMs) > maxCodeWireInteger || waitMs > maxCodePollWait.Milliseconds() {
		return 0, fmt.Errorf("remote code runner: waitMs exceeds %s", maxCodePollWait)
	}
	return time.Duration(waitMs) * time.Millisecond, nil
}

func (session *codeRunSession) append(event CodeRunEvent) {
	var rejected *CodeToolCall
	session.mu.Lock()
	if session.done {
		session.mu.Unlock()
		return
	}
	wire := CodeRunWireEvent{Sequence: session.cursor + 1}
	if event.ToolCall != nil {
		call := event.ToolCall
		wire.Type = "tool_call"
		wire.CallID = call.ID
		wire.Global = call.Global
		wire.Name = call.Name
		wire.Arguments = cloneRawMessage(call.Arguments)
	} else if event.Log != nil {
		wire.Type = "log"
		wire.Level = event.Log.Level
		wire.Text = event.Log.Text
	} else {
		session.mu.Unlock()
		return
	}
	encoded, err := json.Marshal(wire)
	// Host 在同一远端 run 中最多允许 128 个未回包 binding；在 agent 侧
	// 提前拒绝第 129 个，而不是把一个本可诊断的资源上限变成 hostile
	// polling 协议错误。
	pendingFull := event.ToolCall != nil && len(session.pending) >= maxCodePendingBindings
	if err == nil && !pendingFull && session.canRetainLocked(len(encoded), false) {
		session.cursor++
		stored := storedCodeRunEvent{wire: wire, bytes: len(encoded)}
		session.events = append(session.events, stored)
		session.eventBytes += len(encoded)
		if event.ToolCall != nil {
			session.pending[event.ToolCall.ID] = event.ToolCall
		}
		session.wakeLocked()
	} else if event.ToolCall != nil {
		rejected = event.ToolCall
	}
	session.mu.Unlock()
	if rejected != nil {
		// 未投递的 tool_call 不得占用 sequence；拒绝其 Promise 可让 Goja
		// 产生有界终态，避免 Host 永远等一条实际上不会出现的调用。
		_ = rejected.Reject(errors.New("remote code runner: tool call cannot be retained within session limits"))
	}
}

func (session *codeRunSession) finish(result CodeRunResult) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.done {
		return
	}
	session.cursor++
	wire, encoded := codeDoneEventWithinBudget(session.cursor, result, session.maxEventBytes)
	// canRetainLocked 为每条非终态事件预留了 maxEventBytes；因此 terminal
	// 一定可写入。若将来改了预留策略，这个兜底不静默丢 done。
	if session.eventBytes+len(encoded) > session.maxSessionBytes {
		wire, encoded = codeDoneEventWithinBudget(session.cursor, CodeRunResult{
			Logs: []string{}, Error: &CodeRunFailure{Kind: "output-limit", Message: ""},
		}, session.maxEventBytes)
	}
	session.events = append(session.events, storedCodeRunEvent{wire: wire, bytes: len(encoded)})
	session.eventBytes += len(encoded)
	session.pending = make(map[uint64]*CodeToolCall)
	session.done = true
	session.wakeLocked()
	close(session.terminalDone)
}

func (session *codeRunSession) canRetainLocked(bytes int, terminal bool) bool {
	if bytes > session.maxEventBytes {
		return false
	}
	if terminal {
		return session.eventBytes+bytes <= session.maxSessionBytes
	}
	// done 必须在每一种饱和路径中仍可保存，故为它预留一个完整单事件和
	// 一个 event slot。没有接受的 event 就没有可见 sequence，也就不存在
	// 分页时跳过序号的问题。
	return len(session.events)+1 < session.maxEvents &&
		session.eventBytes+bytes+session.maxEventBytes <= session.maxSessionBytes
}

// codeDoneEventWithinBudget 在终态进入可重放事件账本前重新压缩一次输出。
// 远端 runner、会话和 HTTP 都独立有边界，不能假定任一上游已经留足 wire
// envelope 空间。
func codeDoneEventWithinBudget(sequence uint64, result CodeRunResult, maxEventBytes int) (CodeRunWireEvent, []byte) {
	budget := maxEventBytes - codeDoneEventReserve
	if budget < minCodeOutput {
		budget = minCodeOutput
	}
	for {
		candidate := boundedCodeRunResult(result, budget)
		wire := CodeRunWireEvent{
			Type:     "done",
			Sequence: sequence,
			Value:    cloneRawMessage(candidate.Value),
			// logs 是 wire 协议中的必有数组；空日志编码为 []，不能让 nil 漏成 null。
			Logs: append([]string{}, candidate.Logs...), Error: cloneCodeRunFailure(candidate.Error),
		}
		encoded, err := json.Marshal(wire)
		if err == nil && len(encoded) <= maxEventBytes {
			return wire, encoded
		}
		if budget <= minCodeOutput {
			return wire, encoded
		}
		over := 1
		if err == nil {
			over = len(encoded) - maxEventBytes + 1
		}
		budget -= over
		if budget < minCodeOutput {
			budget = minCodeOutput
		}
	}
}

func boundedCodeRunResult(result CodeRunResult, maxBytes int) CodeRunResult {
	ledger := newCodeOutputLedger(maxBytes)
	for _, log := range result.Logs {
		ledger.append(log)
	}
	if result.Error != nil {
		return ledger.failure(result.Error.Kind, result.Error.Message)
	}
	return ledger.success(result.Value, result.Value != nil)
}

func (session *codeRunSession) next(ctx context.Context, after uint64, wait time.Duration) CodeRunNextResponse {
	deadline := time.NewTimer(wait)
	defer deadline.Stop()
	for {
		session.mu.Lock()
		response := session.responseAfterLocked(after)
		notify := session.notify
		// 只要已有可连续交付的事件就立即返回。若响应因字节分页截断，下一
		// 次请求会从本批最后 sequence 继续，而不是把 cursor 跳到全局末尾。
		ready := len(response.Events) > 0
		session.mu.Unlock()
		if ready {
			return response
		}
		select {
		case <-ctx.Done():
			return response
		case <-deadline.C:
			return response
		case <-notify:
		}
	}
}

func (session *codeRunSession) responseAfterLocked(after uint64) CodeRunNextResponse {
	first := len(session.events)
	for index, event := range session.events {
		if event.wire.Sequence > after {
			first = index
			break
		}
	}
	// events 是 polling wire 协议中的必有数组；空批次不能被编码为 null。
	events := make([]CodeRunWireEvent, 0, len(session.events)-first)
	arrayBytes := 2 // []
	cursor := after
	done := false
	for _, stored := range session.events[first:] {
		extra := stored.bytes
		if len(events) > 0 {
			extra++
		}
		candidateCursor := stored.wire.Sequence
		candidateDone := stored.wire.Type == "done"
		if codePollResponseBytes(arrayBytes+extra, candidateCursor, candidateDone) > session.maxPollResponseBytes {
			break
		}
		events = append(events, cloneCodeRunWireEvent(stored.wire))
		arrayBytes += extra
		cursor = candidateCursor
		done = candidateDone
	}
	return CodeRunNextResponse{Events: events, Cursor: cursor, Done: done}
}

func (session *codeRunSession) reply(request CodeRunReplyRequest) error {
	session.mu.Lock()
	call := session.pending[request.CallID]
	if call == nil {
		session.mu.Unlock()
		return ErrCodeRunCallNotFound
	}
	session.mu.Unlock()
	var err error
	if request.OK {
		err = call.ResolveJSON(request.Value)
	} else {
		err = call.Reject(errors.New(request.Message))
	}
	if err != nil {
		return err
	}
	session.mu.Lock()
	if session.pending[request.CallID] == call {
		delete(session.pending, request.CallID)
	}
	session.mu.Unlock()
	return nil
}

func (session *codeRunSession) wakeLocked() {
	close(session.notify)
	session.notify = make(chan struct{})
}

func (session *codeRunSession) scheduleRetention(duration time.Duration, remove func()) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.retentionTimer == nil {
		session.retentionTimer = time.AfterFunc(duration, remove)
	}
}

func (session *codeRunSession) stopRetention() {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.retentionTimer != nil {
		session.retentionTimer.Stop()
	}
}

func codePollResponseBytes(eventArrayBytes int, cursor uint64, done bool) int {
	doneText := "false"
	if done {
		doneText = "true"
	}
	return len(`{"events":`) + eventArrayBytes + len(`,"cursor":`) + len(strconv.FormatUint(cursor, 10)) +
		len(`,"done":`) + len(doneText) + 1
}

func cloneCodeRunWireEvent(event CodeRunWireEvent) CodeRunWireEvent {
	return CodeRunWireEvent{
		Type: event.Type, Sequence: event.Sequence, CallID: event.CallID, Global: event.Global, Name: event.Name,
		Arguments: cloneRawMessage(event.Arguments), Level: event.Level, Text: event.Text,
		Value: cloneRawMessage(event.Value), Logs: append([]string{}, event.Logs...), Error: cloneCodeRunFailure(event.Error),
	}
}

func codeRunRequestFromWire(request CodeRunStartRequest) (CodeRunRequest, error) {
	if err := validateCodeMemoryLimit(request.MemoryLimitBytes); err != nil {
		return CodeRunRequest{}, err
	}
	if request.ComputeMs <= 0 || request.ComputeMs > maxCodeTimeout.Milliseconds() {
		return CodeRunRequest{}, fmt.Errorf("remote code runner: computeMs must be between 1 and %d", maxCodeTimeout.Milliseconds())
	}
	result := CodeRunRequest{
		Program: request.Program, Bindings: request.Bindings, MemoryLimitBytes: request.MemoryLimitBytes,
		Compute: time.Duration(request.ComputeMs) * time.Millisecond,
	}
	if request.TimeoutMs < 0 || uint64(request.TimeoutMs) > maxCodeWireInteger {
		return CodeRunRequest{}, errors.New("remote code runner: timeoutMs cannot be negative")
	}
	if request.TimeoutMs > 0 {
		if request.TimeoutMs > maxCodeTimeout.Milliseconds() {
			return CodeRunRequest{}, fmt.Errorf("remote code runner: timeoutMs exceeds %s", maxCodeTimeout)
		}
		result.Timeout = time.Duration(request.TimeoutMs) * time.Millisecond
	}
	return result, nil
}

func validCodeRunStartNonce(value string) bool {
	if len(value) != 32 {
		return false
	}
	for _, character := range value {
		if !(character >= '0' && character <= '9') && !(character >= 'a' && character <= 'f') {
			return false
		}
	}
	return true
}

func codeRunStartFingerprint(request CodeRunRequest) ([sha256.Size]byte, error) {
	encoded, err := json.Marshal(struct {
		Program          string                 `json:"program"`
		Bindings         []CodeBindingNamespace `json:"bindings"`
		TimeoutMs        int64                  `json:"timeoutMs"`
		ComputeMs        int64                  `json:"computeMs"`
		MemoryLimitBytes int64                  `json:"memoryLimitBytes"`
	}{
		Program: request.Program, Bindings: request.Bindings,
		TimeoutMs: request.Timeout.Milliseconds(), ComputeMs: request.Compute.Milliseconds(),
		MemoryLimitBytes: request.MemoryLimitBytes,
	})
	if err != nil {
		return [sha256.Size]byte{}, fmt.Errorf("remote code runner: fingerprint start request: %w", err)
	}
	return sha256.Sum256(encoded), nil
}

func newCodeSessionID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("remote code runner: session id: %w", err)
	}
	return hex.EncodeToString(bytes), nil
}

func cloneCodeRunFailure(failure *CodeRunFailure) *CodeRunFailure {
	if failure == nil {
		return nil
	}
	return &CodeRunFailure{Kind: failure.Kind, Message: failure.Message}
}
