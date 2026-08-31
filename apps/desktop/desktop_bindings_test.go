package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/deepseek-ai/coding/apps/desktop/internal/remoteagent"
	"github.com/deepseek-ai/coding/apps/internal/hostlaunch"
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
	script := desktopBindingsScript("test-token", "http://127.0.0.1:43123")
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

func TestRemoteSSHBindingsRejectWrongTokenBeforeArguments(t *testing.T) {
	manager := &fakeRemoteSSHManager{}
	app := &App{bridgeToken: "expected-token", remoteManager: manager}
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
	if manager.calls != 0 {
		t.Fatalf("manager calls = %d, want 0", manager.calls)
	}
}

func TestRemoteSSHConnectReturnsOpaqueConfirmationAndUsesFreshSecret(t *testing.T) {
	manager := &fakeRemoteSSHManager{}
	manager.connect = func(_ context.Context, request remoteagent.ConnectRequest) (remoteagent.ConnectionInfo, error) {
		if request.Auth.Password != "first-secret" {
			t.Fatalf("initial password was not forwarded for this call")
		}
		return remoteagent.ConnectionInfo{}, &remoteagent.ErrUnknownHostKey{
			ConfirmationID: "rconfirmation", Fingerprint: "SHA256:fingerprint", Algorithm: "ssh-ed25519", Address: "host:22",
		}
	}
	manager.confirm = func(_ context.Context, id string, request remoteagent.ConnectRequest, fingerprint string) (remoteagent.ConnectionInfo, error) {
		if id != "rconfirmation" || fingerprint != "SHA256:fingerprint" || request.Auth.Password != "fresh-secret" {
			t.Fatalf("confirmation = %q %q, password forwarded = %v", id, fingerprint, request.Auth.Password == "fresh-secret")
		}
		return remoteagent.ConnectionInfo{ID: "rconnection", RemoteHome: "/home/coding"}, nil
	}
	app := &App{bridgeToken: "window-token", remoteManager: manager}
	first, err := app.RemoteSSHConnect("window-token", sshPasswordInput("first-secret"))
	if err != nil || first.Kind != "host-key-confirmation" || first.ConfirmationID != "rconfirmation" {
		t.Fatalf("initial result = %#v, %v", first, err)
	}
	retry := sshPasswordInput("fresh-secret")
	retry.AttemptID = "rattempt-retry"
	retry.ConfirmationID = first.ConfirmationID
	retry.AcceptHostKeyFingerprint = first.Fingerprint
	ready, err := app.RemoteSSHConnect("window-token", retry)
	if err != nil || ready.Kind != "ready" || ready.ConnectionID != "rconnection" || ready.HomePath != "/home/coding" {
		t.Fatalf("confirmed result = %#v, %v", ready, err)
	}
}

func TestRemoteSSHCancelConnectStopsNativeAttempt(t *testing.T) {
	started := make(chan struct{})
	manager := &fakeRemoteSSHManager{}
	manager.connect = func(ctx context.Context, _ remoteagent.ConnectRequest) (remoteagent.ConnectionInfo, error) {
		close(started)
		<-ctx.Done()
		return remoteagent.ConnectionInfo{}, ctx.Err()
	}
	app := &App{bridgeToken: "window-token", remoteManager: manager}
	result := make(chan RemoteSSHConnectResult, 1)
	go func() {
		connected, _ := app.RemoteSSHConnect("window-token", sshPasswordInput("secret"))
		result <- connected
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("native connect did not start")
	}
	if err := app.RemoteSSHCancelConnect("window-token", "rattempt"); err != nil {
		t.Fatal(err)
	}
	select {
	case connected := <-result:
		if connected.Kind != "error" {
			t.Fatalf("cancelled result = %#v", connected)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled native connect did not settle")
	}
}

func TestRemoteSSHCancelConnectIsFencedByAttemptID(t *testing.T) {
	firstStarted := make(chan struct{})
	secondStarted := make(chan struct{})
	var calls atomic.Int32
	manager := &fakeRemoteSSHManager{}
	manager.connect = func(ctx context.Context, _ remoteagent.ConnectRequest) (remoteagent.ConnectionInfo, error) {
		switch calls.Add(1) {
		case 1:
			close(firstStarted)
		case 2:
			close(secondStarted)
		}
		<-ctx.Done()
		return remoteagent.ConnectionInfo{}, ctx.Err()
	}
	app := &App{bridgeToken: "window-token", remoteManager: manager}
	firstDone := make(chan struct{})
	go func() {
		_, _ = app.RemoteSSHConnect("window-token", sshPasswordInput("first"))
		close(firstDone)
	}()
	<-firstStarted
	second := sshPasswordInput("second")
	second.AttemptID = "rattempt-second"
	secondDone := make(chan struct{})
	go func() {
		_, _ = app.RemoteSSHConnect("window-token", second)
		close(secondDone)
	}()
	<-secondStarted
	if err := app.RemoteSSHCancelConnect("window-token", "rattempt"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-secondDone:
		t.Fatal("stale cancellation stopped the current native attempt")
	case <-time.After(50 * time.Millisecond):
	}
	if err := app.RemoteSSHCancelConnect("window-token", second.AttemptID); err != nil {
		t.Fatal(err)
	}
	select {
	case <-firstDone:
	case <-time.After(time.Second):
		t.Fatal("replaced first attempt did not settle")
	}
	select {
	case <-secondDone:
	case <-time.After(time.Second):
		t.Fatal("current cancelled attempt did not settle")
	}
}

func TestRemoteSSHCancelConnectWinsWhenDeliveredBeforeConnect(t *testing.T) {
	manager := &fakeRemoteSSHManager{}
	manager.connect = func(context.Context, remoteagent.ConnectRequest) (remoteagent.ConnectionInfo, error) {
		t.Fatal("pre-cancelled attempt reached Manager")
		return remoteagent.ConnectionInfo{}, nil
	}
	app := &App{bridgeToken: "window-token", remoteManager: manager}
	if err := app.RemoteSSHCancelConnect("window-token", "rattempt"); err != nil {
		t.Fatal(err)
	}
	result, err := app.RemoteSSHConnect("window-token", sshPasswordInput("secret"))
	if err != nil || result.Kind != "error" || manager.calls != 0 {
		t.Fatalf("pre-cancelled result = %#v, error = %v, calls = %d", result, err, manager.calls)
	}
}

func TestRemoteSSHDirectoryBindingsFilterAndRebindDeterministicMarker(t *testing.T) {
	home := t.TempDir()
	launcher, err := hostlaunch.New(hostlaunch.Options{Home: home})
	if err != nil {
		t.Fatal(err)
	}
	manager := &fakeRemoteSSHManager{
		listing: remoteagent.RemoteDirectory{Path: "/srv/project", Entries: []remoteagent.DirectoryEntry{
			{Name: "nested", Path: "/srv/project/nested", Type: "directory"},
			{Name: "file.txt", Path: "/srv/project/file.txt", Type: "file"},
		}},
		resolved: remoteagent.ResolveResponse{Path: "/srv/project", Info: &remoteagent.PathInfo{Path: "/srv/project", Type: "directory"}},
		connections: map[string]remoteagent.ConnectionInfo{
			"rnew": {ID: "rnew", TargetHost: "example.com", TargetPort: 22, TargetUser: "coding"},
			"rold": {ID: "rold", TargetHost: "example.com", TargetPort: 22, TargetUser: "coding"},
		},
	}
	app := &App{bridgeToken: "window-token", remoteManager: manager, remoteBridge: desktopTestRemoteBridge(t), launcher: launcher}
	listing, err := app.RemoteSSHListDirectories("window-token", "rnew", "/srv/project")
	if err != nil || len(listing.Entries) != 1 || !listing.Entries[0].Directory || listing.Entries[0].Name != "nested" {
		t.Fatalf("listing = %#v, %v", listing, err)
	}

	root, err := remoteMarkerRoot(home, manager.connections["rnew"], "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	if err := writeRemoteWorkspaceMarker(root, remoteagent.RemoteWorkspaceMarker{Version: 1, RemoteRoot: "/srv/project", ConnectionID: "rold"}); err != nil {
		t.Fatal(err)
	}
	selection, err := app.RemoteSSHSelectDirectory("window-token", "rnew", "/srv/project")
	if err != nil || selection.MarkerPath != root || selection.RemotePath != "/srv/project" {
		t.Fatalf("selection = %#v, %v", selection, err)
	}
	if len(manager.closed) != 1 || manager.closed[0] != "rold" {
		t.Fatalf("closed connections = %#v", manager.closed)
	}
	marker, err := readRemoteWorkspaceMarker(root, "/srv/project")
	if err != nil || marker == nil || marker.Version != 2 || marker.Generation != 1 || marker.ConnectionID != "rnew" {
		t.Fatalf("rewritten marker = %#v, %v", marker, err)
	}
	info, err := os.Stat(filepath.Join(root, remoteWorkspaceMarkerName))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("marker mode = %o", info.Mode().Perm())
	}
	rootAgain, err := remoteMarkerRoot(home, manager.connections["rnew"], "/srv/project")
	if err != nil || rootAgain != root {
		t.Fatalf("deterministic root = %q, %v", rootAgain, err)
	}
}

func TestRemoteSSHDirectorySelectionKeepsPublishedMarkerWhenReplacedCloseFails(t *testing.T) {
	home := t.TempDir()
	launcher, err := hostlaunch.New(hostlaunch.Options{Home: home})
	if err != nil {
		t.Fatal(err)
	}
	manager := &fakeRemoteSSHManager{
		resolved: remoteagent.ResolveResponse{Path: "/srv/project", Info: &remoteagent.PathInfo{Path: "/srv/project", Type: "directory"}},
		connections: map[string]remoteagent.ConnectionInfo{
			"rnew": {ID: "rnew", TargetHost: "example.com", TargetPort: 22, TargetUser: "coding"},
			"rold": {ID: "rold", TargetHost: "example.com", TargetPort: 22, TargetUser: "coding"},
		},
		close: func(context.Context, string) error { return errors.New("simulated close failure") },
	}
	root, err := remoteMarkerRoot(home, manager.connections["rnew"], "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	if err := writeRemoteWorkspaceMarker(root, remoteagent.RemoteWorkspaceMarker{Version: 1, RemoteRoot: "/srv/project", ConnectionID: "rold"}); err != nil {
		t.Fatal(err)
	}
	app := &App{bridgeToken: "window-token", remoteManager: manager, remoteBridge: desktopTestRemoteBridge(t), launcher: launcher}
	selection, err := app.RemoteSSHSelectDirectory("window-token", "rnew", "/srv/project")
	if err != nil || selection.MarkerPath != root || selection.RemotePath != "/srv/project" {
		t.Fatalf("selection = %#v, %v", selection, err)
	}
	marker, err := readRemoteWorkspaceMarker(root, "/srv/project")
	if err != nil || marker == nil || marker.ConnectionID != "rnew" {
		t.Fatalf("marker after failed replaced cleanup = %#v, %v", marker, err)
	}
}

func TestRemoteSSHCloseRejectsConnectionReferencedByPublishedMarker(t *testing.T) {
	home := t.TempDir()
	launcher, err := hostlaunch.New(hostlaunch.Options{Home: home})
	if err != nil {
		t.Fatal(err)
	}
	manager := &fakeRemoteSSHManager{
		resolved: remoteagent.ResolveResponse{Path: "/srv/project", Info: &remoteagent.PathInfo{Path: "/srv/project", Type: "directory"}},
		connections: map[string]remoteagent.ConnectionInfo{
			"rnew": {ID: "rnew", TargetHost: "example.com", TargetPort: 22, TargetUser: "coding"},
		},
	}
	app := &App{bridgeToken: "window-token", remoteManager: manager, remoteBridge: desktopTestRemoteBridge(t), launcher: launcher}
	if _, err := app.RemoteSSHSelectDirectory("window-token", "rnew", "/srv/project"); err != nil {
		t.Fatal(err)
	}
	if err := app.RemoteSSHClose("window-token", "rnew"); err == nil || !strings.Contains(err.Error(), "used by a workspace") {
		t.Fatalf("close referenced connection error = %v", err)
	}
	if len(manager.closed) != 0 {
		t.Fatalf("closed connections = %#v", manager.closed)
	}
}

func TestRemoteSSHDirectoryRebindingKeepsConnectionReferencedByAnotherMarker(t *testing.T) {
	home := t.TempDir()
	launcher, err := hostlaunch.New(hostlaunch.Options{Home: home})
	if err != nil {
		t.Fatal(err)
	}
	manager := &fakeRemoteSSHManager{
		resolve: func(_ context.Context, _ string, remotePath string) (remoteagent.ResolveResponse, error) {
			return remoteagent.ResolveResponse{Path: remotePath, Info: &remoteagent.PathInfo{Path: remotePath, Type: "directory"}}, nil
		},
		connections: map[string]remoteagent.ConnectionInfo{
			"ra": {ID: "ra", TargetHost: "example.com", TargetPort: 22, TargetUser: "coding"},
			"rb": {ID: "rb", TargetHost: "example.com", TargetPort: 22, TargetUser: "coding"},
		},
	}
	app := &App{bridgeToken: "window-token", remoteManager: manager, remoteBridge: desktopTestRemoteBridge(t), launcher: launcher}
	for _, selection := range []struct {
		connectionID string
		remotePath   string
	}{
		{connectionID: "ra", remotePath: "/srv/one"},
		{connectionID: "ra", remotePath: "/srv/two"},
		{connectionID: "rb", remotePath: "/srv/one"},
	} {
		if _, err := app.RemoteSSHSelectDirectory("window-token", selection.connectionID, selection.remotePath); err != nil {
			t.Fatalf("select %s with %s: %v", selection.remotePath, selection.connectionID, err)
		}
	}
	if len(manager.closed) != 0 {
		t.Fatalf("reused connection was closed while another marker referenced it: %#v", manager.closed)
	}
	secondRoot, err := remoteMarkerRoot(home, manager.connections["ra"], "/srv/two")
	if err != nil {
		t.Fatal(err)
	}
	marker, err := readRemoteWorkspaceMarker(secondRoot, "/srv/two")
	if err != nil || marker == nil || marker.ConnectionID != "ra" {
		t.Fatalf("second marker = %#v, %v", marker, err)
	}
}

func TestRemoteSSHDirectoryBindingRejectsTooManyEntries(t *testing.T) {
	entries := make([]remoteagent.DirectoryEntry, maxRemoteDirectoryEntries+1)
	for index := range entries {
		entries[index] = remoteagent.DirectoryEntry{Name: "directory", Path: "/srv/directory", Type: "directory"}
	}
	manager := &fakeRemoteSSHManager{listing: remoteagent.RemoteDirectory{Path: "/srv", Entries: entries}}
	app := &App{bridgeToken: "window-token", remoteManager: manager}
	_, err := app.RemoteSSHListDirectories("window-token", "rconnection", "/srv")
	if err == nil || !strings.Contains(err.Error(), "too many directory entries") {
		t.Fatalf("ListDirectories error = %v", err)
	}
}

func TestRemoteSSHDirectoryBindingRejectsListingAboveEncodedByteLimit(t *testing.T) {
	remote := remoteagent.RemoteDirectory{
		Path: "/srv",
		Entries: []remoteagent.DirectoryEntry{{
			Name: `quoted"directory`, Path: `/srv/quoted"directory`, Type: "directory",
		}},
	}
	listing, err := normalizeRemoteSSHDirectoryListing(remote, maxRemoteDirectoryListingBytes)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(listing)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := normalizeRemoteSSHDirectoryListing(remote, len(encoded)-1); err == nil || !strings.Contains(err.Error(), "directory listing that is too large") {
		t.Fatalf("listing below encoded byte limit error = %v", err)
	}
	if _, err := normalizeRemoteSSHDirectoryListing(remote, len(encoded)); err != nil {
		t.Fatalf("listing at encoded byte limit error = %v", err)
	}
}

func TestRemoteSSHDirectorySelectionSerializesMarkerRebinding(t *testing.T) {
	home := t.TempDir()
	launcher, err := hostlaunch.New(hostlaunch.Options{Home: home})
	if err != nil {
		t.Fatal(err)
	}
	manager := &fakeRemoteSSHManager{
		resolved: remoteagent.ResolveResponse{Path: "/srv/project", Info: &remoteagent.PathInfo{Path: "/srv/project", Type: "directory"}},
		connections: map[string]remoteagent.ConnectionInfo{
			"ra":   {ID: "ra", TargetHost: "example.com", TargetPort: 22, TargetUser: "coding"},
			"rb":   {ID: "rb", TargetHost: "example.com", TargetPort: 22, TargetUser: "coding"},
			"rold": {ID: "rold", TargetHost: "example.com", TargetPort: 22, TargetUser: "coding"},
		},
	}
	root, err := remoteMarkerRoot(home, manager.connections["ra"], "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	if err := writeRemoteWorkspaceMarker(root, remoteagent.RemoteWorkspaceMarker{Version: 1, RemoteRoot: "/srv/project", ConnectionID: "rold"}); err != nil {
		t.Fatal(err)
	}
	firstCloseStarted := make(chan struct{})
	allowFirstClose := make(chan struct{})
	var closeCalls atomic.Int32
	manager.close = func(_ context.Context, id string) error {
		if closeCalls.Add(1) == 1 {
			close(firstCloseStarted)
			<-allowFirstClose
		}
		manager.mu.Lock()
		manager.closed = append(manager.closed, id)
		manager.mu.Unlock()
		return nil
	}
	app := &App{bridgeToken: "window-token", remoteManager: manager, remoteBridge: desktopTestRemoteBridge(t), launcher: launcher}
	firstResult := make(chan error, 1)
	go func() {
		_, err := app.RemoteSSHSelectDirectory("window-token", "ra", "/srv/project")
		firstResult <- err
	}()
	select {
	case <-firstCloseStarted:
	case <-time.After(time.Second):
		t.Fatal("first selection did not begin replacing the marker")
	}
	secondResult := make(chan error, 1)
	go func() {
		_, err := app.RemoteSSHSelectDirectory("window-token", "rb", "/srv/project")
		secondResult <- err
	}()
	select {
	case <-time.After(50 * time.Millisecond):
		if closeCalls.Load() != 1 {
			t.Fatalf("concurrent selections closed %d connections before the first marker write", closeCalls.Load())
		}
	case err := <-secondResult:
		t.Fatalf("second selection returned before the first rebinding completed: %v", err)
	}
	close(allowFirstClose)
	for _, result := range []<-chan error{firstResult, secondResult} {
		select {
		case err := <-result:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(time.Second):
			t.Fatal("serialized marker selection did not settle")
		}
	}
	if closeCalls.Load() != 2 {
		t.Fatalf("closed connections = %d, want old marker and superseded selection", closeCalls.Load())
	}
}

func TestRemoteSSHDirectorySelectionDoesNotWriteAfterWaitingContextIsCancelled(t *testing.T) {
	home := t.TempDir()
	launcher, err := hostlaunch.New(hostlaunch.Options{Home: home})
	if err != nil {
		t.Fatal(err)
	}
	manager := &fakeRemoteSSHManager{
		resolved: remoteagent.ResolveResponse{Path: "/srv/project", Info: &remoteagent.PathInfo{Path: "/srv/project", Type: "directory"}},
		connections: map[string]remoteagent.ConnectionInfo{
			"rnew": {ID: "rnew", TargetHost: "example.com", TargetPort: 22, TargetUser: "coding"},
		},
	}
	root, err := remoteMarkerRoot(home, manager.connections["rnew"], "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	if err := writeRemoteWorkspaceMarker(root, remoteagent.RemoteWorkspaceMarker{Version: 1, RemoteRoot: "/srv/project", ConnectionID: "rold"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	app := &App{ctx: ctx, bridgeToken: "window-token", remoteManager: manager, remoteBridge: desktopTestRemoteBridge(t), launcher: launcher}
	app.remoteMarkerMu.Lock()
	locked := true
	t.Cleanup(func() {
		if locked {
			app.remoteMarkerMu.Unlock()
		}
	})
	result := make(chan error, 1)
	go func() {
		_, err := app.RemoteSSHSelectDirectory("window-token", "rnew", "/srv/project")
		result <- err
	}()
	// 先持有 mutex，再取消调用。选择在取得锁后必须先观察 ctx.Err，
	// 否则已经取消的调用仍可能探测远端并覆盖已有 marker。
	cancel()
	app.remoteMarkerMu.Unlock()
	locked = false
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled selection error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled marker selection did not settle")
	}
	marker, err := readRemoteWorkspaceMarker(root, "/srv/project")
	if err != nil || marker == nil || marker.ConnectionID != "rold" {
		t.Fatalf("marker after cancelled selection = %#v, %v", marker, err)
	}
}

func TestRemoteSSHDirectoryAndCloseBindingsUseDeadlines(t *testing.T) {
	manager := &fakeRemoteSSHManager{}
	manager.list = func(ctx context.Context, _, _ string) (remoteagent.RemoteDirectory, error) {
		if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > remoteDirectoryTimeout || time.Until(deadline) < remoteDirectoryTimeout-time.Second {
			t.Fatalf("list deadline = %v, %v", deadline, ok)
		}
		return remoteagent.RemoteDirectory{}, context.DeadlineExceeded
	}
	manager.resolve = func(ctx context.Context, _, _ string) (remoteagent.ResolveResponse, error) {
		if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > remoteSelectionTimeout || time.Until(deadline) < remoteSelectionTimeout-time.Second {
			t.Fatalf("select deadline = %v, %v", deadline, ok)
		}
		return remoteagent.ResolveResponse{}, context.DeadlineExceeded
	}
	manager.close = func(ctx context.Context, _ string) error {
		if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > remoteCloseTimeout || time.Until(deadline) < remoteCloseTimeout-time.Second {
			t.Fatalf("close deadline = %v, %v", deadline, ok)
		}
		return context.DeadlineExceeded
	}
	app := &App{bridgeToken: "window-token", remoteManager: manager}
	_, _ = app.RemoteSSHListDirectories("window-token", "rconnection", "/")
	_, _ = app.RemoteSSHSelectDirectory("window-token", "rconnection", "/")
	_ = app.RemoteSSHClose("window-token", "rconnection")
}

func sshPasswordInput(secret string) RemoteSSHConnectInput {
	return RemoteSSHConnectInput{AttemptID: "rattempt", Host: "example.com", Port: 22, Username: "coding", Auth: RemoteSSHAuthInput{Kind: "password", Secret: secret}}
}

func desktopTestRemoteBridge(t *testing.T) *remoteBridge {
	t.Helper()
	bridge, err := newRemoteBridge("abcdefghijklmnopqrstuvwxyz0123456789abcdef", func(context.Context, string, string, string, []byte) (int, []byte, error) {
		return 200, []byte(`{"ok":true}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bridge.Close() })
	return bridge
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
