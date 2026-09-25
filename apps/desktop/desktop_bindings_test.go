package main

import (
	"context"
	"errors"
	"github.com/deepseek-ai/coding/apps/desktop/internal/desktopremote"
	"github.com/deepseek-ai/coding/apps/desktop/internal/remoteagent"
	"github.com/dop251/goja"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func TestBridgeTokenIsRandomURLSafeSecret(t *testing.T) {
	first, err := newBridgeToken()
	if err != nil {
		t.Fatal(err)
	}
	second, err := newBridgeToken()
	if err != nil {
		t.Fatal(err)
	}
	if first == second || len(first) < 32 || strings.ContainsAny(first, "+/=") {
		t.Fatalf("unexpected bridge tokens %q and %q", first, second)
	}
	if !validBridgeToken(first, first) || validBridgeToken(first, second) || validBridgeToken(first, first+"x") {
		t.Fatal("bridge token comparison did not reject a different token")
	}
}

func TestDesktopBindingsScriptInstallsOnlyRequiredRemoteMethods(t *testing.T) {
	script := desktopBindingsScript("test-token", "http://127.0.0.1:43123", "38px", "0px")
	for _, name := range []string{
		"__CODING_DESKTOP_BRIDGE_TOKEN", "RemoteSSHConnect", "RemoteSSHListDirectories",
		"RemoteSSHSelectDirectory", "RemoteSSHClose", "RemoteSSHCancelConnect", "RemoteSSHRejectHostKey",
		"window.webkit?.messageHandlers?.external?.postMessage",
	} {
		if !strings.Contains(script, name) {
			t.Fatalf("desktop bindings script omitted %q", name)
		}
	}
	if !strings.Contains(script, `window.location.origin !== "http://127.0.0.1:43123"`) {
		t.Fatal("desktop bindings script must restrict injection to the current Host origin")
	}
	if strings.Contains(script, "test-token@") || strings.Contains(script, "?test-token") {
		t.Fatal("desktop bindings script must not put a bridge token in a URL")
	}
	if strings.Contains(script, "RemoteSSHNodeStatus") || strings.Contains(script, "RemoteSSHInstallNode") {
		t.Fatal("desktop bindings script exposed an unimplemented Node operation")
	}
}

func TestDesktopBindingsScriptRestoresHostPageInsetsAfterNavigation(t *testing.T) {
	const hostOrigin = "http://127.0.0.1:43123"
	tests := []struct {
		name       string
		pageOrigin string
		platform   string
		top        string
		right      string
	}{
		{name: "macOS Host", pageOrigin: hostOrigin, platform: "darwin", top: "38px", right: "0px"},
		{name: "Windows Host", pageOrigin: hostOrigin, platform: "windows", top: "0px", right: "138px"},
		{name: "unrelated loopback", pageOrigin: "http://127.0.0.1:43124", platform: "darwin"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			vm := goja.New()
			setup := `var window = { location: { origin: ` + strconv.Quote(test.pageOrigin) + ` } };
var insets = {};
var document = { documentElement: { style: { setProperty(name, value) { insets[name] = value } } } };`
			if _, err := vm.RunString(setup); err != nil {
				t.Fatal(err)
			}
			top, right := desktopWindowInsets(test.platform)
			if _, err := vm.RunString(desktopBindingsScript("test-token", hostOrigin, top, right)); err != nil {
				t.Fatal(err)
			}
			insets := vm.Get("insets").ToObject(vm)
			gotTop := insets.Get("--app-safe-area-inset-top")
			gotRight := insets.Get("--app-safe-area-inset-right")
			gotToken := vm.Get("window").ToObject(vm).Get("__CODING_DESKTOP_BRIDGE_TOKEN")
			if test.pageOrigin != hostOrigin {
				if gotTop != nil || gotRight != nil || gotToken != nil {
					t.Fatal("unrelated loopback page received desktop window state")
				}
				return
			}
			if gotTop.String() != test.top || gotRight.String() != test.right || gotToken.String() != "test-token" {
				t.Fatalf("Host page insets/token = (%q, %q, %q), want (%q, %q, %q)",
					gotTop, gotRight, gotToken, test.top, test.right, "test-token")
			}
		})
	}
}

func TestRemoteSSHBindingsRejectWrongTokenBeforeArguments(t *testing.T) {
	app := &App{bridgeToken: "expected-token"}
	if _, err := app.RemoteSSHConnect("wrong-token", RemoteSSHConnectInput{}); !errors.Is(err, errDesktopBridgeUnauthorized) {
		t.Fatalf("Connect error = %v", err)
	}
	if _, err := app.RemoteSSHListDirectories("wrong-token", "", ""); !errors.Is(err, errDesktopBridgeUnauthorized) {
		t.Fatalf("ListDirectories error = %v", err)
	}
	if _, err := app.RemoteSSHSelectDirectory("wrong-token", "", ""); !errors.Is(err, errDesktopBridgeUnauthorized) {
		t.Fatalf("SelectDirectory error = %v", err)
	}
	if err := app.RemoteSSHClose("wrong-token", ""); !errors.Is(err, errDesktopBridgeUnauthorized) {
		t.Fatalf("Close error = %v", err)
	}
	if err := app.RemoteSSHCancelConnect("wrong-token", "rattempt"); !errors.Is(err, errDesktopBridgeUnauthorized) {
		t.Fatalf("CancelConnect error = %v", err)
	}
	if err := app.RemoteSSHRejectHostKey("wrong-token", ""); !errors.Is(err, errDesktopBridgeUnauthorized) {
		t.Fatalf("RejectHostKey error = %v", err)
	}
}

func TestRemoteSSHProductionAdapterUsesSharedService(t *testing.T) {
	manager := &fakeRemoteSSHManager{
		connect: func(_ context.Context, request remoteagent.ConnectRequest) (remoteagent.ConnectionInfo, error) {
			if request.Auth.Password != "secret" {
				t.Fatal("connection secret was not passed only to manager")
			}
			return remoteagent.ConnectionInfo{ID: "connection-1", RemoteHome: "/home/coding"}, nil
		},
	}
	bridge, err := desktopremote.NewBridge("abcdefghijklmnopqrstuvwxyz0123456789abcdef", func(context.Context, string, string, string, []byte) (int, []byte, error) {
		return 200, []byte(`{"ok":true}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bridge.Close() })
	service, err := desktopremote.NewService(desktopremote.Options{
		Home: t.TempDir(), Manager: manager, Bridge: bridge,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = service.CloseAll(context.Background()) })
	app := &App{bridgeToken: "window-token", remoteService: service}
	if _, err := app.RemoteSSHConnect("invalid", sshPasswordInput("secret")); !errors.Is(err, errDesktopBridgeUnauthorized) {
		t.Fatalf("unauthorized adapter error = %v", err)
	}
	if manager.calls != 0 {
		t.Fatalf("manager calls before authorization = %d", manager.calls)
	}
	result, err := app.RemoteSSHConnect("window-token", sshPasswordInput("secret"))
	if err != nil || result.Kind != "ready" || result.ConnectionID != "connection-1" {
		t.Fatalf("connection result = %+v, %v", result, err)
	}
}

func sshPasswordInput(secret string) RemoteSSHConnectInput {
	return RemoteSSHConnectInput{AttemptID: "rattempt", Host: "example.com", Port: 22, Username: "coding", Auth: RemoteSSHAuthInput{Kind: "password", Secret: secret}}
}

type fakeRemoteSSHManager struct {
	mu          sync.Mutex
	calls       int
	connect     func(context.Context, remoteagent.ConnectRequest) (remoteagent.ConnectionInfo, error)
	confirm     func(context.Context, string, remoteagent.ConnectRequest, string) (remoteagent.ConnectionInfo, error)
	list        func(context.Context, string, string) (remoteagent.RemoteDirectory, error)
	resolve     func(context.Context, string, string) (remoteagent.ResolveResponse, error)
	close       func(context.Context, string) error
	marker      func(string, string) (remoteagent.RemoteWorkspaceMarker, error)
	listing     remoteagent.RemoteDirectory
	resolved    remoteagent.ResolveResponse
	connections map[string]remoteagent.ConnectionInfo
	closed      []string
}

func (manager *fakeRemoteSSHManager) Connect(ctx context.Context, request remoteagent.ConnectRequest) (remoteagent.ConnectionInfo, error) {
	manager.recordCall()
	if manager.connect == nil {
		return remoteagent.ConnectionInfo{}, errors.New("unexpected Connect")
	}
	return manager.connect(ctx, request)
}

func (manager *fakeRemoteSSHManager) ConfirmHostKey(ctx context.Context, id string, request remoteagent.ConnectRequest, fingerprint string) (remoteagent.ConnectionInfo, error) {
	manager.recordCall()
	if manager.confirm == nil {
		return remoteagent.ConnectionInfo{}, errors.New("unexpected ConfirmHostKey")
	}
	return manager.confirm(ctx, id, request, fingerprint)
}

func (manager *fakeRemoteSSHManager) RejectHostKey(string) { manager.recordCall() }

func (manager *fakeRemoteSSHManager) ListDirectories(ctx context.Context, connectionID, remotePath string) (remoteagent.RemoteDirectory, error) {
	manager.recordCall()
	if manager.list != nil {
		return manager.list(ctx, connectionID, remotePath)
	}
	return manager.listing, nil
}

func (manager *fakeRemoteSSHManager) ResolvePath(ctx context.Context, connectionID, remotePath string) (remoteagent.ResolveResponse, error) {
	manager.recordCall()
	if manager.resolve != nil {
		return manager.resolve(ctx, connectionID, remotePath)
	}
	return manager.resolved, nil
}

func (manager *fakeRemoteSSHManager) Connection(id string) (remoteagent.ConnectionInfo, error) {
	manager.recordCall()
	info, ok := manager.connections[id]
	if !ok {
		return remoteagent.ConnectionInfo{}, remoteagent.ErrConnectionNotFound
	}
	return info, nil
}

func (manager *fakeRemoteSSHManager) Marker(connectionID, remoteRoot string) (remoteagent.RemoteWorkspaceMarker, error) {
	manager.recordCall()
	if manager.marker != nil {
		return manager.marker(connectionID, remoteRoot)
	}
	return remoteagent.RemoteWorkspaceMarker{Version: 1, RemoteRoot: remoteRoot, ConnectionID: connectionID}, nil
}

func (manager *fakeRemoteSSHManager) Close(ctx context.Context, id string) error {
	manager.recordCall()
	if manager.close != nil {
		return manager.close(ctx, id)
	}
	manager.mu.Lock()
	manager.closed = append(manager.closed, id)
	manager.mu.Unlock()
	return nil
}

func (manager *fakeRemoteSSHManager) CloseAll(context.Context) error {
	manager.recordCall()
	return nil
}

func (manager *fakeRemoteSSHManager) recordCall() {
	manager.mu.Lock()
	manager.calls++
	manager.mu.Unlock()
}
