package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/deepseek-ai/coding/apps/desktop/internal/desktopremote"
	"github.com/deepseek-ai/coding/apps/desktop/internal/helperwire"
	"github.com/deepseek-ai/coding/apps/desktop/internal/instance"
)

func TestParseConfigRequiresExplicitIsolatedPaths(t *testing.T) {
	for _, test := range []struct {
		name  string
		args  []string
		valid bool
	}{
		{"missing home", []string{"--cwd", "/tmp/workspace", "--repo-root", "/tmp/source", "--host-version", "dev"}, false},
		{"missing cwd", []string{"--home", "/tmp/home", "--repo-root", "/tmp/source", "--host-version", "dev"}, false},
		{"missing version", []string{"--home", "/tmp/home", "--cwd", "/tmp/workspace", "--repo-root", "/tmp/source"}, false},
		{"relative home", []string{"--home", "home", "--cwd", "/tmp/workspace", "--repo-root", "/tmp/source", "--host-version", "dev"}, false},
		{"missing runtime", []string{"--home", "/tmp/home", "--cwd", "/tmp/workspace", "--host-version", "dev"}, false},
		{"ambiguous runtime", []string{"--home", "/tmp/home", "--cwd", "/tmp/workspace", "--repo-root", "/tmp/source", "--runtime-root", "/tmp/resources", "--host-version", "dev"}, false},
		{"arbitrary command", []string{"--home", "/tmp/home", "--cwd", "/tmp/workspace", "--repo-root", "/tmp/source", "--host-version", "dev", "--host-command", "sh"}, false},
		{"development", []string{"--home", "/tmp/home", "--cwd", "/tmp/workspace", "--repo-root", "/tmp/source", "--host-version", "dev"}, true},
		{"packaged", []string{"--home", "/tmp/home", "--cwd", "/tmp/workspace", "--runtime-root", "/tmp/resources", "--host-version", "1.2.3"}, true},
		{"packaged exclusive", []string{"--home", "/tmp/home", "--cwd", "/tmp/workspace", "--runtime-root", "/tmp/resources", "--host-version", "1.2.3", "--exclusive-desktop-instance"}, true},
		{"development exclusive", []string{"--home", "/tmp/home", "--cwd", "/tmp/workspace", "--repo-root", "/tmp/source", "--host-version", "dev", "--exclusive-desktop-instance"}, false},
		{"legacy exclusive flag", []string{"--home", "/tmp/home", "--cwd", "/tmp/workspace", "--runtime-root", "/tmp/resources", "--host-version", "1.2.3", "--exclusive-wails-instance"}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := parseConfig(test.args)
			if (err == nil) != test.valid {
				t.Fatalf("parse valid = %v, error = %v", err == nil, err)
			}
		})
	}
}

func TestExclusiveDesktopInstanceRejectsLiveOwnerBeforeHomeWrites(t *testing.T) {
	t.Setenv("DSH_DESKTOP_BROWSER_BRIDGE_ORIGIN", "ws://127.0.0.1:49152/browser-bridge")
	t.Setenv("DSH_DESKTOP_BROWSER_BRIDGE_TOKEN", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
	lockDirectory, err := os.MkdirTemp("", "ci-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(lockDirectory) })
	t.Setenv("TMPDIR", lockDirectory)
	t.Setenv("LOCALAPPDATA", lockDirectory)
	owner, primary, err := instance.Acquire(nil, false)
	if err != nil || !primary {
		t.Fatalf("acquire installed desktop lock = %v, %v", primary, err)
	}
	t.Cleanup(owner.Close)
	go owner.Serve(nil)
	home := filepath.Join(t.TempDir(), "not-created")
	args := []string{"--home", home, "--cwd", t.TempDir(), "--runtime-root", t.TempDir(), "--host-version", "dev", "--exclusive-desktop-instance"}
	var stdout bytes.Buffer
	if err := run(args, strings.NewReader(""), &stdout); err == nil || err.Error() != "installed desktop instance already owns the shared lock" {
		t.Fatalf("helper did not reach installed desktop lock: %v", err)
	}
	if stdout.Len() != 0 {
		t.Fatalf("stdout unexpectedly contains protocol data: %q", stdout.String())
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatalf("helper touched shared home: %v", err)
	}
}

func TestPackagedHelperRequiresBrowserBridgeBeforeHomeWrites(t *testing.T) {
	for _, key := range []string{"DSH_DESKTOP_BROWSER_BRIDGE_ORIGIN", "DSH_DESKTOP_BROWSER_BRIDGE_TOKEN"} {
		t.Setenv(key, "")
		if err := os.Unsetenv(key); err != nil {
			t.Fatal(err)
		}
	}
	home := filepath.Join(t.TempDir(), "not-created")
	args := []string{"--home", home, "--cwd", t.TempDir(), "--runtime-root", t.TempDir(), "--host-version", "dev"}
	var stdout bytes.Buffer
	if err := run(args, strings.NewReader(""), &stdout); err == nil || err.Error() != "packaged helper requires desktop browser bridge" {
		t.Fatalf("packaged helper without browser bridge = %v", err)
	}
	if stdout.Len() != 0 {
		t.Fatalf("helper wrote protocol data before bridge validation: %q", stdout.String())
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatalf("helper touched home before bridge validation: %v", err)
	}
}

func TestDevelopmentHelperAllowsAbsentBrowserBridge(t *testing.T) {
	for _, key := range []string{"DSH_DESKTOP_BROWSER_BRIDGE_ORIGIN", "DSH_DESKTOP_BROWSER_BRIDGE_TOKEN"} {
		t.Setenv(key, "")
		if err := os.Unsetenv(key); err != nil {
			t.Fatal(err)
		}
	}
	home := filepath.Join(t.TempDir(), "not-created")
	args := []string{"--home", home, "--cwd", t.TempDir(), "--repo-root", t.TempDir(), "--host-version", "dev"}
	var stdout bytes.Buffer
	if err := run(args, strings.NewReader(""), &stdout); err == nil || err.Error() != "development Host entry is unavailable" {
		t.Fatalf("development helper did not reach Host entry check: %v", err)
	}
	if stdout.Len() != 0 {
		t.Fatalf("helper wrote protocol data before Host entry check: %q", stdout.String())
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatalf("helper touched home before Host entry check: %v", err)
	}
}

func TestExclusiveDesktopInstanceOwnsInstalledLock(t *testing.T) {
	lockDirectory, err := os.MkdirTemp("", "ci-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(lockDirectory) })
	t.Setenv("TMPDIR", lockDirectory)
	t.Setenv("LOCALAPPDATA", lockDirectory)
	lock, err := acquireExclusiveInstance(config{runtimeRoot: t.TempDir(), exclusiveDesktopInstance: true})
	if err != nil || lock == nil {
		t.Fatalf("helper lock = %v, %v", lock, err)
	}
	t.Cleanup(lock.Close)
	go lock.Serve(nil)
	_, primary, err := instance.Acquire(nil, false)
	if err != nil || primary {
		t.Fatalf("second installed desktop acquisition = %v, %v", primary, err)
	}
}

func TestPrepareAgentsHomePrivateAndRejectsSymlink(t *testing.T) {
	home := filepath.Join(t.TempDir(), "isolated")
	path, err := prepareAgentsHome(home)
	if err != nil || path != filepath.Join(home, "agents") {
		t.Fatalf("agent home = %q, %v", path, err)
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("agent home metadata = %v, %v", info, err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
		t.Fatalf("agent home mode = %o", info.Mode().Perm())
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), path); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := prepareAgentsHome(home); err == nil {
		t.Fatal("symlinked agent home was accepted")
	}
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(home, alias); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := prepareAgentsHome(alias); err == nil {
		t.Fatal("symlinked helper home was accepted")
	}
}

func TestBrowserBridgeEnvironment(t *testing.T) {
	const origin = "ws://127.0.0.1:49152/browser-bridge"
	const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	tests := []struct {
		name, origin, token   string
		withOrigin, withToken bool
		valid                 bool
	}{
		{name: "absent", valid: true},
		{name: "valid", origin: origin, token: token, withOrigin: true, withToken: true, valid: true},
		{name: "missing origin", token: token, withToken: true},
		{name: "missing token", origin: origin, withOrigin: true},
		{name: "empty origin", token: token, withOrigin: true, withToken: true},
		{name: "empty token", origin: origin, withOrigin: true, withToken: true},
		{name: "remote address", origin: "ws://192.0.2.1:49152/browser-bridge", token: token, withOrigin: true, withToken: true},
		{name: "host alias", origin: "ws://localhost:49152/browser-bridge", token: token, withOrigin: true, withToken: true},
		{name: "wrong scheme", origin: "wss://127.0.0.1:49152/browser-bridge", token: token, withOrigin: true, withToken: true},
		{name: "wrong path", origin: "ws://127.0.0.1:49152/remote-bridge", token: token, withOrigin: true, withToken: true},
		{name: "credentials", origin: "ws://user@127.0.0.1:49152/browser-bridge", token: token, withOrigin: true, withToken: true},
		{name: "query", origin: origin + "?token=" + token, token: token, withOrigin: true, withToken: true},
		{name: "port zero", origin: "ws://127.0.0.1:0/browser-bridge", token: token, withOrigin: true, withToken: true},
		{name: "port overflow", origin: "ws://127.0.0.1:65536/browser-bridge", token: token, withOrigin: true, withToken: true},
		{name: "leading zero port", origin: "ws://127.0.0.1:0123/browser-bridge", token: token, withOrigin: true, withToken: true},
		{name: "short token", origin: origin, token: token[:63], withOrigin: true, withToken: true},
		{name: "uppercase token", origin: origin, token: "A" + token[1:], withOrigin: true, withToken: true},
		{name: "non-hex token", origin: origin, token: "g" + token[1:], withOrigin: true, withToken: true},
		{name: "line break token", origin: origin, token: token + "\n", withOrigin: true, withToken: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("DSH_DESKTOP_BROWSER_BRIDGE_ORIGIN", test.origin)
			t.Setenv("DSH_DESKTOP_BROWSER_BRIDGE_TOKEN", test.token)
			if !test.withOrigin {
				if err := os.Unsetenv("DSH_DESKTOP_BROWSER_BRIDGE_ORIGIN"); err != nil {
					t.Fatal(err)
				}
			}
			if !test.withToken {
				if err := os.Unsetenv("DSH_DESKTOP_BROWSER_BRIDGE_TOKEN"); err != nil {
					t.Fatal(err)
				}
			}
			got, err := browserBridgeEnvironment()
			if (err == nil) != test.valid {
				t.Fatalf("bridge environment valid = %v, want %v", err == nil, test.valid)
			}
			if err != nil && (strings.Contains(err.Error(), test.token) && test.token != "" ||
				strings.Contains(err.Error(), test.origin) && test.origin != "") {
				t.Fatal("bridge secret leaked into validation error")
			}
			if test.valid && (got.origin != test.origin || got.token != test.token) {
				t.Fatal("bridge environment not preserved")
			}
		})
	}
}

func TestHostEnvironmentOverridesAmbientAgentHome(t *testing.T) {
	t.Setenv("DSH_AGENTS_HOME", "/global/agents")
	home := filepath.Join(t.TempDir(), "isolated")
	agents, err := prepareAgentsHome(home)
	if err != nil {
		t.Fatal(err)
	}
	env := hostEnvironment("http://127.0.0.1:1234", "private-bridge-token", agents, browserBridgeConfig{})
	if env["DSH_AGENTS_HOME"] != agents || env["DSH_AGENTS_HOME"] == os.Getenv("DSH_AGENTS_HOME") {
		t.Fatalf("agent home not isolated: %q", env["DSH_AGENTS_HOME"])
	}
	if env["DSH_REMOTE_BRIDGE_URL"] != "http://127.0.0.1:1234" || env["DSH_REMOTE_BRIDGE_TOKEN"] != "private-bridge-token" {
		t.Fatal("remote bridge environment changed")
	}
	if _, present := env["DSH_DESKTOP_BROWSER_BRIDGE_TOKEN"]; present {
		t.Fatal("browser bridge token unexpectedly set")
	}
}

func TestHostEnvironmentForwardsBrowserBridgeWithoutExposingItElsewhere(t *testing.T) {
	browser := browserBridgeConfig{
		origin: "ws://127.0.0.1:49152/browser-bridge",
		token:  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	}
	env := hostEnvironment("http://127.0.0.1:1234", "remote-token", "/private/agents", browser)
	if env["DSH_DESKTOP_BROWSER_BRIDGE_ORIGIN"] != browser.origin ||
		env["DSH_DESKTOP_BROWSER_BRIDGE_TOKEN"] != browser.token {
		t.Fatal("browser bridge environment not forwarded to Host")
	}
	if env["DSH_REMOTE_BRIDGE_TOKEN"] != "remote-token" {
		t.Fatal("remote bridge token changed")
	}
}

func TestInvalidBrowserBridgeRejectedBeforeHelperHomeWrites(t *testing.T) {
	const secret = "inherited-private-secret"
	t.Setenv("DSH_DESKTOP_BROWSER_BRIDGE_ORIGIN", "ws://127.0.0.1:49152/browser-bridge")
	t.Setenv("DSH_DESKTOP_BROWSER_BRIDGE_TOKEN", secret)
	home := filepath.Join(t.TempDir(), "not-created")
	args := []string{"--home", home, "--cwd", t.TempDir(), "--runtime-root", t.TempDir(), "--host-version", "dev"}
	var stdout bytes.Buffer
	err := run(args, strings.NewReader(""), &stdout)
	if err == nil || strings.Contains(err.Error(), secret) {
		t.Fatal("invalid bridge token must fail without exposing the secret")
	}
	if stdout.Len() != 0 {
		t.Fatal("invalid bridge token leaked to helper stdout")
	}
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatalf("helper touched home before bridge validation: %v", err)
	}
}

type blockedConnectService struct {
	*fakeService
	started chan struct{}
	closed  chan struct{}
	once    sync.Once
}

type stubbornConnectService struct {
	*fakeService
	started chan struct{}
	release chan struct{}
	closed  chan struct{}
	once    sync.Once
}

func (s *stubbornConnectService) RemoteSSHConnect(desktopremote.RemoteSSHConnectInput) (desktopremote.RemoteSSHConnectResult, error) {
	close(s.started)
	<-s.release
	return desktopremote.RemoteSSHConnectResult{Kind: "error"}, nil
}
func (s *stubbornConnectService) CloseAll(context.Context) error {
	s.once.Do(func() { close(s.closed) })
	return nil
}

func (s *blockedConnectService) RemoteSSHConnect(desktopremote.RemoteSSHConnectInput) (desktopremote.RemoteSSHConnectResult, error) {
	close(s.started)
	<-s.closed
	return desktopremote.RemoteSSHConnectResult{Kind: "error"}, nil
}
func (s *blockedConnectService) CloseAll(context.Context) error {
	s.once.Do(func() { close(s.closed) })
	return nil
}

func TestEOFClosesBlockedRemoteConnect(t *testing.T) {
	service := &blockedConnectService{fakeService: &fakeService{}, started: make(chan struct{}), closed: make(chan struct{})}
	reader, writer := io.Pipe()
	var output bytes.Buffer
	result := make(chan error, 1)
	go func() {
		result <- helperwire.ServeWithEmitter(context.Background(), reader, helperwire.NewEmitter(&output), &handler{service: service})
	}()
	request := `{"type":"request","protocol":1,"id":"request-1","method":"RemoteSSHConnect","payload":{"attemptId":"attempt-1","host":"example.com","port":22,"username":"coding","auth":{"kind":"password","secret":"test-only"}}}` + "\n"
	if _, err := io.WriteString(writer, request); err != nil {
		t.Fatal(err)
	}
	select {
	case <-service.started:
	case <-time.After(time.Second):
		t.Fatal("fake SSH connection did not start")
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-service.closed:
	case <-time.After(time.Second):
		t.Fatal("stdin EOF did not close active service")
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("serve after EOF: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("serve remained blocked after stdin EOF")
	}
	if strings.Contains(output.String(), "test-only") {
		t.Fatal("secret leaked into stdout")
	}
}

func TestEOFBindsServeEvenIfConnectIgnoresCancellation(t *testing.T) {
	service := &stubbornConnectService{fakeService: &fakeService{}, started: make(chan struct{}), release: make(chan struct{}), closed: make(chan struct{})}
	defer close(service.release)
	reader, writer := io.Pipe()
	var output bytes.Buffer
	result := make(chan error, 1)
	go func() {
		result <- helperwire.ServeWithEmitter(context.Background(), reader, helperwire.NewEmitter(&output), &handler{service: service})
	}()
	request := `{"type":"request","protocol":1,"id":"request-1","method":"RemoteSSHConnect","payload":{"attemptId":"attempt-1","host":"example.com","port":22,"username":"coding","auth":{"kind":"password","secret":"test-only"}}}` + "\n"
	if _, err := io.WriteString(writer, request); err != nil {
		t.Fatal(err)
	}
	select {
	case <-service.started:
	case <-time.After(time.Second):
		t.Fatal("connection did not start")
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-service.closed:
	case <-time.After(time.Second):
		t.Fatal("service not closed on EOF")
	}
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("serve after EOF: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("serve waited for cancellation-resistant Connect")
	}
	if strings.Contains(output.String(), "test-only") {
		t.Fatal("secret leaked into stdout")
	}
}

func TestInputEOFBeforeReadyCancelsHostLaunch(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stdin, writer := io.Pipe()
	reader := pumpInput(ctx, stdin, cancel)
	defer reader.Close()
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("parent EOF did not cancel startup")
	}
}

func TestInputPumpPreservesRequestBytes(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stdin, writer := io.Pipe()
	reader := pumpInput(ctx, stdin, cancel)
	defer reader.Close()
	const request = `{"type":"request"}` + "\n"
	written := make(chan error, 1)
	go func() { _, err := io.WriteString(writer, request); written <- err }()
	buf := make([]byte, len(request))
	if _, err := io.ReadFull(reader, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != request {
		t.Fatalf("forwarded bytes = %q", buf)
	}
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("reader EOF did not cancel input")
	}
}

type fakeService struct {
	method                   string
	connect                  desktopremote.RemoteSSHConnectInput
	connectionID, remotePath string
}

func (s *fakeService) RemoteSSHConnect(input desktopremote.RemoteSSHConnectInput) (desktopremote.RemoteSSHConnectResult, error) {
	s.method = "connect"
	s.connect = input
	return desktopremote.RemoteSSHConnectResult{Kind: "ready", ConnectionID: "connected"}, nil
}
func (s *fakeService) RemoteSSHListDirectories(id, path string) (desktopremote.RemoteSSHDirectoryListing, error) {
	s.method = "list"
	s.connectionID = id
	s.remotePath = path
	return desktopremote.RemoteSSHDirectoryListing{Path: path}, nil
}
func (s *fakeService) RemoteSSHSelectDirectory(id, path string) (desktopremote.RemoteSSHDirectorySelection, error) {
	s.method = "select"
	s.connectionID = id
	s.remotePath = path
	return desktopremote.RemoteSSHDirectorySelection{RemotePath: path}, nil
}
func (s *fakeService) RemoteSSHSelectUnclaimed(operationID, id, path string) (desktopremote.UnclaimedSelectionResult, error) {
	s.method = "select-unclaimed"
	s.connectionID = id
	s.remotePath = path
	return desktopremote.UnclaimedSelectionResult{Kind: "selected", MarkerPath: operationID}, nil
}
func (s *fakeService) RemoteSSHRevokeUnclaimed(operationID, id string) (desktopremote.UnclaimedActionResult, error) {
	s.method = "revoke-unclaimed"
	s.connectionID = id
	s.remotePath = operationID
	return desktopremote.UnclaimedActionResult{Kind: "revoked"}, nil
}
func (s *fakeService) RemoteSSHClaimSelection(operationID string) (desktopremote.UnclaimedActionResult, error) {
	s.method = "claim-selection"
	s.connectionID = operationID
	return desktopremote.UnclaimedActionResult{Kind: "claimed"}, nil
}
func (s *fakeService) RemoteSSHClose(id string) error {
	s.method = "close"
	s.connectionID = id
	return nil
}
func (s *fakeService) RemoteSSHCancelConnect(id string) error {
	s.method = "cancel"
	s.connectionID = id
	return nil
}
func (s *fakeService) RemoteSSHRejectHostKey(id string) error {
	s.method = "reject"
	s.connectionID = id
	return nil
}
func (s *fakeService) CloseAll(context.Context) error { s.method = "shutdown"; return nil }

func TestHandlerRoutesStrictPayloads(t *testing.T) {
	service := &fakeService{}
	h := &handler{service: service}
	for _, test := range []struct{ name, method, payload, want string }{
		{"connect", "RemoteSSHConnect", `{"attemptId":"attempt-1","host":"example.com","port":22,"username":"coding","auth":{"kind":"password","secret":"example-secret"}}`, "connect"},
		{"list", "RemoteSSHListDirectories", `{"connectionId":"connection-1","remotePath":"/srv"}`, "list"},
		{"select", "RemoteSSHSelectDirectory", `{"connectionId":"connection-1","remotePath":"/srv"}`, "select"},
		{"select unclaimed", "RemoteSSHSelectUnclaimed", `{"operationId":"operation-1","connectionId":"connection-1","remotePath":"/srv"}`, "select-unclaimed"},
		{"revoke unclaimed", "RemoteSSHRevokeUnclaimed", `{"operationId":"operation-1","connectionId":"connection-1"}`, "revoke-unclaimed"},
		{"claim selection", "RemoteSSHClaimSelection", `{"operationId":"operation-1"}`, "claim-selection"},
		{"close", "RemoteSSHClose", `{"connectionId":"connection-1"}`, "close"},
		{"cancel", "RemoteSSHCancelConnect", `{"attemptId":"attempt-1"}`, "cancel"},
		{"reject", "RemoteSSHRejectHostKey", `{"confirmationId":"confirmation-1"}`, "reject"},
		{"shutdown", "shutdown", `{}`, "shutdown"},
	} {
		t.Run(test.name, func(t *testing.T) {
			value, err := h.Handle(context.Background(), test.method, json.RawMessage(test.payload))
			if err != nil || value == nil || service.method != test.want {
				t.Fatalf("value=%v method=%q error=%v", value, service.method, err)
			}
		})
	}
	if service.connectionID != "confirmation-1" {
		t.Fatalf("last id = %q", service.connectionID)
	}
	for _, payload := range []string{`[]`, `null`, `{"connectionId":"connection-1","extra":1}`, `{"connectionId":"connection-1","connectionId":"other"}`, `{"connectionId":"connection-1"} trailing`} {
		if _, err := h.Handle(context.Background(), "RemoteSSHClose", json.RawMessage(payload)); err == nil {
			t.Errorf("payload %q was accepted", payload)
		}
	}
	if _, err := h.Handle(context.Background(), "RemoteSSHConnect", json.RawMessage(`{"attemptId":"attempt-1","auth":{"kind":"password","kind":"privateKey"}}`)); err == nil {
		t.Fatal("nested duplicate field was accepted")
	}
	if _, err := h.Handle(context.Background(), "arbitrary", json.RawMessage(`{}`)); err == nil || strings.Contains(err.Error(), "example-secret") {
		t.Fatalf("unsupported method error = %v", err)
	}
}
