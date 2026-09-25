package remoteagent

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/deepseek-ai/coding/apps/desktop/internal/sshfixture"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func TestManagerRequiresConfirmationThenConnectsThroughPrivateTunnel(t *testing.T) {
	server := newManagerSSHFixture(t)
	knownHosts := filepath.Join(t.TempDir(), "remote-ssh", "known_hosts")
	agent := filepath.Join(t.TempDir(), "coding-remote-agent-linux-amd64")
	if err := os.WriteFile(agent, []byte("test-agent"), 0o700); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(ManagerOptions{
		KnownHostsPath: knownHosts,
		AgentPathFor: func(platform RemotePlatform) (string, error) {
			if platform != (RemotePlatform{OS: "linux", Arch: "amd64"}) {
				t.Fatalf("platform = %#v", platform)
			}
			return agent, nil
		},
		ConnectTimeout: time.Second,
		StartupTimeout: 2 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := ConnectRequest{Host: server.host(), Port: server.port(), User: "coding", Auth: SSHAuth{Password: "password"}}
	_, err = manager.Connect(context.Background(), request)
	var unknown *ErrUnknownHostKey
	if !errors.As(err, &unknown) {
		t.Fatalf("Connect error = %v, want ErrUnknownHostKey", err)
	}
	if unknown.ConfirmationID == "" || unknown.Fingerprint == "" || unknown.Algorithm == "" {
		t.Fatalf("unknown host key = %#v", unknown)
	}

	request.Auth.Password = "fresh-password"
	info, err := manager.ConfirmHostKey(context.Background(), unknown.ConfirmationID, request, unknown.Fingerprint)
	if err != nil {
		t.Fatalf("ConfirmHostKey: %v", err)
	}
	if info.ID == "" || info.Endpoint != "" || info.Platform != (RemotePlatform{OS: "linux", Arch: "amd64"}) {
		t.Fatalf("connection = %#v", info)
	}
	if !strings.HasPrefix(info.ID, "r") {
		t.Fatalf("connection id must be bridge-safe: %q", info.ID)
	}
	known, err := os.ReadFile(knownHosts)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(known), knownhosts.Line([]string{server.address()}, server.transport.HostKey())) || strings.Contains(string(known), request.Auth.Password) {
		t.Fatalf("known_hosts did not contain exactly the accepted host key")
	}
	if _, err := manager.Proxy(context.Background(), "missing", http.MethodPost, "/v1/read_file", nil); !errors.Is(err, ErrConnectionNotFound) {
		t.Fatalf("unknown connection proxy error = %v", err)
	}
	if _, err := manager.Proxy(context.Background(), info.ID, http.MethodGet, "/v1/exec", nil); err == nil {
		t.Fatal("wrong-method agent route was accepted")
	}
	marker, err := manager.Marker(info.ID, "/remote/workspace")
	if err != nil || marker != (RemoteWorkspaceMarker{Version: 1, RemoteRoot: "/remote/workspace", ConnectionID: info.ID}) {
		t.Fatalf("Marker = %#v, %v", marker, err)
	}
	if err := manager.Close(context.Background(), info.ID); err != nil {
		t.Fatalf("Close: %v", err)
	}
	select {
	case <-server.agentStopped:
	case <-time.After(time.Second):
		t.Fatal("remote agent did not receive shutdown")
	}
	if _, err := manager.Connection(info.ID); !errors.Is(err, ErrConnectionNotFound) {
		t.Fatalf("closed connection lookup = %v", err)
	}
}

func TestManagerRequiresReadyAndHealthVersionsToAgree(t *testing.T) {
	cases := []struct {
		name              string
		readyVersion      string
		healthVersion     string
		omitHealthVersion bool
		wantFailure       bool
	}{
		{name: "matching version", readyVersion: "remote-build", healthVersion: "remote-build"},
		{name: "different version", readyVersion: "remote-build", healthVersion: "other-build", wantFailure: true},
		{name: "missing health version", readyVersion: "remote-build", omitHealthVersion: true, wantFailure: true},
		{name: "empty readiness version", healthVersion: "remote-build", wantFailure: true},
		{name: "oversized readiness version", readyVersion: strings.Repeat("x", 129), healthVersion: strings.Repeat("x", 129), wantFailure: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := newManagerSSHFixture(t)
			server.mu.Lock()
			server.readyVersion = tc.readyVersion
			server.healthVersion = tc.healthVersion
			server.omitHealthVersion = tc.omitHealthVersion
			server.mu.Unlock()
			knownHosts := filepath.Join(t.TempDir(), "known_hosts")
			if err := os.Chmod(filepath.Dir(knownHosts), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := confirmKnownHost(knownHosts, server.address(), server.transport.HostKey()); err != nil {
				t.Fatal(err)
			}
			agent := filepath.Join(t.TempDir(), "coding-remote-agent-linux-amd64")
			if err := os.WriteFile(agent, []byte("test-agent"), 0o700); err != nil {
				t.Fatal(err)
			}
			manager, err := NewManager(ManagerOptions{
				KnownHostsPath: knownHosts,
				AgentPathFor:   func(RemotePlatform) (string, error) { return agent, nil },
				ConnectTimeout: time.Second,
				StartupTimeout: 2 * time.Second,
			})
			if err != nil {
				t.Fatal(err)
			}
			request := ConnectRequest{Host: server.host(), Port: server.port(), User: "coding", Auth: SSHAuth{Password: "password"}}
			info, err := manager.Connect(context.Background(), request)
			if tc.wantFailure {
				if err == nil {
					t.Fatalf("Connect accepted inconsistent version: %#v", info)
				}
				manager.mu.RLock()
				states, starting := len(manager.states), len(manager.starting)
				manager.mu.RUnlock()
				if states != 0 || starting != 0 {
					t.Fatalf("failed connection persisted: states=%d starting=%d", states, starting)
				}
				return
			}
			if err != nil {
				t.Fatalf("matching remote version rejected: %v", err)
			}
			if err := manager.Close(context.Background(), info.ID); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestAgentRoutesAllowRemoteExecutionOnlyAsPost(t *testing.T) {
	for _, path := range []string{
		"/v1/search", "/v1/code/start", "/v1/code/next", "/v1/code/reply", "/v1/code/cancel",
		"/v1/terminals/start", "/v1/terminals/read", "/v1/terminals/write", "/v1/terminals/resize", "/v1/terminals/foreground", "/v1/terminals/signal", "/v1/terminals/terminate",
		"/v1/processes/resolve", "/v1/processes/start", "/v1/processes/read", "/v1/processes/write", "/v1/processes/wait", "/v1/processes/kill",
	} {
		if !isAgentRoute(http.MethodPost, path) {
			t.Fatalf("POST %s was rejected", path)
		}
		if isAgentRoute(http.MethodGet, path) {
			t.Fatalf("GET %s was accepted", path)
		}
	}
}

func TestHostKeyConfirmationRequiresFreshMatchingRequestAndExpires(t *testing.T) {
	server := newManagerSSHFixture(t)
	manager, err := NewManager(ManagerOptions{KnownHostsPath: filepath.Join(t.TempDir(), "remote-ssh", "known_hosts"), ConnectTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	request := ConnectRequest{Host: server.host(), Port: server.port(), User: "coding", Auth: SSHAuth{Password: "first-secret"}}
	_, err = manager.Connect(context.Background(), request)
	var unknown *ErrUnknownHostKey
	if !errors.As(err, &unknown) {
		t.Fatalf("Connect error = %v", err)
	}
	pending := manager.pending[unknown.ConfirmationID]
	if pending == nil || pending.address != server.address() || pending.fingerprint != unknown.Fingerprint {
		t.Fatalf("pending host key = %#v", pending)
	}
	fresh := request
	fresh.Auth.Password = "fresh-secret"
	wrongTarget := fresh
	wrongTarget.Port++
	if _, err := manager.ConfirmHostKey(context.Background(), unknown.ConfirmationID, wrongTarget, unknown.Fingerprint); err == nil {
		t.Fatal("confirmation accepted a different SSH target")
	}
	if _, err := manager.ConfirmHostKey(context.Background(), unknown.ConfirmationID, fresh, "SHA256:different"); err == nil {
		t.Fatal("confirmation accepted a different fingerprint")
	}
	manager.mu.Lock()
	manager.pending[unknown.ConfirmationID].expiresAt = time.Now().Add(-time.Second)
	manager.mu.Unlock()
	if _, err := manager.ConfirmHostKey(context.Background(), unknown.ConfirmationID, fresh, unknown.Fingerprint); err == nil {
		t.Fatal("confirmation accepted an expired id")
	}
	manager.mu.RLock()
	_, retained := manager.pending[unknown.ConfirmationID]
	manager.mu.RUnlock()
	if retained {
		t.Fatal("expired confirmation was retained")
	}
}

func TestPendingHostKeysStayBounded(t *testing.T) {
	manager, err := NewManager(ManagerOptions{KnownHostsPath: filepath.Join(t.TempDir(), "remote-ssh", "known_hosts")})
	if err != nil {
		t.Fatal(err)
	}
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	for index := 0; index < maxPendingHostKeys+5; index++ {
		address := fmt.Sprintf("host-%d:22", index)
		if _, err := manager.rememberPendingHostKey(address, signer.PublicKey(), ssh.FingerprintSHA256(signer.PublicKey())); err != nil {
			t.Fatal(err)
		}
	}
	manager.mu.RLock()
	defer manager.mu.RUnlock()
	if len(manager.pending) != maxPendingHostKeys {
		t.Fatalf("pending host keys = %d, want %d", len(manager.pending), maxPendingHostKeys)
	}
}

func TestPendingHostKeyConfirmationIDsAreUniquePerHandshake(t *testing.T) {
	manager, err := NewManager(ManagerOptions{KnownHostsPath: filepath.Join(t.TempDir(), "remote-ssh", "known_hosts")})
	if err != nil {
		t.Fatal(err)
	}
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		t.Fatal(err)
	}
	fingerprint := ssh.FingerprintSHA256(signer.PublicKey())
	first, err := manager.rememberPendingHostKey("host:22", signer.PublicKey(), fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	second, err := manager.rememberPendingHostKey("host:22", signer.PublicKey(), fingerprint)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("concurrent host-key handshakes reused one confirmation id")
	}
	manager.RejectHostKey(first)
	manager.mu.RLock()
	_, retained := manager.pending[second]
	manager.mu.RUnlock()
	if !retained {
		t.Fatal("rejecting an older handshake removed the newer confirmation")
	}
}

func TestManagerRemovesConnectionWhenRemoteAgentExits(t *testing.T) {
	server := newManagerSSHFixture(t)
	manager, info := connectManagerFixture(t, server)
	server.stopAgent()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := manager.Connection(info.ID); errors.Is(err, ErrConnectionNotFound) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("exited remote agent remained in the connection table")
}

func TestManagerCloseAllSettlesConnectionsAndClearsPending(t *testing.T) {
	server := newManagerSSHFixture(t)
	manager, info := connectManagerFixture(t, server)
	manager.mu.Lock()
	manager.pending["pending"] = &pendingHostKey{expiresAt: time.Now().Add(time.Minute)}
	manager.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := manager.CloseAll(ctx); err != nil {
		t.Fatalf("CloseAll: %v", err)
	}
	if _, err := manager.Connection(info.ID); !errors.Is(err, ErrConnectionNotFound) {
		t.Fatalf("connection after CloseAll = %v", err)
	}
	manager.mu.RLock()
	pendingCount := len(manager.pending)
	manager.mu.RUnlock()
	if pendingCount != 0 {
		t.Fatalf("pending host keys after CloseAll = %d", pendingCount)
	}
}

func TestManagerCloseAllSettlesStartingConnection(t *testing.T) {
	server := newManagerSSHFixture(t)
	manager, info := connectManagerFixture(t, server)
	manager.mu.Lock()
	state := manager.states[info.ID]
	delete(manager.states, info.ID)
	manager.starting[info.ID] = state
	manager.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := manager.CloseAll(ctx); err != nil {
		t.Fatalf("CloseAll: %v", err)
	}
	select {
	case <-server.agentStopped:
	case <-time.After(time.Second):
		t.Fatal("CloseAll did not stop the unpublished remote agent")
	}
	manager.mu.RLock()
	startingCount := len(manager.starting)
	publishedCount := len(manager.states)
	manager.mu.RUnlock()
	if startingCount != 0 || publishedCount != 0 {
		t.Fatalf("connections after CloseAll: starting=%d published=%d", startingCount, publishedCount)
	}
}

func TestManagerCancellationSettlesUnpublishedAgentSession(t *testing.T) {
	server := newManagerSSHFixture(t)
	server.readyGate = make(chan struct{})
	knownHosts := filepath.Join(t.TempDir(), "remote-ssh", "known_hosts")
	if err := confirmKnownHost(knownHosts, server.address(), server.transport.HostKey()); err != nil {
		t.Fatal(err)
	}
	agent := filepath.Join(t.TempDir(), "coding-remote-agent-linux-amd64")
	if err := os.WriteFile(agent, []byte("test-agent"), 0o700); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(ManagerOptions{
		KnownHostsPath: knownHosts,
		AgentPathFor:   func(RemotePlatform) (string, error) { return agent, nil },
		ConnectTimeout: time.Second,
		StartupTimeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := manager.Connect(ctx, ConnectRequest{Host: server.host(), Port: server.port(), User: "coding", Auth: SSHAuth{Password: "password"}})
		result <- err
	}()
	select {
	case <-server.agentStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("remote agent session did not start")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled Connect error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled unpublished session did not settle")
	}
	close(server.readyGate)
	server.stopAgent()
	manager.mu.RLock()
	stateCount := len(manager.states)
	manager.mu.RUnlock()
	if stateCount != 0 {
		t.Fatalf("published states after cancelled startup = %d", stateCount)
	}
}

func TestManagerRejectsChangedKnownHostKey(t *testing.T) {
	first := newManagerSSHFixture(t)
	second := newManagerSSHFixture(t)
	knownHosts := filepath.Join(t.TempDir(), "known_hosts")
	if err := os.Chmod(filepath.Dir(knownHosts), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(knownHosts, []byte(knownhosts.Line([]string{second.address()}, first.transport.HostKey())+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(ManagerOptions{KnownHostsPath: knownHosts, ConnectTimeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.Connect(context.Background(), ConnectRequest{Host: second.host(), Port: second.port(), User: "coding", Auth: SSHAuth{Password: "password"}})
	var changed *ErrHostKeyChanged
	if !errors.As(err, &changed) {
		t.Fatalf("Connect error = %v, want ErrHostKeyChanged", err)
	}
	if changed.Fingerprint != ssh.FingerprintSHA256(second.transport.HostKey()) {
		t.Fatalf("changed key fingerprint = %q", changed.Fingerprint)
	}
}

func TestPlatformProbeParsingSupportsWindowsAndEncodedLaunch(t *testing.T) {
	platform, home, ok := parsePlatformOutput("Windows AMD64\r\nHOME=C:\\Users\\coding\r\n")
	if !ok || platform != (RemotePlatform{OS: "windows", Arch: "amd64"}) || home != `C:\Users\coding` {
		t.Fatalf("parse Windows platform = %#v, %q, %v", platform, home, ok)
	}
	if got := remoteInstallDir("", platform, home); got != "C:/Users/coding/.coding/remote-agent" {
		t.Fatalf("Windows install dir = %q", got)
	}
	command := powershellCommand("& " + powershellQuote(`C:\Users\coding\.coding\remote-agent\coding-remote-agent.exe`) + " --token-stdin")
	if !strings.HasPrefix(command, "powershell.exe -NoProfile -NonInteractive -EncodedCommand ") || strings.Contains(command, `C:\Users\coding`) {
		t.Fatalf("PowerShell command leaks or does not encode path: %q", command)
	}
}

func TestConnectRequestValidationBoundsAndIPv6(t *testing.T) {
	base := ConnectRequest{Host: "[2001:db8::1]", Port: 22, User: "coding", Auth: SSHAuth{Password: "secret"}}
	if err := validateConnectRequest(base); err != nil {
		t.Fatalf("bracketed IPv6 rejected: %v", err)
	}
	host, port := normalizedSSHTarget(base.Host, base.Port)
	if host != "2001:db8::1" || port != 22 || net.JoinHostPort(host, fmt.Sprint(port)) != "[2001:db8::1]:22" {
		t.Fatalf("normalized IPv6 = %q:%d", host, port)
	}
	cases := []ConnectRequest{
		{Host: "scheme://host", Port: 22, User: "coding", Auth: SSHAuth{Password: "secret"}},
		{Host: "not:ipv6", Port: 22, User: "coding", Auth: SSHAuth{Password: "secret"}},
		{Host: "host", Port: 22, User: strings.Repeat("u", maxSSHUserBytes+1), Auth: SSHAuth{Password: "secret"}},
		{Host: "host", Port: 22, User: "coding", Auth: SSHAuth{Password: strings.Repeat("p", maxSSHPasswordBytes+1)}},
		{Host: "host", Port: 22, User: "coding", Auth: SSHAuth{PrivateKey: strings.Repeat("k", maxSSHPrivateKeyBytes+1)}},
	}
	for index, request := range cases {
		if err := validateConnectRequest(request); err == nil {
			t.Fatalf("invalid request %d was accepted", index)
		}
	}
}

func connectManagerFixture(t *testing.T, server *managerSSHFixture) (*Manager, ConnectionInfo) {
	t.Helper()
	agent := filepath.Join(t.TempDir(), "coding-remote-agent-linux-amd64")
	if err := os.WriteFile(agent, []byte("test-agent"), 0o700); err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(ManagerOptions{
		KnownHostsPath: filepath.Join(t.TempDir(), "remote-ssh", "known_hosts"),
		AgentPathFor:   func(RemotePlatform) (string, error) { return agent, nil },
		ConnectTimeout: time.Second,
		StartupTimeout: 2 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := ConnectRequest{Host: server.host(), Port: server.port(), User: "coding", Auth: SSHAuth{Password: "password"}}
	_, err = manager.Connect(context.Background(), request)
	var unknown *ErrUnknownHostKey
	if !errors.As(err, &unknown) {
		t.Fatalf("Connect error = %v", err)
	}
	info, err := manager.ConfirmHostKey(context.Background(), unknown.ConfirmationID, request, unknown.Fingerprint)
	if err != nil {
		t.Fatalf("ConfirmHostKey: %v", err)
	}
	return manager, info
}

type managerSSHFixture struct {
	transport         *sshfixture.Server
	root              string
	agent             *httptest.Server
	mu                sync.Mutex
	token             string
	agentStopped      chan struct{}
	stopOnce          sync.Once
	agentStarted      chan struct{}
	startedOnce       sync.Once
	readyGate         chan struct{}
	readyVersion      string
	healthVersion     string
	omitHealthVersion bool
}

func newManagerSSHFixture(t *testing.T) *managerSSHFixture {
	t.Helper()
	fixture := &managerSSHFixture{
		root:         t.TempDir(),
		agentStopped: make(chan struct{}), agentStarted: make(chan struct{}),
		readyVersion: "test", healthVersion: "test",
	}
	fixture.agent = httptest.NewServer(http.HandlerFunc(fixture.serveAgent))
	var err error
	fixture.transport, err = sshfixture.StartWithHooks(sshfixture.Hooks{
		Authenticate: func(username string, _ []byte) bool { return username == "coding" },
		Session:      fixture.serveSession,
		Forward:      fixture.forward,
	})
	if err != nil {
		fixture.agent.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		fixture.stopAgent()
		fixture.transport.Close()
		fixture.agent.Close()
	})
	return fixture
}

func (fixture *managerSSHFixture) address() string {
	return net.JoinHostPort(fixture.transport.Host, fmt.Sprint(fixture.transport.Port))
}

func (fixture *managerSSHFixture) host() string {
	host, _, _ := net.SplitHostPort(fixture.address())
	return host
}

func (fixture *managerSSHFixture) port() int { return fixture.transport.Port }

func (fixture *managerSSHFixture) stopAgent() {
	fixture.stopOnce.Do(func() { close(fixture.agentStopped) })
}

func (fixture *managerSSHFixture) serveSession(stream ssh.Channel, requests <-chan *ssh.Request) {
	for request := range requests {
		switch request.Type {
		case "subsystem":
			var payload struct{ Subsystem string }
			if err := ssh.Unmarshal(request.Payload, &payload); err != nil || payload.Subsystem != "sftp" {
				_ = request.Reply(false, nil)
				continue
			}
			if err := request.Reply(true, nil); err != nil {
				return
			}
			server, err := sftp.NewServer(stream, sftp.WithServerWorkingDirectory(fixture.root))
			if err != nil {
				return
			}
			_ = server.Serve()
			_ = server.Close()
			return
		case "exec":
			var payload struct{ Command string }
			if err := ssh.Unmarshal(request.Payload, &payload); err != nil {
				_ = request.Reply(false, nil)
				return
			}
			_ = request.Reply(true, nil)
			go fixture.runCommand(stream, payload.Command)
			return
		default:
			_ = request.Reply(false, nil)
		}
	}
}

func (fixture *managerSSHFixture) runCommand(stream ssh.Channel, command string) {
	if strings.Contains(command, "uname -s") {
		_, _ = io.WriteString(stream, "Linux x86_64\nHOME=remote\n")
		fixture.exit(stream)
		return
	}
	if !strings.Contains(command, "--token-stdin") {
		fixture.exit(stream)
		return
	}
	token, _ := io.ReadAll(stream)
	fixture.mu.Lock()
	fixture.token = strings.TrimSpace(string(token))
	version := fixture.readyVersion
	fixture.mu.Unlock()
	fixture.startedOnce.Do(func() { close(fixture.agentStarted) })
	if fixture.readyGate != nil {
		<-fixture.readyGate
	}
	ready, _ := json.Marshal(ReadyRecord{Type: "coding-remote-agent-ready", Protocol: ProtocolVersion, Port: 1, Version: version})
	_, _ = stream.Write(append(ready, '\n'))
	<-fixture.agentStopped
	fixture.exit(stream)
}

func (fixture *managerSSHFixture) exit(stream ssh.Channel) {
	_, _ = stream.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{Status: 0}))
	_ = stream.Close()
}

func (fixture *managerSSHFixture) forward(stream ssh.Channel) {
	defer stream.Close()
	target := strings.TrimPrefix(fixture.agent.URL, "http://")
	connection, err := net.Dial("tcp", target)
	if err != nil {
		return
	}
	defer connection.Close()
	go func() { _, _ = io.Copy(connection, stream); _ = connection.Close() }()
	_, _ = io.Copy(stream, connection)
}

func (fixture *managerSSHFixture) serveAgent(writer http.ResponseWriter, request *http.Request) {
	fixture.mu.Lock()
	token := fixture.token
	version := fixture.healthVersion
	omitVersion := fixture.omitHealthVersion
	fixture.mu.Unlock()
	if request.Header.Get("Authorization") != "Bearer "+token {
		writer.WriteHeader(http.StatusUnauthorized)
		return
	}
	writer.Header().Set("Content-Type", "application/json")
	switch request.URL.Path {
	case "/v1/health":
		health := map[string]any{"type": "coding-remote-agent-health", "protocol": ProtocolVersion, "platform": "linux", "arch": "amd64"}
		if !omitVersion {
			health["version"] = version
		}
		_ = json.NewEncoder(writer).Encode(health)
	case "/v1/shutdown":
		fixture.stopAgent()
		_, _ = writer.Write([]byte(`{"accepted":true}`))
	default:
		writer.WriteHeader(http.StatusNotFound)
		_, _ = writer.Write([]byte(`{"error":{"code":"not-found","message":"missing"}}`))
	}
}
