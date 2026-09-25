// Package sshfixture 提供仅供本机测试使用的一次性 Remote-SSH 服务器。
package sshfixture

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"debug/buildinfo"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

const probe = "printf '%s %s\\n' \"$(uname -s)\" \"$(uname -m)\"; printf 'HOME=%s\\n' \"$HOME\""

// Ready 是测试子进程只在 stdout 输出一次的连接材料；调用方不得落盘或记录密码。
type Ready struct {
	Host       string `json:"host"`
	Port       int    `json:"port"`
	Username   string `json:"username"`
	Password   string `json:"password"`
	RemoteRoot string `json:"remoteRoot"`
}

// Server 的所有网络监听均局限在本机回环接口，Close 会关闭 SSH 和已启动的 agent。
type Server struct {
	Ready
	listener       net.Listener
	root           string
	hostKey        ssh.PublicKey
	hooks          *Hooks
	config         *ssh.ServerConfig
	ctx            context.Context
	cancel         context.CancelFunc
	mu             sync.Mutex
	conns          map[net.Conn]struct{}
	agents         map[*exec.Cmd]struct{}
	port           int
	token          string
	stopping       bool
	denyForwarding bool
	allowDirect    bool
	wg             sync.WaitGroup
	once           sync.Once
}

// Hooks 仅供保留旧 manager 状态机测试的合成 agent 使用；CLI 总使用严格默认实现。
type Hooks struct {
	Authenticate func(username string, password []byte) bool
	Session      func(ssh.Channel, <-chan *ssh.Request)
	Forward      func(ssh.Channel)
}

type fixtureTerminal struct {
	mu         sync.Mutex
	cols, rows uint16
	file       *os.File
}

type fixtureBootstrapKind uint8

const (
	fixtureBootstrapUnknown fixtureBootstrapKind = iota
	fixtureBootstrapExec
	fixtureBootstrapResolve
	fixtureBootstrapProcess
	fixtureBootstrapTerminal
)

// Start 为每次调用创建独立临时目录、SSH 密钥与密码。测试种子仅在该目录中。
func Start() (*Server, error) {
	return start(nil)
}

// StartWithoutForwarding 模拟禁止 direct-tcpip 的 SSH 服务，仍允许 SFTP。
func StartWithoutForwarding() (*Server, error) {
	server, err := start(nil)
	if err != nil {
		return nil, err
	}
	server.mu.Lock()
	server.denyForwarding = true
	server.allowDirect = true
	server.mu.Unlock()
	return server, nil
}

// StartWithHooks 在同一回环 SSH 生命周期上运行旧测试的合成 agent。
func StartWithHooks(hooks Hooks) (*Server, error) {
	if hooks.Authenticate == nil || hooks.Session == nil || hooks.Forward == nil {
		return nil, errors.New("fixture hooks must be complete")
	}
	return start(&hooks)
}

// HostKey 返回本次 SSH 服务的公钥，用于独立的 known_hosts 测试。
func (s *Server) HostKey() ssh.PublicKey { return s.hostKey }

func start(hooks *Hooks) (*Server, error) {
	root, err := os.MkdirTemp("", "coding-ssh-fixture-")
	if err != nil {
		return nil, err
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*Server, error) { _ = os.RemoveAll(root); return nil, err }
	if err := os.Mkdir(filepath.Join(root, "nested"), 0o700); err != nil {
		return fail(err)
	}
	if err := os.WriteFile(filepath.Join(root, "seed.txt"), []byte("remote fixture seed\n"), 0o600); err != nil {
		return fail(err)
	}
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return fail(err)
	}
	signer, err := ssh.NewSignerFromKey(private)
	if err != nil {
		return fail(err)
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return fail(err)
	}
	password := base64.RawURLEncoding.EncodeToString(secret)
	config := &ssh.ServerConfig{PasswordCallback: func(meta ssh.ConnMetadata, candidate []byte) (*ssh.Permissions, error) {
		if hooks != nil {
			if hooks.Authenticate(meta.User(), candidate) {
				return nil, nil
			}
			return nil, errors.New("authentication rejected")
		}
		if meta.User() != "coding" || subtle.ConstantTimeCompare(candidate, []byte(password)) != 1 {
			return nil, errors.New("authentication rejected")
		}
		return nil, nil
	}}
	config.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fail(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	server := &Server{
		Ready: Ready{Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port,
			Username: "coding", Password: password, RemoteRoot: root},
		listener: listener, root: root, hostKey: signer.PublicKey(), hooks: hooks,
		config: config, ctx: ctx, cancel: cancel,
		conns: make(map[net.Conn]struct{}), agents: make(map[*exec.Cmd]struct{}),
	}
	server.wg.Go(server.accept)
	return server, nil
}

// Close 禁止新连接，关闭现有 SSH 通道并有界等待服务端 goroutine 结束。
func (s *Server) Close() {
	s.once.Do(func() {
		_ = s.listener.Close()
		s.mu.Lock()
		s.stopping = true
		port, token := s.port, s.token
		s.mu.Unlock()
		if port != 0 && token != "" {
			request, _ := http.NewRequest(http.MethodPost,
				"http://127.0.0.1:"+strconv.Itoa(port)+"/v1/shutdown", nil)
			request.Header.Set("Authorization", "Bearer "+token)
			client := &http.Client{Timeout: 750 * time.Millisecond}
			if response, err := client.Do(request); err == nil {
				_ = response.Body.Close()
			}
			deadline := time.Now().Add(2500 * time.Millisecond)
			for time.Now().Before(deadline) {
				s.mu.Lock()
				count := len(s.agents)
				s.mu.Unlock()
				if count == 0 {
					break
				}
				time.Sleep(20 * time.Millisecond)
			}
		}
		s.mu.Lock()
		s.cancel()
		for conn := range s.conns {
			_ = conn.Close()
		}
		for agent := range s.agents {
			stopAgentProcess(agent)
		}
		s.mu.Unlock()
		settled := make(chan struct{})
		go func() { s.wg.Wait(); close(settled) }()
		select {
		case <-settled:
		case <-time.After(3 * time.Second):
		}
		_ = os.RemoveAll(s.root)
	})
}

func (s *Server) accept() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		if s.ctx.Err() != nil {
			s.mu.Unlock()
			_ = conn.Close()
			return
		}
		s.conns[conn] = struct{}{}
		s.wg.Go(func() { s.serve(conn) })
		s.mu.Unlock()
	}
}

func (s *Server) serve(conn net.Conn) {
	defer func() {
		_ = conn.Close()
		s.mu.Lock()
		delete(s.conns, conn)
		s.mu.Unlock()
	}()
	server, channels, requests, err := ssh.NewServerConn(conn, s.config)
	if err != nil {
		return
	}
	defer server.Close()
	s.wg.Go(func() { ssh.DiscardRequests(requests) })
	for channel := range channels {
		s.mu.Lock()
		stopping := s.stopping
		s.mu.Unlock()
		if stopping {
			_ = channel.Reject(ssh.Prohibited, "fixture is closing")
			continue
		}
		switch channel.ChannelType() {
		case "session":
			stream, reqs, err := channel.Accept()
			if err == nil {
				if s.hooks != nil {
					s.wg.Go(func() { s.hooks.Session(stream, reqs) })
				} else {
					s.wg.Go(func() { s.session(stream, reqs) })
				}
			}
		case "direct-tcpip":
			s.mu.Lock()
			denied := s.denyForwarding
			s.mu.Unlock()
			if denied {
				_ = channel.Reject(ssh.Prohibited, "port forwarding is disabled")
				continue
			}
			if s.hooks != nil {
				stream, reqs, err := channel.Accept()
				if err == nil {
					s.wg.Go(func() { ssh.DiscardRequests(reqs) })
					s.wg.Go(func() { s.hooks.Forward(stream) })
				}
				continue
			}
			var target struct {
				Host       string
				Port       uint32
				Origin     string
				OriginPort uint32
			}
			s.mu.Lock()
			port := s.port
			s.mu.Unlock()
			if ssh.Unmarshal(channel.ExtraData(), &target) != nil ||
				(target.Host != "127.0.0.1" && target.Host != "localhost") ||
				port == 0 || target.Port != uint32(port) {
				_ = channel.Reject(ssh.Prohibited, "fixture only forwards its agent")
				continue
			}
			upstream, err := net.DialTimeout("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), time.Second)
			if err != nil {
				_ = channel.Reject(ssh.ConnectionFailed, "agent unavailable")
				continue
			}
			stream, reqs, err := channel.Accept()
			if err != nil {
				_ = upstream.Close()
				continue
			}
			s.wg.Go(func() { ssh.DiscardRequests(reqs) })
			s.wg.Go(func() { forward(stream, upstream) })
		default:
			_ = channel.Reject(ssh.UnknownChannelType, "unsupported")
		}
	}
}

func (s *Server) session(stream ssh.Channel, requests <-chan *ssh.Request) {
	defer stream.Close()
	var terminal *fixtureTerminal
	var running *exec.Cmd
	var done <-chan uint32
	defer func() {
		if running != nil {
			stopAgentProcess(running)
		}
	}()
	for {
		select {
		case status := <-done:
			running = nil
			_, _ = stream.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{status}))
			return
		case request, ok := <-requests:
			if !ok {
				return
			}
			switch request.Type {
			case "pty-req":
				var payload struct {
					Term                      string
					Cols, Rows, Width, Height uint32
					Modes                     string
				}
				s.mu.Lock()
				allowed := s.allowDirect
				s.mu.Unlock()
				if !allowed || terminal != nil || running != nil || ssh.Unmarshal(request.Payload, &payload) != nil ||
					payload.Cols == 0 || payload.Rows == 0 || payload.Cols > 500 || payload.Rows > 500 ||
					len(payload.Term) > 64 || len(payload.Modes) > 4096 {
					_ = request.Reply(false, nil)
					continue
				}
				terminal = &fixtureTerminal{cols: uint16(payload.Cols), rows: uint16(payload.Rows)}
				_ = request.Reply(true, nil)
			case "window-change":
				var payload struct{ Cols, Rows, Width, Height uint32 }
				if terminal == nil || ssh.Unmarshal(request.Payload, &payload) != nil ||
					payload.Cols == 0 || payload.Rows == 0 || payload.Cols > 500 || payload.Rows > 500 {
					_ = request.Reply(false, nil)
					continue
				}
				terminal.mu.Lock()
				terminal.cols, terminal.rows = uint16(payload.Cols), uint16(payload.Rows)
				terminal.mu.Unlock()
				terminal.mu.Lock()
				started := terminal.file != nil
				terminal.mu.Unlock()
				if started {
					_ = resizeFixtureTerminal(terminal)
				}
				_ = request.Reply(true, nil)
			case "signal":
				var payload struct{ Signal string }
				if running == nil || ssh.Unmarshal(request.Payload, &payload) != nil ||
					!fixtureSignal(running, payload.Signal) {
					_ = request.Reply(false, nil)
					continue
				}
				_ = request.Reply(true, nil)
			case "subsystem":
				var payload struct{ Subsystem string }
				if ssh.Unmarshal(request.Payload, &payload) != nil || payload.Subsystem != "sftp" {
					_ = request.Reply(false, nil)
					continue
				}
				_ = request.Reply(true, nil)
				handlers := &fileHandlers{root: s.root}
				server := sftp.NewRequestServer(stream, sftp.Handlers{FileGet: handlers, FilePut: handlers, FileCmd: handlers, FileList: handlers})
				_ = server.Serve()
				_ = server.Close()
				return
			case "exec":
				var payload struct{ Command string }
				if ssh.Unmarshal(request.Payload, &payload) != nil {
					_ = request.Reply(false, nil)
					continue
				}
				s.mu.Lock()
				allowDirect := s.allowDirect
				s.mu.Unlock()
				allowed := payload.Command == probe || s.isAgentCommand(payload.Command) ||
					allowDirect && fixtureDirectScript(payload.Command, false)
				if terminal != nil {
					allowed = allowDirect && fixtureDirectScript(payload.Command, true)
				}
				if running != nil || done != nil || !allowed {
					_ = request.Reply(false, nil)
					continue
				}
				_ = request.Reply(true, nil)
				if payload.Command == probe {
					_, _ = fmt.Fprintf(stream, "%s %s\nHOME=%s\n", platformName(), archName(), s.root)
					_, _ = stream.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
					return
				}
				if s.isAgentCommand(payload.Command) {
					status := uint32(0)
					if err := s.agent(stream, payload.Command); err != nil {
						status = 1
					}
					_, _ = stream.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{status}))
					return
				}
				var err error
				running, done, err = s.directSession(stream, payload.Command, terminal)
				if err != nil {
					_, _ = stream.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{1}))
					return
				}
			default:
				_ = request.Reply(false, nil)
			}
		}
	}
}

// fixtureDirectScript 只接受产品 basic 路径当前使用的四段完整固定脚本。
// 摘要变更需与 direct_exec/direct_process/direct_terminal 的协议测试一起审查。
func fixtureDirectScript(command string, pty bool) bool {
	const prefix = "bash -c '"
	if !strings.HasPrefix(command, prefix) || !strings.HasSuffix(command, "'") || len(command) > 8192 {
		return false
	}
	quoted := strings.TrimSuffix(strings.TrimPrefix(command, prefix), "'")
	script := strings.ReplaceAll(quoted, "'\\''", "'")
	if "'"+strings.ReplaceAll(script, "'", "'\\''")+"'" != command[len("bash -c "):] {
		return false
	}
	kind := fixtureScriptKind(script)
	return kind != fixtureBootstrapUnknown && (kind == fixtureBootstrapTerminal) == pty
}

func fixtureScriptKind(script string) fixtureBootstrapKind {
	switch fmt.Sprintf("%x", sha256.Sum256([]byte(script))) {
	case "3909e1cb119c456442d99064cf5ba1078260e3a0bdc733c9075f0057cc9bee08": // direct_exec.go directExecCommand
		return fixtureBootstrapExec
	case "649d9e87060fcdb856db0645cdded7de72921774db7a9605e457bc6bafed7423": // direct_process.go resolve
		return fixtureBootstrapResolve
	case "80e0db53c7b0b4d156e5bcf52850fa947f3d9bf40dea647cd2b89dd8050b03cf": // direct_process.go launch
		return fixtureBootstrapProcess
	case "2ecce0175c7e84b63dd5850b1739362f1db6e5941b9502afb06c652c0142196f": // direct_terminal.go launch
		return fixtureBootstrapTerminal
	default:
		return fixtureBootstrapUnknown
	}
}

func platformName() string {
	if runtime.GOOS == "darwin" {
		return "Darwin"
	}
	return "Linux"
}

func archName() string {
	if runtime.GOARCH == "arm64" {
		return "aarch64"
	}
	return "x86_64"
}

func (s *Server) isAgentCommand(command string) bool {
	const prefix = "exec '"
	const suffix = "' --token-stdin"
	if !strings.HasPrefix(command, prefix) || !strings.HasSuffix(command, suffix) {
		return false
	}
	name := strings.TrimSuffix(strings.TrimPrefix(command, prefix), suffix)
	if !strings.HasPrefix(filepath.Base(name), "coding-remote-agent-") || strings.ContainsAny(name, "'\\\x00\r\n") {
		return false
	}
	return s.deploymentPath(name) == nil
}

func (s *Server) deploymentPath(name string) error {
	rel, err := filepath.Rel(s.root, name)
	if err != nil || rel == "." || !filepath.IsLocal(rel) {
		return errors.New("outside fixture")
	}
	if filepath.Dir(rel) != filepath.Join(".coding", "remote-agent") {
		return errors.New("outside deployment directory")
	}
	return nil
}

func (s *Server) agent(stream ssh.Channel, command string) error {
	const prefix, suffix = "exec '", "' --token-stdin"
	name := strings.TrimSuffix(strings.TrimPrefix(command, prefix), suffix)
	info, err := os.Lstat(name)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return errors.New("agent artifact unavailable")
	}
	build, err := buildinfo.ReadFile(name)
	if err != nil || build.Path != "github.com/deepseek-ai/coding/apps/desktop/cmd/remote-agent" {
		return errors.New("uploaded artifact is not the test remote agent")
	}
	cmd := exec.CommandContext(s.ctx, name, "--token-stdin")
	prepareAgentProcess(cmd)
	cmd.Dir = s.root
	tokenLine, err := bufio.NewReader(io.LimitReader(stream, 4096)).ReadBytes('\n')
	if err != nil || len(tokenLine) < 33 {
		return errors.New("agent token unavailable")
	}
	cmd.Stdin = bytes.NewReader(tokenLine)
	cmd.Stderr = io.Discard
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.ctx.Err() != nil || s.stopping {
		s.mu.Unlock()
		return context.Canceled
	}
	if err := cmd.Start(); err != nil {
		s.mu.Unlock()
		return err
	}
	s.agents[cmd] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.agents, cmd)
		s.port = 0
		s.token = ""
		s.mu.Unlock()
	}()
	reader := bufio.NewReader(stdout)
	ready, err := reader.ReadBytes('\n')
	if err != nil || len(ready) > 4096 {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return errors.New("agent readiness unavailable")
	}
	var record struct {
		Type string `json:"type"`
		Port int    `json:"port"`
	}
	if json.Unmarshal(ready, &record) != nil || record.Type != "coding-remote-agent-ready" || record.Port < 1 || record.Port > 65535 {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return errors.New("agent readiness invalid")
	}
	s.mu.Lock()
	s.port = record.Port
	s.token = strings.TrimSpace(string(tokenLine))
	s.mu.Unlock()
	if _, err := stream.Write(ready); err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	copyDone := make(chan struct{})
	go func() { _, _ = io.Copy(stream, reader); close(copyDone) }()
	err = cmd.Wait()
	<-copyDone
	return err
}

func forward(stream ssh.Channel, upstream net.Conn) {
	defer stream.Close()
	defer upstream.Close()
	done := make(chan struct{})
	go func() { _, _ = io.Copy(upstream, stream); _ = upstream.(*net.TCPConn).CloseWrite(); close(done) }()
	_, _ = io.Copy(stream, upstream)
	_ = stream.Close()
	<-done
}
