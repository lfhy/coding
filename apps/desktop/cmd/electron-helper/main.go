// Electron helper 独占 Remote-SSH 与受管 Host；stdout 只写 v1 协议帧。
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"

	"github.com/deepseek-ai/coding/apps/desktop/internal/desktopremote"
	"github.com/deepseek-ai/coding/apps/desktop/internal/helperwire"
	"github.com/deepseek-ai/coding/apps/desktop/internal/instance"
	"github.com/deepseek-ai/coding/apps/desktop/internal/remoteagent"
	"github.com/deepseek-ai/coding/apps/internal/hostlaunch"
)

type config struct {
	home, cwd, repoRoot, runtimeRoot, hostVersion string
	exclusiveDesktopInstance                      bool
}

func parseConfig(args []string) (config, error) {
	var cfg config
	flags := flag.NewFlagSet("electron-helper", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&cfg.home, "home", "", "isolated Host home")
	flags.StringVar(&cfg.cwd, "cwd", "", "default workspace directory")
	flags.StringVar(&cfg.repoRoot, "repo-root", "", "repository root for development")
	flags.StringVar(&cfg.runtimeRoot, "runtime-root", "", "packaged Resources directory")
	flags.StringVar(&cfg.hostVersion, "host-version", "", "managed Host version")
	flags.BoolVar(&cfg.exclusiveDesktopInstance, "exclusive-desktop-instance", false, "hold the installed desktop instance lock")
	if err := flags.Parse(args); err != nil || len(flags.Args()) != 0 {
		return config{}, errors.New("invalid helper arguments")
	}
	if cfg.home == "" || cfg.cwd == "" || cfg.hostVersion == "" || !filepath.IsAbs(cfg.home) || !filepath.IsAbs(cfg.cwd) ||
		(cfg.repoRoot == "") == (cfg.runtimeRoot == "") {
		return config{}, errors.New("helper requires absolute home and cwd, version, and one runtime root")
	}
	root := cfg.repoRoot
	if root == "" {
		root = cfg.runtimeRoot
	}
	if !filepath.IsAbs(root) {
		return config{}, errors.New("helper runtime root must be absolute")
	}
	if cfg.exclusiveDesktopInstance && cfg.runtimeRoot == "" {
		return config{}, errors.New("exclusive desktop lock requires packaged runtime")
	}
	return cfg, nil
}

func acquireExclusiveInstance(cfg config) (*instance.Listener, error) {
	if !cfg.exclusiveDesktopInstance {
		return nil, nil
	}
	lock, primary, err := instance.Acquire(nil, false)
	if err != nil {
		return nil, err
	}
	if !primary {
		return nil, errors.New("installed desktop instance already owns the shared lock")
	}
	return lock, nil
}

func main() {
	if err := run(os.Args[1:], os.Stdin, os.Stdout); err != nil {
		// 外部错误可能含 SSH 输入或 Host 环境；stderr 只输出固定诊断。
		fmt.Fprintln(os.Stderr, "coding: Electron helper failed")
		os.Exit(1)
	}
}

func run(args []string, stdin io.Reader, stdout io.Writer) error {
	cfg, err := parseConfig(args)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// 获锁失败时不得创建 manager、bridge 或操作共享 Home。
	lock, err := acquireExclusiveInstance(cfg)
	if err != nil {
		return err
	}
	if lock != nil {
		defer lock.Close()
	}
	// 先监听父进程 stdin：若 Electron 在 Host 就绪前退出，EOF 立即取消
	// Host 启动；就绪后同一有界管道原样交给 helperwire，不丢请求字节。
	requestInput := pumpInput(ctx, stdin, stop)
	defer requestInput.Close()
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return err
	}
	bridgeToken := base64.RawURLEncoding.EncodeToString(tokenBytes)
	agentRoot := filepath.Join(cfg.runtimeRoot, "remote-agent")
	var command []string
	if cfg.repoRoot != "" {
		agentRoot = filepath.Join(cfg.repoRoot, "dist", "remote-agent")
		entry := filepath.Join(cfg.repoRoot, "apps", "cli", "src", "bin.ts")
		info, err := os.Stat(entry)
		if err != nil || !info.Mode().IsRegular() {
			return errors.New("development Host entry is unavailable")
		}
		command = []string{"node", "--import", "tsx/esm", entry, "web", "--coding-host"}
	}
	agentsHome, err := prepareAgentsHome(cfg.home)
	if err != nil {
		return err
	}
	manager, err := remoteagent.NewManager(remoteagent.ManagerOptions{
		KnownHostsPath: filepath.Join(cfg.home, "remote-ssh", "known_hosts"),
		AgentPathFor:   agentPathFor(agentRoot),
	})
	if err != nil {
		return err
	}
	bridge, err := desktopremote.NewBridge(bridgeToken, func(ctx context.Context, connectionID, method, path string, body []byte) (int, []byte, error) {
		response, err := manager.Proxy(ctx, connectionID, method, path, body)
		return response.Status, response.Body, err
	})
	if err != nil {
		return err
	}
	emitter := helperwire.NewEmitter(stdout)
	var ready, finished chan struct{}
	var service *desktopremote.Service
	defer func() {
		if finished != nil {
			close(finished)
		}
		if service != nil {
			_ = service.CloseAll(context.Background())
		} else {
			_ = bridge.Close()
		}
	}()
	if lock != nil {
		ready = make(chan struct{})
		finished = make(chan struct{})
		activations := make(chan struct{}, 1)
		go lock.Serve(func() {
			select {
			case activations <- struct{}{}:
			default:
			}
		})
		go func() {
			select {
			case <-ready:
			case <-finished:
				return
			}
			for {
				select {
				case <-finished:
					return
				case <-activations:
					_ = emitter.EmitActivate()
				}
			}
		}()
	}
	service, err = desktopremote.NewService(desktopremote.Options{
		Home: cfg.home, Context: ctx, Manager: manager, Bridge: bridge,
		OnProgress: func(progress desktopremote.ProgressEvent) {
			_ = emitter.EmitProgress(progress.AttemptID, progress.Phase, "")
		},
	})
	if err != nil {
		return err
	}
	launcher, err := hostlaunch.New(hostlaunch.Options{
		Home: cfg.home, CWD: cfg.cwd, Version: cfg.hostVersion, Command: command, RuntimeRoot: cfg.runtimeRoot,
		ReplaceCompatibleHost: true,
		Environment:           hostEnvironment(bridge.URL(), bridgeToken, agentsHome),
	})
	if err != nil {
		return err
	}
	endpoint, err := launcher.Ensure(ctx)
	if err != nil {
		return err
	}
	if err := emitter.WriteReady(endpoint.BaseURL); err != nil {
		return err
	}
	if ready != nil {
		close(ready)
	}
	return helperwire.ServeWithEmitter(ctx, requestInput, emitter, &handler{service: service})
}

func pumpInput(ctx context.Context, input io.Reader, cancel context.CancelFunc) *io.PipeReader {
	reader, writer := io.Pipe()
	var stopClose func() bool
	if closer, ok := input.(io.Closer); ok {
		stopClose = context.AfterFunc(ctx, func() { _ = closer.Close() })
	}
	go func() {
		if stopClose != nil {
			defer stopClose()
		}
		_, err := io.Copy(writer, input)
		_ = writer.CloseWithError(err)
		cancel()
	}()
	return reader
}

// prepareAgentsHome 在专属 Home 中创建不跟随末端符号链接的 agent 数据目录。
func prepareAgentsHome(home string) (string, error) {
	if !filepath.IsAbs(home) {
		return "", errors.New("agent home must be absolute")
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		return "", fmt.Errorf("create helper home: %w", err)
	}
	info, err := os.Lstat(home)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("helper home must be a real directory")
	}
	root, err := os.OpenRoot(home)
	if err != nil {
		return "", fmt.Errorf("open helper home: %w", err)
	}
	defer root.Close()
	openedHome, err := root.Stat(".")
	if err != nil || !os.SameFile(info, openedHome) {
		return "", errors.New("helper home changed during validation")
	}
	if err := root.Mkdir("agents", 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", fmt.Errorf("create private agent home: %w", err)
	}
	agentInfo, err := root.Lstat("agents")
	if err != nil || !agentInfo.IsDir() || agentInfo.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("agent home must be a real directory inside helper home")
	}
	agentRoot, err := root.OpenRoot("agents")
	if err != nil {
		return "", errors.New("agent home escapes helper home")
	}
	defer agentRoot.Close()
	opened, err := agentRoot.Stat(".")
	if err != nil || !os.SameFile(agentInfo, opened) {
		return "", errors.New("agent home changed during validation")
	}
	if runtime.GOOS != "windows" {
		if err := agentRoot.Chmod(".", 0o700); err != nil {
			return "", fmt.Errorf("secure private agent home: %w", err)
		}
	}
	return filepath.Join(home, "agents"), nil
}

func hostEnvironment(bridgeURL, bridgeToken, agentsHome string) map[string]string {
	return map[string]string{
		"DSH_REMOTE_BRIDGE_URL":   bridgeURL,
		"DSH_REMOTE_BRIDGE_TOKEN": bridgeToken,
		"DSH_AGENTS_HOME":         agentsHome,
	}
}

func agentPathFor(root string) func(remoteagent.RemotePlatform) (string, error) {
	return func(platform remoteagent.RemotePlatform) (string, error) {
		if (platform.OS != "darwin" && platform.OS != "linux" && platform.OS != "windows") ||
			(platform.Arch != "arm64" && platform.Arch != "amd64") {
			return "", errors.New("unsupported remote agent target")
		}
		suffix := ""
		if platform.OS == "windows" {
			suffix = ".exe"
		}
		path := filepath.Join(root, fmt.Sprintf("coding-remote-agent-%s-%s%s", platform.OS, platform.Arch, suffix))
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			return "", errors.New("remote agent artifact is unavailable")
		}
		return path, nil
	}
}

type remoteService interface {
	RemoteSSHConnect(desktopremote.RemoteSSHConnectInput) (desktopremote.RemoteSSHConnectResult, error)
	RemoteSSHListDirectories(string, string) (desktopremote.RemoteSSHDirectoryListing, error)
	RemoteSSHSelectDirectory(string, string) (desktopremote.RemoteSSHDirectorySelection, error)
	RemoteSSHSelectUnclaimed(string, string, string) (desktopremote.UnclaimedSelectionResult, error)
	RemoteSSHRevokeUnclaimed(string, string) (desktopremote.UnclaimedActionResult, error)
	RemoteSSHClaimSelection(string) (desktopremote.UnclaimedActionResult, error)
	RemoteSSHClose(string) error
	RemoteSSHCancelConnect(string) error
	RemoteSSHRejectHostKey(string) error
	CloseAll(context.Context) error
}
type handler struct{ service remoteService }

// Handle 对每种 IPC 输入做严格结构校验；service 再校验领域字段。
func (h *handler) Handle(ctx context.Context, method string, payload json.RawMessage) (any, error) {
	if h.service == nil {
		return nil, errors.New("remote service unavailable")
	}
	type response struct {
		value any
		err   error
	}
	completed := make(chan response, 1)
	// 传输最多同时运行 16 个请求。即使某个 SSH 后端不响应取消，
	// EOF 也不能让 helperwire 的请求组永久等待该调用。
	go func() {
		value, err := h.dispatch(ctx, method, payload)
		completed <- response{value, err}
	}()
	select {
	case result := <-completed:
		return result.value, result.err
	case <-ctx.Done():
		// helperwire 的 EOF 取消只覆盖请求 context。Service 另有 SSH
		// 生命周期；异步关闭它，让不响应取消的后端也不能卡住 Serve。
		go func() { _ = h.service.CloseAll(context.Background()) }()
		return nil, ctx.Err()
	}
}

func (h *handler) dispatch(ctx context.Context, method string, payload json.RawMessage) (any, error) {
	switch method {
	case "RemoteSSHConnect":
		var input desktopremote.RemoteSSHConnectInput
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return h.service.RemoteSSHConnect(input)
	case "RemoteSSHListDirectories", "RemoteSSHSelectDirectory":
		var input struct {
			ConnectionID string `json:"connectionId"`
			RemotePath   string `json:"remotePath"`
		}
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		if method == "RemoteSSHListDirectories" {
			return h.service.RemoteSSHListDirectories(input.ConnectionID, input.RemotePath)
		}
		return h.service.RemoteSSHSelectDirectory(input.ConnectionID, input.RemotePath)
	case "RemoteSSHSelectUnclaimed":
		var input struct {
			OperationID  string `json:"operationId"`
			ConnectionID string `json:"connectionId"`
			RemotePath   string `json:"remotePath"`
		}
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return h.service.RemoteSSHSelectUnclaimed(input.OperationID, input.ConnectionID, input.RemotePath)
	case "RemoteSSHRevokeUnclaimed":
		var input struct {
			OperationID  string `json:"operationId"`
			ConnectionID string `json:"connectionId"`
		}
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return h.service.RemoteSSHRevokeUnclaimed(input.OperationID, input.ConnectionID)
	case "RemoteSSHClaimSelection":
		var input struct {
			OperationID string `json:"operationId"`
		}
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return h.service.RemoteSSHClaimSelection(input.OperationID)
	case "RemoteSSHClose":
		var input struct {
			ConnectionID string `json:"connectionId"`
		}
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return struct{}{}, h.service.RemoteSSHClose(input.ConnectionID)
	case "RemoteSSHCancelConnect":
		var input struct {
			AttemptID string `json:"attemptId"`
		}
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return struct{}{}, h.service.RemoteSSHCancelConnect(input.AttemptID)
	case "RemoteSSHRejectHostKey":
		var input struct {
			ConfirmationID string `json:"confirmationId"`
		}
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return struct{}{}, h.service.RemoteSSHRejectHostKey(input.ConfirmationID)
	case "shutdown":
		var input struct{}
		if err := decode(payload, &input); err != nil {
			return nil, err
		}
		return struct{}{}, h.service.CloseAll(ctx)
	default:
		return nil, errors.New("unsupported helper method")
	}
}

func decode(payload json.RawMessage, value any) error {
	if len(payload) == 0 || payload[0] != '{' {
		return errors.New("invalid helper payload")
	}
	if !uniqueJSONFields(payload) {
		return errors.New("invalid helper payload")
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return errors.New("invalid helper payload")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("invalid helper payload")
	}
	return nil
}

func uniqueJSONFields(data []byte) bool {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if !uniqueJSONValue(decoder) {
		return false
	}
	return decoder.Decode(new(any)) == io.EOF
}

func uniqueJSONValue(decoder *json.Decoder) bool {
	token, err := decoder.Token()
	if err != nil {
		return false
	}
	delim, ok := token.(json.Delim)
	if !ok {
		return true
	}
	switch delim {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			key, valid := keyToken.(string)
			if err != nil || !valid {
				return false
			}
			if _, duplicate := seen[key]; duplicate {
				return false
			}
			seen[key] = struct{}{}
			if !uniqueJSONValue(decoder) {
				return false
			}
		}
		end, err := decoder.Token()
		return err == nil && end == json.Delim('}')
	case '[':
		for decoder.More() {
			if !uniqueJSONValue(decoder) {
				return false
			}
		}
		end, err := decoder.Token()
		return err == nil && end == json.Delim(']')
	default:
		return false
	}
}
