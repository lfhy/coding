package remoteagent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/dop251/goja"
	"github.com/evanw/esbuild/pkg/api"
)

const (
	defaultCodeTimeout = 10 * time.Minute
	maxCodeTimeout     = 10 * time.Minute
	defaultCodeOutput  = 64 << 20
	// defaultCodeMemoryLimitBytes 仅用于直接使用 CodeRunner 的内部调用；通过
	// Remote-SSH HTTP 协议创建的运行必须显式声明 memoryLimitBytes。
	defaultCodeMemoryLimitBytes int64 = 512 << 20
	// maxCodeMemoryLimitBytes 是单次远端代码运行的服务端硬上限。它同时约束
	// Linux RLIMIT_AS、Darwin taskpolicy 与 Windows Job Object，不能由 wire
	// 请求或测试专用的直接调用绕过。
	maxCodeMemoryLimitBytes int64 = 2 << 30
	minCodeOutput                 = 64
	defaultCodeEvents             = 128
	maxCodeJSONNumber             = 1 << 20

	// singleCodeEventLimit 约束单个流式日志事件的 JSON 载荷。参数值本身
	// 受 HTTP 请求上限约束；超限日志不作为可选流式事件发送，终态 ledger
	// 仍会给出受预算约束的权威日志，避免单条事件打满 bridge 响应。
	singleCodeEventLimit = maxRequestBytes - (1 << 20)
)

func validateCodeMemoryLimit(limit int64) error {
	if limit <= 0 || limit > maxCodeMemoryLimitBytes || uint64(limit) > maxCodeWireInteger {
		return fmt.Errorf("remote code runner: memoryLimitBytes must be between 1 and %d bytes", maxCodeMemoryLimitBytes)
	}
	return nil
}

// 远端 runner 与 @deepseek-ai/dsh-code-runtime 共享可移植绑定命名空间；不能只
// 按 Goja/JavaScript 的宽松规则接收 `$` 或某个语言独有的关键字。
var codeIdentifier = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

var codeDunderMember = regexp.MustCompile(`^__.+__$`)

var codeReservedGlobals = map[string]struct{}{
	"console": {}, "__dsh_main__": {}, "__builtins__": {}, "__name__": {}, "__debug__": {},
}

var codeReservedWords = map[string]struct{}{
	// ECMAScript 的保留字与严格模式保留名。
	"await": {}, "break": {}, "case": {}, "catch": {}, "class": {}, "const": {}, "continue": {}, "debugger": {},
	"default": {}, "delete": {}, "do": {}, "else": {}, "enum": {}, "export": {}, "extends": {}, "false": {},
	"finally": {}, "for": {}, "function": {}, "if": {}, "import": {}, "in": {}, "instanceof": {}, "new": {},
	"null": {}, "return": {}, "super": {}, "switch": {}, "this": {}, "throw": {}, "true": {}, "try": {},
	"typeof": {}, "var": {}, "void": {}, "while": {}, "with": {}, "yield": {}, "let": {}, "static": {},
	"implements": {}, "interface": {}, "package": {}, "private": {}, "protected": {}, "public": {}, "arguments": {}, "eval": {},
	// Python 3.x 关键字与软关键字。即使本后端执行 TypeScript，也须保留
	// 这份集合以遵守跨后端可移植的 CodeRuntime 合约。
	"False": {}, "None": {}, "True": {}, "and": {}, "as": {}, "assert": {}, "async": {}, "def": {}, "del": {},
	"elif": {}, "except": {}, "from": {}, "global": {}, "is": {}, "lambda": {}, "nonlocal": {}, "not": {},
	"or": {}, "pass": {}, "raise": {}, "match": {}, "type": {}, "_": {},
}

var codeReservedErrorMembers = map[string]struct{}{
	"name": {}, "message": {}, "stack": {},
	"args": {}, "with_traceback": {}, "add_note": {},
}

// CodeBindingErrorClass 描述工具调用失败时注入程序的错误类型。
type CodeBindingErrorClass struct {
	Name               string `json:"name"`
	MemberNameProperty string `json:"memberNameProperty"`
}

// CodeBindingNamespace 是一次代码执行可见的函数命名空间。
type CodeBindingNamespace struct {
	Global     string                 `json:"global"`
	Names      []string               `json:"names"`
	ErrorClass *CodeBindingErrorClass `json:"errorClass,omitempty"`
}

// CodeRunRequest 是一个 TypeScript async 函数体及其可见能力。
type CodeRunRequest struct {
	Program  string                 `json:"program"`
	Bindings []CodeBindingNamespace `json:"bindings"`
	Timeout  time.Duration          `json:"-"`
	// Compute 只累计 Goja 实际执行程序或 promise continuation 的时间；等待
	// 本地 Host binding 的回包由 Timeout 这道不暂停的墙钟上限兜底。
	Compute          time.Duration `json:"-"`
	MemoryLimitBytes int64         `json:"-"`
}

// CodeRunFailure 是代码运行的结构化终态。
type CodeRunFailure struct {
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

// CodeRunResult 是代码运行的完成值、日志和可选失败。
type CodeRunResult struct {
	Value json.RawMessage `json:"value,omitempty"`
	Logs  []string        `json:"logs"`
	Error *CodeRunFailure `json:"error,omitempty"`
}

// CodeLogEvent 是一条已捕获的 console 输出。
type CodeLogEvent struct {
	Level string `json:"level"`
	Text  string `json:"text"`
}

// CodeRunEvent 是运行期间发出的工具调用或日志事件。
type CodeRunEvent struct {
	ToolCall *CodeToolCall `json:"-"`
	Log      *CodeLogEvent `json:"-"`
}

// CodeToolCall 是一次等待宿主结算的异步绑定调用。
// ResolveJSON 和 Reject 可从任意 goroutine 调用，且仅第一次结算生效。
type CodeToolCall struct {
	ID        uint64          `json:"id"`
	Global    string          `json:"global"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`

	mu       sync.Mutex
	settled  bool
	finished <-chan struct{}
	reply    chan codeToolReply
}

type codeToolReply struct {
	value    json.RawMessage
	message  string
	rejected bool
}

// ErrCodeRunFinished 表示运行已结束，不能再结算工具调用。
var ErrCodeRunFinished = errors.New("remote code runner: run is already finished")

// ErrCodeToolCallSettled 表示同一个工具调用已被结算。
var ErrCodeToolCallSettled = errors.New("remote code runner: tool call is already settled")

// ResolveJSON 以一个 lossless JSON 值完成工具调用。
//
// @param value 工具返回的 JSON 值。
// @returns 无法结算时的原因。
func (call *CodeToolCall) ResolveJSON(value json.RawMessage) error {
	if !validCodeJSON(value) {
		return errors.New("remote code runner: tool resolution must be lossless JSON")
	}
	return call.respond(codeToolReply{value: cloneRawMessage(value)})
}

// Reject 让程序内对应的 Promise 以绑定错误失败。
//
// @param err 工具调用的失败原因；nil 会使用固定诊断。
// @returns 无法结算时的原因。
func (call *CodeToolCall) Reject(err error) error {
	message := "binding call failed"
	if err != nil {
		message = err.Error()
	}
	return call.respond(codeToolReply{message: message, rejected: true})
}

func (call *CodeToolCall) respond(reply codeToolReply) error {
	call.mu.Lock()
	defer call.mu.Unlock()
	if call.settled {
		return ErrCodeToolCallSettled
	}
	select {
	case <-call.finished:
		return ErrCodeRunFinished
	default:
	}
	select {
	case call.reply <- reply:
		call.settled = true
		return nil
	case <-call.finished:
		return ErrCodeRunFinished
	}
}

// CodeRun 是一项已启动的执行；事件与终态都会在运行结束后关闭。
type CodeRun struct {
	Events <-chan CodeRunEvent
	Done   <-chan CodeRunResult
	cancel context.CancelFunc
}

// Cancel 请求硬中断执行；可重复调用。
//
// @returns 无返回值。
func (run *CodeRun) Cancel() { run.cancel() }

// CodeRunnerOptions 配置执行的默认墙钟上限、输出预算和事件缓冲。
type CodeRunnerOptions struct {
	DefaultTimeout time.Duration
	MaxTimeout     time.Duration
	MaxOutputBytes int
	// MaxEventBytes 限制单条交付给会话层的 log 或 tool_call 事件。终态不
	// 走这个 channel，而由 polling 会话用同一上限单独编码。
	MaxEventBytes int
	EventBuffer   int
	// IsolateCommand 覆盖 re-exec 的 argv，主要供 package 内集成测试使用。
	// 为空时使用当前 remote-agent 可执行文件及 --code-isolate。
	IsolateCommand []string
	// IsolateEnv 仅追加给隔离 child；测试可据此启动 test helper。
	IsolateEnv []string
}

// CodeRunner 是不暴露文件、网络或 Node 全局的 TypeScript async 函数体执行器。
type CodeRunner struct {
	defaultTimeout time.Duration
	maxTimeout     time.Duration
	maxOutputBytes int
	maxEventBytes  int
	eventBuffer    int
	isolateCommand []string
	isolateEnv     []string
}

// NewCodeRunner 创建一个可并发启动独立 goja isolate 的运行器。
func NewCodeRunner(options CodeRunnerOptions) (*CodeRunner, error) {
	if options.DefaultTimeout <= 0 {
		options.DefaultTimeout = defaultCodeTimeout
	}
	if options.MaxTimeout <= 0 {
		options.MaxTimeout = maxCodeTimeout
	}
	if options.DefaultTimeout > options.MaxTimeout {
		return nil, errors.New("remote code runner: default timeout exceeds maximum")
	}
	if options.MaxOutputBytes == 0 {
		options.MaxOutputBytes = defaultCodeOutput
	}
	if options.MaxOutputBytes < minCodeOutput {
		return nil, fmt.Errorf("remote code runner: output budget must be at least %d bytes", minCodeOutput)
	}
	if options.MaxEventBytes == 0 {
		options.MaxEventBytes = singleCodeEventLimit
	}
	if options.MaxEventBytes < minCodeOutput {
		return nil, fmt.Errorf("remote code runner: event budget must be at least %d bytes", minCodeOutput)
	}
	if options.MaxEventBytes > singleCodeEventLimit {
		options.MaxEventBytes = singleCodeEventLimit
	}
	if options.EventBuffer == 0 {
		options.EventBuffer = defaultCodeEvents
	}
	if options.EventBuffer < 0 {
		return nil, errors.New("remote code runner: event buffer cannot be negative")
	}
	return &CodeRunner{
		defaultTimeout: options.DefaultTimeout,
		maxTimeout:     options.MaxTimeout,
		maxOutputBytes: options.MaxOutputBytes,
		maxEventBytes:  options.MaxEventBytes,
		eventBuffer:    options.EventBuffer,
		isolateCommand: append([]string{}, options.IsolateCommand...),
		isolateEnv:     append([]string{}, options.IsolateEnv...),
	}, nil
}

// Start 在受限的 re-exec child 中异步执行。主 remote-agent 进程绝不直接
// 创建 Goja runtime；无效请求仍通过 Done 返回结构化失败。
func (runner *CodeRunner) Start(parent context.Context, request CodeRunRequest) *CodeRun {
	return StartCodeIsolate(parent, request, codeIsolateOptionsFromRunner(runner))
}

type validatedCodeBinding struct {
	CodeBindingNamespace
}

type codeInterrupt struct {
	kind    string
	message string
}

type codeVMReply struct {
	resolve func(interface{}) error
	reject  func(interface{}) error
	reply   codeToolReply
}

func (runner *CodeRunner) execute(ctx context.Context, request CodeRunRequest, events chan<- CodeRunEvent) CodeRunResult {
	logs := newCodeOutputLedger(runner.maxOutputBytes)
	bindings, err := validateCodeBindings(request.Bindings)
	if err != nil {
		return logs.failure("exception", err.Error())
	}
	code, err := transformCodeProgram(request.Program)
	if err != nil {
		return logs.failure("exception", err.Error())
	}
	timeout := request.Timeout
	if timeout <= 0 {
		timeout = runner.defaultTimeout
	}
	if timeout > runner.maxTimeout {
		return logs.failure("exception", fmt.Sprintf("timeout exceeds maximum %s", runner.maxTimeout))
	}
	compute, err := codeRunComputeBudget(request, timeout)
	if err != nil {
		return logs.failure("exception", err.Error())
	}

	runtime := goja.New()
	runtime.SetMaxCallStackSize(10_000)
	jsonParse, err := codeJSONParse(runtime)
	if err != nil {
		return logs.failure("exception", err.Error())
	}
	wakeup := make(chan codeVMReply, runner.eventBuffer)
	interrupts := make(chan codeInterrupt, 1)
	terminated := make(chan struct{})
	var interruptOnce sync.Once
	interrupt := func(reason codeInterrupt) {
		interruptOnce.Do(func() {
			select {
			case <-terminated:
				return
			default:
			}
			runtime.Interrupt(reason)
			select {
			case interrupts <- reason:
			default:
			}
		})
	}
	computeInterrupt := codeInterrupt{kind: "timeout", message: codeComputeBudgetMessage(compute)}
	active := newCodeActiveBudget(compute, func() { interrupt(computeInterrupt) })
	timer := time.AfterFunc(timeout, func() {
		interrupt(codeInterrupt{kind: "timeout", message: fmt.Sprintf("wall-clock ceiling reached (%s)", timeout)})
	})
	defer timer.Stop()
	defer close(terminated)
	go func() {
		select {
		case <-ctx.Done():
			interrupt(codeInterrupt{kind: "abort", message: contextMessage(ctx)})
		case <-terminated:
		}
	}()

	select {
	case reason := <-interrupts:
		return logs.failure(reason.kind, reason.message)
	default:
	}
	if err := installCodeConsole(runtime, logs, events, runner.maxEventBytes); err != nil {
		return logs.failure("exception", err.Error())
	}
	if err := installCodeBindings(runtime, bindings, events, wakeup, terminated, runner.maxEventBytes, active); err != nil {
		return codeActiveRuntimeFailure(logs, err, compute)
	}

	var value goja.Value
	err = active.run(func() error {
		var runErr error
		value, runErr = runtime.RunString(code)
		return runErr
	})
	if err != nil {
		return codeActiveRuntimeFailure(logs, err, compute)
	}
	promise, ok := value.Export().(*goja.Promise)
	if !ok {
		return logs.failure("exception", "program did not return a Promise")
	}

	for promise.State() == goja.PromiseStatePending {
		select {
		case operation := <-wakeup:
			var settleErr error
			if operation.reply.rejected {
				settleErr = active.run(func() error { return operation.reject(operation.reply.message) })
			} else {
				var parsed goja.Value
				parseErr := active.run(func() error {
					var parseErr error
					parsed, parseErr = parseCodeJSON(runtime, jsonParse, operation.reply.value)
					return parseErr
				})
				if parseErr != nil {
					if errors.Is(parseErr, errCodeComputeBudgetExhausted) {
						return logs.failure("timeout", codeComputeBudgetMessage(compute))
					}
					settleErr = active.run(func() error { return operation.reject(parseErr.Error()) })
				} else {
					settleErr = active.run(func() error { return operation.resolve(parsed) })
				}
			}
			if settleErr != nil {
				return codeActiveRuntimeFailure(logs, settleErr, compute)
			}
		case reason := <-interrupts:
			return logs.failure(reason.kind, reason.message)
		}
	}
	if promise.State() == goja.PromiseStateRejected {
		var message string
		if err := active.run(func() error {
			message = codeValueMessage(promise.Result())
			return nil
		}); err != nil {
			return codeActiveRuntimeFailure(logs, err, compute)
		}
		return logs.failure("exception", message)
	}
	var valueJSON json.RawMessage
	var valuePresent bool
	err = active.run(func() error {
		var snapshotErr error
		valueJSON, valuePresent, snapshotErr = snapshotCodeJSON(promise.Result())
		return snapshotErr
	})
	if err != nil {
		if errors.Is(err, errCodeComputeBudgetExhausted) {
			return logs.failure("timeout", codeComputeBudgetMessage(compute))
		}
		return logs.failure("invalid-output", "program completion must be lossless JSON")
	}
	return logs.success(valueJSON, valuePresent)
}

func installCodeConsole(runtime *goja.Runtime, logs *codeOutputLedger, events chan<- CodeRunEvent, maxEventBytes int) error {
	console := runtime.NewObject()
	if err := console.SetPrototype(nil); err != nil {
		return err
	}
	for _, level := range []string{"log", "info", "warn", "error", "debug"} {
		level := level
		function := func(call goja.FunctionCall) goja.Value {
			parts := make([]string, len(call.Arguments))
			for index, argument := range call.Arguments {
				parts[index] = codeLogValue(argument)
			}
			text := strings.Join(parts, " ")
			if logs.append(text) && codeLogEventFits(maxEventBytes, level, text) {
				select {
				case events <- CodeRunEvent{Log: &CodeLogEvent{Level: level, Text: text}}:
				default:
				}
			}
			return goja.Undefined()
		}
		if err := console.DefineDataProperty(level, runtime.ToValue(function), goja.FLAG_FALSE, goja.FLAG_FALSE, goja.FLAG_TRUE); err != nil {
			return err
		}
	}
	return runtime.Set("console", console)
}

func installCodeBindings(
	runtime *goja.Runtime,
	bindings []validatedCodeBinding,
	events chan<- CodeRunEvent,
	wakeup chan<- codeVMReply,
	finished <-chan struct{},
	maxEventBytes int,
	active *codeActiveBudget,
) error {
	var nextID uint64 = 1
	for _, binding := range bindings {
		binding := binding
		var errorConstructor goja.Value
		if binding.ErrorClass != nil {
			constructor, err := makeCodeBindingErrorClass(runtime, *binding.ErrorClass, active)
			if err != nil {
				return err
			}
			if err := runtime.Set(binding.ErrorClass.Name, constructor); err != nil {
				return err
			}
			errorConstructor = constructor
		}
		namespace := runtime.NewObject()
		if err := namespace.SetPrototype(nil); err != nil {
			return err
		}
		for _, name := range binding.Names {
			name := name
			function := func(call goja.FunctionCall) goja.Value {
				promise, resolve, reject := runtime.NewPromise()
				arguments := call.Argument(0)
				encoded, present, err := snapshotCodeJSON(arguments)
				if err != nil || !present {
					_ = reject(runtime.NewTypeError("binding arguments must be lossless JSON"))
					return runtime.ToValue(promise)
				}
				toolCall := &CodeToolCall{
					ID: nextID, Global: binding.Global, Name: name,
					Arguments: encoded, finished: finished, reply: make(chan codeToolReply, 1),
				}
				if !codeToolCallEventFits(maxEventBytes, toolCall) {
					_ = reject(runtime.NewTypeError("binding call event exceeds the byte limit"))
					return runtime.ToValue(promise)
				}
				nextID++
				select {
				case events <- CodeRunEvent{ToolCall: toolCall}:
				default:
					_ = reject(runtime.NewTypeError("tool call event queue is full"))
					return runtime.ToValue(promise)
				}
				go func(errorConstructor goja.Value) {
					select {
					case reply := <-toolCall.reply:
						select {
						case wakeup <- codeVMReply{resolve: resolve, reject: bindingRejector(runtime, reject, errorConstructor, name), reply: reply}:
						case <-finished:
						}
					case <-finished:
					}
				}(errorConstructor)
				return runtime.ToValue(promise)
			}
			if err := namespace.DefineDataProperty(name, runtime.ToValue(function), goja.FLAG_FALSE, goja.FLAG_FALSE, goja.FLAG_TRUE); err != nil {
				return err
			}
		}
		if err := runtime.Set(binding.Global, namespace); err != nil {
			return err
		}
	}
	return nil
}

func bindingRejector(
	runtime *goja.Runtime,
	reject func(interface{}) error,
	constructor goja.Value,
	member string,
) func(interface{}) error {
	if constructor == nil {
		return func(reason interface{}) error {
			return reject(runtime.NewTypeError("%s", fmt.Sprint(reason)))
		}
	}
	return func(reason interface{}) error {
		object, err := runtime.New(constructor, runtime.ToValue(member), runtime.ToValue(fmt.Sprint(reason)))
		if err != nil {
			return err
		}
		return reject(object)
	}
}

func makeCodeBindingErrorClass(runtime *goja.Runtime, descriptor CodeBindingErrorClass, active *codeActiveBudget) (goja.Value, error) {
	source := fmt.Sprintf(
		`(class %s extends Error { constructor(member, message) { super(message); Object.defineProperty(this, "name", {value: %s, enumerable: true}); Object.defineProperty(this, %s, {value: member, enumerable: true}); } })`,
		descriptor.Name, strconv.Quote(descriptor.Name), strconv.Quote(descriptor.MemberNameProperty),
	)
	var value goja.Value
	err := active.run(func() error {
		var runErr error
		value, runErr = runtime.RunString(source)
		return runErr
	})
	return value, err
}

// codeRunComputeBudget 为缺省的内部调用保留原先与墙钟相同的预算；Remote-SSH
// wire 始终显式传入 Compute，因此等待本地 binding 不会消耗这份预算。
func codeRunComputeBudget(request CodeRunRequest, timeout time.Duration) (time.Duration, error) {
	if request.Compute == 0 {
		return timeout, nil
	}
	if request.Compute < 0 {
		return 0, errors.New("compute budget must be positive")
	}
	return request.Compute, nil
}

func codeComputeBudgetMessage(compute time.Duration) string {
	return fmt.Sprintf("compute budget exhausted (%dms busy)", compute.Milliseconds())
}

func codeActiveRuntimeFailure(logs *codeOutputLedger, err error, compute time.Duration) CodeRunResult {
	if errors.Is(err, errCodeComputeBudgetExhausted) {
		return logs.failure("timeout", codeComputeBudgetMessage(compute))
	}
	return codeRuntimeFailure(logs, err)
}

func validateCodeBindings(bindings []CodeBindingNamespace) ([]validatedCodeBinding, error) {
	globals := make(map[string]struct{}, len(bindings)*2)
	validated := make([]validatedCodeBinding, 0, len(bindings))
	for _, binding := range bindings {
		if !usableCodeGlobal(binding.Global) {
			return nil, fmt.Errorf("binding global %q is not usable", binding.Global)
		}
		if _, exists := globals[binding.Global]; exists {
			return nil, fmt.Errorf("duplicate injected global %q", binding.Global)
		}
		globals[binding.Global] = struct{}{}
		names := make(map[string]struct{}, len(binding.Names))
		for _, name := range binding.Names {
			if _, exists := names[name]; exists {
				return nil, fmt.Errorf("binding %q has duplicate member %q", binding.Global, name)
			}
			names[name] = struct{}{}
		}
		if binding.ErrorClass != nil {
			descriptor := binding.ErrorClass
			if !usableCodeGlobal(descriptor.Name) {
				return nil, fmt.Errorf("binding error class %q is not usable", descriptor.Name)
			}
			if !usableCodeErrorMember(descriptor.MemberNameProperty) {
				return nil, fmt.Errorf("binding error member property %q is not usable", descriptor.MemberNameProperty)
			}
			if _, exists := globals[descriptor.Name]; exists {
				return nil, fmt.Errorf("duplicate injected global %q", descriptor.Name)
			}
			globals[descriptor.Name] = struct{}{}
		}
		validated = append(validated, validatedCodeBinding{CodeBindingNamespace: binding})
	}
	return validated, nil
}

func usableCodeGlobal(value string) bool {
	if !codeIdentifier.MatchString(value) {
		return false
	}
	if _, reserved := codeReservedWords[value]; reserved {
		return false
	}
	_, reserved := codeReservedGlobals[value]
	return !reserved
}

func usableCodeErrorMember(value string) bool {
	if value == "" || codeDunderMember.MatchString(value) {
		return false
	}
	_, reserved := codeReservedErrorMembers[value]
	return !reserved
}

func transformCodeProgram(program string) (string, error) {
	wrapped := "async function __dsh_main__() {\n" + program + "\n}\n__dsh_main__();"
	result := api.Transform(wrapped, api.TransformOptions{
		Loader:        api.LoaderTS,
		Target:        api.ES2020,
		LogLevel:      api.LogLevelSilent,
		LegalComments: api.LegalCommentsNone,
		Sourcefile:    "run_code.ts",
		TsconfigRaw:   `{"compilerOptions":{"useDefineForClassFields":true}}`,
	})
	if len(result.Errors) > 0 {
		messages := make([]string, len(result.Errors))
		for index, message := range result.Errors {
			messages[index] = message.Text
			if message.Location != nil {
				messages[index] = fmt.Sprintf("%s:%d:%d: %s", message.Location.File, message.Location.Line, message.Location.Column, message.Text)
			}
		}
		return "", errors.New(strings.Join(messages, "; "))
	}
	return string(result.Code), nil
}

func codeJSONParse(runtime *goja.Runtime) (goja.Callable, error) {
	jsonValue := runtime.Get("JSON")
	jsonObject, ok := jsonValue.(*goja.Object)
	if !ok {
		return nil, errors.New("remote code runner: JSON intrinsic is unavailable")
	}
	parse, ok := goja.AssertFunction(jsonObject.Get("parse"))
	if !ok {
		return nil, errors.New("remote code runner: JSON.parse intrinsic is unavailable")
	}
	return parse, nil
}

func parseCodeJSON(runtime *goja.Runtime, parse goja.Callable, raw json.RawMessage) (goja.Value, error) {
	if !validCodeJSON(raw) {
		return nil, errors.New("binding resolution must be lossless JSON")
	}
	value, err := parse(goja.Undefined(), runtime.ToValue(string(raw)))
	if err != nil {
		return nil, err
	}
	return value, nil
}

func snapshotCodeJSON(value goja.Value) (json.RawMessage, bool, error) {
	if goja.IsUndefined(value) {
		return nil, false, nil
	}
	var encoded []byte
	var err error
	if object, ok := value.(*goja.Object); ok {
		encoded, err = object.MarshalJSON()
	} else {
		encoded, err = json.Marshal(value.Export())
	}
	if err != nil || !validCodeJSON(encoded) {
		return nil, false, errors.New("value is not lossless JSON")
	}
	return cloneRawMessage(encoded), true, nil
}

func validCodeJSON(raw []byte) bool {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return false
	}
	return validCodeJSONValue(value)
}

func validCodeJSONValue(value any) bool {
	switch typed := value.(type) {
	case nil, bool, string:
		return true
	case json.Number:
		text := string(typed)
		parsed, err := strconv.ParseFloat(text, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed == 0 && strings.HasPrefix(text, "-") {
			return false
		}
		return codeLosslessNumberToken(text, parsed)
	case []any:
		for _, item := range typed {
			if !validCodeJSONValue(item) {
				return false
			}
		}
		return true
	case map[string]any:
		for _, item := range typed {
			if !validCodeJSONValue(item) {
				return false
			}
		}
		return true
	default:
		return false
	}
}

// codeLosslessNumberToken 读取 decoder 保留的原始 JSON 数字，而非只检查已经
// 被 float64 舍入的值。将源 token 和 Goja 会看到的最短 float64 表示解析成
// 有理数后比较，因而 0.1、1e3、1.0 等同值写法会通过，实际被舍入的整数、小数
// 和科学计数法则会被拒绝。单个数字受限，避免验证敌对超长小数时分配无界大整数。
func codeLosslessNumberToken(token string, parsed float64) bool {
	if len(token) == 0 || len(token) > maxCodeJSONNumber {
		return false
	}
	want, ok := new(big.Rat).SetString(token)
	if !ok {
		return false
	}
	got, ok := new(big.Rat).SetString(strconv.FormatFloat(parsed, 'g', -1, 64))
	return ok && want.Cmp(got) == 0
}

func codeRuntimeFailure(logs *codeOutputLedger, err error) CodeRunResult {
	var interrupted *goja.InterruptedError
	if errors.As(err, &interrupted) {
		if reason, ok := interrupted.Value().(codeInterrupt); ok {
			return logs.failure(reason.kind, reason.message)
		}
	}
	return logs.failure("exception", err.Error())
}

func codeValueMessage(value goja.Value) string {
	if object, ok := value.(*goja.Object); ok {
		if message := object.Get("message"); !goja.IsUndefined(message) {
			return message.String()
		}
	}
	return value.String()
}

func codeLogValue(value goja.Value) string {
	if goja.IsUndefined(value) {
		return "undefined"
	}
	if value == nil || goja.IsNull(value) {
		return "null"
	}
	if object, ok := value.(*goja.Object); ok {
		if encoded, err := object.MarshalJSON(); err == nil {
			return string(encoded)
		}
	}
	return value.String()
}

// codeLogEventFits 与 CodeRunWireEvent.MarshalJSON 使用同一封闭载荷形状。
// sequence 采用最大值以覆盖真实会话序号的所有编码长度。
func codeLogEventFits(maxBytes int, level, text string) bool {
	encoded, err := json.Marshal(CodeRunWireEvent{
		Type: "log", Sequence: math.MaxUint64, Level: level, Text: text,
	})
	return err == nil && len(encoded) <= maxBytes
}

func codeToolCallEventFits(maxBytes int, call *CodeToolCall) bool {
	encoded, err := json.Marshal(CodeRunWireEvent{
		Type: "tool_call", Sequence: math.MaxUint64,
		CallID: call.ID, Global: call.Global, Name: call.Name, Arguments: call.Arguments,
	})
	return err == nil && len(encoded) <= maxBytes
}

func contextMessage(ctx context.Context) string {
	if cause := context.Cause(ctx); cause != nil {
		return cause.Error()
	}
	return "code run aborted"
}

func cloneRawMessage(raw []byte) json.RawMessage {
	return append(json.RawMessage(nil), raw...)
}

type codeOutputLedger struct {
	maxBytes int
	logs     []string
	logBytes int
	logJSON  []int
	limited  bool
}

func newCodeOutputLedger(maxBytes int) *codeOutputLedger {
	return &codeOutputLedger{maxBytes: maxBytes, logBytes: 2}
}

// append 只保留仍有空间构成最小 output-limit 结果的日志。除了总字节数外，
// 还限制条数，避免大量极短日志把 slice 元数据本身变成不受控内存。
func (ledger *codeOutputLedger) append(text string) bool {
	if ledger.limited {
		return false
	}
	encoded, _ := json.Marshal(text)
	extra := len(encoded)
	if len(ledger.logs) > 0 {
		extra++
	}
	if len(ledger.logs) >= defaultCodeEvents || !codeFailurePayloadFits(
		ledger.maxBytes, ledger.logBytes+extra, "output-limit", "",
	) {
		ledger.limited = true
		return false
	}
	ledger.logs = append(ledger.logs, text)
	ledger.logJSON = append(ledger.logJSON, len(encoded))
	ledger.logBytes += extra
	return true
}

func (ledger *codeOutputLedger) success(value json.RawMessage, present bool) CodeRunResult {
	result := CodeRunResult{Logs: cloneCodeLogs(ledger.logs)}
	if present {
		result.Value = cloneRawMessage(value)
	}
	if ledger.limited || !codeRunResultFits(ledger.maxBytes, result) {
		return ledger.limit()
	}
	return result
}

func (ledger *codeOutputLedger) failure(kind, message string) CodeRunResult {
	result := CodeRunResult{
		Logs:  cloneCodeLogs(ledger.logs),
		Error: &CodeRunFailure{Kind: kind, Message: message},
	}
	if ledger.limited || !codeRunResultFits(ledger.maxBytes, result) {
		return ledger.limit()
	}
	return result
}

// limit 以可编码的 output-limit 结果取代越界结果。它根据完整 CodeRunResult
// JSON（包括 error.kind 和 error.message）计算，而不是只粗略加日志和值的长度。
func (ledger *codeOutputLedger) limit() CodeRunResult {
	const kind = "output-limit"
	message := truncateCodeJSONString(
		fmt.Sprintf("outer output exceeded %d bytes", ledger.maxBytes),
		ledger.maxBytes-codeFailurePayloadBytes(2, kind, ""),
	)
	retained := make([]string, 0, len(ledger.logs))
	logBytes := 2
	for index, text := range ledger.logs {
		extra := ledger.logJSON[index]
		if len(retained) > 0 {
			extra++
		}
		if codeFailurePayloadFits(ledger.maxBytes, logBytes+extra, kind, message) {
			retained = append(retained, text)
			logBytes += extra
			continue
		}
		available := ledger.maxBytes - codeFailurePayloadBytes(logBytes, kind, message)
		if len(retained) > 0 {
			available--
		}
		if prefix := truncateCodeJSONString(text, available); prefix != "" {
			retained = append(retained, prefix)
		}
		break
	}
	result := CodeRunResult{Logs: retained, Error: &CodeRunFailure{Kind: kind, Message: message}}
	if codeRunResultFits(ledger.maxBytes, result) {
		return result
	}
	// NewCodeRunner 已拒绝小于 minCodeOutput 的预算；这个最小形态因此总能
	// 装入。保留兜底可防止以后变更 JSON 字段时悄悄写出超限响应。
	return CodeRunResult{Logs: []string{}, Error: &CodeRunFailure{Kind: kind, Message: ""}}
}

func codeRunResultFits(maxBytes int, result CodeRunResult) bool {
	encoded, err := json.Marshal(result)
	return err == nil && len(encoded) <= maxBytes
}

func cloneCodeLogs(logs []string) []string {
	return append([]string{}, logs...)
}

func codeFailurePayloadFits(maxBytes, logBytes int, kind, message string) bool {
	return codeFailurePayloadBytes(logBytes, kind, message) <= maxBytes
}

// codeFailurePayloadBytes 是 CodeRunResult{logs,error} 的完整 JSON 字节数。
// logBytes 已包括方括号和条目间逗号；字符串统一由 encoding/json 计量。
func codeFailurePayloadBytes(logBytes int, kind, message string) int {
	encodedKind, _ := json.Marshal(kind)
	encodedMessage, _ := json.Marshal(message)
	return len(`{"logs":`) + logBytes + len(`,"error":{"kind":`) + len(encodedKind) +
		len(`,"message":`) + len(encodedMessage) + len(`}}`)
}

// truncateCodeJSONString 返回 JSON 编码不超过 maxBytes 的一个尽量长 UTF-8
// 前缀。overflow 路径才调用它；按实际 encoding/json 长度比例缩小避免为每个
// rune 分配临时字符串或在多字节边界二分时停滞。
func truncateCodeJSONString(text string, maxBytes int) string {
	if maxBytes < 2 {
		return ""
	}
	encoded, _ := json.Marshal(text)
	if len(encoded) <= maxBytes {
		return text
	}
	end := len(text)
	if end > maxBytes-2 {
		end = maxBytes - 2
	}
	for end > 0 {
		end = codeRuneBoundary(text, end)
		candidate := text[:end]
		encoded, _ = json.Marshal(candidate)
		if len(encoded) <= maxBytes {
			return candidate
		}
		next := end * maxBytes / len(encoded)
		if next >= end {
			next = end - 1
		}
		end = next
	}
	return ""
}

func codeRuneBoundary(text string, end int) int {
	if end >= len(text) {
		return len(text)
	}
	for end > 0 && !utf8.RuneStart(text[end]) {
		end--
	}
	return end
}
