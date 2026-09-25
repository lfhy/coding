package remoteagent

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"
)

const directCodeTestRoot = "/a/remote-only/project-that-does-not-exist"

func newDirectCodeTestBackend(t *testing.T) *directCodeBackend {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	backend, err := newDirectCodeBackend([]string{executable, "-test.run=^$"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := backend.Close(); err != nil {
			t.Errorf("close direct code backend: %v", err)
		}
	})
	return backend
}

func directCodeTestRequest(t *testing.T, backend *directCodeBackend, route string, request any) ProxyResponse {
	t.Helper()
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	response, err := backend.Proxy(context.Background(), route, body)
	if err != nil {
		t.Fatal(err)
	}
	if response.ContentType != "application/json" {
		t.Fatalf("%s content type = %q", route, response.ContentType)
	}
	return response
}

func directCodeTestStart(t *testing.T, backend *directCodeBackend, program, nonce string) string {
	t.Helper()
	response := directCodeTestRequest(t, backend, "/v1/code/start", CodeRunStartRequest{
		Root: directCodeTestRoot, Program: program,
		Bindings:  []CodeBindingNamespace{{Global: "tools", Names: []string{"bash"}}},
		ComputeMs: 1_000, MemoryLimitBytes: defaultCodeMemoryLimitBytes, StartNonce: nonce,
	})
	if response.Status != http.StatusOK {
		t.Fatalf("start status = %d: %s", response.Status, response.Body)
	}
	var started CodeRunStartResponse
	if err := json.Unmarshal(response.Body, &started); err != nil || started.ID == "" {
		t.Fatalf("start response = %s: %v", response.Body, err)
	}
	return started.ID
}

func directCodeTestNext(t *testing.T, backend *directCodeBackend, root, id string, after uint64) CodeRunNextResponse {
	t.Helper()
	response := directCodeTestRequest(t, backend, "/v1/code/next", CodeRunNextRequest{
		Root: root, ID: id, After: after, WaitMs: 5_000,
	})
	if response.Status != http.StatusOK {
		t.Fatalf("next status = %d: %s", response.Status, response.Body)
	}
	var next CodeRunNextResponse
	if err := json.Unmarshal(response.Body, &next); err != nil {
		t.Fatal(err)
	}
	return next
}

func TestDirectCodeBashBindingRoundTripWithoutHostGlobals(t *testing.T) {
	if _, err := os.Stat(directCodeTestRoot); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("test remote marker root unexpectedly exists on Host: %v", err)
	}
	backend := newDirectCodeTestBackend(t)
	program := `const globals = [typeof process, typeof require, typeof fs, typeof fetch, typeof Deno];
const output = await tools.bash({ command: "printf remote-code", timeout: 1000 });
return { globals, output };`
	id := directCodeTestStart(t, backend, program, "20000000000000000000000000000001")
	first := directCodeTestNext(t, backend, directCodeTestRoot, id, 0)
	if len(first.Events) != 1 || first.Events[0].Type != "tool_call" {
		t.Fatalf("binding events = %#v", first.Events)
	}
	call := first.Events[0]
	if call.Global != "tools" || call.Name != "bash" || string(call.Arguments) != `{"command":"printf remote-code","timeout":1000}` {
		t.Fatalf("bash binding = %#v", call)
	}
	reply := directCodeTestRequest(t, backend, "/v1/code/reply", CodeRunReplyRequest{
		Root: directCodeTestRoot, ID: id, CallID: call.CallID, OK: true,
		Value: json.RawMessage(`{"stdout":"remote-code","exitCode":0}`),
	})
	if reply.Status != http.StatusOK {
		t.Fatalf("reply status = %d: %s", reply.Status, reply.Body)
	}
	finished := directCodeTestNext(t, backend, directCodeTestRoot, id, first.Cursor)
	if !finished.Done || len(finished.Events) != 1 || finished.Events[0].Type != "done" || finished.Events[0].Error != nil {
		t.Fatalf("completed events = %#v", finished)
	}
	want := `{"globals":["undefined","undefined","undefined","undefined","undefined"],"output":{"stdout":"remote-code","exitCode":0}}`
	if string(finished.Events[0].Value) != want {
		t.Fatalf("result = %s, want %s", finished.Events[0].Value, want)
	}
	// 这里只结算 Host 传回的绑定 JSON；没有 SSH client、远端 agent 或
	// TCP forward 被传给此 backend，程序也无法直接调用本机 Bash。
}

func TestDirectCodeCancelAndRejectCrossRoot(t *testing.T) {
	backend := newDirectCodeTestBackend(t)
	id := directCodeTestStart(t, backend, `await tools.bash({ command: "wait" }); return 1`, "20000000000000000000000000000002")
	first := directCodeTestNext(t, backend, directCodeTestRoot, id, 0)
	if len(first.Events) != 1 || first.Events[0].Type != "tool_call" {
		t.Fatalf("binding events = %#v", first.Events)
	}
	foreign := directCodeTestRequest(t, backend, "/v1/code/cancel", CodeRunCancelRequest{Root: "/another/remote", ID: id})
	if foreign.Status != http.StatusNotFound {
		t.Fatalf("foreign cancel status = %d: %s", foreign.Status, foreign.Body)
	}
	canceled := directCodeTestRequest(t, backend, "/v1/code/cancel", CodeRunCancelRequest{Root: directCodeTestRoot, ID: id})
	if canceled.Status != http.StatusOK {
		t.Fatalf("cancel status = %d: %s", canceled.Status, canceled.Body)
	}
	final := directCodeTestNext(t, backend, directCodeTestRoot, id, first.Cursor)
	if !final.Done || len(final.Events) != 1 || final.Events[0].Error == nil || final.Events[0].Error.Kind != "abort" {
		t.Fatalf("canceled events = %#v", final.Events)
	}
	late := directCodeTestRequest(t, backend, "/v1/code/reply", CodeRunReplyRequest{
		Root: directCodeTestRoot, ID: id, CallID: first.Events[0].CallID, OK: true, Value: json.RawMessage(`null`),
	})
	if late.Status != http.StatusConflict {
		t.Fatalf("late reply status = %d: %s", late.Status, late.Body)
	}
}

func TestDirectCodeBindingErrorAndRouteBoundary(t *testing.T) {
	backend := newDirectCodeTestBackend(t)
	id := directCodeTestStart(t, backend, `return await tools.bash({ command: "denied" })`, "20000000000000000000000000000003")
	first := directCodeTestNext(t, backend, directCodeTestRoot, id, 0)
	if len(first.Events) != 1 || first.Events[0].Type != "tool_call" {
		t.Fatalf("binding events = %#v", first.Events)
	}
	rejected := directCodeTestRequest(t, backend, "/v1/code/reply", CodeRunReplyRequest{
		Root: directCodeTestRoot, ID: id, CallID: first.Events[0].CallID, Message: "permission denied",
	})
	if rejected.Status != http.StatusOK {
		t.Fatalf("reject status = %d: %s", rejected.Status, rejected.Body)
	}
	final := directCodeTestNext(t, backend, directCodeTestRoot, id, first.Cursor)
	if !final.Done || len(final.Events) != 1 || final.Events[0].Error == nil || !strings.Contains(final.Events[0].Error.Message, "permission denied") {
		t.Fatalf("denied result = %#v", final.Events)
	}
	if _, err := backend.Proxy(context.Background(), "/v1/exec", []byte(`{}`)); err == nil {
		t.Fatal("direct code backend accepted an exec route")
	}
	if _, err := backend.Proxy(context.Background(), "/v1/processes/start", []byte(`{}`)); err == nil {
		t.Fatal("direct code backend accepted a process route")
	}
	invalid := directCodeTestRequest(t, backend, "/v1/code/start", CodeRunStartRequest{
		Root: "relative/path", Program: `return 1`, ComputeMs: 1_000,
		MemoryLimitBytes: defaultCodeMemoryLimitBytes, StartNonce: "20000000000000000000000000000004",
	})
	if invalid.Status != http.StatusBadRequest {
		t.Fatalf("relative root status = %d: %s", invalid.Status, invalid.Body)
	}
}

func TestDirectCodeRequiresLocalIsolateExecutable(t *testing.T) {
	for _, test := range []struct {
		name    string
		command []string
	}{
		{name: "missing command"},
		{name: "nonexistent asset", command: []string{"/nonexistent/coding-remote-agent", "--code-isolate"}},
		{name: "no isolated entry", command: []string{"/bin/sh", "-c"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if backend, err := newDirectCodeBackend(test.command); err == nil {
				_ = backend.Close()
				t.Fatal("direct code accepted an unavailable isolate")
			}
		})
	}
}
