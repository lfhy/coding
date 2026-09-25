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
