package hostlaunch

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestEnsureAttachesToCompatibleHost(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/api/host.describe" {
			http.NotFound(writer, request)
			return
		}
		var message map[string]any
		if err := json.NewDecoder(request.Body).Decode(&message); err != nil || message["method"] != "host.describe" {
			http.Error(writer, "bad request", http.StatusBadRequest)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"type": "server-response", "rpcId": message["rpcId"],
			"result": map[string]any{"ok": true, "value": map[string]any{"version": "dev"}},
		})
	}))
	t.Cleanup(server.Close)
	// httptest's URL is host:port; the standard library has no public helper
	// for the port, so parse the last authority segment explicitly.
	port, err := strconv.Atoi(server.URL[len("http://127.0.0.1:"):])
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	record := Record{Type: "coding-host-ready", Port: port, PID: os.Getpid(), Version: "dev", Protocol: Protocol, Token: "token"}
	data, _ := json.Marshal(record)
	if err := os.WriteFile(filepath.Join(home, "host.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	launcher, err := New(Options{Home: home, Version: "dev", PollInterval: time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	endpoint, err := launcher.Ensure(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if endpoint.Started || endpoint.Record != record || endpoint.BaseURL != "http://127.0.0.1:"+strconv.Itoa(port) {
		t.Fatalf("unexpected endpoint: %#v", endpoint)
	}
}

func TestEnsureRefusesLiveIncompatibleHost(t *testing.T) {
	home := t.TempDir()
	record := Record{Type: "coding-host-ready", Port: 43123, PID: os.Getpid(), Version: "other", Protocol: Protocol, Token: "token"}
	data, _ := json.Marshal(record)
	if err := os.WriteFile(filepath.Join(home, "host.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	launcher, err := New(Options{Home: home, Version: "current"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = launcher.Ensure(context.Background())
	if err != ErrHostIncompatible {
		t.Fatalf("expected ErrHostIncompatible, got %v", err)
	}
}

func TestAcquireLockTimesOutWithoutRemovingOwner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "host.lock")
	owner, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	_, err = acquireLock(context.Background(), path, 5*time.Millisecond, time.Millisecond)
	if err == nil {
		t.Fatal("expected lock timeout")
	}
	if _, statErr := os.Stat(path); statErr != nil {
		t.Fatalf("owner lock was removed: %v", statErr)
	}
}
