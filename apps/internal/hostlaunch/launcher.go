package hostlaunch

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	ErrHostUnavailable    = errors.New("coding: no compatible local Host is available")
	ErrHostNotReplaceable = errors.New("coding: a live Coding Host could not be replaced in the shared home")
)

// Launcher 串行执行 Host 发现和启动；Host 就绪后独立运行，不归 Launcher 所有。
type Launcher struct {
	options Options
	client  *http.Client
	mu      sync.Mutex
}

// AppVersion 是发行启动器编译进来的产品版本；开发构建使用 dev 连接当前源码 Host。
var AppVersion = "dev"

// guiLoginShellPath 返回 GUI 启动时用来替换继承 PATH 的登录 shell 路径，空字符串表示
// 保留继承环境。每个进程只探测一次；测试替换该变量以注入固定路径。
var guiLoginShellPath = sync.OnceValue(resolveGuiLoginShellPath)

// New 填充平台默认值并校验由调用方附加的 Host 环境。
func New(options Options) (*Launcher, error) {
	seenEnvironmentKeys := make(map[string]string, len(options.Environment))
	for key, value := range options.Environment {
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, '\x00') {
			return nil, fmt.Errorf("coding: invalid Host environment variable %q", key)
		}
		normalized := environmentKey(key)
		if previous, exists := seenEnvironmentKeys[normalized]; exists {
			return nil, fmt.Errorf("coding: duplicate Host environment variables %q and %q", previous, key)
		}
		seenEnvironmentKeys[normalized] = key
	}
	if options.Home == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("coding: resolve user home: %w", err)
		}
		options.Home = filepath.Join(home, ".dsh")
	}
	absoluteHome, err := filepath.Abs(options.Home)
	if err != nil {
		return nil, fmt.Errorf("coding: resolve DSH_HOME: %w", err)
	}
	options.Home = absoluteHome
	if options.CWD == "" {
		options.CWD, err = os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("coding: resolve default cwd: %w", err)
		}
	}
	options.CWD, err = filepath.Abs(options.CWD)
	if err != nil {
		return nil, fmt.Errorf("coding: resolve cwd: %w", err)
	}
	if options.Version == "" {
		options.Version = AppVersion
	}
	if options.StartupTimeout <= 0 {
		options.StartupTimeout = DefaultStartupTimeout
	}
	if options.LockTimeout <= 0 {
		options.LockTimeout = 30 * time.Second
	}
	if options.PollInterval <= 0 {
		options.PollInterval = 100 * time.Millisecond
	}
	return &Launcher{options: options, client: &http.Client{Timeout: 2 * time.Second}}, nil
}

// RecordPath 返回共享 Host 发现记录的路径。
func (l *Launcher) RecordPath() string { return filepath.Join(l.options.Home, "host.json") }

// Home 返回发现记录和运行时文件共用的绝对 DSH_HOME。
func (l *Launcher) Home() string { return l.options.Home }

// Ensure 在跨进程启动锁内连接兼容 Host 或启动新 Host；观察到就绪后立即释放锁。
func (l *Launcher) Ensure(ctx context.Context) (Endpoint, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := os.MkdirAll(l.options.Home, 0o700); err != nil {
		return Endpoint{}, fmt.Errorf("coding: create DSH_HOME: %w", err)
	}
	lock, err := acquireLock(ctx, filepath.Join(l.options.Home, "host.lock"), l.options.LockTimeout, l.options.PollInterval)
	if err != nil {
		return Endpoint{}, err
	}
	defer lock.Close()

	endpoint, state := l.discover(ctx)
	if err := ctx.Err(); err != nil {
		return Endpoint{}, err
	}
	if state == discoveryCompatible && !l.options.ReplaceCompatibleHost {
		return endpoint, nil
	}
	if state == discoveryCompatible || state == discoveryLiveIncompatible {
		// 私有 bridge 环境不能被 host.json 表达；附着旧 Host 会保留已经失效
		// 的 token。停止受管进程后由本次启动继承当前窗口的环境。
		if err := l.stopExisting(ctx, endpoint.Record.PID); err != nil {
			return Endpoint{}, err
		}
		_, state = l.discover(ctx)
		if err := ctx.Err(); err != nil {
			return Endpoint{}, err
		}
		if state != discoveryMissing {
			return Endpoint{}, ErrHostNotReplaceable
		}
	} else if state == discoveryUnverifiedLive {
		return Endpoint{}, ErrHostNotReplaceable
	}
	return l.start(ctx)
}

// hostExitWaitTicks 限制已有 Host 响应退出请求的轮询次数。
var hostExitWaitTicks = 100

// stopExisting 请求已验证的 Host 退出，并等待其原始 PID 结束。探针短暂失败
// 不代表旧进程已退出；在它仍存活时启动新 Host 会让两者共享 DSH_HOME。
func (l *Launcher) stopExisting(ctx context.Context, pid int) error {
	if pid < 1 || !processAlive(pid) {
		return nil
	}
	terminateProcess(pid)
	for attempt := 0; ; attempt++ {
		if !processAlive(pid) {
			return nil
		}
		if attempt >= hostExitWaitTicks {
			return ErrHostNotReplaceable
		}
		timer := time.NewTimer(l.options.PollInterval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

type discoveryState uint8

const (
	discoveryMissing discoveryState = iota
	discoveryCompatible
	discoveryLiveIncompatible
	discoveryUnverifiedLive
)

func (l *Launcher) discover(ctx context.Context) (Endpoint, discoveryState) {
	data, err := os.ReadFile(l.RecordPath())
	if err != nil {
		return Endpoint{}, discoveryMissing
	}
	var record Record
	if json.Unmarshal(data, &record) != nil || record.Type != "coding-host-ready" || record.Port < 1 || record.Port > 65535 || record.PID < 1 || record.Token == "" {
		return Endpoint{}, discoveryMissing
	}
	endpoint := Endpoint{Record: record, BaseURL: baseURL(record.Port)}
	alive := processAlive(record.PID)
	responsive := l.probe(ctx, endpoint)
	if alive != responsive {
		// PID 记录和 loopback 探针必须同时成立，才能把该进程视为本记录的
		// Host。任一方不成立都可能是损坏记录、PID 复用或另一个占用端口的
		// 进程；此时不能终止 PID，也不能覆盖共享 home 启动第二个 Host。
		return endpoint, discoveryUnverifiedLive
	}
	if !alive {
		return Endpoint{}, discoveryMissing
	}
	if record.Protocol != Protocol || record.Version != l.options.Version {
		return endpoint, discoveryLiveIncompatible
	}
	return endpoint, discoveryCompatible
}

func (l *Launcher) probe(ctx context.Context, endpoint Endpoint) bool {
	rpcID := randomID()
	payload := map[string]any{
		"type": "client-request", "rpcId": rpcID, "method": "host.describe", "payload": map[string]any{},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return false
	}
	requestCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint.BaseURL+"/api/host.describe", strings.NewReader(string(body)))
	if err != nil {
		return false
	}
	request.Header.Set("Content-Type", "application/json")
	request.Host = "127.0.0.1:" + strconv.Itoa(endpoint.Record.Port)
	response, err := l.client.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false
	}
	var envelope struct {
		Type   string `json:"type"`
		RPCID  string `json:"rpcId"`
		Result struct {
			OK    bool `json:"ok"`
			Value struct {
				Version          string `json:"version"`
				ManagedHostToken string `json:"managedHostToken"`
			} `json:"value"`
		} `json:"result"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&envelope) != nil {
		return false
	}
	return envelope.Type == "server-response" && envelope.RPCID == rpcID && envelope.Result.OK &&
		envelope.Result.Value.Version == endpoint.Record.Version &&
		envelope.Result.Value.ManagedHostToken == endpoint.Record.Token
}

func (l *Launcher) start(ctx context.Context) (Endpoint, error) {
	command, err := l.command()
	if err != nil {
		return Endpoint{}, err
	}
	if len(command) == 0 {
		return Endpoint{}, fmt.Errorf("coding: empty Host command")
	}
	child := exec.Command(command[0], command[1:]...)
	child.Dir = l.commandWorkingDirectory()
	child.Env = l.childEnvironment()
	stdout, err := child.StdoutPipe()
	if err != nil {
		return Endpoint{}, fmt.Errorf("coding: capture Host stdout: %w", err)
	}
	child.Stderr = os.Stderr
	if err := child.Start(); err != nil {
		return Endpoint{}, fmt.Errorf("coding: start Host: %w", err)
	}
	readyCtx, cancel := context.WithTimeout(ctx, l.options.StartupTimeout)
	defer cancel()
	scanner := bufio.NewScanner(stdout)
	ready := make(chan Record, 1)
	readErr := make(chan error, 1)
	go func() {
		for scanner.Scan() {
			var record Record
			if json.Unmarshal(scanner.Bytes(), &record) == nil && record.Type == "coding-host-ready" {
				ready <- record
				return
			}
			var progress struct {
				Type  string `json:"type"`
				Done  int    `json:"done"`
				Total int    `json:"total"`
			}
			if json.Unmarshal(scanner.Bytes(), &progress) == nil && progress.Type == "coding-runtime-progress" && l.options.OnProgress != nil {
				l.options.OnProgress(progress.Done, progress.Total)
			}
		}
		if err := scanner.Err(); err != nil {
			readErr <- err
		} else {
			readErr <- ErrHostUnavailable
		}
	}()
	select {
	case record := <-ready:
		if record.Protocol != Protocol || record.Port < 1 || record.Port > 65535 || record.Version != l.options.Version || record.Token == "" {
			return Endpoint{}, fmt.Errorf("coding: invalid Host readiness record")
		}
		endpoint := Endpoint{Record: record, BaseURL: baseURL(record.Port), Started: true}
		if !l.probe(readyCtx, endpoint) {
			return Endpoint{}, fmt.Errorf("coding: Host announced readiness but host.describe health check failed")
		}
		return endpoint, nil
	case err := <-readErr:
		return Endpoint{}, fmt.Errorf("coding: Host exited before readiness: %w", err)
	case <-readyCtx.Done():
		return Endpoint{}, fmt.Errorf("coding: Host readiness timeout: %w", readyCtx.Err())
	}
}

// childEnvironment 合并父进程环境、调用方私有变量和启动器拥有的变量。按 key
// 去重后再排序，使敏感变量不会因重复项被旧值覆盖，也便于测试精确观察启动环境。
func (l *Launcher) childEnvironment() []string {
	type variable struct {
		key   string
		value string
	}
	values := make(map[string]variable)
	for _, entry := range os.Environ() {
		key, value, found := strings.Cut(entry, "=")
		if found {
			values[environmentKey(key)] = variable{key: key, value: value}
		}
	}
	// macOS GUI 启动继承的 launchd PATH 只有系统目录，模型执行的命令会找不到
	// Homebrew、nvm、Go 等用户目录，因此 GUI 启动时改用登录 shell 的 PATH；调用方
	// 通过 Options.Environment 显式传入的 PATH 仍然优先。
	if path := guiLoginShellPath(); path != "" {
		values[environmentKey("PATH")] = variable{key: "PATH", value: path}
	}
	for key, value := range l.options.Environment {
		values[environmentKey(key)] = variable{key: key, value: value}
	}
	// 这些变量是启动器的所有权边界，不能由附加环境覆盖。
	values[environmentKey("DSH_HOME")] = variable{key: "DSH_HOME", value: l.options.Home}
	values[environmentKey("DSH_CWD")] = variable{key: "DSH_CWD", value: l.options.CWD}
	values[environmentKey("DSH_APP_VERSION")] = variable{key: "DSH_APP_VERSION", value: l.options.Version}
	keys := make([]string, 0, len(values))
	for _, entry := range values {
		keys = append(keys, entry.key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		entry := values[environmentKey(key)]
		result = append(result, entry.key+"="+entry.value)
	}
	return result
}

func environmentKey(key string) string {
	if runtime.GOOS == "windows" {
		return strings.ToUpper(key)
	}
	return key
}

func (l *Launcher) commandWorkingDirectory() string {
	if root := repoRoot(); root != "" {
		return root
	}
	return l.options.CWD
}

func (l *Launcher) command() ([]string, error) {
	if len(l.options.Command) > 0 {
		return append([]string(nil), l.options.Command...), nil
	}
	if value := strings.TrimSpace(os.Getenv("CODING_HOST_COMMAND")); value != "" {
		return strings.Fields(value), nil
	}
	if l.options.RuntimeRoot != "" {
		executable := filepath.Join(l.options.RuntimeRoot, runtimeHostExecutableName())
		if _, err := os.Stat(executable); err != nil {
			return nil, fmt.Errorf("coding: packaged Host is missing at %s: %w", executable, err)
		}
		entry := packagedHostEntry(l.options.RuntimeRoot)
		if _, err := os.Stat(entry); err != nil {
			return nil, fmt.Errorf("coding: packaged Host entry is missing at %s: %w", entry, err)
		}
		return []string{executable, entry, "web", "--coding-host"}, nil
	}
	if executable, err := exec.LookPath("coding-host"); err == nil {
		return []string{executable, "web", "--coding-host"}, nil
	}
	if executable, err := exec.LookPath("dsh"); err == nil {
		return []string{executable, "web", "--coding-host"}, nil
	}
	root := repoRoot()
	if root != "" {
		entry := filepath.Join(root, "apps", "cli", "src", "bin.ts")
		if _, err := os.Stat(entry); err == nil {
			return []string{"node", "--import", "tsx/esm", entry, "web", "--coding-host"}, nil
		}
	}
	return nil, fmt.Errorf("coding: no Host executable; set CODING_HOST_COMMAND or install coding-host")
}

func runtimeHostExecutableName() string {
	if runtime.GOOS == "windows" {
		return "coding-host.exe"
	}
	return "coding-host"
}

// packagedHostEntry 返回桌面应用内预展开闭包的 Node 入口。
func packagedHostEntry(root string) string {
	return filepath.Join(root, "runtime", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")
}

func repoRoot() string {
	if value := strings.TrimSpace(os.Getenv("CODING_REPO_ROOT")); value != "" {
		return value
	}
	working, err := os.Getwd()
	if err != nil {
		return ""
	}
	for current := working; ; current = filepath.Dir(current) {
		if _, err := os.Stat(filepath.Join(current, "apps", "cli", "src", "bin.ts")); err == nil {
			return current
		}
		parent := filepath.Dir(current)
		if parent == current {
			return ""
		}
	}
}

func baseURL(port int) string { return "http://127.0.0.1:" + strconv.Itoa(port) }

func randomID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(bytes[:])
}

type launchLock struct {
	file *os.File
	path string
}

func (lock *launchLock) Close() error {
	if lock == nil || lock.file == nil {
		return nil
	}
	if err := lock.file.Close(); err != nil {
		return err
	}
	return os.Remove(lock.path)
}

// acquireLock 获取启动锁。锁文件首行是持锁进程 PID；若该进程已死亡，视为残留锁
// 直接清除后重试，避免崩溃/强杀留下的锁把后续启动阻塞到超时（表现为启动页一直转圈）。
func acquireLock(ctx context.Context, path string, timeout, interval time.Duration) (*launchLock, error) {
	deadline := time.Now().Add(timeout)
	for {
		file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			_, _ = file.WriteString(strconv.Itoa(os.Getpid()) + "\n")
			return &launchLock{file: file, path: path}, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("coding: acquire Host launch lock: %w", err)
		}
		if owner := readLockOwner(path); owner > 0 && !processAlive(owner) {
			_ = os.Remove(path)
			continue
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("coding: timed out waiting for Host launch lock")
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

// readLockOwner 解析锁文件首行的持锁 PID；文件缺失或内容非法时返回 0。
func readLockOwner(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	line := strings.TrimSpace(strings.SplitN(string(data), "\n", 2)[0])
	owner, err := strconv.Atoi(line)
	if err != nil || owner <= 0 {
		return 0
	}
	return owner
}
