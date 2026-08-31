package remoteagent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

const (
	codeIsolateMemoryLimitEnv = "CODING_REMOTE_AGENT_CODE_ISOLATE_MEMORY_LIMIT_BYTES"
	codeIsolateTestChildEnv   = "CODING_REMOTE_AGENT_CODE_ISOLATE_TEST_CHILD"
	codeIsolateFrameBytes     = maxRequestBytes
	codeIsolateStderrBytes    = 64 << 10
	codeIsolateCancelGrace    = 250 * time.Millisecond
	codeIsolateTimeoutGrace   = 2 * time.Second
	maxCodeWireInteger        = uint64(1<<53 - 1)
	// isolate 协议最多携带与最大 polling session 相同的有界事件历史。会话
	// collector 可以选择更小的上限；这个固定天花板既防止不可信 child 无限
	// streaming，也允许合法运行超过默认事件缓冲。
	maxCodeIsolateStreamedEvents = maxCodeSessionEvents
)

// CodeIsolateOptions 是一次 re-exec 运行所需的、已由父 runner 校验的上限。
// Command 为空时使用 remote-agent 自身的 --code-isolate 入口。
type CodeIsolateOptions struct {
	Command        []string
	Env            []string
	DefaultTimeout time.Duration
	MaxTimeout     time.Duration
	MaxOutputBytes int
	MaxEventBytes  int
	EventBuffer    int
}

type codeIsolateStart struct {
	Type    string                 `json:"type"`
	Request codeIsolateRequest     `json:"request"`
	Options codeIsolateRunnerLimit `json:"options"`
}

type codeIsolateRequest struct {
	Program          string                 `json:"program"`
	Bindings         []CodeBindingNamespace `json:"bindings"`
	TimeoutMs        int64                  `json:"timeoutMs"`
	ComputeMs        int64                  `json:"computeMs"`
	MemoryLimitBytes int64                  `json:"memoryLimitBytes"`
}

type codeIsolateRunnerLimit struct {
	DefaultTimeoutMs int64 `json:"defaultTimeoutMs"`
	MaxTimeoutMs     int64 `json:"maxTimeoutMs"`
	MaxOutputBytes   int   `json:"maxOutputBytes"`
	MaxEventBytes    int   `json:"maxEventBytes"`
	EventBuffer      int   `json:"eventBuffer"`
}

type codeIsolateLog struct {
	Type  string `json:"type"`
	Level string `json:"level"`
	Text  string `json:"text"`
}

type codeIsolateCall struct {
	Type      string          `json:"type"`
	ID        uint64          `json:"id"`
	Global    string          `json:"global"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type codeIsolateDone struct {
	Type   string        `json:"type"`
	Result CodeRunResult `json:"result"`
}

type codeIsolateReply struct {
	Type    string          `json:"type"`
	ID      uint64          `json:"id"`
	OK      bool            `json:"ok"`
	Value   json.RawMessage `json:"value,omitempty"`
	Message string          `json:"message,omitempty"`
}

type codeIsolateCancel struct {
	Type string `json:"type"`
}

// codeIsolateObject 把一帧先限制为封闭 JSON object。后续 variant parser 必须
// 明确声明所有字段，避免 child 或本地 Host 的协议漂移被静默接受。
func codeIsolateObject(frame []byte, allowed ...string) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(frame))
	var value map[string]json.RawMessage
	if err := decoder.Decode(&value); err != nil || value == nil {
		return nil, errors.New("remote code isolate: frame must be an object")
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, errors.New("remote code isolate: trailing protocol JSON")
	}
	permitted := make(map[string]struct{}, len(allowed))
	for _, key := range allowed {
		permitted[key] = struct{}{}
	}
	for key := range value {
		if _, ok := permitted[key]; !ok {
			return nil, fmt.Errorf("remote code isolate: unsupported protocol field %q", key)
		}
	}
	return value, nil
}

func codeIsolateRequiredField(object map[string]json.RawMessage, key string) (json.RawMessage, error) {
	value, ok := object[key]
	if !ok {
		return nil, fmt.Errorf("remote code isolate: missing protocol field %q", key)
	}
	return value, nil
}

func codeIsolateString(object map[string]json.RawMessage, key string) (string, error) {
	raw, err := codeIsolateRequiredField(object, key)
	if err != nil {
		return "", err
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil || !utf8.ValidString(value) {
		return "", fmt.Errorf("remote code isolate: field %q must be a UTF-8 string", key)
	}
	return value, nil
}

func codeIsolateSafeUint(object map[string]json.RawMessage, key string, minimum uint64) (uint64, error) {
	raw, err := codeIsolateRequiredField(object, key)
	if err != nil {
		return 0, err
	}
	value, err := strconv.ParseUint(string(raw), 10, 64)
	if err != nil || value < minimum || value > maxCodeWireInteger {
		return 0, fmt.Errorf("remote code isolate: field %q must be a safe integer", key)
	}
	return value, nil
}

func codeIsolateSafeInt(object map[string]json.RawMessage, key string, minimum int64, maximum int64) (int64, error) {
	raw, err := codeIsolateRequiredField(object, key)
	if err != nil {
		return 0, err
	}
	value, err := strconv.ParseInt(string(raw), 10, 64)
	if err != nil || value < minimum || value > maximum || uint64(value) > maxCodeWireInteger {
		return 0, fmt.Errorf("remote code isolate: field %q must be a safe integer", key)
	}
	return value, nil
}

type codeIsolateFrameWriter struct {
	mu  sync.Mutex
	out io.Writer
}

func (writer *codeIsolateFrameWriter) write(value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	// 上限包含 NDJSON 的结尾换行；writer 与 reader 因此不会在恰好边界处
	// 对同一帧得出相反结论。
	if len(encoded) == 0 || len(encoded) >= codeIsolateFrameBytes {
		return errors.New("remote code isolate: protocol frame exceeds limit")
	}
	encoded = append(encoded, '\n')
	writer.mu.Lock()
	defer writer.mu.Unlock()
	for len(encoded) > 0 {
		count, writeErr := writer.out.Write(encoded)
		if writeErr != nil {
			return writeErr
		}
		if count == 0 {
			return io.ErrShortWrite
		}
		encoded = encoded[count:]
	}
	return nil
}

func readCodeIsolateFrame(reader *bufio.Reader) ([]byte, error) {
	var frame bytes.Buffer
	for {
		fragment, err := reader.ReadSlice('\n')
		if len(fragment) > codeIsolateFrameBytes-frame.Len() {
			return nil, errors.New("remote code isolate: protocol frame exceeds limit")
		}
		_, _ = frame.Write(fragment)
		if err == nil {
			break
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return nil, err
		}
	}
	result := bytes.TrimSuffix(frame.Bytes(), []byte{'\n'})
	if len(result) == 0 {
		return nil, errors.New("remote code isolate: empty protocol frame")
	}
	return append([]byte{}, result...), nil
}

func decodeCodeIsolateFrame(frame []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(frame))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("remote code isolate: trailing protocol JSON")
		}
		return err
	}
	return nil
}

func codeIsolateType(frame []byte) (string, error) {
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(frame, &head); err != nil || head.Type == "" {
		return "", errors.New("remote code isolate: invalid protocol frame")
	}
	return head.Type, nil
}

func codeIsolateOptionsFromRunner(runner *CodeRunner) CodeIsolateOptions {
	return CodeIsolateOptions{
		Command: append([]string{}, runner.isolateCommand...), Env: append([]string{}, runner.isolateEnv...),
		DefaultTimeout: runner.defaultTimeout, MaxTimeout: runner.maxTimeout,
		MaxOutputBytes: runner.maxOutputBytes, MaxEventBytes: runner.maxEventBytes, EventBuffer: runner.eventBuffer,
	}
}

// StartCodeIsolate re-exec 当前 agent，令 Goja 只在可独立回收的 child 中执行。
// Child 的 stdout 仅承载有界 NDJSON；工具调用仍由父 agent 交给本地 Host 结算。
func StartCodeIsolate(parent context.Context, request CodeRunRequest, options CodeIsolateOptions) *CodeRun {
	if parent == nil {
		parent = context.Background()
	}
	if request.MemoryLimitBytes == 0 {
		request.MemoryLimitBytes = defaultCodeMemoryLimitBytes
	}
	if options.EventBuffer < 0 {
		options.EventBuffer = 0
	}
	ctx, cancel := context.WithCancel(parent)
	events := make(chan CodeRunEvent, options.EventBuffer)
	done := make(chan CodeRunResult, 1)
	run := &CodeRun{Events: events, Done: done, cancel: cancel}
	go func() {
		defer cancel()
		result := runCodeIsolateParent(ctx, request, options, events)
		close(events)
		done <- result
		close(done)
	}()
	return run
}

func runCodeIsolateParent(ctx context.Context, request CodeRunRequest, options CodeIsolateOptions, events chan<- CodeRunEvent) CodeRunResult {
	if err := validateCodeMemoryLimit(request.MemoryLimitBytes); err != nil {
		return codeIsolateFailure(err.Error())
	}
	timeout, err := codeIsolateRunTimeout(request, options)
	if err != nil {
		return CodeRunResult{Logs: []string{}, Error: &CodeRunFailure{Kind: "exception", Message: err.Error()}}
	}
	compute, err := codeIsolateRunComputeBudget(request, options, timeout)
	if err != nil {
		return CodeRunResult{Logs: []string{}, Error: &CodeRunFailure{Kind: "exception", Message: err.Error()}}
	}
	command, err := newCodeIsolateCommand(options.Command, options.Env, request.MemoryLimitBytes)
	if err != nil {
		return codeIsolateFailure(err.Error())
	}
	configureCommand(command)
	stdin, err := command.StdinPipe()
	if err != nil {
		return codeIsolateFailure(err.Error())
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return codeIsolateFailure(err.Error())
	}
	stderr, err := command.StderrPipe()
	if err != nil {
		return codeIsolateFailure(err.Error())
	}
	if err := command.Start(); err != nil {
		return codeIsolateFailure(fmt.Sprintf("start isolate: %v", err))
	}
	limitAttachment, err := attachCodeIsolateMemoryLimit(command, request.MemoryLimitBytes)
	if err != nil {
		killProcessTree(command)
		_ = command.Wait()
		return codeIsolateFailure(err.Error())
	}
	if limitAttachment != nil {
		defer limitAttachment.Close()
	}
	stderrDone := captureCodeIsolateStderr(stderr)
	writer := &codeIsolateFrameWriter{out: stdin}
	reader := bufio.NewReaderSize(stdout, 64<<10)
	finished := make(chan struct{})
	defer close(finished)
	stopWatchers := make(chan struct{})
	defer close(stopWatchers)
	var cancelSent atomic.Bool
	var timeoutExpired atomic.Bool
	go func() {
		select {
		case <-ctx.Done():
			timer := time.NewTimer(codeIsolateCancelGrace)
			defer timer.Stop()
			written := make(chan error, 1)
			go func() { written <- writer.write(codeIsolateCancel{Type: "cancel"}) }()
			select {
			case err := <-written:
				if err == nil {
					cancelSent.Store(true)
				} else {
					_ = stdin.Close()
					killProcessTree(command)
					return
				}
				select {
				case <-timer.C:
					_ = stdin.Close()
					killProcessTree(command)
				case <-stopWatchers:
				}
			case <-timer.C:
				_ = stdin.Close()
				killProcessTree(command)
			case <-stopWatchers:
			}
		case <-stopWatchers:
		}
	}()
	watchdog := time.NewTimer(timeout + codeIsolateTimeoutGrace)
	defer watchdog.Stop()
	go func() {
		select {
		case <-watchdog.C:
			timeoutExpired.Store(true)
			_ = stdin.Close()
			killProcessTree(command)
		case <-stopWatchers:
		}
	}()
	timeoutMs := request.Timeout.Milliseconds()
	if request.Timeout <= 0 {
		timeoutMs = 0
	}
	start := codeIsolateStart{
		Type: "start",
		Request: codeIsolateRequest{
			Program: request.Program, Bindings: request.Bindings, TimeoutMs: timeoutMs,
			ComputeMs: codeDurationMilliseconds(compute), MemoryLimitBytes: request.MemoryLimitBytes,
		},
		Options: codeIsolateRunnerLimit{DefaultTimeoutMs: options.DefaultTimeout.Milliseconds(), MaxTimeoutMs: options.MaxTimeout.Milliseconds(), MaxOutputBytes: options.MaxOutputBytes, MaxEventBytes: options.MaxEventBytes, EventBuffer: options.EventBuffer},
	}
	if err := writer.write(start); err != nil {
		killProcessTree(command)
		_ = stdin.Close()
		_ = command.Wait()
		return codeIsolateFailure(fmt.Sprintf("start isolate protocol: %v", err))
	}
	replyFailure := make(chan error, 1)
	var replyFailureOnce sync.Once
	reportReplyFailure := func(err error) {
		replyFailureOnce.Do(func() {
			replyFailure <- err
			_ = stdin.Close()
			killProcessTree(command)
		})
	}
	takeReplyFailure := func() error {
		select {
		case err := <-replyFailure:
			return err
		default:
			return nil
		}
	}
	stop := func(protocolErr error) CodeRunResult {
		_ = stdin.Close()
		killProcessTree(command)
		_, _ = io.Copy(io.Discard, reader)
		waitErr := command.Wait()
		return codeIsolateExitResult(ctx, waitErr, <-stderrDone, protocolErr, cancelSent.Load(), timeoutExpired.Load())
	}
	var terminal *CodeRunResult
	// seenCalls 保留整个运行期间见过的 id，用于拒绝重放；pendingCalls 只
	// 记录尚未成功把 Host 回包写入 child 的调用。replyWriter 持锁完成写入
	// 和删除，避免 child 在收到回包后立刻发出下一调用时读到过期槽位。
	seenCalls := make(map[uint64]struct{})
	pendingCalls := make(map[uint64]struct{}, maxCodePendingBindings)
	var pendingCallsMu sync.Mutex
	var lastCallID uint64
	replyWriter := func(message codeIsolateReply) error {
		pendingCallsMu.Lock()
		defer pendingCallsMu.Unlock()
		if err := writer.write(message); err != nil {
			return err
		}
		delete(pendingCalls, message.ID)
		return nil
	}
	streamedEvents := 0
	for {
		if err := takeReplyFailure(); err != nil {
			return stop(err)
		}
		frame, readErr := readCodeIsolateFrame(reader)
		if err := takeReplyFailure(); err != nil {
			return stop(err)
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) || terminal == nil {
				return stop(readErr)
			}
			break
		}
		typeName, typeErr := codeIsolateType(frame)
		if typeErr != nil || terminal != nil {
			return stop(errors.New("invalid isolate protocol"))
		}
		switch typeName {
		case "log":
			message, err := decodeCodeIsolateLog(frame)
			if err != nil {
				return stop(err)
			}
			streamedEvents++
			if streamedEvents > maxCodeIsolateStreamedEvents {
				return stop(errors.New("remote code isolate: too many streamed events"))
			}
			select {
			case events <- CodeRunEvent{Log: &CodeLogEvent{Level: message.Level, Text: message.Text}}:
			default:
			}
		case "tool_call":
			message, err := decodeCodeIsolateCall(frame)
			if err != nil {
				return stop(err)
			}
			if _, exists := seenCalls[message.ID]; exists {
				return stop(errors.New("remote code isolate: duplicate tool call id"))
			}
			if message.ID <= lastCallID {
				return stop(errors.New("remote code isolate: tool call ids must be strictly increasing"))
			}
			streamedEvents++
			pendingCallsMu.Lock()
			pendingFull := len(pendingCalls) >= maxCodePendingBindings
			if !pendingFull {
				pendingCalls[message.ID] = struct{}{}
			}
			pendingCallsMu.Unlock()
			if streamedEvents > maxCodeIsolateStreamedEvents || pendingFull {
				return stop(errors.New("remote code isolate: too many tool calls"))
			}
			seenCalls[message.ID] = struct{}{}
			lastCallID = message.ID
			call := &CodeToolCall{ID: message.ID, Global: message.Global, Name: message.Name, Arguments: cloneRawMessage(message.Arguments), finished: finished, reply: make(chan codeToolReply, 1)}
			go relayCodeIsolateReply(call, finished, replyWriter, reportReplyFailure)
			select {
			case events <- CodeRunEvent{ToolCall: call}:
			case <-ctx.Done():
			}
		case "done":
			result, err := decodeCodeIsolateDone(frame)
			if err != nil {
				return stop(err)
			}
			pendingCallsMu.Lock()
			pendingCount := len(pendingCalls)
			pendingCallsMu.Unlock()
			if pendingCount != 0 && !codeIsolateDoneMayContainPending(result) {
				return stop(errors.New("remote code isolate: completion arrived with pending tool calls"))
			}
			if pendingCount != 0 {
				// timeout/abort 是父端已经收敛执行的终态；未回包调用随
				// finished 一起失效，不能继续占用 relay 生命周期。
				pendingCallsMu.Lock()
				clear(pendingCalls)
				pendingCallsMu.Unlock()
			}
			if !codeRunResultFits(options.MaxOutputBytes, result) {
				return stop(errors.New("remote code isolate: result exceeds output limit"))
			}
			terminalResult := cloneCodeIsolateResult(result)
			terminal = &terminalResult
			_ = stdin.Close()
		default:
			return stop(errors.New("unsupported isolate event"))
		}
	}
	waitErr := command.Wait()
	if waitErr != nil {
		return codeIsolateExitResult(ctx, waitErr, <-stderrDone, nil, cancelSent.Load(), timeoutExpired.Load())
	}
	<-stderrDone
	if terminal == nil {
		return codeIsolateFailure("isolate exited without completion")
	}
	return *terminal
}

func codeIsolateRunTimeout(request CodeRunRequest, options CodeIsolateOptions) (time.Duration, error) {
	timeout := request.Timeout
	if timeout <= 0 {
		timeout = options.DefaultTimeout
	}
	if timeout <= 0 {
		return 0, errors.New("remote code isolate: default timeout must be positive")
	}
	if options.MaxTimeout <= 0 || timeout > options.MaxTimeout {
		return 0, fmt.Errorf("timeout exceeds maximum %s", options.MaxTimeout)
	}
	return timeout, nil
}

// codeIsolateRunComputeBudget 在 child wire 中明确传递累计计算预算。直接调用
// CodeRunner 的旧内部调用未指定 Compute 时与原有行为一致，采用墙钟上限。
func codeIsolateRunComputeBudget(request CodeRunRequest, options CodeIsolateOptions, timeout time.Duration) (time.Duration, error) {
	compute := request.Compute
	if compute == 0 {
		compute = timeout
	}
	if compute <= 0 || compute > options.MaxTimeout {
		return 0, fmt.Errorf("compute budget exceeds maximum %s", options.MaxTimeout)
	}
	return compute, nil
}

func codeDurationMilliseconds(duration time.Duration) int64 {
	return int64((duration + time.Millisecond - 1) / time.Millisecond)
}

func relayCodeIsolateReply(call *CodeToolCall, finished <-chan struct{}, writeReply func(codeIsolateReply) error, reportFailure func(error)) {
	select {
	case reply := <-call.reply:
		message := codeIsolateReply{Type: "reply", ID: call.ID}
		if reply.rejected {
			message.Message = reply.message
		} else {
			message.OK = true
			message.Value = cloneRawMessage(reply.value)
		}
		if err := writeReply(message); err != nil {
			reportFailure(fmt.Errorf("remote code isolate: write reply: %w", err))
		}
	case <-finished:
	}
}

func captureCodeIsolateStderr(reader io.Reader) <-chan string {
	done := make(chan string, 1)
	go func() {
		var retained bytes.Buffer
		buffer := make([]byte, 32<<10)
		truncated := false
		for {
			count, err := reader.Read(buffer)
			if count > 0 {
				remaining := codeIsolateStderrBytes - retained.Len()
				if remaining > 0 {
					if count > remaining {
						_, _ = retained.Write(buffer[:remaining])
						truncated = true
					} else {
						_, _ = retained.Write(buffer[:count])
					}
				} else {
					truncated = true
				}
			}
			if err != nil {
				break
			}
		}
		data := retained.Bytes()
		if truncated {
			marker := []byte("…")
			if len(data) >= len(marker) {
				data = append(data[:len(data)-len(marker)], marker...)
			} else {
				data = marker
			}
		}
		done <- strings.TrimSpace(string(data))
		close(done)
	}()
	return done
}

func codeIsolateExitResult(ctx context.Context, waitErr error, stderr string, protocolErr error, cancelSent, timeoutExpired bool) CodeRunResult {
	if timeoutExpired {
		return CodeRunResult{Logs: []string{}, Error: &CodeRunFailure{Kind: "timeout", Message: "wall-clock ceiling reached before the isolated worker completed"}}
	}
	// 只有 cancel frame 已成功写入 child 时，才能把随后退出归因于取消。若
	// stdin 已坏、OOM 或 worker 已死，ctx 恰好取消不能掩盖真正的 worker-exit。
	if cancelSent && ctx.Err() != nil {
		return CodeRunResult{Logs: []string{}, Error: &CodeRunFailure{Kind: "abort", Message: contextMessage(ctx)}}
	}
	parts := []string{"code isolate exited before completion"}
	if protocolErr != nil {
		parts = append(parts, protocolErr.Error())
	}
	if waitErr != nil {
		parts = append(parts, waitErr.Error())
	}
	if stderr != "" {
		parts = append(parts, stderr)
	}
	return codeIsolateFailure(strings.Join(parts, ": "))
}

func codeIsolateFailure(message string) CodeRunResult {
	return CodeRunResult{Logs: []string{}, Error: &CodeRunFailure{Kind: "worker-exit", Message: message}}
}

func validCodeIsolateResult(result CodeRunResult) bool {
	if result.Error != nil && result.Value != nil {
		return false
	}
	for _, log := range result.Logs {
		if !utf8.ValidString(log) {
			return false
		}
	}
	if result.Value != nil && !validCodeJSON(result.Value) {
		return false
	}
	if result.Error != nil && (result.Error.Kind == "" || !utf8.ValidString(result.Error.Kind) || !utf8.ValidString(result.Error.Message)) {
		return false
	}
	return true
}

func cloneCodeIsolateResult(result CodeRunResult) CodeRunResult {
	return CodeRunResult{Value: cloneRawMessage(result.Value), Logs: append([]string{}, result.Logs...), Error: cloneCodeRunFailure(result.Error)}
}

// RunCodeIsolateStdio 是 --code-isolate 入口。它先从父进程注入的环境中取得
// 限额并施加平台硬限制，之后才读取可达 40 MiB 的首个协议帧。
func RunCodeIsolateStdio(in io.Reader, out io.Writer, _ io.Writer) error {
	limit, err := codeIsolateLimitFromEnvironment()
	if err != nil {
		return err
	}
	if err := installCodeIsolateMemoryLimit(limit); err != nil {
		return err
	}
	return runCodeIsolateStdio(in, out, limit)
}

func codeIsolateLimitFromEnvironment() (int64, error) {
	text := os.Getenv(codeIsolateMemoryLimitEnv)
	limit, err := strconv.ParseInt(text, 10, 64)
	if err != nil {
		return 0, errors.New("remote code isolate: missing or invalid memory limit")
	}
	if err := validateCodeMemoryLimit(limit); err != nil {
		return 0, err
	}
	return limit, nil
}

func codeIsolateCommandArgs(command []string) ([]string, error) {
	if len(command) == 0 {
		executable, err := os.Executable()
		if err != nil {
			return nil, fmt.Errorf("remote code isolate: locate executable: %w", err)
		}
		// `go test` 的二进制没有 remote-agent 的 main。测试子进程仍然是真实
		// re-exec；TestMain 根据专用环境变量进入同一 stdio child 入口。
		if isGoTestBinary(executable) {
			return []string{executable, "-test.run=^$"}, nil
		}
		return []string{executable, "--code-isolate"}, nil
	}
	for _, part := range command {
		if strings.TrimSpace(part) == "" {
			return nil, errors.New("remote code isolate: command contains an empty argument")
		}
	}
	return append([]string{}, command...), nil
}

func newCodeIsolateCommand(command []string, extra []string, memoryLimit int64) (*exec.Cmd, error) {
	if err := validateCodeMemoryLimit(memoryLimit); err != nil {
		return nil, err
	}
	argv, err := codeIsolateCommandArgs(command)
	if err != nil {
		return nil, err
	}
	argv, platformEnv, err := codeIsolatePlatformCommand(argv, memoryLimit)
	if err != nil {
		return nil, err
	}
	if len(argv) == 0 {
		return nil, errors.New("remote code isolate: platform produced an empty command")
	}
	child := exec.Command(argv[0], argv[1:]...)
	child.Env = codeIsolateEnvironment(extra, platformEnv, memoryLimit)
	return child, nil
}

func codeIsolateEnvironment(extra []string, platform []string, memoryLimit int64) []string {
	values := append([]string{}, os.Environ()...)
	values = append(values, extra...)
	for _, item := range platform {
		key, value, found := strings.Cut(item, "=")
		if !found || key == "" {
			continue
		}
		values = codeIsolateReplaceEnvironment(values, key, value)
	}
	values = codeIsolateReplaceEnvironment(values, codeIsolateMemoryLimitEnv, strconv.FormatInt(memoryLimit, 10))
	if isGoTestBinary(os.Args[0]) {
		values = codeIsolateReplaceEnvironment(values, codeIsolateTestChildEnv, "1")
	}
	return values
}

// isGoTestBinary 识别 Unix 与 Windows 上 `go test` 的 re-exec 名称。Windows
// 会附加 `.exe`；若把它视为普通 agent，就会递归进入 TestMain 而非 isolate stdio child。
func isGoTestBinary(path string) bool {
	base := strings.ToLower(filepath.Base(path))
	return strings.HasSuffix(base, ".test") || strings.HasSuffix(base, ".test.exe")
}

func codeIsolateReplaceEnvironment(values []string, key, value string) []string {
	prefix := key + "="
	retained := values[:0]
	for _, item := range values {
		if !strings.HasPrefix(item, prefix) {
			retained = append(retained, item)
		}
	}
	return append(retained, prefix+value)
}

func decodeCodeIsolateStart(frame []byte, memoryLimit int64) (codeIsolateStart, error) {
	object, err := codeIsolateObject(frame, "type", "request", "options")
	if err != nil {
		return codeIsolateStart{}, err
	}
	typeName, err := codeIsolateString(object, "type")
	if err != nil || typeName != "start" {
		return codeIsolateStart{}, errors.New("remote code isolate: invalid start type")
	}
	requestRaw, err := codeIsolateRequiredField(object, "request")
	if err != nil {
		return codeIsolateStart{}, err
	}
	requestObject, err := codeIsolateObject(requestRaw, "program", "bindings", "timeoutMs", "computeMs", "memoryLimitBytes")
	if err != nil {
		return codeIsolateStart{}, err
	}
	if _, err := codeIsolateString(requestObject, "program"); err != nil {
		return codeIsolateStart{}, err
	}
	if _, err := codeIsolateRequiredField(requestObject, "bindings"); err != nil {
		return codeIsolateStart{}, err
	}
	if _, err := codeIsolateSafeInt(requestObject, "timeoutMs", 0, maxCodeTimeout.Milliseconds()); err != nil {
		return codeIsolateStart{}, err
	}
	configuredCompute, err := codeIsolateSafeInt(requestObject, "computeMs", 1, maxCodeTimeout.Milliseconds())
	if err != nil {
		return codeIsolateStart{}, err
	}
	configuredMemory, err := codeIsolateSafeInt(requestObject, "memoryLimitBytes", 1, maxCodeMemoryLimitBytes)
	if err != nil || configuredMemory != memoryLimit {
		return codeIsolateStart{}, errors.New("remote code isolate: start memory limit does not match child environment")
	}
	optionsRaw, err := codeIsolateRequiredField(object, "options")
	if err != nil {
		return codeIsolateStart{}, err
	}
	optionsObject, err := codeIsolateObject(optionsRaw, "defaultTimeoutMs", "maxTimeoutMs", "maxOutputBytes", "maxEventBytes", "eventBuffer")
	if err != nil {
		return codeIsolateStart{}, err
	}
	defaultTimeout, err := codeIsolateSafeInt(optionsObject, "defaultTimeoutMs", 1, maxCodeTimeout.Milliseconds())
	if err != nil {
		return codeIsolateStart{}, err
	}
	maximumTimeout, err := codeIsolateSafeInt(optionsObject, "maxTimeoutMs", defaultTimeout, maxCodeTimeout.Milliseconds())
	if err != nil {
		return codeIsolateStart{}, err
	}
	if _, err := codeIsolateSafeInt(optionsObject, "maxOutputBytes", minCodeOutput, codeIsolateFrameBytes); err != nil {
		return codeIsolateStart{}, err
	}
	if _, err := codeIsolateSafeInt(optionsObject, "maxEventBytes", minCodeOutput, codeIsolateFrameBytes); err != nil {
		return codeIsolateStart{}, err
	}
	if _, err := codeIsolateSafeInt(optionsObject, "eventBuffer", 0, maxCodeSessionEvents); err != nil {
		return codeIsolateStart{}, err
	}
	var start codeIsolateStart
	if err := decodeCodeIsolateFrame(frame, &start); err != nil {
		return codeIsolateStart{}, err
	}
	if start.Options.DefaultTimeoutMs != defaultTimeout || start.Options.MaxTimeoutMs != maximumTimeout || start.Request.ComputeMs != configuredCompute || start.Request.MemoryLimitBytes != configuredMemory {
		return codeIsolateStart{}, errors.New("remote code isolate: inconsistent start frame")
	}
	return start, nil
}

func decodeCodeIsolateLog(frame []byte) (codeIsolateLog, error) {
	object, err := codeIsolateObject(frame, "type", "level", "text")
	if err != nil {
		return codeIsolateLog{}, err
	}
	typeName, err := codeIsolateString(object, "type")
	if err != nil || typeName != "log" {
		return codeIsolateLog{}, errors.New("remote code isolate: invalid log type")
	}
	level, err := codeIsolateString(object, "level")
	if err != nil || level == "" {
		return codeIsolateLog{}, errors.New("remote code isolate: invalid log level")
	}
	text, err := codeIsolateString(object, "text")
	if err != nil {
		return codeIsolateLog{}, err
	}
	return codeIsolateLog{Type: typeName, Level: level, Text: text}, nil
}

func decodeCodeIsolateCall(frame []byte) (codeIsolateCall, error) {
	object, err := codeIsolateObject(frame, "type", "id", "global", "name", "arguments")
	if err != nil {
		return codeIsolateCall{}, err
	}
	typeName, err := codeIsolateString(object, "type")
	if err != nil || typeName != "tool_call" {
		return codeIsolateCall{}, errors.New("remote code isolate: invalid tool call type")
	}
	id, err := codeIsolateSafeUint(object, "id", 1)
	if err != nil {
		return codeIsolateCall{}, err
	}
	global, err := codeIsolateString(object, "global")
	if err != nil || global == "" {
		return codeIsolateCall{}, errors.New("remote code isolate: invalid tool call global")
	}
	name, err := codeIsolateString(object, "name")
	if err != nil || name == "" {
		return codeIsolateCall{}, errors.New("remote code isolate: invalid tool call name")
	}
	arguments, err := codeIsolateRequiredField(object, "arguments")
	if err != nil || !validCodeJSON(arguments) {
		return codeIsolateCall{}, errors.New("remote code isolate: invalid tool call arguments")
	}
	return codeIsolateCall{Type: typeName, ID: id, Global: global, Name: name, Arguments: cloneRawMessage(arguments)}, nil
}

func decodeCodeIsolateDone(frame []byte) (CodeRunResult, error) {
	object, err := codeIsolateObject(frame, "type", "result")
	if err != nil {
		return CodeRunResult{}, err
	}
	typeName, err := codeIsolateString(object, "type")
	if err != nil || typeName != "done" {
		return CodeRunResult{}, errors.New("remote code isolate: invalid done type")
	}
	rawResult, err := codeIsolateRequiredField(object, "result")
	if err != nil {
		return CodeRunResult{}, err
	}
	resultObject, err := codeIsolateObject(rawResult, "logs", "value", "error")
	if err != nil {
		return CodeRunResult{}, err
	}
	rawLogs, err := codeIsolateRequiredField(resultObject, "logs")
	if err != nil {
		return CodeRunResult{}, err
	}
	var rawLogItems []json.RawMessage
	if err := json.Unmarshal(rawLogs, &rawLogItems); err != nil || rawLogItems == nil {
		return CodeRunResult{}, errors.New("remote code isolate: result logs must be an array")
	}
	if len(rawLogItems) > defaultCodeEvents {
		return CodeRunResult{}, errors.New("remote code isolate: result has too many logs")
	}
	logs := make([]string, 0, len(rawLogItems))
	for _, rawLog := range rawLogItems {
		var log string
		if err := json.Unmarshal(rawLog, &log); err != nil || !utf8.ValidString(log) {
			return CodeRunResult{}, errors.New("remote code isolate: result log must be a UTF-8 string")
		}
		logs = append(logs, log)
	}
	rawValue, hasValue := resultObject["value"]
	rawFailure, hasFailure := resultObject["error"]
	if hasValue && hasFailure {
		return CodeRunResult{}, errors.New("remote code isolate: result has both value and error")
	}
	result := CodeRunResult{Logs: logs}
	if hasValue {
		if !validCodeJSON(rawValue) {
			return CodeRunResult{}, errors.New("remote code isolate: result value is not lossless JSON")
		}
		result.Value = cloneRawMessage(rawValue)
	}
	if hasFailure {
		failureObject, err := codeIsolateObject(rawFailure, "kind", "message")
		if err != nil {
			return CodeRunResult{}, err
		}
		kind, err := codeIsolateString(failureObject, "kind")
		if err != nil || !codeIsolateFailureKind(kind) {
			return CodeRunResult{}, errors.New("remote code isolate: unsupported result error kind")
		}
		message, err := codeIsolateString(failureObject, "message")
		if err != nil {
			return CodeRunResult{}, err
		}
		result.Error = &CodeRunFailure{Kind: kind, Message: message}
	}
	return result, nil
}

func codeIsolateFailureKind(kind string) bool {
	switch kind {
	case "exception", "timeout", "abort", "worker-exit", "invalid-output", "output-limit":
		return true
	default:
		return false
	}
}

func runCodeIsolateStdio(in io.Reader, out io.Writer, memoryLimit int64) error {
	reader := bufio.NewReaderSize(in, 64<<10)
	frame, err := readCodeIsolateFrame(reader)
	if err != nil {
		return err
	}
	start, err := decodeCodeIsolateStart(frame, memoryLimit)
	if err != nil {
		return err
	}
	runner, err := NewCodeRunner(CodeRunnerOptions{
		DefaultTimeout: time.Duration(start.Options.DefaultTimeoutMs) * time.Millisecond,
		MaxTimeout:     time.Duration(start.Options.MaxTimeoutMs) * time.Millisecond,
		MaxOutputBytes: start.Options.MaxOutputBytes, MaxEventBytes: start.Options.MaxEventBytes, EventBuffer: start.Options.EventBuffer,
	})
	if err != nil {
		return err
	}
	request := CodeRunRequest{
		Program: start.Request.Program, Bindings: start.Request.Bindings,
		Compute: time.Duration(start.Request.ComputeMs) * time.Millisecond, MemoryLimitBytes: memoryLimit,
	}
	if start.Request.TimeoutMs < 0 {
		return errors.New("remote code isolate: invalid timeout")
	}
	request.Timeout = time.Duration(start.Request.TimeoutMs) * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	events := make(chan CodeRunEvent, runner.eventBuffer)
	done := make(chan CodeRunResult, 1)
	go func() {
		result := runner.execute(ctx, request, events)
		close(events)
		done <- result
		close(done)
	}()
	writer := &codeIsolateFrameWriter{out: out}
	incoming := make(chan []byte, 1)
	readErr := make(chan error, 1)
	go func() {
		for {
			value, err := readCodeIsolateFrame(reader)
			if err != nil {
				readErr <- err
				return
			}
			incoming <- value
		}
	}()
	pending := make(map[uint64]*CodeToolCall)
	for events != nil || done != nil {
		select {
		case event, open := <-events:
			if !open {
				events = nil
				continue
			}
			if event.Log != nil {
				if err := writer.write(codeIsolateLog{Type: "log", Level: event.Log.Level, Text: event.Log.Text}); err != nil {
					return err
				}
			}
			if event.ToolCall != nil {
				call := event.ToolCall
				if _, exists := pending[call.ID]; exists {
					return errors.New("remote code isolate: duplicate local tool call id")
				}
				pending[call.ID] = call
				if err := writer.write(codeIsolateCall{Type: "tool_call", ID: call.ID, Global: call.Global, Name: call.Name, Arguments: cloneRawMessage(call.Arguments)}); err != nil {
					return err
				}
			}
		case result, open := <-done:
			if !open {
				done = nil
				continue
			}
			if events != nil {
				for event := range events {
					if event.Log != nil {
						if err := writer.write(codeIsolateLog{Type: "log", Level: event.Log.Level, Text: event.Log.Text}); err != nil {
							return err
						}
					}
					if event.ToolCall != nil {
						return errors.New("remote code isolate: tool call after completion")
					}
				}
				events = nil
			}
			if err := writer.write(codeIsolateDone{Type: "done", Result: result}); err != nil {
				return err
			}
			return nil
		case frame := <-incoming:
			if err := applyCodeIsolateInput(frame, pending, cancel); err != nil {
				return err
			}
		case err := <-readErr:
			if !errors.Is(err, io.EOF) {
				return err
			}
			cancel()
			readErr = nil
		}
	}
	return errors.New("remote code isolate: execution finished without result")
}

// timeout/abort 终态允许 child 在等待 binding 时直接结束；父端会让这些调用
// 随运行一起失效，但成功终态仍严格禁止与 pending tool call 同时出现。
func codeIsolateDoneMayContainPending(result CodeRunResult) bool {
	return result.Error != nil && (result.Error.Kind == "timeout" || result.Error.Kind == "abort")
}

func applyCodeIsolateInput(frame []byte, pending map[uint64]*CodeToolCall, cancel context.CancelFunc) error {
	typeName, err := codeIsolateType(frame)
	if err != nil {
		return err
	}
	switch typeName {
	case "cancel":
		object, err := codeIsolateObject(frame, "type")
		if err != nil {
			return err
		}
		typeName, err := codeIsolateString(object, "type")
		if err != nil || typeName != "cancel" {
			return errors.New("remote code isolate: invalid cancel")
		}
		cancel()
		return nil
	case "reply":
		object, err := codeIsolateObject(frame, "type", "id", "ok", "value", "message")
		if err != nil {
			return err
		}
		typeName, err := codeIsolateString(object, "type")
		if err != nil || typeName != "reply" {
			return errors.New("remote code isolate: invalid reply type")
		}
		id, err := codeIsolateSafeUint(object, "id", 1)
		if err != nil {
			return err
		}
		rawOK, err := codeIsolateRequiredField(object, "ok")
		if err != nil {
			return err
		}
		var ok bool
		if err := json.Unmarshal(rawOK, &ok); err != nil || (string(rawOK) != "true" && string(rawOK) != "false") {
			return errors.New("remote code isolate: reply ok must be boolean")
		}
		call := pending[id]
		if call == nil {
			return errors.New("remote code isolate: reply for unknown call")
		}
		delete(pending, id)
		if ok {
			if _, hasMessage := object["message"]; hasMessage {
				return errors.New("remote code isolate: successful reply has message")
			}
			value, exists := object["value"]
			if !exists || !validCodeJSON(value) {
				return errors.New("remote code isolate: invalid reply value")
			}
			err = call.ResolveJSON(value)
			if errors.Is(err, ErrCodeRunFinished) {
				return nil
			}
			return err
		}
		if _, hasValue := object["value"]; hasValue {
			return errors.New("remote code isolate: rejected reply has value")
		}
		message, err := codeIsolateString(object, "message")
		if err != nil {
			return errors.New("remote code isolate: rejected reply requires message")
		}
		err = call.Reject(errors.New(message))
		if errors.Is(err, ErrCodeRunFinished) {
			return nil
		}
		return err
	default:
		return errors.New("remote code isolate: unsupported input")
	}
}
