package desktopremote

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/deepseek-ai/coding/apps/desktop/internal/remoteagent"
	"github.com/deepseek-ai/coding/apps/desktop/internal/sshprofile"
)

// profileService 构造带加密档案库的服务，并让每次 Connect 返回递增的连接 id。
func profileService(t *testing.T) (*Service, *serviceManager, *sshprofile.Store, *int) {
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
	service, err := NewService(Options{Home: home, Manager: manager, Bridge: &serviceBridge{}, Profiles: store})
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

func TestReconnectWorkspaceReusesLiveConnection(t *testing.T) {
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
	before, err := readRemoteWorkspaceMarker(selection.MarkerPath, "/srv/project")
	if err != nil || before == nil {
		t.Fatalf("read marker = %#v, %v", before, err)
	}
	reconnected, err := service.RemoteSSHReconnectWorkspace(selection.MarkerPath)
	if err != nil {
		t.Fatalf("reconnect: %v", err)
	}
	// 活跃连接被复用：不再握手，marker 仍指向同一条连接，且重新发布了 generation。
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
	if marker.ConnectionID != result.ConnectionID {
		t.Fatalf("marker connection = %q, want %q", marker.ConnectionID, result.ConnectionID)
	}
	manager.mu.Lock()
	closed := append([]string(nil), manager.closed...)
	manager.mu.Unlock()
	if len(closed) != 0 {
		t.Fatalf("reuse must not close connections, closed = %#v", closed)
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

func TestReconnectWorkspaceFallsBackWhenLiveConnectionFailsResolution(t *testing.T) {
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
	// 快路径的探活就是解析远端根：旧连接解析失败必须退回完整重连，不能让入口页卡住。
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
