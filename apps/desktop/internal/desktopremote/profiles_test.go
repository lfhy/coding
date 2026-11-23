package desktopremote

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/deepseek-ai/coding/apps/desktop/internal/remoteagent"
	"github.com/deepseek-ai/coding/apps/desktop/internal/sshprofile"
)

// profileService 构造带加密档案库的服务，并让每次 Connect 返回递增的连接 id。
func profileService(t *testing.T) (*Service, *serviceManager, *sshprofile.Store, *int) {
	t.Helper()
	return profileServiceWithBridge(t, desktopTestRemoteBridge(t))
}

func profileServiceWithBridge(t *testing.T, bridge *Bridge) (*Service, *serviceManager, *sshprofile.Store, *int) {
	t.Helper()
	home := t.TempDir()
	store, err := sshprofile.Open(home)
	if err != nil {
		t.Fatal(err)
	}
	sequence := 0
	manager := &serviceManager{connect: func(context.Context, remoteagent.ConnectRequest) (remoteagent.ConnectionInfo, error) {
		sequence++
		return remoteagent.ConnectionInfo{
			ID: "conn-" + string(rune('a'+sequence)), Mode: remoteagent.ModeBasic,
			TargetHost: "example.com", TargetPort: 22, TargetUser: "coding", RemoteHome: "/home/coding",
		}, nil
	}}
	service, err := NewService(Options{Home: home, Manager: manager, Bridge: bridge, Profiles: store})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.CloseAll(context.Background()) })
	return service, manager, store, &sequence
}

func TestRememberProfileCapturesTargetAfterSelection(t *testing.T) {
	service, _, store, _ := profileService(t)
	ctx := context.Background()
	result, err := service.RemoteSSHConnect(RemoteSSHConnectInput{
		AttemptID: "attempt-1", Mode: remoteagent.ModeBasic, Host: "example.com", Port: 22, Username: "coding",
		Auth: RemoteSSHAuthInput{Kind: "password", Secret: "hunter2"}, Remember: true,
	})
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	if result.Kind != "ready" || result.ConnectionID == "" {
		t.Fatalf("connect result = %#v", result)
	}
	profiles, err := service.RemoteSSHProfiles()
	if err != nil {
		t.Fatalf("list profiles: %v", err)
	}
	if len(profiles) != 1 || profiles[0].MarkerPath != "" {
		t.Fatalf("profiles after connect = %#v", profiles)
	}
	selection, err := service.RemoteSSHSelectDirectory(result.ConnectionID, "/srv/project")
	if err != nil {
		t.Fatalf("select directory: %v", err)
	}
	profiles, err = service.RemoteSSHProfiles()
	if err != nil {
		t.Fatalf("list profiles: %v", err)
	}
	if len(profiles) != 1 || profiles[0].MarkerPath != selection.MarkerPath || profiles[0].RemoteRoot != "/srv/project" {
		t.Fatalf("profiles after select = %#v", profiles)
	}
	kind, secret, err := store.Secret(ctx, profiles[0].ID)
	if err != nil {
		t.Fatalf("read saved secret: %v", err)
	}
	if kind != "password" || secret != "hunter2" {
		t.Fatalf("saved secret = %q/%q", kind, secret)
	}
	// 配置里不得出现明文口令。
	raw, err := os.ReadFile(store.ConfigPath())
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if strings.Contains(string(raw), "hunter2") {
		t.Fatalf("config file leaks the password: %s", raw)
	}
}

func TestReconnectWorkspaceReusesLiveConnectionWithoutSavedProfile(t *testing.T) {
	service, manager, _, sequence := profileService(t)
	result, err := service.RemoteSSHConnect(RemoteSSHConnectInput{
		AttemptID: "attempt-1", Mode: remoteagent.ModeBasic, Host: "example.com", Port: 22, Username: "coding",
		Auth: RemoteSSHAuthInput{Kind: "privateKey", Secret: "key-material"},
	})
	if err != nil || result.Kind != "ready" {
		t.Fatalf("connect = %#v, %v", result, err)
	}
	selection, err := service.RemoteSSHSelectDirectory(result.ConnectionID, "/srv/project")
	if err != nil {
		t.Fatalf("select directory: %v", err)
	}
	before, err := readRemoteWorkspaceMarker(selection.MarkerPath, "/srv/project")
	if err != nil || before == nil {
		t.Fatalf("read marker = %#v, %v", before, err)
	}
	reconnected, err := service.RemoteSSHReconnectWorkspace(selection.MarkerPath)
	if err != nil {
		t.Fatalf("reconnect: %v", err)
	}
	// 已发布的活连接保留原来的 marker 身份。
	if reconnected.Kind != "ready" || reconnected.ConnectionID != result.ConnectionID {
		t.Fatalf("reconnect result = %#v, want connection %q", reconnected, result.ConnectionID)
	}
	if *sequence != 1 {
		t.Fatalf("connect calls = %d, want 1", *sequence)
	}
	marker, err := readRemoteWorkspaceMarker(selection.MarkerPath, "/srv/project")
	if err != nil || marker == nil {
		t.Fatalf("read marker = %#v, %v", marker, err)
	}
	if *marker != *before {
		t.Fatal("reusing a live connection must not replace the marker")
	}
	manager.mu.Lock()
	closed := append([]string(nil), manager.closed...)
	manager.mu.Unlock()
	if len(closed) != 0 {
		t.Fatalf("reuse must not close connections, closed = %#v", closed)
	}
}

func TestReconnectWorkspaceDoesNotWaitForInFlightFileRead(t *testing.T) {
	const token = "abcdefghijklmnopqrstuvwxyz0123456789abcdef"
	reading := make(chan struct{})
	release := make(chan struct{})
	bridge, err := NewBridge(token, func(context.Context, string, string, string, []byte) (int, []byte, error) {
		close(reading)
		<-release
		return http.StatusOK, []byte(`{"ok":true}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bridge.Close() })
	service, manager, _, sequence := profileServiceWithBridge(t, bridge)
	connected, err := service.RemoteSSHConnect(RemoteSSHConnectInput{
		AttemptID: "read-test", Mode: remoteagent.ModeBasic, Host: "example.com", Port: 22, Username: "coding",
		Auth: RemoteSSHAuthInput{Kind: "password", Secret: "test-only"}, Remember: true,
	})
	if err != nil || connected.Kind != "ready" {
		t.Fatalf("connect: %v (%s)", err, connected.Kind)
	}
	selected, err := service.RemoteSSHSelectDirectory(connected.ConnectionID, "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	marker, err := readRemoteWorkspaceMarker(selected.MarkerPath, selected.RemotePath)
	if err != nil || marker == nil {
		t.Fatalf("read marker: %v", err)
	}
	resolves := 0
	manager.resolve = func(string) (remoteagent.ResolveResponse, error) {
		resolves++
		return remoteagent.ResolveResponse{Path: "/srv/project", Info: &remoteagent.PathInfo{Path: "/srv/project", Type: "directory"}}, nil
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/read_file", strings.NewReader(`{"root":"/srv/project","path":"seed.txt"}`))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	setRemoteBridgeMarkerHeaders(request, remoteBridgeTestMarker{
		root: selected.MarkerPath, remoteRoot: marker.RemoteRoot, connection: marker.ConnectionID, generation: marker.Generation,
	}, false)
	reply := httptest.NewRecorder()
	readDone := make(chan struct{})
	go func() { bridge.serveHTTP(reply, request); close(readDone) }()
	unblock := sync.OnceFunc(func() { close(release); <-readDone })
	t.Cleanup(unblock)
	select {
	case <-reading:
	case <-time.After(2 * time.Second):
		t.Fatal("file request did not dispatch")
	}
	opened := make(chan error, 1)
	go func() {
		result, err := service.RemoteSSHReconnectWorkspace(selected.MarkerPath)
		if err == nil && (result.Kind != "ready" || result.ConnectionID != connected.ConnectionID) {
			err = errors.New("did not reuse the existing connection")
		}
		opened <- err
	}()
	select {
	case err := <-opened:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		unblock()
		<-opened
		t.Fatal("opening workspace waited for the previous file request")
	}
	after, err := readRemoteWorkspaceMarker(selected.MarkerPath, selected.RemotePath)
	if err != nil || after == nil || *after != *marker || *sequence != 1 || resolves != 0 {
		t.Fatalf("opening the same workspace replaced its route or connection: %v", err)
	}
	unblock()
	if reply.Code != http.StatusOK {
		t.Fatalf("the existing file request was interrupted: HTTP %d", reply.Code)
	}
}

func TestReconnectWorkspaceReconnectsWhenLiveConnectionIsGone(t *testing.T) {
	service, manager, _, sequence := profileService(t)
	result, err := service.RemoteSSHConnect(RemoteSSHConnectInput{
		AttemptID: "attempt-1", Mode: remoteagent.ModeBasic, Host: "example.com", Port: 22, Username: "coding",
		Auth: RemoteSSHAuthInput{Kind: "privateKey", Secret: "key-material"}, Remember: true,
	})
	if err != nil || result.Kind != "ready" {
		t.Fatalf("connect = %#v, %v", result, err)
	}
	selection, err := service.RemoteSSHSelectDirectory(result.ConnectionID, "/srv/project")
	if err != nil {
		t.Fatalf("select directory: %v", err)
	}
	// 模拟桌面进程侧连接已经断开：manager 里不再有这条连接，marker 因而失效。
	manager.mu.Lock()
	delete(manager.live, result.ConnectionID)
	manager.mu.Unlock()
	reconnected, err := service.RemoteSSHReconnectWorkspace(selection.MarkerPath)
	if err != nil {
		t.Fatalf("reconnect: %v", err)
	}
	if reconnected.Kind != "ready" || reconnected.ConnectionID == result.ConnectionID {
		t.Fatalf("reconnect result = %#v", reconnected)
	}
	if *sequence != 2 {
		t.Fatalf("connect calls = %d, want 2", *sequence)
	}
	marker, err := readRemoteWorkspaceMarker(selection.MarkerPath, "/srv/project")
	if err != nil || marker == nil {
		t.Fatalf("read marker = %#v, %v", marker, err)
	}
	if marker.ConnectionID != reconnected.ConnectionID {
		t.Fatalf("marker connection = %q, want %q", marker.ConnectionID, reconnected.ConnectionID)
	}
	// 旧连接已经不在 manager 里，没有可关闭的对象；新 marker 必须指向新连接。
	manager.mu.Lock()
	_, stale := manager.live[result.ConnectionID]
	manager.mu.Unlock()
	if stale {
		t.Fatal("the dead connection must not be re-registered")
	}
}

func TestReconnectWorkspaceFallsBackWhenRouteRepairFails(t *testing.T) {
	service, manager, _, sequence := profileService(t)
	result, err := service.RemoteSSHConnect(RemoteSSHConnectInput{
		AttemptID: "attempt-1", Mode: remoteagent.ModeBasic, Host: "example.com", Port: 22, Username: "coding",
		Auth: RemoteSSHAuthInput{Kind: "privateKey", Secret: "key-material"}, Remember: true,
	})
	if err != nil || result.Kind != "ready" {
		t.Fatalf("connect = %#v, %v", result, err)
	}
	selection, err := service.RemoteSSHSelectDirectory(result.ConnectionID, "/srv/project")
	if err != nil {
		t.Fatalf("select directory: %v", err)
	}
	// 磁盘与当前路由的世代不符，不能把活连接当作可用路由。旧连接无法修复时仍要重连。
	marker, err := readRemoteWorkspaceMarker(selection.MarkerPath, selection.RemotePath)
	if err != nil || marker == nil {
		t.Fatalf("read marker: %v", err)
	}
	marker.Generation++
	if err := writeRemoteWorkspaceMarker(selection.MarkerPath, *marker); err != nil {
		t.Fatal(err)
	}
	manager.resolve = func(connectionID string) (remoteagent.ResolveResponse, error) {
		if connectionID == result.ConnectionID {
			return remoteagent.ResolveResponse{}, remoteagent.ErrConnectionNotFound
		}
		return remoteagent.ResolveResponse{
			Path: "/srv/project",
			Info: &remoteagent.PathInfo{Path: "/srv/project", Type: "directory"},
		}, nil
	}
	reconnected, err := service.RemoteSSHReconnectWorkspace(selection.MarkerPath)
	if err != nil {
		t.Fatalf("reconnect: %v", err)
	}
	if reconnected.Kind != "ready" || reconnected.ConnectionID == result.ConnectionID {
		t.Fatalf("reconnect result = %#v", reconnected)
	}
	if *sequence != 2 {
		t.Fatalf("connect calls = %d, want 2", *sequence)
	}
}

func TestReconnectWithoutProfileFails(t *testing.T) {
	service, _, _, _ := profileService(t)
	marker := filepath.Join(t.TempDir(), "unknown")
	if _, err := service.RemoteSSHReconnectWorkspace(marker); err == nil {
		t.Fatal("reconnect without a saved profile must fail")
	}
}

func TestForgetProfileRemovesCiphertext(t *testing.T) {
	service, _, store, _ := profileService(t)
	result, err := service.RemoteSSHConnect(RemoteSSHConnectInput{
		AttemptID: "attempt-1", Mode: remoteagent.ModeBasic, Host: "example.com", Port: 22, Username: "coding",
		Auth: RemoteSSHAuthInput{Kind: "password", Secret: "hunter2"}, Remember: true,
	})
	if err != nil || result.Kind != "ready" {
		t.Fatalf("connect = %#v, %v", result, err)
	}
	profiles, err := service.RemoteSSHProfiles()
	if err != nil || len(profiles) != 1 {
		t.Fatalf("profiles = %#v, %v", profiles, err)
	}
	id := profiles[0].ID
	if err := service.RemoteSSHForgetProfile(id); err != nil {
		t.Fatalf("forget profile: %v", err)
	}
	profiles, err = service.RemoteSSHProfiles()
	if err != nil || len(profiles) != 0 {
		t.Fatalf("profiles after forget = %#v, %v", profiles, err)
	}
	if _, _, err := store.Secret(context.Background(), id); err == nil {
		t.Fatal("secret must be gone after forgetting")
	}
}

func TestConnectWithoutRememberStoresNothing(t *testing.T) {
	service, _, store, _ := profileService(t)
	if _, err := service.RemoteSSHConnect(RemoteSSHConnectInput{
		AttemptID: "attempt-1", Mode: remoteagent.ModeBasic, Host: "example.com", Port: 22, Username: "coding",
		Auth: RemoteSSHAuthInput{Kind: "password", Secret: "hunter2"},
	}); err != nil {
		t.Fatalf("connect: %v", err)
	}
	profiles, err := store.List(context.Background())
	if err != nil || len(profiles) != 0 {
		t.Fatalf("profiles = %#v, %v", profiles, err)
	}
	if _, err := os.Stat(store.ConfigPath()); !os.IsNotExist(err) {
		t.Fatalf("config file should not exist, err = %v", err)
	}
}
