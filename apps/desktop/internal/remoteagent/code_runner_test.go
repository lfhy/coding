package remoteagent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

const codeRunnerTestWait = 5 * time.Second

func newTestCodeRunner(t *testing.T, timeout time.Duration) *CodeRunner {
	t.Helper()
	runner, err := NewCodeRunner(CodeRunnerOptions{
		DefaultTimeout: timeout,
		MaxTimeout:     time.Second,
		MaxOutputBytes: 1 << 20,
		EventBuffer:    16,
	})
	if err != nil {
		t.Fatal(err)
	}
	return runner
}

func waitForCodeEvent(t *testing.T, run *CodeRun) CodeRunEvent {
	t.Helper()
	select {
	case event, open := <-run.Events:
		if !open {
			t.Fatal("code run closed events before the expected event")
		}
		return event
	case result := <-run.Done:
		t.Fatalf("code run ended before the expected event: %#v", result)
	case <-time.After(codeRunnerTestWait):
		t.Fatal("timed out waiting for code event")
	}
	return CodeRunEvent{}
}

func waitForCodeResult(t *testing.T, run *CodeRun) CodeRunResult {
	t.Helper()
	select {
	case result, open := <-run.Done:
		if !open {
			t.Fatal("code run closed Done without a result")
		}
		return result
	case <-time.After(codeRunnerTestWait):
		t.Fatal("timed out waiting for code result")
	}
	return CodeRunResult{}
}

func requireCodeJSON(t *testing.T, raw json.RawMessage, want string) {
	t.Helper()
	var gotValue any
	if err := json.Unmarshal(raw, &gotValue); err != nil {
		t.Fatalf("decode returned JSON: %v", err)
	}
	var wantValue any
	if err := json.Unmarshal([]byte(want), &wantValue); err != nil {
		t.Fatalf("decode expected JSON: %v", err)
	}
	got, _ := json.Marshal(gotValue)
	expected, _ := json.Marshal(wantValue)
	if string(got) != string(expected) {
		t.Fatalf("JSON = %s, want %s", got, expected)
	}
}

func TestCodeRunnerExecutesTypeScriptAndAsyncTool(t *testing.T) {
	runner := newTestCodeRunner(t, time.Second)
	run := runner.Start(context.Background(), CodeRunRequest{
		Program: `
      const input: { n: number } = await tools.double({ n: 21 });
      console.log("received", input.n);
      return { answer: input.n * 2 };
    `,
		Bindings: []CodeBindingNamespace{{Global: "tools", Names: []string{"double"}}},
	})
	event := waitForCodeEvent(t, run)
	if event.ToolCall == nil {
		t.Fatalf("event = %#v, want tool call", event)
	}
	call := event.ToolCall
	if call.ID == 0 || call.Global != "tools" || call.Name != "double" {
		t.Fatalf("tool call = %#v", call)
	}
	requireCodeJSON(t, call.Arguments, `{"n":21}`)
	if err := call.ResolveJSON(json.RawMessage(`{"n":21}`)); err != nil {
		t.Fatal(err)
	}
	result := waitForCodeResult(t, run)
	if result.Error != nil {
		t.Fatalf("result error = %#v", result.Error)
	}
	requireCodeJSON(t, result.Value, `{"answer":42}`)
	if len(result.Logs) != 1 || result.Logs[0] != "received 21" {
		t.Fatalf("logs = %#v", result.Logs)
	}
}

func TestCodeRunnerSupportsPromiseAllAndReverseReplies(t *testing.T) {
	runner := newTestCodeRunner(t, time.Second)
	run := runner.Start(context.Background(), CodeRunRequest{
		Program: `
      const [left, right] = await Promise.all([
        tools.lookup({ side: "left" }),
        tools.lookup({ side: "right" }),
      ]);
      return [left.value, right.value];
    `,
		Bindings: []CodeBindingNamespace{{Global: "tools", Names: []string{"lookup"}}},
	})
	calls := map[string]*CodeToolCall{}
	for len(calls) != 2 {
		event := waitForCodeEvent(t, run)
		if event.ToolCall == nil {
			continue
		}
		var arguments struct {
			Side string `json:"side"`
		}
		if err := json.Unmarshal(event.ToolCall.Arguments, &arguments); err != nil {
			t.Fatal(err)
		}
		calls[arguments.Side] = event.ToolCall
	}
	if err := calls["right"].ResolveJSON(json.RawMessage(`{"value":"R"}`)); err != nil {
		t.Fatal(err)
	}
	if err := calls["left"].ResolveJSON(json.RawMessage(`{"value":"L"}`)); err != nil {
		t.Fatal(err)
	}
	result := waitForCodeResult(t, run)
	if result.Error != nil {
		t.Fatalf("result error = %#v", result.Error)
	}
	requireCodeJSON(t, result.Value, `["L","R"]`)
}

func TestCodeRunnerRejectsToolWithDeclaredErrorClass(t *testing.T) {
	runner := newTestCodeRunner(t, time.Second)
	run := runner.Start(context.Background(), CodeRunRequest{
		Program: `
      try {
        await tools.fail({});
      } catch (error) {
        return {
          typed: error instanceof ToolCallError,
          name: error.name,
          member: error.toolName,
          message: error.message,
        };
      }
    `,
		Bindings: []CodeBindingNamespace{{
			Global: "tools", Names: []string{"fail"},
			ErrorClass: &CodeBindingErrorClass{Name: "ToolCallError", MemberNameProperty: "toolName"},
		}},
	})
	event := waitForCodeEvent(t, run)
	if event.ToolCall == nil {
		t.Fatal("expected tool call")
	}
	if err := event.ToolCall.Reject(errors.New("denied")); err != nil {
		t.Fatal(err)
	}
	result := waitForCodeResult(t, run)
	if result.Error != nil {
		t.Fatalf("result error = %#v", result.Error)
	}
	requireCodeJSON(t, result.Value, `{"typed":true,"name":"ToolCallError","member":"fail","message":"denied"}`)
}

func TestCodeRunnerTimesOutBusyJavaScript(t *testing.T) {
	runner := newTestCodeRunner(t, 25*time.Millisecond)
	run := runner.Start(context.Background(), CodeRunRequest{Program: `for (;;) {}`})
	result := waitForCodeResult(t, run)
	if result.Error == nil || result.Error.Kind != "timeout" {
		t.Fatalf("result = %#v, want timeout", result)
	}
}

func TestCodeRunnerInterruptsBusyJavaScriptAtComputeBudget(t *testing.T) {
	runner := newTestCodeRunner(t, time.Second)
	run := runner.Start(context.Background(), CodeRunRequest{
		Program: `for (;;) {}`, Timeout: time.Second, Compute: 50 * time.Millisecond,
	})
	result := waitForCodeResult(t, run)
	if result.Error == nil || result.Error.Kind != "timeout" || !strings.Contains(result.Error.Message, "compute budget exhausted") {
		t.Fatalf("result = %#v, want compute timeout", result)
	}
}

func TestCodeRunnerDoesNotChargeBindingWaitToComputeBudget(t *testing.T) {
	runner := newTestCodeRunner(t, time.Second)
	run := runner.Start(context.Background(), CodeRunRequest{
		Program: `const value = await tools.wait({}); return value`, Timeout: time.Second, Compute: 50 * time.Millisecond,
		Bindings: []CodeBindingNamespace{{Global: "tools", Names: []string{"wait"}}},
	})
	event := waitForCodeEvent(t, run)
	if event.ToolCall == nil {
		t.Fatalf("event = %#v, want tool call", event)
	}
	// 这段时间属于本地 Host binding 的等待；若远端按墙钟累计 computeMs，
	// 下面的 resolve 会错误地得到 timeout。
	time.Sleep(150 * time.Millisecond)
	if err := event.ToolCall.ResolveJSON(json.RawMessage(`42`)); err != nil {
		t.Fatal(err)
	}
	result := waitForCodeResult(t, run)
	if result.Error != nil {
		t.Fatalf("result error = %#v", result.Error)
	}
	requireCodeJSON(t, result.Value, `42`)
}

func TestCodeRunnerTimesOutPendingToolCall(t *testing.T) {
	runner := newTestCodeRunner(t, 25*time.Millisecond)
	run := runner.Start(context.Background(), CodeRunRequest{
		Program:  `await tools.wait({}); return 1`,
		Bindings: []CodeBindingNamespace{{Global: "tools", Names: []string{"wait"}}},
	})
	event := waitForCodeEvent(t, run)
	if event.ToolCall == nil {
		t.Fatal("expected tool call")
	}
	result := waitForCodeResult(t, run)
	if result.Error == nil || result.Error.Kind != "timeout" {
		t.Fatalf("result = %#v, want timeout", result)
	}
}

func TestCodeRunnerCancelsPendingToolCall(t *testing.T) {
	runner := newTestCodeRunner(t, time.Second)
	run := runner.Start(context.Background(), CodeRunRequest{
		Program:  `await tools.wait({}); return 1`,
		Bindings: []CodeBindingNamespace{{Global: "tools", Names: []string{"wait"}}},
	})
	event := waitForCodeEvent(t, run)
	if event.ToolCall == nil {
		t.Fatal("expected tool call")
	}
	run.Cancel()
	result := waitForCodeResult(t, run)
	if result.Error == nil || result.Error.Kind != "abort" {
		t.Fatalf("result = %#v, want abort", result)
	}
	if err := event.ToolCall.ResolveJSON(json.RawMessage(`null`)); !errors.Is(err, ErrCodeRunFinished) {
		t.Fatalf("late resolve = %v, want ErrCodeRunFinished", err)
	}
}

func TestCodeRunnerDoesNotExposeNodeOrFetchGlobals(t *testing.T) {
	runner := newTestCodeRunner(t, time.Second)
	run := runner.Start(context.Background(), CodeRunRequest{
		Program: `return [typeof fetch, typeof fs, typeof require, typeof process]`,
	})
	result := waitForCodeResult(t, run)
	if result.Error != nil {
		t.Fatalf("result error = %#v", result.Error)
	}
	requireCodeJSON(t, result.Value, `["undefined","undefined","undefined","undefined"]`)
}

func TestCodeRunnerRejectsRoundedIntegerReplyTokens(t *testing.T) {
	if !validCodeJSON(json.RawMessage(`9007199254740992`)) {
		t.Fatal("exact 2**53 JSON integer was rejected")
	}
	for _, token := range []string{`0.1`, `1e3`, `1.0`} {
		if !validCodeJSON(json.RawMessage(token)) {
			t.Fatalf("lossless JSON number %q was rejected", token)
		}
	}
	if validCodeJSON(json.RawMessage(`9007199254740993`)) {
		t.Fatal("rounded JSON integer token was accepted")
	}
	for _, token := range []string{`9007199254740993.0`, `9.007199254740993e15`} {
		if validCodeJSON(json.RawMessage(token)) {
			t.Fatalf("rounded JSON number token %q was accepted", token)
		}
	}
	call := &CodeToolCall{finished: make(chan struct{}), reply: make(chan codeToolReply, 1)}
	if err := call.ResolveJSON(json.RawMessage(`9007199254740993`)); err == nil {
		t.Fatal("rounded tool reply token was accepted")
	}
}

func TestCodeBindingValidationMatchesPortableRuntimeContract(t *testing.T) {
	valid := CodeBindingNamespace{
		Global: "tools", Names: []string{"", "constructor", "__proto__"},
		ErrorClass: &CodeBindingErrorClass{Name: "ToolCallError", MemberNameProperty: "tool-name"},
	}
	if _, err := validateCodeBindings([]CodeBindingNamespace{valid}); err != nil {
		t.Fatalf("portable binding rejected: %v", err)
	}
	if _, err := validateCodeBindings([]CodeBindingNamespace{{
		Global: "tools", ErrorClass: &CodeBindingErrorClass{Name: "ToolCallError", MemberNameProperty: "__"},
	}}); err != nil {
		t.Fatalf("non-dunder error member rejected: %v", err)
	}
	for _, global := range []string{"globalThis", "undefined"} {
		if _, err := validateCodeBindings([]CodeBindingNamespace{{Global: global}}); err != nil {
			t.Errorf("portable global %q rejected: %v", global, err)
		}
	}

	for _, name := range []string{
		"$tools", "lambda", "console", "__dsh_main__", "__builtins__", "__name__", "__debug__",
	} {
		if _, err := validateCodeBindings([]CodeBindingNamespace{{Global: name}}); err == nil {
			t.Errorf("global %q was accepted", name)
		}
		if _, err := validateCodeBindings([]CodeBindingNamespace{{
			Global: "tools", ErrorClass: &CodeBindingErrorClass{Name: name, MemberNameProperty: "member"},
		}}); err == nil {
			t.Errorf("error class %q was accepted", name)
		}
	}
	for _, member := range []string{
		"", "name", "message", "stack", "args", "with_traceback", "add_note", "__dict__",
	} {
		if _, err := validateCodeBindings([]CodeBindingNamespace{{
			Global: "tools", ErrorClass: &CodeBindingErrorClass{Name: "ToolCallError", MemberNameProperty: member},
		}}); err == nil {
			t.Errorf("error member %q was accepted", member)
		}
	}
}

func TestCodeBindingValidationRejectsInjectedNamespaceCollisions(t *testing.T) {
	for _, bindings := range [][]CodeBindingNamespace{
		{{Global: "tools"}, {Global: "tools"}},
		{{Global: "tools", ErrorClass: &CodeBindingErrorClass{Name: "ToolCallError", MemberNameProperty: "member"}}, {Global: "ToolCallError"}},
		{{Global: "ToolCallError"}, {Global: "tools", ErrorClass: &CodeBindingErrorClass{Name: "ToolCallError", MemberNameProperty: "member"}}},
		{{Global: "tools", ErrorClass: &CodeBindingErrorClass{Name: "ToolCallError", MemberNameProperty: "member"}}, {Global: "other", ErrorClass: &CodeBindingErrorClass{Name: "ToolCallError", MemberNameProperty: "member"}}},
	} {
		if _, err := validateCodeBindings(bindings); err == nil {
			t.Errorf("colliding bindings were accepted: %#v", bindings)
		}
	}
}

func TestCodeRunWireEventsUseExactVariantFields(t *testing.T) {
	for _, test := range []struct {
		name  string
		event CodeRunWireEvent
		want  string
	}{
		{
			name: "log", event: CodeRunWireEvent{Type: "log", Sequence: 1, Level: "info", Text: "ready"},
			want: `{"type":"log","sequence":1,"level":"info","text":"ready"}`,
		},
		{
			name: "tool call", event: CodeRunWireEvent{Type: "tool_call", Sequence: 2, CallID: 3, Global: "tools", Name: "echo", Arguments: json.RawMessage(`{"value":1}`)},
			want: `{"type":"tool_call","sequence":2,"callId":3,"global":"tools","name":"echo","arguments":{"value":1}}`,
		},
		{
			name: "done with empty logs", event: CodeRunWireEvent{Type: "done", Sequence: 3, Logs: []string{}},
			want: `{"type":"done","sequence":3,"logs":[]}`,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := json.Marshal(test.event)
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != test.want {
				t.Fatalf("JSON = %s, want %s", got, test.want)
			}
		})
	}
	if _, err := json.Marshal(CodeRunWireEvent{
		Type: "done", Sequence: 1, Value: json.RawMessage(`1`), Logs: []string{}, Error: &CodeRunFailure{Kind: "exception", Message: "bad"},
	}); err == nil {
		t.Fatal("done event with value and error was encoded")
	}
	response := (&codeRunSession{}).responseAfterLocked(0)
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"events":[],"cursor":0,"done":false}` {
		t.Fatalf("empty poll JSON = %s", encoded)
	}
}

func TestCodeRunSessionsBoundRetainedSessions(t *testing.T) {
	sessions, err := NewCodeRunSessions(CodeRunSessionsOptions{
		PollWait:    time.Second,
		Retention:   25 * time.Millisecond,
		MaxSessions: 1,
		RunnerOptions: CodeRunnerOptions{
			DefaultTimeout: time.Second,
			MaxTimeout:     time.Second,
			MaxOutputBytes: 1 << 20,
			EventBuffer:    16,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sessions.Close(context.Background()) }()
	started, err := sessions.Start(CodeRunStartRequest{Program: `return 1`, ComputeMs: 1_000, MemoryLimitBytes: defaultCodeMemoryLimitBytes, StartNonce: "00000000000000000000000000000001"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sessions.Start(CodeRunStartRequest{Program: `return 2`, ComputeMs: 1_000, MemoryLimitBytes: defaultCodeMemoryLimitBytes, StartNonce: "00000000000000000000000000000002"}); !errors.Is(err, ErrCodeRunSessionLimit) {
		t.Fatalf("second start = %v, want ErrCodeRunSessionLimit", err)
	}
	completed, err := sessions.Next(context.Background(), CodeRunNextRequest{ID: started.ID, WaitMs: 5_000})
	if err != nil || !completed.Done {
		t.Fatalf("first session completion = %#v, %v", completed, err)
	}

	deadline := time.Now().Add(time.Second)
	for {
		_, err = sessions.Start(CodeRunStartRequest{Program: `return 3`, ComputeMs: 1_000, MemoryLimitBytes: defaultCodeMemoryLimitBytes, StartNonce: "00000000000000000000000000000003"})
		if err == nil {
			return
		}
		if !errors.Is(err, ErrCodeRunSessionLimit) {
			t.Fatalf("start after retention = %v", err)
		}
		if time.Now().After(deadline) {
			t.Fatal("completed session did not release its capacity after retention")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestCodeRunStartNonceIsIdempotentAndExpiresWithSession(t *testing.T) {
	sessions, err := NewCodeRunSessions(CodeRunSessionsOptions{
		PollWait: time.Second, Retention: 20 * time.Millisecond, MaxSessions: 2,
		RunnerOptions: CodeRunnerOptions{DefaultTimeout: time.Second, MaxTimeout: time.Second, MaxOutputBytes: 1 << 20, EventBuffer: 16},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sessions.Close(context.Background()) }()
	request := CodeRunStartRequest{
		Program: `return 1`, ComputeMs: 1_000, MemoryLimitBytes: defaultCodeMemoryLimitBytes,
		StartNonce: "30000000000000000000000000000001",
	}
	first, err := sessions.Start(request)
	if err != nil {
		t.Fatal(err)
	}
	retried, err := sessions.Start(request)
	if err != nil {
		t.Fatal(err)
	}
	if retried.ID != first.ID {
		t.Fatalf("retry id = %q, want %q", retried.ID, first.ID)
	}
	conflicting := request
	conflicting.Program = `return 2`
	if _, err := sessions.Start(conflicting); !errors.Is(err, ErrCodeRunStartNonceConflict) {
		t.Fatalf("conflicting nonce start = %v, want ErrCodeRunStartNonceConflict", err)
	}
	completed, err := sessions.Next(context.Background(), CodeRunNextRequest{ID: first.ID, WaitMs: 5_000})
	if err != nil || !completed.Done {
		t.Fatalf("first completion = %#v, %v", completed, err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		next, startErr := sessions.Start(conflicting)
		if startErr == nil {
			if next.ID == first.ID {
				t.Fatal("expired nonce reused the old session id")
			}
			return
		}
		if !errors.Is(startErr, ErrCodeRunStartNonceConflict) {
			t.Fatalf("start after nonce retention = %v", startErr)
		}
		if time.Now().After(deadline) {
			t.Fatal("nonce record did not expire with its retained session")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestCodeRunStartNonceRequiresLowercaseHex(t *testing.T) {
	for _, nonce := range []string{"", "300", "3000000000000000000000000000000G", "A0000000000000000000000000000001"} {
		if validCodeRunStartNonce(nonce) {
			t.Fatalf("nonce %q was accepted", nonce)
		}
	}
	if !validCodeRunStartNonce("30000000000000000000000000000001") {
		t.Fatal("valid nonce was rejected")
	}
}

func TestCodeRunStartWireRequiresComputeBudget(t *testing.T) {
	request := CodeRunStartRequest{
		Program: `return 1`, MemoryLimitBytes: defaultCodeMemoryLimitBytes, ComputeMs: 37,
	}
	decoded, err := codeRunRequestFromWire(request)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Compute != 37*time.Millisecond {
		t.Fatalf("compute budget = %s, want 37ms", decoded.Compute)
	}
	for _, compute := range []int64{0, -1, maxCodeTimeout.Milliseconds() + 1} {
		invalid := request
		invalid.ComputeMs = compute
		if _, err := codeRunRequestFromWire(invalid); err == nil {
			t.Fatalf("computeMs %d was accepted", compute)
		}
	}
	changed := decoded
	changed.Compute = 38 * time.Millisecond
	left, err := codeRunStartFingerprint(decoded)
	if err != nil {
		t.Fatal(err)
	}
	right, err := codeRunStartFingerprint(changed)
	if err != nil {
		t.Fatal(err)
	}
	if left == right {
		t.Fatal("start fingerprint ignored compute budget")
	}
}

func TestCodeRunStartWireBoundsMemoryLimit(t *testing.T) {
	request := CodeRunStartRequest{
		Program: `return 1`, MemoryLimitBytes: maxCodeMemoryLimitBytes, ComputeMs: 37,
	}
	if decoded, err := codeRunRequestFromWire(request); err != nil {
		t.Fatalf("maximum memory limit was rejected: %v", err)
	} else if decoded.MemoryLimitBytes != maxCodeMemoryLimitBytes {
		t.Fatalf("memory limit = %d, want %d", decoded.MemoryLimitBytes, maxCodeMemoryLimitBytes)
	}
	for _, limit := range []int64{0, -1, maxCodeMemoryLimitBytes + 1, int64(^uint64(0) >> 1)} {
		invalid := request
		invalid.MemoryLimitBytes = limit
		if _, err := codeRunRequestFromWire(invalid); err == nil {
			t.Fatalf("memoryLimitBytes %d was accepted", limit)
		}
	}
}

func TestCodeRunSessionsPollsAndRepliesWithCursor(t *testing.T) {
	sessions, err := NewCodeRunSessions(CodeRunSessionsOptions{
		PollWait: 100 * time.Millisecond,
		RunnerOptions: CodeRunnerOptions{
			DefaultTimeout: time.Second,
			MaxTimeout:     time.Second,
			MaxOutputBytes: 1 << 20,
			EventBuffer:    16,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sessions.Close(context.Background()) }()
	started, err := sessions.Start(CodeRunStartRequest{
		Program:          `const answer = await tools.echo({ value: 41 }); console.info("ready"); return answer.value + 1`,
		Bindings:         []CodeBindingNamespace{{Global: "tools", Names: []string{"echo"}}},
		ComputeMs:        1_000,
		MemoryLimitBytes: defaultCodeMemoryLimitBytes,
		StartNonce:       "00000000000000000000000000000004",
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err := sessions.Next(context.Background(), CodeRunNextRequest{ID: started.ID, WaitMs: 5_000})
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Events) != 1 || first.Events[0].Type != "tool_call" {
		t.Fatalf("first poll = %#v", first)
	}
	call := first.Events[0]
	if call.CallID == 0 || call.Global != "tools" || call.Name != "echo" {
		t.Fatalf("call event = %#v", call)
	}
	requireCodeJSON(t, call.Arguments, `{"value":41}`)
	if err := sessions.Reply(CodeRunReplyRequest{
		ID: started.ID, CallID: call.CallID, OK: true, Value: json.RawMessage(`{"value":41}`),
	}); err != nil {
		t.Fatal(err)
	}
	second, err := sessions.Next(context.Background(), CodeRunNextRequest{ID: started.ID, After: first.Cursor, WaitMs: 5_000})
	if err != nil {
		t.Fatal(err)
	}
	for !second.Done {
		second, err = sessions.Next(context.Background(), CodeRunNextRequest{ID: started.ID, After: second.Cursor, WaitMs: 5_000})
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(second.Events) == 0 {
		t.Fatalf("terminal poll = %#v", second)
	}
	last := second.Events[len(second.Events)-1]
	if last.Type != "done" || last.Error != nil {
		t.Fatalf("done event = %#v", last)
	}
	requireCodeJSON(t, last.Value, `42`)
	if len(last.Logs) != 1 || last.Logs[0] != "ready" {
		t.Fatalf("done logs = %#v", last.Logs)
	}
	if err := sessions.Reply(CodeRunReplyRequest{ID: started.ID, CallID: call.CallID, OK: true, Value: json.RawMessage(`null`)}); !errors.Is(err, ErrCodeRunCallNotFound) {
		t.Fatalf("duplicate reply = %v, want ErrCodeRunCallNotFound", err)
	}
}

func TestCodeRunSessionPollReturnsToolCallAfterLeadingLog(t *testing.T) {
	first := CodeRunWireEvent{Type: "log", Sequence: 1, Level: "info", Text: "before call"}
	second := CodeRunWireEvent{Type: "tool_call", Sequence: 2, CallID: 1, Global: "tools", Name: "echo", Arguments: json.RawMessage(`{}`)}
	firstJSON, err := json.Marshal(first)
	if err != nil {
		t.Fatal(err)
	}
	secondJSON, err := json.Marshal(second)
	if err != nil {
		t.Fatal(err)
	}
	session := &codeRunSession{
		events: []storedCodeRunEvent{{wire: first, bytes: len(firstJSON)}, {wire: second, bytes: len(secondJSON)}},
		cursor: 2, eventBytes: len(firstJSON) + len(secondJSON), notify: make(chan struct{}),
		maxEvents: 16, maxEventBytes: 1 << 20, maxSessionBytes: 2 << 20, maxPollResponseBytes: 1 << 20,
	}
	started := time.Now()
	response := session.next(context.Background(), 0, time.Second)
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("poll waited %s after a tool call was already buffered", elapsed)
	}
	if len(response.Events) != 2 || response.Events[1].Type != "tool_call" {
		t.Fatalf("poll events = %#v", response.Events)
	}
}

func TestCodeRunSessionPagesEventsWithoutSkippingCursor(t *testing.T) {
	makeLog := func(sequence uint64, size int) storedCodeRunEvent {
		t.Helper()
		wire := CodeRunWireEvent{Type: "log", Sequence: sequence, Level: "info", Text: strings.Repeat("x", size)}
		encoded, err := json.Marshal(wire)
		if err != nil {
			t.Fatal(err)
		}
		return storedCodeRunEvent{wire: wire, bytes: len(encoded)}
	}
	first := makeLog(1, 150<<10)
	second := makeLog(2, 150<<10)
	doneWire := CodeRunWireEvent{Type: "done", Sequence: 3, Logs: []string{}}
	doneJSON, err := json.Marshal(doneWire)
	if err != nil {
		t.Fatal(err)
	}
	session := &codeRunSession{
		events: []storedCodeRunEvent{first, second, {wire: doneWire, bytes: len(doneJSON)}},
		cursor: 3, eventBytes: first.bytes + second.bytes + len(doneJSON), done: true,
		notify: make(chan struct{}), maxEvents: 8, maxEventBytes: 192 << 10,
		maxSessionBytes: 512 << 10, maxPollResponseBytes: 256 << 10,
	}
	firstPage := session.responseAfterLocked(0)
	if len(firstPage.Events) != 1 || firstPage.Cursor != 1 || firstPage.Done {
		t.Fatalf("first page = %#v", firstPage)
	}
	encodedFirst, err := json.Marshal(firstPage)
	if err != nil || len(encodedFirst) > session.maxPollResponseBytes {
		t.Fatalf("first page bytes = %d, err = %v", len(encodedFirst), err)
	}
	secondPage := session.responseAfterLocked(firstPage.Cursor)
	if len(secondPage.Events) != 2 || secondPage.Events[0].Sequence != 2 || secondPage.Events[1].Type != "done" || secondPage.Cursor != 3 || !secondPage.Done {
		t.Fatalf("second page = %#v", secondPage)
	}
	empty := session.responseAfterLocked(secondPage.Cursor)
	if len(empty.Events) != 0 || empty.Cursor != secondPage.Cursor || empty.Done {
		t.Fatalf("empty terminal page = %#v", empty)
	}
}

func TestCodeRunSessionRejectsUnretainableToolWithoutSequenceGap(t *testing.T) {
	session := &codeRunSession{
		pending: make(map[uint64]*CodeToolCall), notify: make(chan struct{}), terminalDone: make(chan struct{}),
		maxEvents: 2, maxEventBytes: 1 << 20, maxSessionBytes: 2 << 20, maxPollResponseBytes: 1 << 20,
	}
	first := &CodeToolCall{ID: 1, Global: "tools", Name: "one", Arguments: json.RawMessage(`{}`), finished: make(chan struct{}), reply: make(chan codeToolReply, 1)}
	second := &CodeToolCall{ID: 2, Global: "tools", Name: "two", Arguments: json.RawMessage(`{}`), finished: make(chan struct{}), reply: make(chan codeToolReply, 1)}
	session.append(CodeRunEvent{ToolCall: first})
	session.append(CodeRunEvent{ToolCall: second})
	select {
	case reply := <-second.reply:
		if reply.message == "" {
			t.Fatalf("second tool reply = %#v", reply)
		}
	case <-time.After(time.Second):
		t.Fatal("unretainable tool call was not rejected")
	}
	session.finish(CodeRunResult{Logs: []string{}})
	response := session.responseAfterLocked(0)
	if len(response.Events) != 2 || response.Events[0].Sequence != 1 || response.Events[0].CallID != 1 || response.Events[1].Sequence != 2 || response.Events[1].Type != "done" || !response.Done {
		t.Fatalf("retained events = %#v", response)
	}
}

func TestCodeRunSessionCapsPendingBindingsBeforeHostProtocolFails(t *testing.T) {
	session := &codeRunSession{
		pending: make(map[uint64]*CodeToolCall), notify: make(chan struct{}), terminalDone: make(chan struct{}),
		maxEvents: maxCodePendingBindings + 2, maxEventBytes: 1 << 20,
		maxSessionBytes: (maxCodePendingBindings + 2) << 20, maxPollResponseBytes: 1 << 20,
	}
	for id := 1; id <= maxCodePendingBindings; id++ {
		call := &CodeToolCall{ID: uint64(id), Global: "tools", Name: "wait", Arguments: json.RawMessage(`{}`), finished: make(chan struct{}), reply: make(chan codeToolReply, 1)}
		session.append(CodeRunEvent{ToolCall: call})
	}
	overflow := &CodeToolCall{ID: maxCodePendingBindings + 1, Global: "tools", Name: "overflow", Arguments: json.RawMessage(`{}`), finished: make(chan struct{}), reply: make(chan codeToolReply, 1)}
	session.append(CodeRunEvent{ToolCall: overflow})
	select {
	case reply := <-overflow.reply:
		if reply.message == "" {
			t.Fatalf("overflow reply = %#v", reply)
		}
	case <-time.After(time.Second):
		t.Fatal("129th pending binding was not rejected")
	}
	if len(session.pending) != maxCodePendingBindings || session.cursor != maxCodePendingBindings {
		t.Fatalf("pending = %d, cursor = %d", len(session.pending), session.cursor)
	}
}

func TestCodeOutputLedgerCountsFullFailureEnvelope(t *testing.T) {
	ledger := newCodeOutputLedger(64)
	result := ledger.failure("exception", "this message cannot fit the full JSON result envelope")
	if result.Error == nil || result.Error.Kind != "output-limit" {
		t.Fatalf("result = %#v", result)
	}
	encoded, err := json.Marshal(result)
	if err != nil || len(encoded) > 64 {
		t.Fatalf("bounded failure bytes = %d, err = %v, result = %s", len(encoded), err, encoded)
	}
	if !strings.Contains(string(encoded), `"logs":[]`) {
		t.Fatalf("failure encoded logs as non-array: %s", encoded)
	}
	ledger = newCodeOutputLedger(64)
	ledger.append("x")
	result = ledger.success(json.RawMessage(`123456789012345678901234567890123456789012345678901234567890`), true)
	if result.Error == nil || result.Error.Kind != "output-limit" {
		t.Fatalf("oversized completion = %#v", result)
	}
	encoded, err = json.Marshal(result)
	if err != nil || len(encoded) > 64 {
		t.Fatalf("bounded completion failure bytes = %d, err = %v", len(encoded), err)
	}
}
