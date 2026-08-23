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
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	ErrHostUnavailable  = errors.New("coding: no compatible local Host is available")
	ErrHostIncompatible = errors.New("coding: a different live Coding Host owns the shared home")
)

// Launcher owns no Host process. It serializes discovery/start operations and
// returns a client endpoint; the managed Host remains independent after ready.
type Launcher struct {
	options Options
	client  *http.Client
	mu      sync.Mutex
}

// AppVersion is the product version compiled into release launchers.
// Development builds deliberately use dev so they accept the checkout Host.
var AppVersion = "dev"

// New returns a launcher with platform defaults filled in.
func New(options Options) (*Launcher, error) {
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

// RecordPath returns the shared discovery filename.
func (l *Launcher) RecordPath() string { return filepath.Join(l.options.Home, "host.json") }

// Home returns the resolved shared DSH_HOME used for discovery and runtime files.
func (l *Launcher) Home() string { return l.options.Home }

// Ensure returns a compatible running Host or starts one while holding the
// cross-process launch lock. The lock is released as soon as readiness is
// observed, so clients never serialize normal request traffic.
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

	if endpoint, state := l.discover(ctx); state == discoveryCompatible {
		return endpoint, nil
	} else if state == discoveryLiveIncompatible {
		return Endpoint{}, ErrHostIncompatible
	}
	return l.start(ctx)
}

type discoveryState uint8

const (
	discoveryMissing discoveryState = iota
	discoveryCompatible
	discoveryLiveIncompatible
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
	if record.Protocol != Protocol || record.Version != l.options.Version {
		if processAlive(record.PID) || l.probe(ctx, endpoint) {
			return Endpoint{}, discoveryLiveIncompatible
		}
		return Endpoint{}, discoveryMissing
	}
	if !processAlive(record.PID) || !l.probe(ctx, endpoint) {
		return Endpoint{}, discoveryMissing
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
				Version string `json:"version"`
			} `json:"value"`
		} `json:"result"`
	}
	if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&envelope) != nil {
		return false
	}
	return envelope.Type == "server-response" && envelope.RPCID == rpcID && envelope.Result.OK && envelope.Result.Value.Version == endpoint.Record.Version
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
	child.Env = append(os.Environ(), "DSH_HOME="+l.options.Home, "DSH_CWD="+l.options.CWD, "DSH_APP_VERSION="+l.options.Version)
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
		if record.Protocol != Protocol || record.Port < 1 || record.Port > 65535 || record.Version != l.options.Version {
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
		return []string{executable, "web", "--coding-host"}, nil
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
