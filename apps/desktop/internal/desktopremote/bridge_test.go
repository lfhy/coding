package desktopremote

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/deepseek-ai/coding/apps/desktop/internal/remoteagent"
)

type remoteBridgeTestMarker struct {
	root       string
	remoteRoot string
	connection string
	generation uint64
}

func publishRemoteBridgeTestMarker(t *testing.T, bridge *Bridge, connection string, previous uint64) remoteBridgeTestMarker {
	t.Helper()
	marker := remoteBridgeTestMarker{root: t.TempDir(), remoteRoot: "/remote/project", connection: connection}
	generation, err := bridge.PublishMarker(context.Background(), marker.root, marker.remoteRoot, marker.connection, previous, func(uint64) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	marker.generation = generation
	return marker
}

func setRemoteBridgeMarkerHeaders(request *http.Request, marker remoteBridgeTestMarker, cleanup bool) {
	request.Header.Set("X-Coding-Remote-Connection", marker.connection)
	request.Header.Set(remoteBridgeMarkerRootHeader, marker.root)
	request.Header.Set(remoteBridgeMarkerGenerationHeader, strconv.FormatUint(marker.generation, 10))
	request.Header.Set(remoteBridgeRemoteRootHeader, marker.remoteRoot)
	if cleanup {
		request.Header.Set(remoteBridgeCleanupHeader, "1")
	}
}

func TestSharedBridgeRejectsUnauthenticatedAndUnroutableRequests(t *testing.T) {
	var calls atomic.Int32
	bridge, err := NewBridge("abcdefghijklmnopqrstuvwxyz0123456789abcdef", func(context.Context, string, string, string, []byte) (int, []byte, error) {
		calls.Add(1)
		return http.StatusOK, []byte(`{"ok":true}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bridge.Close() })
	for _, request := range []*http.Request{
		httptest.NewRequest(http.MethodPost, "/v1/read_file", nil),
		func() *http.Request {
			request := httptest.NewRequest(http.MethodPost, "/v1/read_file", nil)
			request.Header.Set("Authorization", "abcdefghijklmnopqrstuvwxyz0123456789abcdef")
			return request
		}(),
		func() *http.Request {
			request := httptest.NewRequest(http.MethodPost, "/v1/shutdown", nil)
			request.Header.Set("Authorization", "Bearer abcdefghijklmnopqrstuvwxyz0123456789abcdef")
			return request
		}(),
	} {
		response := httptest.NewRecorder()
		bridge.serveHTTP(response, request)
		if response.Code == http.StatusOK {
			t.Fatalf("unexpected success for %s %s", request.Method, request.URL.Path)
		}
	}
	if calls.Load() != 0 {
		t.Fatalf("proxy calls = %d, want 0", calls.Load())
	}
}

func TestRemoteBridgeRejectsSpoofedJSONTypeAndRemovedRoutes(t *testing.T) {
	const token = "abcdefghijklmnopqrstuvwxyz0123456789abcdef"
	var calls atomic.Int32
	bridge, err := NewBridge(token, func(context.Context, string, string, string, []byte) (int, []byte, error) {
		calls.Add(1)
		return http.StatusOK, []byte(`{"ok":true}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bridge.Close() })
	for _, requestPath := range []string{"/v1/health", "/v1/node", "/v1/list_files", "/v1/shutdown"} {
		request := httptest.NewRequest(http.MethodPost, requestPath, strings.NewReader(`{}`))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Coding-Remote-Connection", "connection-1")
		response := httptest.NewRecorder()
		bridge.serveHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d", requestPath, response.Code)
		}
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/read_file", strings.NewReader(`{}`))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json-evil")
	request.Header.Set("X-Coding-Remote-Connection", "connection-1")
	response := httptest.NewRecorder()
	bridge.serveHTTP(response, request)
	if response.Code != http.StatusUnsupportedMediaType || calls.Load() != 0 {
		t.Fatalf("spoofed content type status = %d, calls = %d", response.Code, calls.Load())
	}
}

func TestRemoteBridgeAllowsRemoteExecutionOnlyAsPost(t *testing.T) {
	for _, path := range []string{
		"/v1/search", "/v1/code/start", "/v1/code/next", "/v1/code/reply", "/v1/code/cancel",
		"/v1/terminals/start", "/v1/terminals/read", "/v1/terminals/write", "/v1/terminals/resize", "/v1/terminals/foreground", "/v1/terminals/signal", "/v1/terminals/terminate",
		"/v1/processes/resolve", "/v1/processes/start", "/v1/processes/read", "/v1/processes/write", "/v1/processes/wait", "/v1/processes/kill",
	} {
		if !allowedBridgeRoute(http.MethodPost, path) {
			t.Fatalf("POST %s was rejected", path)
		}
		if allowedBridgeRoute(http.MethodGet, path) {
			t.Fatalf("GET %s was accepted", path)
		}
	}
}

func TestRemoteBridgeBasicModeBindsRootBeforeProxy(t *testing.T) {
	const token = "abcdefghijklmnopqrstuvwxyz0123456789abcdef"
	var calls atomic.Int32
	bridge, err := NewBridge(token, func(context.Context, string, string, string, []byte) (int, []byte, error) {
		calls.Add(1)
		return http.StatusOK, []byte(`{"ok":true}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bridge.Close() })
	mode := remoteagent.ModeBasic
	bridge.connection = func(string) (remoteagent.ConnectionInfo, error) {
		return remoteagent.ConnectionInfo{Mode: mode}, nil
	}
	marker := publishRemoteBridgeTestMarker(t, bridge, "connection-1", 0)
	requestFor := func(route, body string, marker remoteBridgeTestMarker) *http.Request {
		request := httptest.NewRequest(http.MethodPost, route, strings.NewReader(body))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		setRemoteBridgeMarkerHeaders(request, marker, false)
		return request
	}
	for _, route := range []string{"/v1/update_file", "/v1/edit_file", "/v1/search", "/v1/processes/start", "/v1/terminals/start", "/v1/code/start"} {
		response := httptest.NewRecorder()
		bridge.serveHTTP(response, requestFor(route, `{"root":"/remote/project"}`, marker))
		if response.Code != http.StatusOK {
			t.Fatalf("basic %s = %d %s", route, response.Code, response.Body.String())
		}
	}
	const allowed = 6
	for _, body := range []string{`{"root":"/"}`, `{"path":"file"}`, `{"root":"/remote/project/sub"}`} {
		response := httptest.NewRecorder()
		bridge.serveHTTP(response, requestFor("/v1/read_file", body, marker))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("unbound root %s = %d", body, response.Code)
		}
	}
	stale := marker
	stale.generation++
	response := httptest.NewRecorder()
	bridge.serveHTTP(response, requestFor("/v1/read_file", `{"root":"/remote/project"}`, stale))
	if response.Code != http.StatusConflict || calls.Load() != allowed {
		t.Fatalf("stale marker = %d, proxy calls = %d", response.Code, calls.Load())
	}
	response = httptest.NewRecorder()
	bridge.serveHTTP(response, requestFor("/v1/read_file", `{"root":"/remote/project"}`, marker))
	if response.Code != http.StatusOK || calls.Load() != allowed+1 {
		t.Fatalf("bound basic request = %d, proxy calls = %d", response.Code, calls.Load())
	}
	mode = remoteagent.ModeAgent
	response = httptest.NewRecorder()
	bridge.serveHTTP(response, requestFor("/v1/search", `{}`, marker))
	if response.Code != http.StatusOK || calls.Load() != allowed+2 {
		t.Fatalf("agent route = %d, proxy calls = %d", response.Code, calls.Load())
	}
}

func TestRemoteBridgeForwardsVerifiedRequestWithoutToken(t *testing.T) {
	const token = "abcdefghijklmnopqrstuvwxyz0123456789abcdef"
	var gotConnection, gotMethod, gotPath, gotBody string
	bridge, err := NewBridge(token, func(_ context.Context, connection, method, path string, body []byte) (int, []byte, error) {
		gotConnection, gotMethod, gotPath, gotBody = connection, method, path, string(body)
		return http.StatusOK, []byte(`{"path":"/remote/project"}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bridge.Close() })
	marker := publishRemoteBridgeTestMarker(t, bridge, "connection-1", 0)
	request := httptest.NewRequest(http.MethodPost, "/v1/resolve", strings.NewReader(`{"path":"/remote/project"}`))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	setRemoteBridgeMarkerHeaders(request, marker, false)
	response := httptest.NewRecorder()
	bridge.serveHTTP(response, request)
	if response.Code != http.StatusOK || gotConnection != "connection-1" || gotMethod != http.MethodPost || gotPath != "/v1/resolve" || gotBody != `{"path":"/remote/project"}` {
		t.Fatalf("response = %d, proxy = %q %q %q %q", response.Code, gotConnection, gotMethod, gotPath, gotBody)
	}
	body, _ := io.ReadAll(response.Result().Body)
	if string(body) != `{"path":"/remote/project"}` {
		t.Fatalf("body = %q", body)
	}
}

func TestRemoteBridgeAcceptsResponseLargerThanSixteenMiB(t *testing.T) {
	const token = "abcdefghijklmnopqrstuvwxyz0123456789abcdef"
	large := []byte(`{"content":"` + strings.Repeat("a", (17<<20)) + `"}`)
	bridge, err := NewBridge(token, func(context.Context, string, string, string, []byte) (int, []byte, error) {
		return http.StatusOK, large, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bridge.Close() })
	marker := publishRemoteBridgeTestMarker(t, bridge, "connection-1", 0)
	request := httptest.NewRequest(http.MethodPost, "/v1/read_bytes", strings.NewReader(`{"root":"/","path":"file"}`))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json; charset=utf-8")
	setRemoteBridgeMarkerHeaders(request, marker, false)
	response := httptest.NewRecorder()
	bridge.serveHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.Len() != len(large) {
		t.Fatalf("large response = %d bytes, status %d", response.Body.Len(), response.Code)
	}
}

func TestRemoteBridgeRequiresEveryPublishedMarkerIdentityHeader(t *testing.T) {
	const token = "abcdefghijklmnopqrstuvwxyz0123456789abcdef"
	var calls atomic.Int32
	bridge, err := NewBridge(token, func(context.Context, string, string, string, []byte) (int, []byte, error) {
		calls.Add(1)
		return http.StatusOK, []byte(`{"ok":true}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bridge.Close() })
	marker := publishRemoteBridgeTestMarker(t, bridge, "connection-1", 0)
	for _, header := range []string{
		"X-Coding-Remote-Connection", remoteBridgeMarkerRootHeader, remoteBridgeMarkerGenerationHeader, remoteBridgeRemoteRootHeader,
	} {
		request := httptest.NewRequest(http.MethodPost, "/v1/read_file", strings.NewReader(`{"path":"/remote/project/file"}`))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		setRemoteBridgeMarkerHeaders(request, marker, false)
		request.Header.Del(header)
		response := httptest.NewRecorder()
		bridge.serveHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("missing %s status = %d", header, response.Code)
		}
	}
	duplicate := httptest.NewRequest(http.MethodPost, "/v1/read_file", strings.NewReader(`{"path":"/remote/project/file"}`))
	duplicate.Header.Set("Authorization", "Bearer "+token)
	duplicate.Header.Set("Content-Type", "application/json")
	setRemoteBridgeMarkerHeaders(duplicate, marker, false)
	duplicate.Header.Add(remoteBridgeMarkerGenerationHeader, strconv.FormatUint(marker.generation, 10))
	duplicateResponse := httptest.NewRecorder()
	bridge.serveHTTP(duplicateResponse, duplicate)
	if duplicateResponse.Code != http.StatusBadRequest {
		t.Fatalf("duplicate marker generation status = %d", duplicateResponse.Code)
	}
	if calls.Load() != 0 {
		t.Fatalf("proxy calls = %d, want 0", calls.Load())
	}
}

func TestRemoteBridgeRejectsStaleMarkerButAllowsExplicitRetiredCleanup(t *testing.T) {
	const token = "abcdefghijklmnopqrstuvwxyz0123456789abcdef"
	var connections []string
	bridge, err := NewBridge(token, func(_ context.Context, connection, _ string, _ string, _ []byte) (int, []byte, error) {
		connections = append(connections, connection)
		return http.StatusOK, []byte(`{"accepted":true}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bridge.Close() })
	old := publishRemoteBridgeTestMarker(t, bridge, "connection-1", 0)
	newGeneration, err := bridge.PublishMarker(context.Background(), old.root, old.remoteRoot, "connection-2", old.generation, func(uint64) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	current := remoteBridgeTestMarker{root: old.root, remoteRoot: old.remoteRoot, connection: "connection-2", generation: newGeneration}
	requestFor := func(path string, marker remoteBridgeTestMarker, cleanup bool) *http.Request {
		request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"id":"published"}`))
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/json")
		setRemoteBridgeMarkerHeaders(request, marker, cleanup)
		return request
	}
	for _, request := range []*http.Request{
		requestFor("/v1/processes/read", old, false),
		requestFor("/v1/processes/kill", old, false),
		requestFor("/v1/processes/read", old, true),
		requestFor("/v1/processes/start", old, true),
	} {
		response := httptest.NewRecorder()
		bridge.serveHTTP(response, request)
		if response.Code != http.StatusConflict {
			t.Fatalf("stale %s cleanup=%q status = %d", request.URL.Path, request.Header.Get(remoteBridgeCleanupHeader), response.Code)
		}
	}
	for _, path := range []string{"/v1/processes/kill", "/v1/terminals/terminate", "/v1/code/cancel"} {
		response := httptest.NewRecorder()
		bridge.serveHTTP(response, requestFor(path, old, true))
		if response.Code != http.StatusOK {
			t.Fatalf("retired cleanup %s status = %d", path, response.Code)
		}
	}
	response := httptest.NewRecorder()
	bridge.serveHTTP(response, requestFor("/v1/read_file", current, false))
	if response.Code != http.StatusOK {
		t.Fatalf("current marker status = %d", response.Code)
	}
	if strings.Join(connections, ",") != "connection-1,connection-1,connection-1,connection-2" {
		t.Fatalf("proxied connections = %#v", connections)
	}
}

func TestRemoteBridgeCancelledRebindLeavesOldRouteUntilActiveDispatchReturns(t *testing.T) {
	const token = "abcdefghijklmnopqrstuvwxyz0123456789abcdef"
	entered := make(chan struct{})
	release := make(chan struct{})
	bridge, err := NewBridge(token, func(context.Context, string, string, string, []byte) (int, []byte, error) {
		close(entered)
		<-release
		return http.StatusOK, []byte(`{"ok":true}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bridge.Close() })
	old := publishRemoteBridgeTestMarker(t, bridge, "connection-1", 0)
	request := httptest.NewRequest(http.MethodPost, "/v1/read_file", strings.NewReader(`{"path":"/remote/project/file"}`))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	setRemoteBridgeMarkerHeaders(request, old, false)
	finished := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		response := httptest.NewRecorder()
		bridge.serveHTTP(response, request)
		finished <- response
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("old request did not reach proxy")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	wrote := false
	_, err = bridge.PublishMarker(ctx, old.root, old.remoteRoot, "connection-2", old.generation, func(uint64) error {
		wrote = true
		return nil
	})
	if !errors.Is(err, context.DeadlineExceeded) || wrote {
		t.Fatalf("cancelled rebind = %v, wrote = %v", err, wrote)
	}
	bridge.markerMu.RLock()
	current := bridge.markerRoutes[old.root]
	bridge.markerMu.RUnlock()
	if current.connectionID != old.connection || current.generation != old.generation {
		t.Fatalf("route changed after cancelled rebind = %#v", current)
	}
	close(release)
	select {
	case response := <-finished:
		if response.Code != http.StatusOK {
			t.Fatalf("active old request status = %d", response.Code)
		}
	case <-time.After(time.Second):
		t.Fatal("active old request did not finish")
	}
	newGeneration, err := bridge.PublishMarker(context.Background(), old.root, old.remoteRoot, "connection-2", old.generation, func(uint64) error { return nil })
	if err != nil || newGeneration <= old.generation {
		t.Fatalf("settled rebind = %d, %v", newGeneration, err)
	}
}

func TestBridgeAdoptsDiskMarkerIdentityAfterRestart(t *testing.T) {
	token := "abcdefghijklmnopqrstuvwxyz0123456789abcdef"
	connection := remoteagent.ConnectionInfo{ID: "conn-restarted", Mode: remoteagent.ModeBasic}
	var calls atomic.Int32
	proxy := func(context.Context, string, string, string, []byte) (int, []byte, error) {
		calls.Add(1)
		return http.StatusOK, []byte(`{"ok":true}`), nil
	}
	// 第一次启动：发布 marker，得到磁盘与内存一致的世代。
	before, err := NewBridge(token, proxy)
	if err != nil {
		t.Fatal(err)
	}
	before.connection = func(string) (remoteagent.ConnectionInfo, error) { return connection, nil }
	t.Cleanup(func() { _ = before.Close() })
	marker := publishRemoteBridgeTestMarker(t, before, connection.ID, 0)

	// 模拟 helper 重启：新桥接器没有任何内存路由，只剩磁盘上的 marker。
	after, err := NewBridge(token, proxy)
	if err != nil {
		t.Fatal(err)
	}
	after.connection = func(id string) (remoteagent.ConnectionInfo, error) {
		if id != connection.ID {
			return remoteagent.ConnectionInfo{}, errors.New("unknown connection")
		}
		return connection, nil
	}
	t.Cleanup(func() { _ = after.Close() })

	request := httptest.NewRequest(http.MethodPost, "/v1/exec", strings.NewReader(`{"root":"/remote/project","path":"/remote/project","shell":"bash","command":"true"}`))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	setRemoteBridgeMarkerHeaders(request, marker, false)
	response := httptest.NewRecorder()
	after.serveHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("adopted request = %d %s", response.Code, response.Body.String())
	}
	if calls.Load() != 1 {
		t.Fatalf("proxy calls = %d", calls.Load())
	}

	// 采纳之后世代仍然严格：换一个世代即被视为过期。
	stale := marker
	stale.generation++
	conflict := httptest.NewRequest(http.MethodPost, "/v1/exec", strings.NewReader(`{"root":"/remote/project","path":"/remote/project","shell":"bash","command":"true"}`))
	conflict.Header.Set("Authorization", "Bearer "+token)
	conflict.Header.Set("Content-Type", "application/json")
	setRemoteBridgeMarkerHeaders(conflict, stale, false)
	conflictResponse := httptest.NewRecorder()
	after.serveHTTP(conflictResponse, conflict)
	if conflictResponse.Code != http.StatusConflict {
		t.Fatalf("stale generation = %d %s", conflictResponse.Code, conflictResponse.Body.String())
	}
}

func TestBridgeReconnectsOnceWhenTheConnectionIsGone(t *testing.T) {
	token := "abcdefghijklmnopqrstuvwxyz0123456789abcdef"
	live := atomic.Bool{}
	var reconnects atomic.Int32
	var proxied atomic.Int32
	connectionID := "conn-reconnected"
	bridge, err := NewBridge(token, func(_ context.Context, connection string, _, _ string, _ []byte) (int, []byte, error) {
		proxied.Add(1)
		if connection != connectionID {
			t.Fatalf("proxy connection = %q", connection)
		}
		return http.StatusOK, []byte(`{"ok":true}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bridge.Close() })
	bridge.connection = func(id string) (remoteagent.ConnectionInfo, error) {
		if !live.Load() || id != connectionID {
			return remoteagent.ConnectionInfo{}, remoteagent.ErrConnectionNotFound
		}
		return remoteagent.ConnectionInfo{ID: connectionID, Mode: remoteagent.ModeBasic}, nil
	}
	// 自动重连：建立连接并重新发布 marker（真实实现走保存的档案）。
	bridge.reconnect = func(_ context.Context, markerRoot string) error {
		reconnects.Add(1)
		live.Store(true)
		_, err := bridge.PublishMarker(context.Background(), markerRoot, "/remote/project", connectionID, 0, func(uint64) error { return nil })
		return err
	}
	stale := remoteBridgeTestMarker{
		root: t.TempDir(), remoteRoot: "/remote/project", connection: "conn-lost", generation: 3,
	}
	request := func() *httptest.ResponseRecorder {
		call := httptest.NewRequest(http.MethodPost, "/v1/exec", strings.NewReader(`{"root":"/remote/project","path":"/remote/project","shell":"bash","command":"true"}`))
		call.Header.Set("Authorization", "Bearer "+token)
		call.Header.Set("Content-Type", "application/json")
		setRemoteBridgeMarkerHeaders(call, stale, false)
		recorder := httptest.NewRecorder()
		bridge.serveHTTP(recorder, call)
		return recorder
	}

	// 连接已经不在：自动重连一次，并在新路由上完成这次请求。
	if response := request(); response.Code != http.StatusOK {
		t.Fatalf("reconnected request = %d %s", response.Code, response.Body.String())
	}
	if reconnects.Load() != 1 || proxied.Load() != 1 {
		t.Fatalf("reconnects = %d, proxy calls = %d", reconnects.Load(), proxied.Load())
	}

	// 重连成功后身份过期仍是硬错误：不重复重连，也不放行旧世代。
	duplicate := request()
	if duplicate.Code != http.StatusConflict {
		t.Fatalf("stale generation after reconnect = %d %s", duplicate.Code, duplicate.Body.String())
	}
	if reconnects.Load() != 1 {
		t.Fatalf("reconnects after conflict = %d", reconnects.Load())
	}
}

func TestBridgeReconnectsWhenTheRoutedConnectionDrops(t *testing.T) {
	token := "abcdefghijklmnopqrstuvwxyz0123456789abcdef"
	// 会话中途掉线：路由还在，但那条连接已经不在 manager 里。
	var reconnects atomic.Int32
	var proxied atomic.Int32
	replacement := "conn-after-drop"
	bridge, err := NewBridge(token, func(_ context.Context, connection string, _, _ string, _ []byte) (int, []byte, error) {
		proxied.Add(1)
		if connection != replacement {
			t.Fatalf("proxy connection = %q", connection)
		}
		return http.StatusOK, []byte(`{"ok":true}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bridge.Close() })
	marker := publishRemoteBridgeTestMarker(t, bridge, "conn-dropped", 0)
	bridge.connection = func(id string) (remoteagent.ConnectionInfo, error) {
		if id != replacement {
			return remoteagent.ConnectionInfo{}, remoteagent.ErrConnectionNotFound
		}
		return remoteagent.ConnectionInfo{ID: replacement, Mode: remoteagent.ModeBasic}, nil
	}
	bridge.reconnect = func(_ context.Context, markerRoot string) error {
		reconnects.Add(1)
		_, err := bridge.PublishMarker(context.Background(), markerRoot, "/remote/project", replacement, 0, func(uint64) error { return nil })
		return err
	}

	call := httptest.NewRequest(http.MethodPost, "/v1/exec", strings.NewReader(`{"root":"/remote/project","path":"/remote/project","shell":"bash","command":"true"}`))
	call.Header.Set("Authorization", "Bearer "+token)
	call.Header.Set("Content-Type", "application/json")
	setRemoteBridgeMarkerHeaders(call, marker, false)
	response := httptest.NewRecorder()
	bridge.serveHTTP(response, call)

	if response.Code != http.StatusOK {
		t.Fatalf("reconnected request = %d %s", response.Code, response.Body.String())
	}
	if reconnects.Load() != 1 || proxied.Load() != 1 {
		t.Fatalf("reconnects = %d, proxy calls = %d", reconnects.Load(), proxied.Load())
	}
}
