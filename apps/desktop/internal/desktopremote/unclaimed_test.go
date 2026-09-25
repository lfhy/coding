package desktopremote

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/deepseek-ai/coding/apps/desktop/internal/remoteagent"
)

func unclaimedFixture(t *testing.T) (*Service, *Bridge, *fakeRemoteSSHManager, string) {
	t.Helper()
	home := t.TempDir()
	manager := &fakeRemoteSSHManager{
		resolved: remoteagent.ResolveResponse{Path: "/srv/project", Info: &remoteagent.PathInfo{Path: "/srv/project", Type: "directory"}},
		connections: map[string]remoteagent.ConnectionInfo{
			"rnew":  {ID: "rnew", TargetHost: "example.com", TargetPort: 22, TargetUser: "coding"},
			"rnext": {ID: "rnext", TargetHost: "example.com", TargetPort: 22, TargetUser: "coding"},
			"rold":  {ID: "rold", TargetHost: "example.com", TargetPort: 22, TargetUser: "coding"},
		},
	}
	bridge := desktopTestRemoteBridge(t)
	service := testServiceAt(t, home, context.Background(), manager, bridge)
	return service, bridge, manager, home
}

func requireUnclaimedKind(t *testing.T, result UnclaimedActionResult, err error, want string) {
	t.Helper()
	if err != nil || result.Kind != want {
		t.Fatalf("result = %+v, %v; want %q", result, err, want)
	}
}

func TestUnclaimedRevokeBeforeSelect(t *testing.T) {
	service, _, manager, home := unclaimedFixture(t)
	result, err := service.RemoteSSHRevokeUnclaimed("operation-1", "rnew")
	requireUnclaimedKind(t, result, err, "revoked")
	selected, err := service.RemoteSSHSelectUnclaimed("operation-1", "rnew", "/srv/project")
	if err != nil || selected.Kind != "revoked" || selected.MarkerPath != "" {
		t.Fatalf("selection = %+v, %v", selected, err)
	}
	result, err = service.RemoteSSHClaimSelection("operation-1")
	requireUnclaimedKind(t, result, err, "revoked")
	root, err := remoteMarkerRoot(home, manager.connections["rnew"], "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(root, remoteWorkspaceMarkerName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("canceled selection published marker: %v", err)
	}
	if _, err := service.RemoteSSHRevokeUnclaimed("operation-1", "rnext"); err == nil {
		t.Fatal("mismatched connection accepted")
	}
	if _, err := service.RemoteSSHSelectUnclaimed("operation-1", "rnext", "/srv/project"); err == nil {
		t.Fatal("reused operation id")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.closed) != 0 {
		t.Fatalf("pre-select tombstone closed connection without ownership proof: %v", manager.closed)
	}
}

func TestUnclaimedRevokeDuringResolvePreventsPublication(t *testing.T) {
	service, _, manager, _ := unclaimedFixture(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	manager.resolve = func(_ context.Context, _, _ string) (remoteagent.ResolveResponse, error) {
		close(entered)
		<-release
		return manager.resolved, nil
	}
	result := make(chan UnclaimedSelectionResult, 1)
	go func() {
		selected, _ := service.RemoteSSHSelectUnclaimed("operation-2", "rnew", "/srv/project")
		result <- selected
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("resolve did not start")
	}
	revoked, err := service.RemoteSSHRevokeUnclaimed("operation-2", "rnew")
	requireUnclaimedKind(t, revoked, err, "revoked")
	close(release)
	select {
	case selected := <-result:
		if selected.Kind != "revoked" {
			t.Fatalf("selected after revoke: %+v", selected)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled selection did not finish")
	}
	if len(service.remoteMarkers) != 0 {
		t.Fatalf("canceled selection registered marker: %v", service.remoteMarkers)
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.closed) != 1 || manager.closed[0] != "rnew" {
		t.Fatalf("revoked in-flight candidate was not cleaned up: %v", manager.closed)
	}
}

func TestUnclaimedPendingSelectionPinsConnectionUntilRevoked(t *testing.T) {
	service, _, manager, _ := unclaimedFixture(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	manager.resolve = func(_ context.Context, _, _ string) (remoteagent.ResolveResponse, error) {
		close(entered)
		<-release
		return manager.resolved, nil
	}
	result := make(chan UnclaimedSelectionResult, 1)
	go func() {
		selected, _ := service.RemoteSSHSelectUnclaimed("operation-pin", "rnew", "/srv/project")
		result <- selected
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("resolve did not start")
	}
	if err := service.RemoteSSHClose("rnew"); err == nil {
		t.Fatal("pending selection connection was closed")
	}
	manager.mu.Lock()
	closed := len(manager.closed)
	manager.mu.Unlock()
	if closed != 0 {
		t.Fatalf("manager closed pending connection %d times", closed)
	}
	revoked, err := service.RemoteSSHRevokeUnclaimed("operation-pin", "rnew")
	requireUnclaimedKind(t, revoked, err, "revoked")
	if err := service.RemoteSSHClose("rnew"); err == nil {
		t.Fatal("revoked but in-flight selection lost its connection pin")
	}
	close(release)
	select {
	case selected := <-result:
		if selected.Kind != "revoked" {
			t.Fatalf("late selection = %+v", selected)
		}
	case <-time.After(time.Second):
		t.Fatal("late selection did not settle")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.closed) != 1 || manager.closed[0] != "rnew" {
		t.Fatalf("settled candidate was not closed once: %v", manager.closed)
	}
}

func TestUnclaimedPendingRevokeKeepsExistingSameConnection(t *testing.T) {
	service, _, manager, home := unclaimedFixture(t)
	root, err := remoteMarkerRoot(home, manager.connections["rold"], "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	if err := writeRemoteWorkspaceMarker(root, remoteagent.RemoteWorkspaceMarker{Version: 1, RemoteRoot: "/srv/project", ConnectionID: "rold"}); err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	release := make(chan struct{})
	manager.resolve = func(_ context.Context, _, _ string) (remoteagent.ResolveResponse, error) {
		close(entered)
		<-release
		return manager.resolved, nil
	}
	result := make(chan UnclaimedSelectionResult, 1)
	go func() {
		selected, _ := service.RemoteSSHSelectUnclaimed("pending-old", "rold", "/srv/project")
		result <- selected
	}()
	<-entered
	revoked, err := service.RemoteSSHRevokeUnclaimed("pending-old", "rold")
	requireUnclaimedKind(t, revoked, err, "revoked")
	close(release)
	select {
	case selected := <-result:
		if selected.Kind != "revoked" {
			t.Fatalf("selection = %+v", selected)
		}
	case <-time.After(time.Second):
		t.Fatal("selection did not settle")
	}
	marker, err := readRemoteWorkspaceMarker(root, "/srv/project")
	if err != nil || marker == nil || marker.ConnectionID != "rold" {
		t.Fatalf("old marker = %+v, %v", marker, err)
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.closed) != 0 {
		t.Fatalf("old workspace connection closed: %v", manager.closed)
	}
}

func TestUnclaimedPendingRevokeWaitsForOtherSelectionOfSameConnection(t *testing.T) {
	service, _, manager, _ := unclaimedFixture(t)
	entered := make(chan string, 2)
	releaseFirst := make(chan struct{})
	releaseSecond := make(chan struct{})
	manager.resolve = func(_ context.Context, _, remotePath string) (remoteagent.ResolveResponse, error) {
		entered <- remotePath
		if remotePath == "/srv/first" {
			<-releaseFirst
		} else {
			<-releaseSecond
		}
		return manager.resolved, nil
	}
	results := make(chan UnclaimedSelectionResult, 2)
	go func() {
		selected, _ := service.RemoteSSHSelectUnclaimed("pending-first", "rnew", "/srv/first")
		results <- selected
	}()
	go func() {
		selected, _ := service.RemoteSSHSelectUnclaimed("pending-second", "rnew", "/srv/second")
		results <- selected
	}()
	for index := 0; index < 2; index++ {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("selection did not enter resolve")
		}
	}
	first, err := service.RemoteSSHRevokeUnclaimed("pending-first", "rnew")
	requireUnclaimedKind(t, first, err, "revoked")
	close(releaseFirst)
	select {
	case selected := <-results:
		if selected.Kind != "revoked" {
			t.Fatalf("first selection = %+v", selected)
		}
	case <-time.After(time.Second):
		t.Fatal("first selection did not settle")
	}
	manager.mu.Lock()
	closed := len(manager.closed)
	manager.mu.Unlock()
	if closed != 0 {
		t.Fatalf("another pending selection lost its connection: %d closes", closed)
	}
	second, err := service.RemoteSSHRevokeUnclaimed("pending-second", "rnew")
	requireUnclaimedKind(t, second, err, "revoked")
	close(releaseSecond)
	select {
	case selected := <-results:
		if selected.Kind != "revoked" {
			t.Fatalf("second selection = %+v", selected)
		}
	case <-time.After(time.Second):
		t.Fatal("second selection did not settle")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.closed) != 1 || manager.closed[0] != "rnew" {
		t.Fatalf("last settled connection closed incorrectly: %v", manager.closed)
	}
}

func TestUnclaimedRevokeBetweenSelectionAndSettlement(t *testing.T) {
	for _, hasPrevious := range []bool{false, true} {
		name := "new-marker"
		if hasPrevious {
			name = "existing-marker"
		}
		t.Run(name, func(t *testing.T) {
			service, _, manager, _ := unclaimedFixture(t)
			if hasPrevious {
				if _, err := service.RemoteSSHSelectDirectory("rold", "/srv/project"); err != nil {
					t.Fatal(err)
				}
			}
			entered := make(chan struct{})
			release := make(chan struct{})
			var once sync.Once
			defer once.Do(func() { close(release) })
			service.afterUnclaimedSelect = func() {
				close(entered)
				<-release
			}
			result := make(chan UnclaimedSelectionResult, 1)
			go func() {
				selected, _ := service.RemoteSSHSelectUnclaimed("settlement-race", "rnew", "/srv/project")
				result <- selected
			}()
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("selection did not reach settlement")
			}
			revoked, err := service.RemoteSSHRevokeUnclaimed("settlement-race", "rnew")
			requireUnclaimedKind(t, revoked, err, "revoked")
			once.Do(func() { close(release) })
			select {
			case selected := <-result:
				if selected.Kind != "revoked" {
					t.Fatalf("revoked selection delivered: %+v", selected)
				}
			case <-time.After(time.Second):
				t.Fatal("selection did not settle")
			}
			manager.mu.Lock()
			defer manager.mu.Unlock()
			if len(manager.closed) != 1 || manager.closed[0] != "rnew" {
				t.Fatalf("candidate orphaned after settlement: %v", manager.closed)
			}
		})
	}
}

func TestUnclaimedPendingRevokeResolveErrorWithoutMarkerIdentityIsConservative(t *testing.T) {
	service, _, manager, _ := unclaimedFixture(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	manager.resolve = func(context.Context, string, string) (remoteagent.ResolveResponse, error) {
		close(entered)
		<-release
		return remoteagent.ResolveResponse{}, errors.New("remote resolve failed")
	}
	result := make(chan UnclaimedSelectionResult, 1)
	go func() {
		selected, _ := service.RemoteSSHSelectUnclaimed("unknown-root", "rnew", "/srv/project")
		result <- selected
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("resolve did not start")
	}
	revoked, err := service.RemoteSSHRevokeUnclaimed("unknown-root", "rnew")
	requireUnclaimedKind(t, revoked, err, "revoked")
	once.Do(func() { close(release) })
	select {
	case selected := <-result:
		if selected.Kind != "revoked" {
			t.Fatalf("selection = %+v", selected)
		}
	case <-time.After(time.Second):
		t.Fatal("selection did not settle")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.closed) != 0 {
		t.Fatalf("unknown ownership closed connection: %v", manager.closed)
	}
}

func TestUnclaimedFailedSelectionWithKnownRootRevokesCandidate(t *testing.T) {
	service, _, manager, _ := unclaimedFixture(t)
	manager.marker = func(connectionID, remoteRoot string) (remoteagent.RemoteWorkspaceMarker, error) {
		service.cancel()
		return remoteagent.RemoteWorkspaceMarker{Version: 1, RemoteRoot: remoteRoot, ConnectionID: connectionID}, nil
	}
	if _, err := service.RemoteSSHSelectUnclaimed("known-root-failure", "rnew", "/srv/project"); !errors.Is(err, context.Canceled) {
		t.Fatalf("selection error = %v", err)
	}
	revoked, err := service.RemoteSSHRevokeUnclaimed("known-root-failure", "rnew")
	requireUnclaimedKind(t, revoked, err, "revoked")
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.closed) != 1 || manager.closed[0] != "rnew" {
		t.Fatalf("failed selection candidate remains: %v", manager.closed)
	}
}

func TestUnclaimedPublishedNewMarkerRevokesRouteFileAndConnection(t *testing.T) {
	service, bridge, manager, _ := unclaimedFixture(t)
	selected, err := service.RemoteSSHSelectUnclaimed("operation-3", "rnew", "/srv/project")
	if err != nil || selected.Kind != "selected" {
		t.Fatalf("selection = %+v, %v", selected, err)
	}
	operation := service.unclaimed["operation-3"]
	if !bridge.CurrentMarker(context.Background(), operation.marker, func() bool { return publishedMarkerMatches(operation) }) {
		t.Fatal("marker not routable")
	}
	revoked, err := service.RemoteSSHRevokeUnclaimed("operation-3", "rnew")
	requireUnclaimedKind(t, revoked, err, "revoked")
	if _, err := os.Lstat(filepath.Join(selected.MarkerPath, remoteWorkspaceMarkerName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("revoked marker remains: %v", err)
	}
	if bridge.CurrentMarker(context.Background(), operation.marker, func() bool { return true }) {
		t.Fatal("revoked bridge route remains")
	}
	if len(service.remoteMarkers) != 0 {
		t.Fatalf("revoked reference remains: %v", service.remoteMarkers)
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.closed) != 1 || manager.closed[0] != "rnew" {
		t.Fatalf("closed = %v", manager.closed)
	}
	revoked, err = service.RemoteSSHRevokeUnclaimed("operation-3", "rnew")
	requireUnclaimedKind(t, revoked, err, "revoked")
}

func TestUnclaimedClaimBeforeRevokeRetainsMarker(t *testing.T) {
	service, _, manager, _ := unclaimedFixture(t)
	selected, err := service.RemoteSSHSelectUnclaimed("operation-4", "rnew", "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := service.RemoteSSHClaimSelection("operation-4")
	requireUnclaimedKind(t, claimed, err, "claimed")
	revoked, err := service.RemoteSSHRevokeUnclaimed("operation-4", "rnew")
	requireUnclaimedKind(t, revoked, err, "claimed")
	if _, err := os.Lstat(filepath.Join(selected.MarkerPath, remoteWorkspaceMarkerName)); err != nil {
		t.Fatalf("claimed marker removed: %v", err)
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.closed) != 0 {
		t.Fatalf("claimed connection closed: %v", manager.closed)
	}
}

func TestUnclaimedExistingMarkerRevokePreservesOldBinding(t *testing.T) {
	service, bridge, manager, _ := unclaimedFixture(t)
	old, err := service.RemoteSSHSelectDirectory("rold", "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.Lstat(filepath.Join(old.MarkerPath, remoteWorkspaceMarkerName))
	if err != nil {
		t.Fatal(err)
	}
	oldMarker, err := readRemoteWorkspaceMarker(old.MarkerPath, old.RemotePath)
	if err != nil || oldMarker == nil {
		t.Fatalf("old marker = %+v, %v", oldMarker, err)
	}
	oldIdentity := MarkerIdentity{MarkerRoot: old.MarkerPath, RemoteRoot: old.RemotePath, ConnectionID: "rold", Generation: oldMarker.Generation}
	selected, err := service.RemoteSSHSelectUnclaimed("operation-5", "rnew", "/srv/project")
	if err != nil || selected.Kind != "selected" {
		t.Fatalf("selection = %+v, %v", selected, err)
	}
	assertOld := func() {
		t.Helper()
		current, err := os.Lstat(filepath.Join(old.MarkerPath, remoteWorkspaceMarkerName))
		if err != nil || !os.SameFile(before, current) {
			t.Fatalf("old marker file changed: %v", err)
		}
		marker, err := readRemoteWorkspaceMarker(old.MarkerPath, old.RemotePath)
		if err != nil || marker == nil || *marker != *oldMarker {
			t.Fatalf("old marker changed: %+v, %v", marker, err)
		}
		if !bridge.CurrentMarker(context.Background(), oldIdentity, func() bool { return true }) {
			t.Fatal("old route lost")
		}
	}
	assertOld()
	if err := service.RemoteSSHClose("rnew"); err == nil {
		t.Fatal("staged connection was not pinned")
	}
	manager.mu.Lock()
	closed := append([]string(nil), manager.closed...)
	manager.mu.Unlock()
	if len(closed) != 0 {
		t.Fatalf("connection prematurely closed: %v", closed)
	}
	revoked, err := service.RemoteSSHRevokeUnclaimed("operation-5", "rnew")
	requireUnclaimedKind(t, revoked, err, "revoked")
	assertOld()
	claimed, err := service.RemoteSSHClaimSelection("operation-5")
	requireUnclaimedKind(t, claimed, err, "revoked")
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.closed) != 1 || manager.closed[0] != "rnew" {
		t.Fatalf("closed = %v", manager.closed)
	}
}

func TestUnclaimedRevokeSameConnectionKeepsOldWorkspaceAlive(t *testing.T) {
	service, bridge, manager, _ := unclaimedFixture(t)
	old, err := service.RemoteSSHSelectDirectory("rold", "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	selected, err := service.RemoteSSHSelectUnclaimed("same-connection", "rold", "/srv/project")
	if err != nil || selected.Kind != "selected" {
		t.Fatalf("selection = %+v, %v", selected, err)
	}
	revoked, err := service.RemoteSSHRevokeUnclaimed("same-connection", "rold")
	requireUnclaimedKind(t, revoked, err, "revoked")
	marker, err := readRemoteWorkspaceMarker(old.MarkerPath, old.RemotePath)
	if err != nil || marker == nil || marker.ConnectionID != "rold" {
		t.Fatalf("old marker lost: %+v, %v", marker, err)
	}
	identity := MarkerIdentity{MarkerRoot: old.MarkerPath, RemoteRoot: old.RemotePath, ConnectionID: "rold", Generation: marker.Generation}
	if !bridge.CurrentMarker(context.Background(), identity, func() bool { return true }) {
		t.Fatal("old route lost")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.closed) != 0 {
		t.Fatalf("old connection closed: %v", manager.closed)
	}
}

func TestUnclaimedExistingMarkerClaimCommitsAndClosesOld(t *testing.T) {
	service, bridge, manager, _ := unclaimedFixture(t)
	old, err := service.RemoteSSHSelectDirectory("rold", "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	oldMarker, err := readRemoteWorkspaceMarker(old.MarkerPath, old.RemotePath)
	if err != nil || oldMarker == nil {
		t.Fatal(err)
	}
	selected, err := service.RemoteSSHSelectUnclaimed("operation-rebind", "rnew", "/srv/project")
	if err != nil || selected.Kind != "selected" {
		t.Fatalf("selection = %+v, %v", selected, err)
	}
	claimed, err := service.RemoteSSHClaimSelection("operation-rebind")
	requireUnclaimedKind(t, claimed, err, "claimed")
	marker, err := readRemoteWorkspaceMarker(old.MarkerPath, old.RemotePath)
	if err != nil || marker == nil || marker.ConnectionID != "rnew" || marker.Generation <= oldMarker.Generation {
		t.Fatalf("committed marker = %+v, %v", marker, err)
	}
	identity := MarkerIdentity{MarkerRoot: old.MarkerPath, RemoteRoot: old.RemotePath, ConnectionID: "rnew", Generation: marker.Generation}
	if !bridge.CurrentMarker(context.Background(), identity, func() bool { return true }) {
		t.Fatal("new route not committed")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.closed) != 1 || manager.closed[0] != "rold" {
		t.Fatalf("closed = %v", manager.closed)
	}
}

func TestUnclaimedTwoStagedRebindsCommitOnlyFirstClaim(t *testing.T) {
	service, bridge, manager, _ := unclaimedFixture(t)
	old, err := service.RemoteSSHSelectDirectory("rold", "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	for _, selection := range []struct{ operation, connection string }{
		{"first-rebind", "rnew"}, {"second-rebind", "rnext"},
	} {
		selected, err := service.RemoteSSHSelectUnclaimed(selection.operation, selection.connection, "/srv/project")
		if err != nil || selected.Kind != "selected" || selected.MarkerPath != old.MarkerPath {
			t.Fatalf("selection = %+v, %v", selected, err)
		}
	}
	marker, err := readRemoteWorkspaceMarker(old.MarkerPath, old.RemotePath)
	if err != nil || marker == nil || marker.ConnectionID != "rold" {
		t.Fatalf("staging changed marker: %+v, %v", marker, err)
	}
	claimed, err := service.RemoteSSHClaimSelection("second-rebind")
	requireUnclaimedKind(t, claimed, err, "claimed")
	claimed, err = service.RemoteSSHClaimSelection("first-rebind")
	requireUnclaimedKind(t, claimed, err, "missing")
	revoked, err := service.RemoteSSHRevokeUnclaimed("first-rebind", "rnew")
	requireUnclaimedKind(t, revoked, err, "revoked")
	marker, err = readRemoteWorkspaceMarker(old.MarkerPath, old.RemotePath)
	if err != nil || marker == nil || marker.ConnectionID != "rnext" {
		t.Fatalf("committed marker lost: %+v, %v", marker, err)
	}
	identity := MarkerIdentity{MarkerRoot: old.MarkerPath, RemoteRoot: old.RemotePath, ConnectionID: "rnext", Generation: marker.Generation}
	if !bridge.CurrentMarker(context.Background(), identity, func() bool { return true }) {
		t.Fatal("committed route lost")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.closed) != 2 || manager.closed[0] != "rold" || manager.closed[1] != "rnew" {
		t.Fatalf("closed = %v", manager.closed)
	}
}

func TestUnclaimedStagedRebindRejectsOldMarkerFileReplacement(t *testing.T) {
	service, _, manager, _ := unclaimedFixture(t)
	old, err := service.RemoteSSHSelectDirectory("rold", "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	selected, err := service.RemoteSSHSelectUnclaimed("file-replaced", "rnew", "/srv/project")
	if err != nil || selected.Kind != "selected" {
		t.Fatalf("selection = %+v, %v", selected, err)
	}
	filename := filepath.Join(old.MarkerPath, remoteWorkspaceMarkerName)
	data, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	temporary, err := os.CreateTemp(old.MarkerPath, ".replacement-*")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := temporary.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := temporary.Chmod(0o600); err != nil {
		t.Fatal(err)
	}
	if err := temporary.Close(); err != nil {
		t.Fatal(err)
	}
	if err := replaceMarkerFile(temporary.Name(), filename); err != nil {
		t.Fatal(err)
	}
	replaced, err := os.Lstat(filename)
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := service.RemoteSSHClaimSelection("file-replaced")
	requireUnclaimedKind(t, claimed, err, "missing")
	revoked, err := service.RemoteSSHRevokeUnclaimed("file-replaced", "rnew")
	requireUnclaimedKind(t, revoked, err, "revoked")
	current, err := os.Lstat(filename)
	if err != nil || !os.SameFile(replaced, current) {
		t.Fatalf("replacement removed: %v", err)
	}
	if service.remoteMarkers[old.MarkerPath] != "rold" {
		t.Fatalf("old reference lost: %v", service.remoteMarkers)
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.closed) != 1 || manager.closed[0] != "rnew" {
		t.Fatalf("closed = %v", manager.closed)
	}
}

func TestUnclaimedStagedRebindClaimFailureLeavesOldBinding(t *testing.T) {
	service, bridge, manager, _ := unclaimedFixture(t)
	old, err := service.RemoteSSHSelectDirectory("rold", "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	oldMarker, err := readRemoteWorkspaceMarker(old.MarkerPath, old.RemotePath)
	if err != nil || oldMarker == nil {
		t.Fatal(err)
	}
	selected, err := service.RemoteSSHSelectUnclaimed("failed-rebind", "rnew", "/srv/project")
	if err != nil || selected.Kind != "selected" {
		t.Fatalf("selection = %+v, %v", selected, err)
	}
	service.remoteBridge = rejectingWriterBridge{bridge}
	if _, err := service.RemoteSSHClaimSelection("failed-rebind"); err == nil {
		t.Fatal("failed publication was claimed")
	}
	marker, err := readRemoteWorkspaceMarker(old.MarkerPath, old.RemotePath)
	if err != nil || marker == nil || *marker != *oldMarker {
		t.Fatalf("old marker lost: %+v, %v", marker, err)
	}
	identity := MarkerIdentity{MarkerRoot: old.MarkerPath, RemoteRoot: old.RemotePath, ConnectionID: "rold", Generation: marker.Generation}
	if !bridge.CurrentMarker(context.Background(), identity, func() bool { return true }) {
		t.Fatal("old route lost")
	}
	revoked, err := service.RemoteSSHRevokeUnclaimed("failed-rebind", "rnew")
	requireUnclaimedKind(t, revoked, err, "revoked")
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.closed) != 1 || manager.closed[0] != "rnew" {
		t.Fatalf("closed = %v", manager.closed)
	}
}

type blockingClaimBridge struct {
	*Bridge
	entered chan struct{}
	release chan struct{}
}

type unverifiedClaimBridge struct{ *Bridge }

func (b unverifiedClaimBridge) CurrentMarker(context.Context, MarkerIdentity, func() bool) bool {
	return false
}

type deadlineInWriterBridge struct{ *Bridge }

func (b deadlineInWriterBridge) PublishMarker(ctx context.Context, root, remoteRoot, connectionID string, previous uint64, write func(uint64) error) (uint64, error) {
	return b.Bridge.PublishMarker(ctx, root, remoteRoot, connectionID, previous, func(generation uint64) error {
		<-ctx.Done()
		return write(generation)
	})
}

func (b deadlineInWriterBridge) CurrentMarker(ctx context.Context, identity MarkerIdentity, verify func() bool) bool {
	if ctx.Err() != nil {
		return false
	}
	return b.Bridge.CurrentMarker(ctx, identity, verify)
}

func TestUnclaimedStagedClaimVerifiesAfterRequestCancellation(t *testing.T) {
	service, bridge, manager, _ := unclaimedFixture(t)
	old, err := service.RemoteSSHSelectDirectory("rold", "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	selected, err := service.RemoteSSHSelectUnclaimed("late-claim", "rnew", "/srv/project")
	if err != nil || selected.Kind != "selected" {
		t.Fatalf("selection = %+v, %v", selected, err)
	}
	claimCtx, cancel := context.WithTimeout(service.ctx, 250*time.Millisecond)
	defer cancel()
	service.ctx = claimCtx
	service.remoteBridge = deadlineInWriterBridge{Bridge: bridge}
	claimed, err := service.RemoteSSHClaimSelection("late-claim")
	requireUnclaimedKind(t, claimed, err, "claimed")
	marker, err := readRemoteWorkspaceMarker(old.MarkerPath, old.RemotePath)
	if err != nil || marker == nil || marker.ConnectionID != "rnew" {
		t.Fatalf("committed marker = %+v, %v", marker, err)
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.closed) != 1 || manager.closed[0] != "rold" {
		t.Fatalf("old connection not retired: %v", manager.closed)
	}
}

func TestUnclaimedStagedUnverifiedCommitKeepsOldConnection(t *testing.T) {
	service, bridge, manager, _ := unclaimedFixture(t)
	_, err := service.RemoteSSHSelectDirectory("rold", "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.RemoteSSHSelectUnclaimed("unverified", "rnew", "/srv/project"); err != nil {
		t.Fatal(err)
	}
	service.remoteBridge = unverifiedClaimBridge{bridge}
	claimed, err := service.RemoteSSHClaimSelection("unverified")
	requireUnclaimedKind(t, claimed, err, "missing")
	revoked, err := service.RemoteSSHRevokeUnclaimed("unverified", "rnew")
	requireUnclaimedKind(t, revoked, err, "retained")
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.closed) != 0 {
		t.Fatalf("old connection closed after unverified publication: %v", manager.closed)
	}
}

func (b blockingClaimBridge) PublishMarker(ctx context.Context, root, remoteRoot, connectionID string, previous uint64, write func(uint64) error) (uint64, error) {
	return b.Bridge.PublishMarker(ctx, root, remoteRoot, connectionID, previous, func(generation uint64) error {
		close(b.entered)
		<-b.release
		return write(generation)
	})
}

func TestUnclaimedStagedClaimAndRevokeLinearize(t *testing.T) {
	service, bridge, manager, _ := unclaimedFixture(t)
	old, err := service.RemoteSSHSelectDirectory("rold", "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	selected, err := service.RemoteSSHSelectUnclaimed("claim-race", "rnew", "/srv/project")
	if err != nil || selected.Kind != "selected" {
		t.Fatalf("selection = %+v, %v", selected, err)
	}
	blocking := blockingClaimBridge{Bridge: bridge, entered: make(chan struct{}), release: make(chan struct{})}
	service.remoteBridge = blocking
	claimDone := make(chan UnclaimedActionResult, 1)
	go func() { claimed, _ := service.RemoteSSHClaimSelection("claim-race"); claimDone <- claimed }()
	select {
	case <-blocking.entered:
	case <-time.After(time.Second):
		t.Fatal("claim did not enter publication")
	}
	revokeDone := make(chan UnclaimedActionResult, 1)
	go func() { revoked, _ := service.RemoteSSHRevokeUnclaimed("claim-race", "rnew"); revokeDone <- revoked }()
	close(blocking.release)
	select {
	case claimed := <-claimDone:
		if claimed.Kind != "claimed" {
			t.Fatalf("claim = %+v", claimed)
		}
	case <-time.After(time.Second):
		t.Fatal("claim did not finish")
	}
	select {
	case revoked := <-revokeDone:
		if revoked.Kind != "claimed" {
			t.Fatalf("revoke = %+v", revoked)
		}
	case <-time.After(time.Second):
		t.Fatal("revoke did not finish")
	}
	marker, err := readRemoteWorkspaceMarker(old.MarkerPath, old.RemotePath)
	if err != nil || marker == nil || marker.ConnectionID != "rnew" {
		t.Fatalf("committed marker = %+v, %v", marker, err)
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.closed) != 1 || manager.closed[0] != "rold" {
		t.Fatalf("closed = %v", manager.closed)
	}
}

func TestUnclaimedStagedRebindRejectsMarkerRootReplacement(t *testing.T) {
	service, _, manager, _ := unclaimedFixture(t)
	old, err := service.RemoteSSHSelectDirectory("rold", "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	selected, err := service.RemoteSSHSelectUnclaimed("root-replaced", "rnew", "/srv/project")
	if err != nil || selected.Kind != "selected" {
		t.Fatalf("selection = %+v, %v", selected, err)
	}
	backup := old.MarkerPath + "-old"
	if err := os.Rename(old.MarkerPath, backup); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(old.MarkerPath, 0o700); err != nil {
		t.Fatal(err)
	}
	claimed, err := service.RemoteSSHClaimSelection("root-replaced")
	requireUnclaimedKind(t, claimed, err, "missing")
	revoked, err := service.RemoteSSHRevokeUnclaimed("root-replaced", "rnew")
	requireUnclaimedKind(t, revoked, err, "revoked")
	if _, err := os.Stat(filepath.Join(backup, remoteWorkspaceMarkerName)); err != nil {
		t.Fatalf("original marker lost: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(old.MarkerPath, remoteWorkspaceMarkerName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("replacement root modified: %v", err)
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if len(manager.closed) != 1 || manager.closed[0] != "rnew" {
		t.Fatalf("closed = %v", manager.closed)
	}
}

func TestUnclaimedSupersededGenerationCannotDeleteNewMarker(t *testing.T) {
	service, bridge, _, _ := unclaimedFixture(t)
	first, err := service.RemoteSSHSelectUnclaimed("operation-6", "rnew", "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	second, err := service.RemoteSSHSelectUnclaimed("operation-7", "rnext", "/srv/project")
	if err != nil || second.MarkerPath != first.MarkerPath {
		t.Fatalf("replacement = %+v, %v", second, err)
	}
	claimed, err := service.RemoteSSHClaimSelection("operation-7")
	requireUnclaimedKind(t, claimed, err, "claimed")
	revoked, err := service.RemoteSSHRevokeUnclaimed("operation-6", "rnew")
	requireUnclaimedKind(t, revoked, err, "retained")
	claimed, err = service.RemoteSSHClaimSelection("operation-6")
	requireUnclaimedKind(t, claimed, err, "missing")
	marker, err := readRemoteWorkspaceMarker(second.MarkerPath, "/srv/project")
	if err != nil || marker == nil || marker.ConnectionID != "rnext" {
		t.Fatalf("new generation damaged: %+v, %v", marker, err)
	}
	if !bridge.CurrentMarker(context.Background(), service.unclaimed["operation-7"].marker, func() bool { return true }) {
		t.Fatal("new generation route lost")
	}
}

func TestUnclaimedFileIdentityMismatchCannotDelete(t *testing.T) {
	service, bridge, _, _ := unclaimedFixture(t)
	selected, err := service.RemoteSSHSelectUnclaimed("operation-8", "rnew", "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(selected.MarkerPath, remoteWorkspaceMarkerName)
	data, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	temporary, err := os.CreateTemp(selected.MarkerPath, ".replacement-*")
	if err != nil {
		t.Fatal(err)
	}
	if err := temporary.Chmod(0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := temporary.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := temporary.Close(); err != nil {
		t.Fatal(err)
	}
	if err := replaceMarkerFile(temporary.Name(), filename); err != nil {
		t.Fatal(err)
	}
	revoked, err := service.RemoteSSHRevokeUnclaimed("operation-8", "rnew")
	requireUnclaimedKind(t, revoked, err, "retained")
	if _, err := os.Stat(filename); err != nil {
		t.Fatalf("replaced file was removed: %v", err)
	}
	if !bridge.CurrentMarker(context.Background(), service.unclaimed["operation-8"].marker, func() bool { return true }) {
		t.Fatal("route wrongly revoked")
	}
	claimed, err := service.RemoteSSHClaimSelection("operation-8")
	requireUnclaimedKind(t, claimed, err, "missing")
}

func TestUnclaimedMarkerRootReplacementCannotDelete(t *testing.T) {
	service, _, _, _ := unclaimedFixture(t)
	selected, err := service.RemoteSSHSelectUnclaimed("operation-root", "rnew", "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	backup := selected.MarkerPath + "-old"
	if err := os.Rename(selected.MarkerPath, backup); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Symlink(outside, selected.MarkerPath); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	revoked, err := service.RemoteSSHRevokeUnclaimed("operation-root", "rnew")
	requireUnclaimedKind(t, revoked, err, "retained")
	if _, err := os.Stat(filepath.Join(backup, remoteWorkspaceMarkerName)); err != nil {
		t.Fatalf("original marker removed: %v", err)
	}
	claimed, err := service.RemoteSSHClaimSelection("operation-root")
	requireUnclaimedKind(t, claimed, err, "missing")
}

func TestUnclaimedRevokeWaitsForDispatchedBridgeRequest(t *testing.T) {
	service, _, _, _ := unclaimedFixture(t)
	entered := make(chan struct{})
	release := make(chan struct{})
	bridge, err := NewBridge("abcdefghijklmnopqrstuvwxyz0123456789abcdef", func(context.Context, string, string, string, []byte) (int, []byte, error) {
		close(entered)
		<-release
		return http.StatusOK, []byte(`{"ok":true}`), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bridge.Close() })
	service.remoteBridge = bridge
	selected, err := service.RemoteSSHSelectUnclaimed("operation-bridge", "rnew", "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	identity := service.unclaimed["operation-bridge"].marker
	request := httptest.NewRequest(http.MethodPost, "/v1/read_file", strings.NewReader("{}"))
	request.Header.Set("Authorization", "Bearer abcdefghijklmnopqrstuvwxyz0123456789abcdef")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Coding-Remote-Connection", identity.ConnectionID)
	request.Header.Set(remoteBridgeMarkerRootHeader, identity.MarkerRoot)
	request.Header.Set(remoteBridgeRemoteRootHeader, identity.RemoteRoot)
	request.Header.Set(remoteBridgeMarkerGenerationHeader, strconv.FormatUint(identity.Generation, 10))
	response := httptest.NewRecorder()
	requestDone := make(chan struct{})
	go func() { bridge.serveHTTP(response, request); close(requestDone) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("proxy did not start")
	}
	revoked := make(chan UnclaimedActionResult, 1)
	go func() { result, _ := service.RemoteSSHRevokeUnclaimed("operation-bridge", "rnew"); revoked <- result }()
	select {
	case result := <-revoked:
		t.Fatalf("revoked in-flight route: %+v", result)
	case <-time.After(30 * time.Millisecond):
	}
	if _, err := os.Stat(filepath.Join(selected.MarkerPath, remoteWorkspaceMarkerName)); err != nil {
		t.Fatalf("in-flight marker removed: %v", err)
	}
	close(release)
	select {
	case <-requestDone:
	case <-time.After(time.Second):
		t.Fatal("proxy did not finish")
	}
	select {
	case result := <-revoked:
		if result.Kind != "revoked" {
			t.Fatalf("revoke = %+v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("revoke did not finish after proxy")
	}
}

type rejectingWriterBridge struct{ *Bridge }

func (b rejectingWriterBridge) PublishMarker(ctx context.Context, root, remoteRoot, connectionID string, previous uint64, _ func(uint64) error) (uint64, error) {
	return b.Bridge.PublishMarker(ctx, root, remoteRoot, connectionID, previous, func(uint64) error { return errors.New("injected marker write failure") })
}

func TestUnclaimedFailedPublicationDoesNotBecomeClaimable(t *testing.T) {
	service, bridge, manager, home := unclaimedFixture(t)
	service.remoteBridge = rejectingWriterBridge{bridge}
	if _, err := service.RemoteSSHSelectUnclaimed("operation-9", "rnew", "/srv/project"); err == nil {
		t.Fatal("injected writer failure was accepted")
	}
	claimed, err := service.RemoteSSHClaimSelection("operation-9")
	requireUnclaimedKind(t, claimed, err, "missing")
	revoked, err := service.RemoteSSHRevokeUnclaimed("operation-9", "rnew")
	requireUnclaimedKind(t, revoked, err, "revoked")
	root, err := remoteMarkerRoot(home, manager.connections["rnew"], "/srv/project")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(root, remoteWorkspaceMarkerName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed writer left marker: %v", err)
	}
}

func TestUnclaimedStrictIDDuplicateAndCapacity(t *testing.T) {
	service, _, _, _ := unclaimedFixture(t)
	if _, err := service.RemoteSSHRevokeUnclaimed("bad id", "rnew"); err == nil {
		t.Fatal("invalid id accepted")
	}
	selected, err := service.RemoteSSHSelectUnclaimed("operation-10", "rnew", "/srv/project")
	if err != nil || selected.Kind != "selected" {
		t.Fatalf("selection = %+v, %v", selected, err)
	}
	if _, err := service.RemoteSSHSelectUnclaimed("operation-10", "rnew", "/srv/project"); err == nil {
		t.Fatal("duplicate operation selected")
	}
	for i := len(service.unclaimed); i < maxUnclaimedOperations; i++ {
		service.unclaimed[fmt.Sprintf("filled-%d", i)] = &unclaimedOperation{connectionID: "rnew", state: unclaimedRevoked}
	}
	if _, err := service.RemoteSSHRevokeUnclaimed("overflow", "rnew"); err == nil {
		t.Fatal("tombstone limit exceeded")
	}
}

func TestUnclaimedClaimAndRevokeRaceLinearizes(t *testing.T) {
	for index := 0; index < 12; index++ {
		t.Run(fmt.Sprint(index), func(t *testing.T) {
			service, _, _, _ := unclaimedFixture(t)
			selected, err := service.RemoteSSHSelectUnclaimed("raced", "rnew", "/srv/project")
			if err != nil {
				t.Fatal(err)
			}
			var wg sync.WaitGroup
			var claim, revoke UnclaimedActionResult
			var claimErr, revokeErr error
			wg.Add(2)
			go func() { defer wg.Done(); claim, claimErr = service.RemoteSSHClaimSelection("raced") }()
			go func() { defer wg.Done(); revoke, revokeErr = service.RemoteSSHRevokeUnclaimed("raced", "rnew") }()
			wg.Wait()
			if claimErr != nil || revokeErr != nil {
				t.Fatalf("claim/revoke errors = %v, %v", claimErr, revokeErr)
			}
			_, fileErr := os.Stat(filepath.Join(selected.MarkerPath, remoteWorkspaceMarkerName))
			switch {
			case claim.Kind == "claimed" && revoke.Kind == "claimed":
				if fileErr != nil {
					t.Fatalf("claimed marker lost: %v", fileErr)
				}
			case claim.Kind == "revoked" && revoke.Kind == "revoked":
				if !errors.Is(fileErr, os.ErrNotExist) {
					t.Fatalf("revoked marker remains: %v", fileErr)
				}
			default:
				t.Fatalf("nonlinearizable claim=%q revoke=%q", claim.Kind, revoke.Kind)
			}
		})
	}
}
