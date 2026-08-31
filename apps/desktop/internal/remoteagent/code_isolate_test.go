package remoteagent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"testing"
	"time"
)

const codeIsolateTestPIDEnv = "CODING_REMOTE_AGENT_CODE_ISOLATE_TEST_PID_PATH"
const codeIsolateTestModeEnv = "CODING_REMOTE_AGENT_CODE_ISOLATE_TEST_MODE"
const codeIsolateTestCompletionEnv = "CODING_REMOTE_AGENT_CODE_ISOLATE_TEST_COMPLETION_PATH"

// TestMain 让默认 re-exec 在 `go test` 中仍通过与生产相同的 stdio child
// 入口执行。它不是 execute 的测试替身：父 runner 仍会 spawn 一个新进程。
func TestMain(m *testing.M) {
	if os.Getenv(codeIsolateTestChildEnv) == "1" {
		switch os.Getenv(codeIsolateTestModeEnv) {
		case "exit":
			os.Exit(0)
		case "malformed":
			_, _ = fmt.Fprintln(os.Stdout, "not-json")
			os.Exit(0)
		case "done-pending":
			if err := writeCodeIsolateTestFrames(
				codeIsolateCall{Type: "tool_call", ID: 1, Global: "tools", Name: "echo", Arguments: json.RawMessage(`{}`)},
				codeIsolateDone{Type: "done", Result: CodeRunResult{Logs: []string{}, Value: json.RawMessage(`null`)}},
			); err != nil {
				fmt.Fprintln(os.Stderr, "remoteagent code isolate test child:", err)
				os.Exit(2)
			}
			os.Exit(0)
		case "decreasing-call-id":
			if err := writeCodeIsolateTestFrames(
				codeIsolateCall{Type: "tool_call", ID: 2, Global: "tools", Name: "echo", Arguments: json.RawMessage(`{}`)},
				codeIsolateCall{Type: "tool_call", ID: 1, Global: "tools", Name: "echo", Arguments: json.RawMessage(`{}`)},
			); err != nil {
				fmt.Fprintln(os.Stderr, "remoteagent code isolate test child:", err)
				os.Exit(2)
			}
			os.Exit(0)
		case "reply-write-error":
			if err := writeCodeIsolateTestFrames(
				codeIsolateCall{Type: "tool_call", ID: 1, Global: "tools", Name: "echo", Arguments: json.RawMessage(`{}`)},
			); err != nil {
				fmt.Fprintln(os.Stderr, "remoteagent code isolate test child:", err)
				os.Exit(2)
			}
			// 让父端继续读取 stdout，但让其下一次向 stdin 写入时确定失败。
			_ = os.Stdin.Close()
			time.Sleep(10 * time.Second)
			os.Exit(0)
		case "oom":
			// taskpolicy/RLIMIT/Job Object 都应在此 child 读取 program 前生效。
			// 禁用 GC 并逐页触碰分配，避免保留虚拟地址却没有实际内存压力。
			limit, err := codeIsolateLimitFromEnvironment()
			if err != nil || installCodeIsolateMemoryLimit(limit) != nil {
				fmt.Fprintln(os.Stderr, "remoteagent code isolate test child: missing memory limit")
				os.Exit(2)
			}
			debug.SetGCPercent(-1)
			allocations := make([][]byte, 0, 64)
			for index := 0; index < 64; index++ {
				block := make([]byte, 8<<20)
				for offset := 0; offset < len(block); offset += 4096 {
					block[offset] = byte(index)
				}
				allocations = append(allocations, block)
			}
			runtime.KeepAlive(allocations)
			if path := os.Getenv(codeIsolateTestCompletionEnv); path != "" {
				_ = os.WriteFile(path, []byte("unexpected completion"), 0o600)
			}
			os.Exit(0)
		}
		if path := os.Getenv(codeIsolateTestPIDEnv); path != "" {
			if err := os.WriteFile(path, []byte(strconv.Itoa(os.Getpid())), 0o600); err != nil {
				fmt.Fprintln(os.Stderr, "remoteagent code isolate test child:", err)
				os.Exit(2)
			}
		}
		if err := RunCodeIsolateStdio(os.Stdin, os.Stdout, os.Stderr); err != nil {
			fmt.Fprintln(os.Stderr, "remoteagent code isolate test child:", err)
			os.Exit(2)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func writeCodeIsolateTestFrames(frames ...any) error {
	reader := bufio.NewReaderSize(os.Stdin, 64<<10)
	if _, err := readCodeIsolateFrame(reader); err != nil {
		return fmt.Errorf("read start frame: %w", err)
	}
	writer := &codeIsolateFrameWriter{out: os.Stdout}
	for _, frame := range frames {
		if err := writer.write(frame); err != nil {
			return fmt.Errorf("write test frame: %w", err)
		}
	}
	return nil
}

func newCodeIsolateTestRunner(t *testing.T, extraEnv ...string) *CodeRunner {
	t.Helper()
	runner, err := NewCodeRunner(CodeRunnerOptions{
		DefaultTimeout: 2 * time.Second,
		MaxTimeout:     2 * time.Second,
		MaxOutputBytes: 1 << 20,
		MaxEventBytes:  1 << 20,
		EventBuffer:    16,
		IsolateEnv:     extraEnv,
	})
	if err != nil {
		t.Fatal(err)
	}
	return runner
}

func waitForIsolateResult(t *testing.T, run *CodeRun) CodeRunResult {
	t.Helper()
	select {
	case result, open := <-run.Done:
		if !open {
			t.Fatal("isolate closed Done without a result")
		}
		return result
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for isolated code result")
	}
	return CodeRunResult{}
}

func TestCodeRunnerReexecutesCodeIsolateChild(t *testing.T) {
	pidPath := filepath.Join(t.TempDir(), "child.pid")
	runner := newCodeIsolateTestRunner(t, codeIsolateTestPIDEnv+"="+pidPath)
	result := waitForIsolateResult(t, runner.Start(context.Background(), CodeRunRequest{Program: `return 42`}))
	if result.Error != nil {
		t.Fatalf("result error = %#v", result.Error)
	}
	requireCodeJSON(t, result.Value, `42`)
	data, err := os.ReadFile(pidPath)
	if err != nil {
		t.Fatalf("read child PID: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil || pid <= 0 || pid == os.Getpid() {
		t.Fatalf("isolate PID = %q, parent PID = %d", data, os.Getpid())
	}
}

func TestCodeIsolateStartRequiresComputeBudget(t *testing.T) {
	start := codeIsolateStart{
		Type: "start",
		Request: codeIsolateRequest{
			Program: `return 1`, Bindings: []CodeBindingNamespace{}, TimeoutMs: 500,
			ComputeMs: 37, MemoryLimitBytes: defaultCodeMemoryLimitBytes,
		},
		Options: codeIsolateRunnerLimit{
			DefaultTimeoutMs: 500, MaxTimeoutMs: 1_000,
			MaxOutputBytes: minCodeOutput, MaxEventBytes: minCodeOutput, EventBuffer: 1,
		},
	}
	encode := func(value codeIsolateStart) []byte {
		t.Helper()
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return encoded
	}
	decoded, err := decodeCodeIsolateStart(encode(start), defaultCodeMemoryLimitBytes)
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Request.ComputeMs != 37 {
		t.Fatalf("computeMs = %d, want 37", decoded.Request.ComputeMs)
	}
	start.Request.ComputeMs = 0
	if _, err := decodeCodeIsolateStart(encode(start), defaultCodeMemoryLimitBytes); err == nil {
		t.Fatal("missing compute budget was accepted")
	}
	start.Request.ComputeMs = 37
	start.Request.MemoryLimitBytes = maxCodeMemoryLimitBytes + 1
	if _, err := decodeCodeIsolateStart(encode(start), maxCodeMemoryLimitBytes+1); err == nil {
		t.Fatal("memory limit above the hard cap was accepted")
	}
	start.Request.MemoryLimitBytes = maxCodeMemoryLimitBytes
	if _, err := decodeCodeIsolateStart(encode(start), maxCodeMemoryLimitBytes); err != nil {
		t.Fatalf("maximum memory limit was rejected: %v", err)
	}
}

func TestIsGoTestBinaryRecognizesWindowsAndUnixNames(t *testing.T) {
	for _, path := range []string{"/tmp/remoteagent.test", `C:\\work\\remoteagent.test.exe`, `C:\\work\\REMOTEAGENT.TEST.EXE`} {
		if !isGoTestBinary(path) {
			t.Fatalf("test binary %q was not recognized", path)
		}
	}
	for _, path := range []string{"/tmp/remote-agent", "/tmp/remoteagent.test.bak", `C:\\work\\remoteagent.exe`} {
		if isGoTestBinary(path) {
			t.Fatalf("non-test binary %q was recognized", path)
		}
	}
}

func TestCodeIsolateAllowsMoreThanPendingBindingWindowWhenCallsSettle(t *testing.T) {
	runner, err := NewCodeRunner(CodeRunnerOptions{
		DefaultTimeout: 10 * time.Second,
		MaxTimeout:     10 * time.Second,
		MaxOutputBytes: 1 << 20,
		MaxEventBytes:  1 << 20,
		EventBuffer:    16,
	})
	if err != nil {
		t.Fatal(err)
	}
	const count = maxCodePendingBindings*2 + 1
	run := runner.Start(context.Background(), CodeRunRequest{
		Program: `
      for (let i = 0; i < 257; i++) {
        const result = await tools.echo({ i });
        if (result.i !== i) throw new Error("binding order mismatch");
      }
      return 257;
    `,
		Bindings: []CodeBindingNamespace{{Global: "tools", Names: []string{"echo"}}},
	})
	for expected := 0; expected < count; expected++ {
		var event CodeRunEvent
		select {
		case event = <-run.Events:
		case result := <-run.Done:
			t.Fatalf("run ended after %d calls: %#v", expected, result)
		case <-time.After(10 * time.Second):
			t.Fatalf("timed out waiting for call %d", expected+1)
		}
		if event.ToolCall == nil {
			t.Fatalf("event %d = %#v, want tool call", expected+1, event)
		}
		if event.ToolCall.ID != uint64(expected+1) {
			t.Fatalf("call id = %d, want %d", event.ToolCall.ID, expected+1)
		}
		var args struct {
			I int `json:"i"`
		}
		if err := json.Unmarshal(event.ToolCall.Arguments, &args); err != nil {
			t.Fatalf("call %d arguments: %v", expected+1, err)
		}
		if args.I != expected {
			t.Fatalf("call %d argument = %d, want %d", expected+1, args.I, expected)
		}
		if err := event.ToolCall.ResolveJSON(json.RawMessage(fmt.Sprintf(`{"i":%d}`, expected))); err != nil {
			t.Fatalf("resolve call %d: %v", expected+1, err)
		}
	}
	result := waitForIsolateResult(t, run)
	if result.Error != nil {
		t.Fatalf("sequential calls result error = %#v", result.Error)
	}
	requireCodeJSON(t, result.Value, `257`)
}

func TestCodeIsolateMalformedChildDoesNotPoisonNextRun(t *testing.T) {
	broken := newCodeIsolateTestRunner(t, codeIsolateTestModeEnv+"=malformed")
	result := waitForIsolateResult(t, broken.Start(context.Background(), CodeRunRequest{Program: `return 1`}))
	if result.Error == nil || result.Error.Kind != "worker-exit" || len(result.Logs) != 0 {
		t.Fatalf("malformed child result = %#v", result)
	}
	healthy := newCodeIsolateTestRunner(t)
	result = waitForIsolateResult(t, healthy.Start(context.Background(), CodeRunRequest{Program: `return 2`}))
	if result.Error != nil {
		t.Fatalf("healthy child error = %#v", result.Error)
	}
	requireCodeJSON(t, result.Value, `2`)
}

func TestCodeIsolateRejectsCompletionWithPendingToolCall(t *testing.T) {
	runner := newCodeIsolateTestRunner(t, codeIsolateTestModeEnv+"=done-pending")
	result := waitForIsolateResult(t, runner.Start(context.Background(), CodeRunRequest{Program: `return 1`}))
	if result.Error == nil || result.Error.Kind != "worker-exit" {
		t.Fatalf("pending completion result = %#v", result)
	}
	if !strings.Contains(result.Error.Message, "completion arrived with pending tool calls") {
		t.Fatalf("pending completion error = %q", result.Error.Message)
	}
}

func TestCodeIsolateRejectsDecreasingToolCallID(t *testing.T) {
	runner := newCodeIsolateTestRunner(t, codeIsolateTestModeEnv+"=decreasing-call-id")
	result := waitForIsolateResult(t, runner.Start(context.Background(), CodeRunRequest{Program: `return 1`}))
	if result.Error == nil || result.Error.Kind != "worker-exit" {
		t.Fatalf("decreasing call id result = %#v", result)
	}
	if !strings.Contains(result.Error.Message, "tool call ids must be strictly increasing") {
		t.Fatalf("decreasing call id error = %q", result.Error.Message)
	}
}

func TestCodeIsolateReplyWriteFailureStopsRunPromptly(t *testing.T) {
	runner := newCodeIsolateTestRunner(t, codeIsolateTestModeEnv+"=reply-write-error")
	run := runner.Start(context.Background(), CodeRunRequest{Program: `return 1`})
	var event CodeRunEvent
	select {
	case event = <-run.Events:
	case result := <-run.Done:
		t.Fatalf("run ended before tool call: %#v", result)
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for tool call")
	}
	if event.ToolCall == nil {
		t.Fatalf("event = %#v, want tool call", event)
	}
	if err := event.ToolCall.ResolveJSON(json.RawMessage(`null`)); err != nil {
		t.Fatalf("resolve tool call: %v", err)
	}
	started := time.Now()
	result := waitForIsolateResult(t, run)
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("reply write failure took %s, expected prompt termination", elapsed)
	}
	if result.Error == nil || result.Error.Kind != "worker-exit" {
		t.Fatalf("reply write failure result = %#v", result)
	}
	if !strings.Contains(result.Error.Message, "write reply") {
		t.Fatalf("reply write failure error = %q", result.Error.Message)
	}
}

func TestCodeIsolateOOMLeavesServerHealthy(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("this platform intentionally fails closed without an isolate memory limiter")
	}
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })
	start := func(program, nonce string) CodeRunStartResponse {
		response := agentJSONRequest(t, server, "/v1/code/start", CodeRunStartRequest{
			Program: program, ComputeMs: 1_000, MemoryLimitBytes: 128 << 20, StartNonce: nonce,
		})
		if response.Code != http.StatusOK {
			t.Fatalf("start status = %d: %s", response.Code, response.Body.String())
		}
		var started CodeRunStartResponse
		if err := json.Unmarshal(response.Body.Bytes(), &started); err != nil {
			t.Fatal(err)
		}
		return started
	}
	terminal := func(id string) CodeRunWireEvent {
		var after uint64
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			response := agentJSONRequest(t, server, "/v1/code/next", CodeRunNextRequest{ID: id, After: after, WaitMs: 1_000})
			if response.Code != http.StatusOK {
				t.Fatalf("poll status = %d: %s", response.Code, response.Body.String())
			}
			var next CodeRunNextResponse
			if err := json.Unmarshal(response.Body.Bytes(), &next); err != nil {
				t.Fatal(err)
			}
			after = next.Cursor
			if next.Done && len(next.Events) > 0 {
				return next.Events[len(next.Events)-1]
			}
		}
		t.Fatal("timed out waiting for OOM terminal event")
		return CodeRunWireEvent{}
	}
	completionPath := filepath.Join(t.TempDir(), "unexpected-oom-completion")
	t.Setenv(codeIsolateTestModeEnv, "oom")
	t.Setenv(codeIsolateTestCompletionEnv, completionPath)
	oom := start(`return "unreachable"`, "20000000000000000000000000000001")
	failed := terminal(oom.ID)
	if failed.Type != "done" || failed.Error == nil || failed.Error.Kind != "worker-exit" {
		t.Fatalf("OOM terminal = %#v", failed)
	}
	if data, err := os.ReadFile(completionPath); err == nil {
		t.Fatalf("limited child unexpectedly completed allocation: %s", data)
	} else if !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if err := os.Unsetenv(codeIsolateTestModeEnv); err != nil {
		t.Fatal(err)
	}
	if err := os.Unsetenv(codeIsolateTestCompletionEnv); err != nil {
		t.Fatal(err)
	}
	if health := agentRequest(server, http.MethodGet, "/v1/health", ""); health.Code != http.StatusOK {
		t.Fatalf("health after OOM = %d: %s", health.Code, health.Body.String())
	}
	healthy := start(`return 42`, "20000000000000000000000000000002")
	completed := terminal(healthy.ID)
	if completed.Error != nil {
		t.Fatalf("healthy terminal error = %#v", completed.Error)
	}
	requireCodeJSON(t, completed.Value, `42`)
}
