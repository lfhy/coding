package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestRemoteBridgeRejectsUnauthenticatedAndUnroutableRequests(t *testing.T) {
	var calls atomic.Int32
	bridge, err := newRemoteBridge("abcdefghijklmnopqrstuvwxyz0123456789abcdef", func(context.Context, string, string, string, []byte) (int, []byte, error) {
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
	bridge, err := newRemoteBridge(token, func(context.Context, string, string, string, []byte) (int, []byte, error) {
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

func TestRemoteBridgeForwardsVerifiedRequestWithoutToken(t *testing.T) {
	const token = "abcdefghijklmnopqrstuvwxyz0123456789abcdef"
	var gotConnection, gotMethod, gotPath, gotBody string
	bridge, err := newRemoteBridge(token, func(_ context.Context, connection, method, path string, body []byte) (int, []byte, error) {
		gotConnection, gotMethod, gotPath, gotBody = connection, method, path, string(body)
		return http.StatusOK, []byte(`{"path":"/remote/project"}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bridge.Close() })
	request := httptest.NewRequest(http.MethodPost, "/v1/resolve", strings.NewReader(`{"path":"/remote/project"}`))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Coding-Remote-Connection", "connection-1")
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
	bridge, err := newRemoteBridge(token, func(context.Context, string, string, string, []byte) (int, []byte, error) {
		return http.StatusOK, large, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bridge.Close() })
	request := httptest.NewRequest(http.MethodPost, "/v1/read_bytes", strings.NewReader(`{"root":"/","path":"file"}`))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json; charset=utf-8")
	request.Header.Set("X-Coding-Remote-Connection", "connection-1")
	response := httptest.NewRecorder()
	bridge.serveHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.Len() != len(large) {
		t.Fatalf("large response = %d bytes, status %d", response.Body.Len(), response.Code)
	}
}
