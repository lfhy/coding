package desktopremote

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/deepseek-ai/coding/apps/desktop/internal/remoteagent"
	"golang.org/x/crypto/ssh"
)

type serviceManager struct {
	connect func(context.Context, remoteagent.ConnectRequest) (remoteagent.ConnectionInfo, error)
	closed  []string
	mu      sync.Mutex
}

func (m *serviceManager) Connect(ctx context.Context, request remoteagent.ConnectRequest) (remoteagent.ConnectionInfo, error) {
	if m.connect != nil {
		return m.connect(ctx, request)
	}
	return remoteagent.ConnectionInfo{}, errors.New("unexpected connection")
}
func (m *serviceManager) ConfirmHostKey(ctx context.Context, _ string, request remoteagent.ConnectRequest, _ string) (remoteagent.ConnectionInfo, error) {
	return m.Connect(ctx, request)
}
func (m *serviceManager) RejectHostKey(string) {}
func (m *serviceManager) ListDirectories(context.Context, string, string) (remoteagent.RemoteDirectory, error) {
	return remoteagent.RemoteDirectory{Path: "/srv", Entries: []remoteagent.DirectoryEntry{{Name: "project", Path: "/srv/project", Type: "directory"}}}, nil
}
func (m *serviceManager) ResolvePath(context.Context, string, string) (remoteagent.ResolveResponse, error) {
	return remoteagent.ResolveResponse{Path: "/srv/project", Info: &remoteagent.PathInfo{Path: "/srv/project", Type: "directory"}}, nil
}
func (m *serviceManager) Connection(id string) (remoteagent.ConnectionInfo, error) {
	return remoteagent.ConnectionInfo{ID: id, Mode: remoteagent.ModeAgent, TargetHost: "example.com", TargetPort: 22, TargetUser: "coding"}, nil
}
func (m *serviceManager) Marker(id, root string) (remoteagent.RemoteWorkspaceMarker, error) {
	return remoteagent.RemoteWorkspaceMarker{Version: 3, Mode: remoteagent.ModeAgent, RemoteRoot: root, ConnectionID: id}, nil
}
func (m *serviceManager) Close(_ context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = append(m.closed, id)
	return nil
}
func (m *serviceManager) CloseAll(context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.closed = append(m.closed, "all")
	return nil
}

type serviceBridge struct {
	mu         sync.Mutex
	closed     bool
	closeOrder func()
}

func (b *serviceBridge) PublishMarker(_ context.Context, _, _, _ string, generation uint64, write func(uint64) error) (uint64, error) {
	return generation + 1, write(generation + 1)
}
func (b *serviceBridge) RevokeMarker(_ context.Context, _ MarkerIdentity, remove func() (bool, error)) (bool, error) {
	return remove()
}
func (b *serviceBridge) CurrentMarker(_ context.Context, _ MarkerIdentity, verify func() bool) bool {
	return verify()
}
func (b *serviceBridge) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	if b.closeOrder != nil {
		b.closeOrder()
	}
	return nil
}

func testService(t *testing.T, manager *serviceManager, bridge MarkerPublisher, progress func(ProgressEvent)) *Service {
	t.Helper()
	service, err := NewService(Options{Home: t.TempDir(), Manager: manager, Bridge: bridge, OnProgress: progress})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.CloseAll(context.Background()) })
	return service
}

func TestRemoteSSHFailureOnlyCodesHealthForwardingDenial(t *testing.T) {
	cases := []struct {
		name     string
		err      error
		wantCode bool
	}{
		{name: "health forwarding denial", err: fmt.Errorf("connect: %w", remoteagent.ErrPortForwardingDenied), wantCode: true},
		{name: "prohibited outside health", err: &ssh.OpenChannelError{Reason: ssh.Prohibited, Message: "open failed"}},
		{name: "network failure", err: errors.New("network unreachable")},
		{name: "authentication failure", err: errors.New("SSH authentication failed")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := remoteSSHFailure(tc.err)
			data, err := json.Marshal(result)
			if err != nil {
				t.Fatal(err)
			}
			var envelope map[string]string
			if err := json.Unmarshal(data, &envelope); err != nil {
				t.Fatal(err)
			}
			if envelope["kind"] != "error" || envelope["message"] == "" {
				t.Fatalf("invalid legacy error result: %s", data)
			}
			if tc.wantCode {
				if envelope["code"] != "port-forwarding-denied" || !strings.Contains(envelope["message"], "SSH port forwarding denied by server policy") {
					t.Fatalf("coded result = %s", data)
				}
			} else if _, ok := envelope["code"]; ok {
				t.Fatalf("uncoded result gained a code: %s", data)
			}
			var oldClient struct {
				Kind    string `json:"kind"`
				Message string `json:"message"`
			}
			if err := json.Unmarshal(data, &oldClient); err != nil || oldClient.Kind != "error" || oldClient.Message == "" {
				t.Fatalf("legacy Client cannot read result: %#v, %v", oldClient, err)
			}
		})
	}
}

func TestRemoteSSHConnectRequestRequiresExplicitMode(t *testing.T) {
	input := RemoteSSHConnectInput{AttemptID: "attempt-1", Host: "example.com", Port: 22, Username: "coding", Auth: RemoteSSHAuthInput{Kind: "password", Secret: "test"}}
	for _, mode := range []remoteagent.ConnectionMode{"", "unknown"} {
		input.Mode = mode
		if _, err := remoteSSHConnectRequest(input); err == nil {
			t.Fatalf("accepted mode %q", mode)
		}
	}
	for _, mode := range []remoteagent.ConnectionMode{remoteagent.ModeBasic, remoteagent.ModeAgent} {
		input.Mode = mode
		request, err := remoteSSHConnectRequest(input)
		if err != nil || request.Mode != mode {
			t.Fatalf("mode %q mapped to %+v, %v", mode, request, err)
		}
	}
}

func TestRemoteWorkspaceMarkerModesAndLegacyGeneration(t *testing.T) {
	for _, tc := range []struct {
		name       string
		marker     remoteagent.RemoteWorkspaceMarker
		valid      bool
		generation uint64
	}{
		{name: "legacy v1", marker: remoteagent.RemoteWorkspaceMarker{Version: 1}, valid: true},
		{name: "legacy v2 agent", marker: remoteagent.RemoteWorkspaceMarker{Version: 2, Generation: 7}, valid: true, generation: 7},
		{name: "v3 basic", marker: remoteagent.RemoteWorkspaceMarker{Version: 3, Mode: remoteagent.ModeBasic, Generation: 8}, valid: true, generation: 8},
		{name: "v3 agent", marker: remoteagent.RemoteWorkspaceMarker{Version: 3, Mode: remoteagent.ModeAgent, Generation: 9}, valid: true, generation: 9},
		{name: "v3 missing mode", marker: remoteagent.RemoteWorkspaceMarker{Version: 3, Generation: 1}, generation: 1},
		{name: "v2 forged basic", marker: remoteagent.RemoteWorkspaceMarker{Version: 2, Mode: remoteagent.ModeBasic, Generation: 1}, generation: 1},
		{name: "v3 unknown mode", marker: remoteagent.RemoteWorkspaceMarker{Version: 3, Mode: "unknown", Generation: 1}, generation: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if validRemoteWorkspaceMarker(tc.marker) != tc.valid || remoteWorkspaceMarkerGeneration(&tc.marker) != tc.generation {
				t.Fatalf("marker %+v: valid=%v generation=%d", tc.marker, validRemoteWorkspaceMarker(tc.marker), remoteWorkspaceMarkerGeneration(&tc.marker))
			}
		})
	}
}

func TestServiceConnectPreservesForwardingDenialCode(t *testing.T) {
	manager := &serviceManager{connect: func(context.Context, remoteagent.ConnectRequest) (remoteagent.ConnectionInfo, error) {
		return remoteagent.ConnectionInfo{}, fmt.Errorf("check remote agent health: %w", remoteagent.ErrPortForwardingDenied)
	}}
	service := testService(t, manager, &serviceBridge{}, nil)
	result, err := service.RemoteSSHConnect(RemoteSSHConnectInput{
		AttemptID: "attempt-1", Mode: remoteagent.ModeAgent, Host: "example.com", Port: 22, Username: "coding",
		Auth: RemoteSSHAuthInput{Kind: "password", Secret: "test-only"},
	})
	if err != nil || result.Kind != "error" || result.Code != "port-forwarding-denied" || result.Message == "" {
		t.Fatalf("Connect = %#v, %v", result, err)
	}
}

func TestServiceConnectCancelFencesLateResult(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	manager := &serviceManager{connect: func(ctx context.Context, request remoteagent.ConnectRequest) (remoteagent.ConnectionInfo, error) {
		request.OnProgress(remoteagent.Progress{Stage: "connecting"})
		close(started)
		<-release
		return remoteagent.ConnectionInfo{ID: "connection-1", RemoteHome: "/home/coding"}, nil
	}}
	var mu sync.Mutex
	var progress []ProgressEvent
	service := testService(t, manager, &serviceBridge{}, func(event ProgressEvent) { mu.Lock(); defer mu.Unlock(); progress = append(progress, event) })
	result := make(chan RemoteSSHConnectResult, 1)
	go func() {
		value, _ := service.RemoteSSHConnect(RemoteSSHConnectInput{AttemptID: "attempt-1", Mode: remoteagent.ModeAgent, Host: "example.com", Port: 22, Username: "coding", Auth: RemoteSSHAuthInput{Kind: "password", Secret: "secret"}})
		result <- value
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("connection did not start")
	}
	if err := service.RemoteSSHCancelConnect("attempt-1"); err != nil {
		t.Fatal(err)
	}
	close(release)
	select {
	case value := <-result:
		if value.Kind != "error" {
			t.Fatalf("result = %+v", value)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled connect did not finish")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.closed) != 1 || manager.closed[0] != "connection-1" {
		t.Fatalf("closed = %v", manager.closed)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(progress) != 1 || progress[0].Phase != "authenticating" || progress[0].Message != "" {
		t.Fatalf("progress = %v", progress)
	}
}

func TestServiceMarkerAndCloseOrder(t *testing.T) {
	manager := &serviceManager{}
	bridge := &serviceBridge{closeOrder: func() {
		manager.mu.Lock()
		defer manager.mu.Unlock()
		if len(manager.closed) == 0 || manager.closed[len(manager.closed)-1] != "all" {
			t.Error("bridge closed before manager")
		}
	}}
	service := testService(t, manager, bridge, nil)
	listing, err := service.RemoteSSHListDirectories("connection-1", "/srv")
	if err != nil || len(listing.Entries) != 1 {
		t.Fatalf("listing = %+v, %v", listing, err)
	}
	selected, err := service.RemoteSSHSelectDirectory("connection-1", "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	if selected.RemotePath != "/srv/project" {
		t.Fatalf("selection = %+v", selected)
	}
	marker, err := os.ReadFile(filepath.Join(selected.MarkerPath, remoteWorkspaceMarkerName))
	if err != nil || len(marker) == 0 {
		t.Fatalf("marker read = %v", err)
	}
	if err := service.RemoteSSHClose("connection-1"); err == nil {
		t.Fatal("published connection must remain referenced")
	}
	if err := service.CloseAll(context.Background()); err != nil {
		t.Fatal(err)
	}
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	if !bridge.closed {
		t.Fatal("bridge not closed")
	}
}
