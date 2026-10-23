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

func TestReconnectWorkspaceRepublishesMarker(t *testing.T) {
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
	// marker 必须指向新连接，旧连接被关闭。
	marker, err := readRemoteWorkspaceMarker(selection.MarkerPath, "/srv/project")
	if err != nil || marker == nil {
		t.Fatalf("read marker = %#v, %v", marker, err)
	}
	if marker.ConnectionID != reconnected.ConnectionID {
		t.Fatalf("marker connection = %q, want %q", marker.ConnectionID, reconnected.ConnectionID)
	}
	manager.mu.Lock()
	closed := append([]string(nil), manager.closed...)
	manager.mu.Unlock()
	if len(closed) == 0 || closed[len(closed)-1] != result.ConnectionID {
		t.Fatalf("closed connections = %#v", closed)
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
