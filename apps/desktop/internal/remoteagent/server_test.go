package remoteagent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func agentRequest(server *Server, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+server.token)
	response := httptest.NewRecorder()
	server.routes().ServeHTTP(response, request)
	return response
}

func agentJSONRequest(t *testing.T, server *Server, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return agentRequest(server, http.MethodPost, path, string(encoded))
}

func responseErrorCode(t *testing.T, response *httptest.ResponseRecorder) string {
	t.Helper()
	var envelope struct {
		Error AgentError `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.Error.Code
}

func TestRoutesRejectWrongMethodAndTrailingJSON(t *testing.T) {
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	if response := agentRequest(server, http.MethodGet, "/v1/shutdown", ""); response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET shutdown status = %d, want %d", response.Code, http.StatusMethodNotAllowed)
	}
	response := agentRequest(server, http.MethodPost, "/v1/resolve", `{"path":"."}{"path":"."}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("trailing JSON status = %d, want %d", response.Code, http.StatusBadRequest)
	}
	response = agentRequest(server, http.MethodPost, "/v1/resolve", `{"path":".","unknown":true}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown field status = %d, want %d", response.Code, http.StatusBadRequest)
	}
	bareToken := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	bareToken.Header.Set("Authorization", server.token)
	bareTokenResponse := httptest.NewRecorder()
	server.routes().ServeHTTP(bareTokenResponse, bareToken)
	if bareTokenResponse.Code != http.StatusUnauthorized {
		t.Fatalf("bare authorization status = %d, want %d", bareTokenResponse.Code, http.StatusUnauthorized)
	}
	emptyPath := agentJSONRequest(t, server, "/v1/resolve", ResolveRequest{Path: ""})
	if emptyPath.Code != http.StatusBadRequest || responseErrorCode(t, emptyPath) != "invalid-path" {
		t.Fatalf("empty path response = %d %s", emptyPath.Code, emptyPath.Body.String())
	}
	for _, removed := range []string{"/v1/node", "/v1/list_files"} {
		if response := agentRequest(server, http.MethodPost, removed, `{}`); response.Code != http.StatusMethodNotAllowed {
			t.Fatalf("removed route %s status = %d", removed, response.Code)
		}
	}
}

func TestCodeRunRoutesPollReplyAndClassifyRecoverableErrors(t *testing.T) {
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })
	if response := agentRequest(server, http.MethodGet, "/v1/code/start", ""); response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET code start status = %d, want %d", response.Code, http.StatusMethodNotAllowed)
	}

	root := t.TempDir()
	startedResponse := agentJSONRequest(t, server, "/v1/code/start", CodeRunStartRequest{
		// callRemoteWorkspaceBridge 会给所有请求附带 root；Code API 必须接受它。
		Root:             root,
		Program:          `const result = await tools.echo({ value: 41 }); console.info("ready"); return result.value + 1`,
		Bindings:         []CodeBindingNamespace{{Global: "tools", Names: []string{"echo"}}},
		ComputeMs:        1_000,
		MemoryLimitBytes: defaultCodeMemoryLimitBytes,
		StartNonce:       "10000000000000000000000000000001",
	})
	if startedResponse.Code != http.StatusOK {
		t.Fatalf("code start status = %d: %s", startedResponse.Code, startedResponse.Body.String())
	}
	var started CodeRunStartResponse
	if err := json.Unmarshal(startedResponse.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	if started.ID == "" {
		t.Fatal("code start returned an empty session id")
	}
	retriedResponse := agentJSONRequest(t, server, "/v1/code/start", CodeRunStartRequest{
		Root: root, Program: `const result = await tools.echo({ value: 41 }); console.info("ready"); return result.value + 1`,
		Bindings: []CodeBindingNamespace{{Global: "tools", Names: []string{"echo"}}}, ComputeMs: 1_000, MemoryLimitBytes: defaultCodeMemoryLimitBytes,
		StartNonce: "10000000000000000000000000000001",
	})
	if retriedResponse.Code != http.StatusOK {
		t.Fatalf("retried code start = %d: %s", retriedResponse.Code, retriedResponse.Body.String())
	}
	var retried CodeRunStartResponse
	if err := json.Unmarshal(retriedResponse.Body.Bytes(), &retried); err != nil || retried.ID != started.ID {
		t.Fatalf("retried code start = %#v, %v; want id %q", retried, err, started.ID)
	}
	conflictingResponse := agentJSONRequest(t, server, "/v1/code/start", CodeRunStartRequest{
		Root: root, Program: `return 0`, ComputeMs: 1_000, MemoryLimitBytes: defaultCodeMemoryLimitBytes, StartNonce: "10000000000000000000000000000001",
	})
	if conflictingResponse.Code != http.StatusConflict || responseErrorCode(t, conflictingResponse) != "code-start-nonce-conflict" {
		t.Fatalf("conflicting code start = %d: %s", conflictingResponse.Code, conflictingResponse.Body.String())
	}

	firstResponse := agentJSONRequest(t, server, "/v1/code/next", CodeRunNextRequest{
		Root: root, ID: started.ID, WaitMs: 5_000,
	})
	if firstResponse.Code != http.StatusOK {
		t.Fatalf("first code poll status = %d: %s", firstResponse.Code, firstResponse.Body.String())
	}
	var first CodeRunNextResponse
	if err := json.Unmarshal(firstResponse.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if len(first.Events) != 1 || first.Events[0].Type != "tool_call" {
		t.Fatalf("first code poll = %#v", first)
	}
	call := first.Events[0]
	if call.CallID == 0 || call.Global != "tools" || call.Name != "echo" {
		t.Fatalf("tool call = %#v", call)
	}
	replyResponse := agentJSONRequest(t, server, "/v1/code/reply", CodeRunReplyRequest{
		Root: root, ID: started.ID, CallID: call.CallID, OK: true, Value: json.RawMessage(`{"value":41}`),
	})
	if replyResponse.Code != http.StatusOK || replyResponse.Body.String() != "{\"accepted\":true}\n" {
		t.Fatalf("code reply = %d %s", replyResponse.Code, replyResponse.Body.String())
	}
	finishedResponse := agentJSONRequest(t, server, "/v1/code/next", CodeRunNextRequest{
		Root: root, ID: started.ID, After: first.Cursor, WaitMs: 5_000,
	})
	if finishedResponse.Code != http.StatusOK {
		t.Fatalf("final code poll status = %d: %s", finishedResponse.Code, finishedResponse.Body.String())
	}
	var finished CodeRunNextResponse
	if err := json.Unmarshal(finishedResponse.Body.Bytes(), &finished); err != nil {
		t.Fatal(err)
	}
	for !finished.Done {
		finishedResponse = agentJSONRequest(t, server, "/v1/code/next", CodeRunNextRequest{
			Root: root, ID: started.ID, After: finished.Cursor, WaitMs: 5_000,
		})
		if finishedResponse.Code != http.StatusOK {
			t.Fatalf("continued final poll status = %d: %s", finishedResponse.Code, finishedResponse.Body.String())
		}
		if err := json.Unmarshal(finishedResponse.Body.Bytes(), &finished); err != nil {
			t.Fatal(err)
		}
	}
	if len(finished.Events) == 0 {
		t.Fatalf("terminal code poll = %#v", finished)
	}
	terminal := finished.Events[len(finished.Events)-1]
	if terminal.Type != "done" || terminal.Error != nil {
		t.Fatalf("terminal event = %#v", terminal)
	}
	requireCodeJSON(t, terminal.Value, `42`)
	if len(terminal.Logs) != 1 || terminal.Logs[0] != "ready" {
		t.Fatalf("terminal logs = %#v", terminal.Logs)
	}

	missing := agentJSONRequest(t, server, "/v1/code/next", CodeRunNextRequest{ID: "missing", WaitMs: 1})
	if missing.Code != http.StatusNotFound || responseErrorCode(t, missing) != "code-session-not-found" {
		t.Fatalf("missing code session = %d %s", missing.Code, missing.Body.String())
	}
	unknownCall := agentJSONRequest(t, server, "/v1/code/reply", CodeRunReplyRequest{
		Root: root, ID: started.ID, CallID: call.CallID + 1, OK: true, Value: json.RawMessage(`null`),
	})
	if unknownCall.Code != http.StatusConflict || responseErrorCode(t, unknownCall) != "code-call-not-pending" {
		t.Fatalf("unknown code call = %d %s", unknownCall.Code, unknownCall.Body.String())
	}
}

func TestCodeRunRoutesCancelAndServerShutdownAbortRuns(t *testing.T) {
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })
	root := t.TempDir()
	startedResponse := agentJSONRequest(t, server, "/v1/code/start", CodeRunStartRequest{
		Root:             root,
		Program:          `await tools.wait({}); return "unreachable"`,
		Bindings:         []CodeBindingNamespace{{Global: "tools", Names: []string{"wait"}}},
		ComputeMs:        1_000,
		MemoryLimitBytes: defaultCodeMemoryLimitBytes,
		StartNonce:       "10000000000000000000000000000002",
	})
	if startedResponse.Code != http.StatusOK {
		t.Fatalf("code start status = %d: %s", startedResponse.Code, startedResponse.Body.String())
	}
	var started CodeRunStartResponse
	if err := json.Unmarshal(startedResponse.Body.Bytes(), &started); err != nil {
		t.Fatal(err)
	}
	firstResponse := agentJSONRequest(t, server, "/v1/code/next", CodeRunNextRequest{Root: root, ID: started.ID, WaitMs: 5_000})
	if firstResponse.Code != http.StatusOK {
		t.Fatalf("first code poll status = %d: %s", firstResponse.Code, firstResponse.Body.String())
	}
	var first CodeRunNextResponse
	if err := json.Unmarshal(firstResponse.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if len(first.Events) != 1 || first.Events[0].Type != "tool_call" {
		t.Fatalf("first code poll = %#v", first)
	}
	canceled := agentJSONRequest(t, server, "/v1/code/cancel", CodeRunCancelRequest{Root: root, ID: started.ID})
	if canceled.Code != http.StatusOK || canceled.Body.String() != "{\"accepted\":true}\n" {
		t.Fatalf("code cancel = %d %s", canceled.Code, canceled.Body.String())
	}
	if session := server.codeRuns.session(started.ID); session == nil {
		t.Fatal("canceled session disappeared before its terminal event could be replayed")
	} else {
		select {
		case <-session.terminalDone:
		default:
			t.Fatal("cancel accepted before the terminal event was collected")
		}
	}
	terminalResponse := agentJSONRequest(t, server, "/v1/code/next", CodeRunNextRequest{Root: root, ID: started.ID, After: first.Cursor, WaitMs: 5_000})
	if terminalResponse.Code != http.StatusOK {
		t.Fatalf("cancel terminal status = %d: %s", terminalResponse.Code, terminalResponse.Body.String())
	}
	var terminal CodeRunNextResponse
	if err := json.Unmarshal(terminalResponse.Body.Bytes(), &terminal); err != nil {
		t.Fatal(err)
	}
	if !terminal.Done || len(terminal.Events) == 0 || terminal.Events[len(terminal.Events)-1].Error == nil || terminal.Events[len(terminal.Events)-1].Error.Kind != "abort" {
		t.Fatalf("cancel terminal = %#v", terminal)
	}

	secondStarted := agentJSONRequest(t, server, "/v1/code/start", CodeRunStartRequest{
		Program:          `await tools.wait({}); return "unreachable"`,
		Bindings:         []CodeBindingNamespace{{Global: "tools", Names: []string{"wait"}}},
		ComputeMs:        1_000,
		MemoryLimitBytes: defaultCodeMemoryLimitBytes,
		StartNonce:       "10000000000000000000000000000003",
	})
	if secondStarted.Code != http.StatusOK {
		t.Fatalf("second code start status = %d: %s", secondStarted.Code, secondStarted.Body.String())
	}
	var second CodeRunStartResponse
	if err := json.Unmarshal(secondStarted.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	secondSession := server.codeRuns.session(second.ID)
	if secondSession == nil {
		t.Fatal("second code session was not registered")
	}
	if err := server.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case <-secondSession.collectorDone:
		terminal := secondSession.next(context.Background(), 0, time.Second)
		if len(terminal.Events) == 0 || terminal.Events[len(terminal.Events)-1].Error == nil || terminal.Events[len(terminal.Events)-1].Error.Kind != "abort" {
			t.Fatalf("shutdown terminal = %#v", terminal)
		}
	case <-time.After(time.Second):
		t.Fatal("server shutdown did not collect the code terminal event")
	}
	missingAfterShutdown := agentJSONRequest(t, server, "/v1/code/cancel", CodeRunCancelRequest{ID: second.ID})
	if missingAfterShutdown.Code != http.StatusNotFound || responseErrorCode(t, missingAfterShutdown) != "code-session-not-found" {
		t.Fatalf("shutdown session = %d %s", missingAfterShutdown.Code, missingAfterShutdown.Body.String())
	}
}

func TestCodeRunStartRouteReturnsCapacityStatus(t *testing.T) {
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	sessions, err := NewCodeRunSessions(CodeRunSessionsOptions{
		MaxSessions: 1,
		RunnerOptions: CodeRunnerOptions{
			DefaultTimeout: time.Second, MaxTimeout: time.Second, MaxOutputBytes: 1 << 20,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	server.codeRuns = sessions
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })
	missingLimit := agentJSONRequest(t, server, "/v1/code/start", CodeRunStartRequest{Program: `return 1`})
	if missingLimit.Code != http.StatusBadRequest || responseErrorCode(t, missingLimit) != "invalid-code-request" {
		t.Fatalf("missing memory limit = %d %s", missingLimit.Code, missingLimit.Body.String())
	}
	invalidNonce := agentJSONRequest(t, server, "/v1/code/start", CodeRunStartRequest{Program: `return 1`, ComputeMs: 1_000, MemoryLimitBytes: defaultCodeMemoryLimitBytes, StartNonce: "bad"})
	if invalidNonce.Code != http.StatusBadRequest || responseErrorCode(t, invalidNonce) != "invalid-code-request" {
		t.Fatalf("invalid start nonce = %d %s", invalidNonce.Code, invalidNonce.Body.String())
	}
	for _, rawMemory := range []string{"0", "-1", "1.5", "1e3", "2147483649", "9007199254740992"} {
		body := `{"program":"return 1","computeMs":1000,"memoryLimitBytes":` + rawMemory + `,"startNonce":"1000000000000000000000000000000a"}`
		response := agentRequest(server, http.MethodPost, "/v1/code/start", body)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("memoryLimitBytes %s = %d %s", rawMemory, response.Code, response.Body.String())
		}
	}
	first := agentJSONRequest(t, server, "/v1/code/start", CodeRunStartRequest{Program: `await tools.wait({})`, Bindings: []CodeBindingNamespace{{Global: "tools", Names: []string{"wait"}}}, ComputeMs: 1_000, MemoryLimitBytes: defaultCodeMemoryLimitBytes, StartNonce: "10000000000000000000000000000004"})
	if first.Code != http.StatusOK {
		t.Fatalf("first code start = %d %s", first.Code, first.Body.String())
	}
	second := agentJSONRequest(t, server, "/v1/code/start", CodeRunStartRequest{Program: `return 2`, ComputeMs: 1_000, MemoryLimitBytes: defaultCodeMemoryLimitBytes, StartNonce: "10000000000000000000000000000005"})
	if second.Code != http.StatusTooManyRequests || responseErrorCode(t, second) != "code-session-limit" {
		t.Fatalf("capacity code start = %d %s", second.Code, second.Body.String())
	}
}

func TestCodeRunSessionsRejectCrossRootAccess(t *testing.T) {
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })
	ownerRoot := t.TempDir()
	foreignRoot := t.TempDir()
	started := agentJSONRequest(t, server, "/v1/code/start", CodeRunStartRequest{
		Root: ownerRoot, Program: `await tools.wait({})`,
		Bindings:         []CodeBindingNamespace{{Global: "tools", Names: []string{"wait"}}},
		ComputeMs:        1_000,
		MemoryLimitBytes: defaultCodeMemoryLimitBytes,
		StartNonce:       "10000000000000000000000000000006",
	})
	if started.Code != http.StatusOK {
		t.Fatalf("code start = %d %s", started.Code, started.Body.String())
	}
	var response CodeRunStartResponse
	if err := json.Unmarshal(started.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	for _, request := range []struct {
		path string
		body any
	}{
		{"/v1/code/next", CodeRunNextRequest{Root: foreignRoot, ID: response.ID, WaitMs: 1}},
		{"/v1/code/reply", CodeRunReplyRequest{Root: foreignRoot, ID: response.ID, CallID: 1, OK: true, Value: json.RawMessage(`null`)}},
		{"/v1/code/cancel", CodeRunCancelRequest{Root: foreignRoot, ID: response.ID}},
	} {
		got := agentJSONRequest(t, server, request.path, request.body)
		if got.Code != http.StatusNotFound || responseErrorCode(t, got) != "code-session-not-found" {
			t.Fatalf("cross-root %s = %d %s", request.path, got.Code, got.Body.String())
		}
	}
	if canceled := agentJSONRequest(t, server, "/v1/code/cancel", CodeRunCancelRequest{Root: ownerRoot, ID: response.ID}); canceled.Code != http.StatusOK {
		t.Fatalf("owner cancel = %d %s", canceled.Code, canceled.Body.String())
	}
}

func TestCodeRunSessionsKeepLaunchOwnerAfterRootAliasChanges(t *testing.T) {
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })
	realRoot := t.TempDir()
	aliasParent := t.TempDir()
	aliasRoot := filepath.Join(aliasParent, "workspace")
	if err := os.Symlink(realRoot, aliasRoot); err != nil {
		t.Fatal(err)
	}
	started := agentJSONRequest(t, server, "/v1/code/start", CodeRunStartRequest{
		Root: aliasRoot, Program: `await tools.wait({})`,
		Bindings:         []CodeBindingNamespace{{Global: "tools", Names: []string{"wait"}}},
		ComputeMs:        1_000,
		MemoryLimitBytes: defaultCodeMemoryLimitBytes,
		StartNonce:       "10000000000000000000000000000007",
	})
	if started.Code != http.StatusOK {
		t.Fatalf("code start = %d %s", started.Code, started.Body.String())
	}
	var startResponse CodeRunStartResponse
	if err := json.Unmarshal(started.Body.Bytes(), &startResponse); err != nil {
		t.Fatal(err)
	}
	for _, request := range []struct {
		path string
		body any
	}{
		{"/v1/code/next", CodeRunNextRequest{Root: realRoot, ID: startResponse.ID, WaitMs: 1}},
		{"/v1/code/cancel", CodeRunCancelRequest{Root: realRoot, ID: startResponse.ID}},
	} {
		got := agentJSONRequest(t, server, request.path, request.body)
		if got.Code != http.StatusNotFound || responseErrorCode(t, got) != "code-session-not-found" {
			t.Fatalf("canonical-root %s = %d %s", request.path, got.Code, got.Body.String())
		}
	}
	if err := os.Remove(aliasRoot); err != nil {
		t.Fatal(err)
	}
	if owner := agentJSONRequest(t, server, "/v1/code/next", CodeRunNextRequest{
		Root: aliasRoot, ID: startResponse.ID, WaitMs: 1,
	}); owner.Code != http.StatusOK {
		t.Fatalf("owner next after alias removal = %d %s", owner.Code, owner.Body.String())
	}
	canceled := agentJSONRequest(t, server, "/v1/code/cancel", CodeRunCancelRequest{Root: aliasRoot, ID: startResponse.ID})
	if canceled.Code != http.StatusOK {
		t.Fatalf("owner cancel after alias removal = %d %s", canceled.Code, canceled.Body.String())
	}
}

func TestResolveCanonicalizesExistingPathsAndAcceptsRoot(t *testing.T) {
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	realRoot := t.TempDir()
	linkRoot := filepath.Join(t.TempDir(), "workspace-link")
	if err := os.Symlink(realRoot, linkRoot); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	response := agentJSONRequest(t, server, "/v1/resolve", ResolveRequest{Path: linkRoot})
	if response.Code != http.StatusOK {
		t.Fatalf("resolve status = %d: %s", response.Code, response.Body.String())
	}
	var resolved ResolveResponse
	if err := json.Unmarshal(response.Body.Bytes(), &resolved); err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(realRoot)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Path != canonical {
		t.Fatalf("resolved path = %q, want %q", resolved.Path, canonical)
	}
	response = agentJSONRequest(t, server, "/v1/stat", StatRequest{Root: canonical, Path: canonical})
	if response.Code != http.StatusOK {
		t.Fatalf("root-scoped stat status = %d: %s", response.Code, response.Body.String())
	}
}

func TestScopedRoutesRejectSymlinkEscapes(t *testing.T) {
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.bin")
	if err := os.WriteFile(secret, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	read := agentJSONRequest(t, server, "/v1/read_file", ReadRequest{
		Root: root, Path: filepath.Join(link, "secret.bin"),
	})
	if read.Code != http.StatusForbidden || responseErrorCode(t, read) != "outside-root" {
		t.Fatalf("escape read = %d %s", read.Code, read.Body.String())
	}
	created := filepath.Join(outside, "created.txt")
	write := agentJSONRequest(t, server, "/v1/update_file", WriteRequest{
		Root: root, Path: filepath.Join(link, "created.txt"), Content: "blocked",
	})
	if write.Code != http.StatusForbidden || responseErrorCode(t, write) != "outside-root" {
		t.Fatalf("escape write = %d %s", write.Code, write.Body.String())
	}
	if _, err := os.Stat(created); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("escaped write created %q", created)
	}
}

func TestReadBytesRoundTripAndRootlessDirectoryBrowse(t *testing.T) {
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	data := []byte{0x00, 0x01, 0x7f, 0x80, 0xff}
	path := filepath.Join(root, "binary.dat")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	response := agentJSONRequest(t, server, "/v1/read_bytes", ReadRequest{Root: root, Path: path, MaxBytes: 32})
	if response.Code != http.StatusOK {
		t.Fatalf("read bytes status = %d: %s", response.Code, response.Body.String())
	}
	var read ReadBytesResponse
	if err := json.Unmarshal(response.Body.Bytes(), &read); err != nil {
		t.Fatal(err)
	}
	if read.ContentBase64 != base64.StdEncoding.EncodeToString(data) || read.Version == "" {
		t.Fatalf("read bytes = %#v", read)
	}
	browse := agentJSONRequest(t, server, "/v1/directories", ListRequest{Path: root})
	if browse.Code != http.StatusOK {
		t.Fatalf("rootless browse status = %d: %s", browse.Code, browse.Body.String())
	}
	insideLink := filepath.Join(root, "inside-link")
	outsideLink := filepath.Join(root, "outside-link")
	outsideTarget := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outsideTarget, []byte("outside-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(path, insideLink); err == nil {
		if err := os.Symlink(outsideTarget, outsideLink); err != nil {
			t.Fatal(err)
		}
		browse = agentJSONRequest(t, server, "/v1/directories", ListRequest{Root: root, Path: root})
		if browse.Code != http.StatusOK {
			t.Fatalf("symlink browse status = %d: %s", browse.Code, browse.Body.String())
		}
		var listing ListResponse
		if err := json.Unmarshal(browse.Body.Bytes(), &listing); err != nil {
			t.Fatal(err)
		}
		canonicalRoot, err := filepath.EvalSymlinks(root)
		if err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"inside-link", "outside-link"} {
			found := false
			for _, entry := range listing.Entries {
				if entry.Name == name {
					found = true
					if entry.Type != "other" || !pathWithin(canonicalRoot, entry.Path) {
						t.Fatalf("symlink entry = %#v", entry)
					}
				}
			}
			if !found {
				t.Fatalf("missing symlink entry %q", name)
			}
		}
	}
}

func TestReadRejectsOversizedFileBeforeBuffering(t *testing.T) {
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	path := filepath.Join(root, "large.bin")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(maxFileBytes + 1); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	response := agentJSONRequest(t, server, "/v1/read_bytes", ReadRequest{Root: root, Path: path})
	if response.Code != http.StatusRequestEntityTooLarge || responseErrorCode(t, response) != "too-large" {
		t.Fatalf("oversized read = %d %s", response.Code, response.Body.String())
	}
}

func TestSearchGlobAndGrepStayScopedAndStable(t *testing.T) {
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	nested := filepath.Join(root, "nested")
	if err := os.Mkdir(nested, 0o700); err != nil {
		t.Fatal(err)
	}
	for path, content := range map[string]string{
		filepath.Join(root, "new.ts"):          "export const newest = true\n",
		filepath.Join(nested, "old.ts"):        "export const oldest = true\n",
		filepath.Join(root, "first.txt"):       "before\nneedle one\nafter\n",
		filepath.Join(nested, "second.md"):     "needle two\n",
		filepath.Join(root, ".git", "skip.ts"): "needle hidden\n",
	} {
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	older := time.Now().Add(-time.Hour)
	if err := os.Chtimes(filepath.Join(nested, "old.ts"), older, older); err != nil {
		t.Fatal(err)
	}
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}

	glob := agentJSONRequest(t, server, "/v1/search", SearchRequest{
		Root: root, Kind: "glob", Pattern: "**/*.ts",
	})
	if glob.Code != http.StatusOK {
		t.Fatalf("glob status = %d: %s", glob.Code, glob.Body.String())
	}
	var globResult SearchResponse
	if err := json.Unmarshal(glob.Body.Bytes(), &globResult); err != nil {
		t.Fatal(err)
	}
	if globResult.Root != canonicalRoot || !reflect.DeepEqual(globResult.Paths, []string{"new.ts", "nested/old.ts"}) || globResult.Truncated {
		t.Fatalf("glob result = %#v", globResult)
	}
	basename := agentJSONRequest(t, server, "/v1/search", SearchRequest{
		Root: root, Kind: "glob", Pattern: "*.ts",
	})
	if basename.Code != http.StatusOK {
		t.Fatalf("basename glob status = %d: %s", basename.Code, basename.Body.String())
	}
	var basenameResult SearchResponse
	if err := json.Unmarshal(basename.Body.Bytes(), &basenameResult); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(basenameResult.Paths, globResult.Paths) {
		t.Fatalf("basename glob = %#v, want %#v", basenameResult.Paths, globResult.Paths)
	}

	grep := agentJSONRequest(t, server, "/v1/search", SearchRequest{
		Root: root, Kind: "grep", Pattern: "needle", Include: "*.{txt,md}",
	})
	if grep.Code != http.StatusOK {
		t.Fatalf("grep status = %d: %s", grep.Code, grep.Body.String())
	}
	var grepResult SearchResponse
	if err := json.Unmarshal(grep.Body.Bytes(), &grepResult); err != nil {
		t.Fatal(err)
	}
	wantMatches := []SearchMatch{
		{Path: "first.txt", LineNumber: 2, Line: "needle one"},
		{Path: "nested/second.md", LineNumber: 1, Line: "needle two"},
	}
	if !reflect.DeepEqual(grepResult.Matches, wantMatches) || grepResult.Truncated {
		t.Fatalf("grep result = %#v", grepResult)
	}
}

func TestSearchRejectsEscapesInvalidPatternsAndCancellation(t *testing.T) {
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	escape := agentJSONRequest(t, server, "/v1/search", SearchRequest{
		Root: root, Path: "escape", Kind: "glob", Pattern: "*",
	})
	if escape.Code != http.StatusForbidden || responseErrorCode(t, escape) != "outside-root" {
		t.Fatalf("escaped search = %d %s", escape.Code, escape.Body.String())
	}
	missingRoot := agentJSONRequest(t, server, "/v1/search", SearchRequest{Kind: "glob", Pattern: "*"})
	if missingRoot.Code != http.StatusBadRequest || responseErrorCode(t, missingRoot) != "invalid-root" {
		t.Fatalf("missing root search = %d %s", missingRoot.Code, missingRoot.Body.String())
	}
	for _, request := range []SearchRequest{
		{Root: root, Kind: "glob", Pattern: "["},
		{Root: root, Kind: "grep", Pattern: "["},
		{Root: root, Kind: "grep", Pattern: "x", Include: "!*.ts"},
		{Root: root, Kind: "grep", Pattern: "x", Include: "*.ts,*.tsx"},
	} {
		response := agentJSONRequest(t, server, "/v1/search", request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid search %#v = %d %s", request, response.Code, response.Body.String())
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = searchWorkspace(ctx, SearchRequest{Root: root, Kind: "glob", Pattern: "*"})
	var failure *agentFailure
	if !errors.As(err, &failure) || failure.code != "request-canceled" {
		t.Fatalf("canceled search error = %#v", err)
	}
}

func TestSearchReportsResultFileAndResponseBounds(t *testing.T) {
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	for _, name := range []string{"a.txt", "b.txt", "long.txt"} {
		content := "needle\n"
		if name == "long.txt" {
			content = strings.Repeat("x", 2048) + " needle\n"
		}
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	resultBound := agentJSONRequest(t, server, "/v1/search", SearchRequest{
		Root: root, Kind: "grep", Pattern: "needle", MaxResults: 1,
	})
	if resultBound.Code != http.StatusOK {
		t.Fatalf("result bound status = %d: %s", resultBound.Code, resultBound.Body.String())
	}
	var resultBoundValue SearchResponse
	if err := json.Unmarshal(resultBound.Body.Bytes(), &resultBoundValue); err != nil {
		t.Fatal(err)
	}
	if len(resultBoundValue.Matches) != 1 || !containsSearchTruncation(resultBoundValue.TruncatedBy, "results") {
		t.Fatalf("result bound = %#v", resultBoundValue)
	}
	fileBound := agentJSONRequest(t, server, "/v1/search", SearchRequest{
		Root: root, Kind: "glob", Pattern: "*", MaxFiles: 1,
	})
	if fileBound.Code != http.StatusOK {
		t.Fatalf("file bound status = %d: %s", fileBound.Code, fileBound.Body.String())
	}
	var fileBoundValue SearchResponse
	if err := json.Unmarshal(fileBound.Body.Bytes(), &fileBoundValue); err != nil {
		t.Fatal(err)
	}
	if !fileBoundValue.Truncated || !containsSearchTruncation(fileBoundValue.TruncatedBy, "files") {
		t.Fatalf("file bound = %#v", fileBoundValue)
	}
	byteBound := agentJSONRequest(t, server, "/v1/search", SearchRequest{
		Root: root, Path: "long.txt", Kind: "grep", Pattern: "needle", MaxBytes: 800,
	})
	if byteBound.Code != http.StatusOK {
		t.Fatalf("byte bound status = %d: %s", byteBound.Code, byteBound.Body.String())
	}
	if byteBound.Body.Len() > 800 {
		t.Fatalf("byte bound response = %d bytes, want <= 800", byteBound.Body.Len())
	}
	var byteBoundValue SearchResponse
	if err := json.Unmarshal(byteBound.Body.Bytes(), &byteBoundValue); err != nil {
		t.Fatal(err)
	}
	if len(byteBoundValue.Matches) != 0 || !byteBoundValue.Truncated || !containsSearchTruncation(byteBoundValue.TruncatedBy, "bytes") {
		t.Fatalf("byte bound = %#v", byteBoundValue)
	}
}

func TestAtomicWriteUsesContentVersionAndPreservesMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "document.txt")
	if err := os.WriteFile(path, []byte("first"), 0o640); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	observed, err := version(path, info)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("other"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	_, err = atomicWrite(path, "updated", &WriteExpectation{Kind: "replaceIfVersion", Version: observed})
	var failure *agentFailure
	if !errors.As(err, &failure) || failure.code != "stale-version" {
		t.Fatalf("content-only change error = %#v, want stale-version", err)
	}
	current, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	currentVersion, err := version(path, current)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := atomicWrite(path, "updated", &WriteExpectation{Kind: "replaceIfVersion", Version: currentVersion}); err != nil {
		t.Fatal(err)
	}
	updated, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Mode().Perm() != 0o640 {
		t.Fatalf("mode = %o, want 640", updated.Mode().Perm())
	}
}

func TestAtomicCreateIfAbsentPublishesWithoutReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "created.txt")
	const writers = 16
	start := make(chan struct{})
	results := make(chan error, writers)
	var group sync.WaitGroup
	for index := 0; index < writers; index++ {
		group.Add(1)
		go func(value string) {
			defer group.Done()
			<-start
			_, err := atomicWrite(path, value, &WriteExpectation{Kind: "createIfAbsent"})
			results <- err
		}(string(rune('a' + index)))
	}
	close(start)
	group.Wait()
	close(results)
	succeeded := 0
	for err := range results {
		if err == nil {
			succeeded++
			continue
		}
		var failure *agentFailure
		if !errors.As(err, &failure) || failure.code != "not-observed" {
			t.Fatalf("create race error = %#v", err)
		}
	}
	if succeeded != 1 {
		t.Fatalf("successful creates = %d, want 1", succeeded)
	}
	content, err := os.ReadFile(path)
	if err != nil || len(content) != 1 {
		t.Fatalf("created content = %q, err = %v", content, err)
	}
}

func TestAtomicWriteChecksResponseBudgetAndCancellationBeforePublish(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "large.txt")
	original := strings.Repeat("\t", maxFileBytes)
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := atomicWrite(path, strings.Repeat("\n", maxFileBytes), nil)
	var failure *agentFailure
	if !errors.As(err, &failure) || failure.code != "response-too-large" {
		t.Fatalf("response budget error = %#v", err)
	}
	stored, err := os.ReadFile(path)
	if err != nil || string(stored) != original {
		t.Fatalf("oversized response changed file: len = %d, err = %v", len(stored), err)
	}
	canceledPath := filepath.Join(root, "canceled.txt")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = atomicWriteContext(ctx, canceledPath, "blocked", nil)
	if !errors.As(err, &failure) || failure.code != "request-canceled" {
		t.Fatalf("canceled write error = %#v", err)
	}
	if _, err := os.Stat(canceledPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("canceled write published %q", canceledPath)
	}
}

func TestEditNormalizesMatchingAndRestoresCRLF(t *testing.T) {
	path := filepath.Join(t.TempDir(), "document.txt")
	if err := os.WriteFile(path, []byte("a\r\nOLD\r\nb\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := editFile(context.Background(), path, EditRequest{
		OldString: "OLD\n", NewString: "NEW\r\n", ReplaceAll: false,
	}, func() (string, error) { return path, nil })
	if err != nil {
		t.Fatal(err)
	}
	if result.Before != "a\nOLD\nb\n" || result.After != "a\nNEW\nb\n" {
		t.Fatalf("edit result = %#v", result)
	}
	stored, err := os.ReadFile(path)
	if err != nil || string(stored) != "a\r\nNEW\r\nb\r\n" {
		t.Fatalf("stored edit = %q, err = %v", stored, err)
	}
}

func TestListDirectoryFailsClosedAtItemLimit(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	_, err := listDirectory(root, 2)
	var failure *agentFailure
	if !errors.As(err, &failure) || failure.code != "too-many-entries" {
		t.Fatalf("directory limit error = %#v", err)
	}
}

func TestRemoteBashScrubsAmbientSecretsAndReportsSignalsAndTimeouts(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash is unavailable")
	}
	t.Setenv("DEEPSEEK_API_KEY", "ambient-key")
	t.Setenv("DSH_REMOTE_BRIDGE_TOKEN", "ambient-token")
	root := t.TempDir()
	result, err := executeCommand(context.Background(), root, ExecRequest{
		Shell:   "bash",
		Command: `printf '%s|%s|%s' "${DEEPSEEK_API_KEY-unset}" "${DSH_REMOTE_BRIDGE_TOKEN-unset}" "$EXPLICIT_TOKEN"`,
		Env:     map[string]string{"EXPLICIT_TOKEN": "allowed"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Stdout != "unset|unset|allowed" || result.ExitCode == nil || *result.ExitCode != 0 {
		t.Fatalf("scrub result = %#v", result)
	}
	if runtime.GOOS != "windows" {
		signaled, err := executeCommand(context.Background(), root, ExecRequest{Shell: "bash", Command: "kill -TERM $$"})
		if err != nil {
			t.Fatal(err)
		}
		if signaled.ExitCode != nil || signaled.Signal != "SIGTERM" {
			t.Fatalf("signal result = %#v", signaled)
		}
	}
	timedOut, err := executeCommand(context.Background(), root, ExecRequest{
		Shell: "bash", Command: "printf before; sleep 5", TimeoutMs: 50,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !timedOut.TimedOut || timedOut.Signal != "SIGKILL" || timedOut.ExitCode != nil || timedOut.Stdout != "before" {
		t.Fatalf("timeout result = %#v", timedOut)
	}
	largeTimeout, err := executeCommand(context.Background(), root, ExecRequest{
		Shell: "bash", Command: "true", TimeoutMs: int(^uint(0) >> 1),
	})
	if err != nil || largeTimeout.TimedOut || largeTimeout.ExitCode == nil || *largeTimeout.ExitCode != 0 {
		t.Fatalf("large timeout result = %#v, err = %v", largeTimeout, err)
	}
}

func TestRemoteBashRequiresBashAndKeepsUTF8Tail(t *testing.T) {
	_, err := executeCommand(context.Background(), t.TempDir(), ExecRequest{Shell: "sh", Command: "true"})
	var failure *agentFailure
	if !errors.As(err, &failure) || failure.code != "unsupported-shell" {
		t.Fatalf("shell error = %#v", err)
	}
	buffer := &limitedBuffer{limit: 5}
	_, _ = buffer.Write([]byte("ab世界"))
	if !buffer.truncated || buffer.String() != "界" {
		t.Fatalf("UTF-8 tail = %q, truncated = %v", buffer.String(), buffer.truncated)
	}
}

func TestRemoteBashReportsMissingBash(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	_, err := executeCommand(context.Background(), t.TempDir(), ExecRequest{Shell: "bash", Command: "true"})
	var failure *agentFailure
	if !errors.As(err, &failure) || failure.code != "shell-unavailable" {
		t.Fatalf("missing bash error = %#v", err)
	}
}
