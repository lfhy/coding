package remoteagent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// directProcessBackend 只拥有本条 SSH 连接启动的进程。SSH 没有进程树
// 终止确认协议；断线或发信号后绝不把未知状态伪装成正常退出。
type directProcessBackend struct {
	client            *ssh.Client
	retention         time.Duration
	mu                sync.Mutex
	processes         map[string]*directProcess
	starts            map[processStartKey]*processStartRecord
	inflight          map[*processStartRecord]*ssh.Session
	unknown           map[processStartKey]struct{}
	closed            bool
	closeUnknown      bool
	starting          int
	afterSessionStart func()
}

type directProcess struct {
	id, root                    string
	startKey                    processStartKey
	owner                       *directProcessBackend
	startedAt                   int64
	pid                         int
	session                     *ssh.Session
	stdin                       io.WriteCloser
	stdinMode                   string
	stdinMu                     sync.Mutex
	captureDone                 sync.WaitGroup
	mu                          sync.Mutex
	stdout, stderr              processStream
	notify                      chan struct{}
	done                        chan struct{}
	stdinClosed, exited, closed bool
	exitCode                    *int
	exitSignal                  *string
	exitedAt                    *int64
}

func newDirectProcessBackend(client *ssh.Client) *directProcessBackend {
	return &directProcessBackend{client: client, retention: defaultProcessRetention, processes: make(map[string]*directProcess), starts: make(map[processStartKey]*processStartRecord), inflight: make(map[*processStartRecord]*ssh.Session), unknown: make(map[processStartKey]struct{})}
}

func (b *directProcessBackend) Proxy(ctx context.Context, route string, body []byte) (ProxyResponse, error) {
	if runtime.GOOS == "windows" {
		return directExecError(http.StatusNotImplemented, "unsupported-platform", "direct SSH processes require a POSIX platform"), nil
	}
	if len(body) > maxProxyRequestBytes {
		return directExecError(http.StatusRequestEntityTooLarge, "request-too-large", "request exceeds the byte limit"), nil
	}
	var value any
	switch route {
	case "/v1/processes/resolve":
		value = &ProcessResolveRequest{}
	case "/v1/processes/start":
		value = &ProcessStartRequest{}
	case "/v1/processes/read":
		value = &ProcessReadRequest{}
	case "/v1/processes/write":
		value = &ProcessWriteRequest{}
	case "/v1/processes/wait":
		value = &ProcessWaitRequest{}
	case "/v1/processes/kill":
		value = &ProcessKillRequest{}
	default:
		return directExecError(http.StatusNotFound, "not-found", "unknown process route"), nil
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return directExecError(http.StatusBadRequest, "invalid-json", "invalid process request JSON"), nil
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return directExecError(http.StatusBadRequest, "invalid-json", "request must contain exactly one JSON value"), nil
	}
	if err := ctx.Err(); err != nil {
		return ProxyResponse{}, err
	}
	var result any
	var err error
	switch request := value.(type) {
	case *ProcessResolveRequest:
		result, err = b.resolve(ctx, *request)
	case *ProcessStartRequest:
		result, err = b.start(ctx, *request)
	case *ProcessReadRequest:
		result, err = b.read(ctx, *request)
	case *ProcessWriteRequest:
		result, err = b.write(ctx, *request)
	case *ProcessWaitRequest:
		result, err = b.wait(ctx, *request)
	case *ProcessKillRequest:
		result, err = b.kill(*request)
	}
	if err != nil {
		var failure *agentFailure
		if errors.As(err, &failure) {
			return directExecError(failure.status, failure.code, failure.message), nil
		}
		if errors.Is(err, ErrProcessNotFound) {
			return directExecError(404, "process-not-found", "process not found"), nil
		}
		if errors.Is(err, ErrProcessStartConflict) {
			return directExecError(409, "start-nonce-conflict", "start nonce conflicts with an existing request"), nil
		}
		if errors.Is(err, ErrProcessClosed) {
			return directExecError(409, "process-closed", "process stdin is closed"), nil
		}
		if errors.Is(err, ErrProcessInputBackpressure) {
			return directExecError(429, "input-backpressure", "process input queue is full"), nil
		}
		return ProxyResponse{}, err
	}
	return directExecJSON(200, result)
}

// Close 停止本地持有 SSH channel；远端进程树的结果仍为未知，不能承诺回收。
func (b *directProcessBackend) Close() error {
	b.mu.Lock()
	b.closed = true
	b.closeUnknown = b.closeUnknown || b.starting > 0 || len(b.unknown) > 0
	unknown := b.closeUnknown
	all := make([]*directProcess, 0, len(b.processes))
	for _, process := range b.processes {
		all = append(all, process)
	}
	starting := make([]*ssh.Session, 0, b.starting)
	for _, session := range b.inflight {
		starting = append(starting, session)
	}
	b.mu.Unlock()
	for _, session := range starting {
		_ = session.Close()
	}
	for _, process := range all {
		process.mu.Lock()
		active := !process.exited
		process.mu.Unlock()
		if active {
			_ = process.session.Signal(ssh.SIGKILL)
			_ = process.session.Close()
			unknown = true
		}
	}
	if unknown {
		b.mu.Lock()
		b.closeUnknown = true
		b.mu.Unlock()
		return errors.New("direct SSH process tree termination is unknown")
	}
	return nil
}

func directProcessPath(root, cwd string) (string, string, error) {
	if len(root) > maxRemotePathBytes || len(cwd) > maxRemotePathBytes || strings.ContainsRune(root, 0) || strings.ContainsRune(cwd, 0) {
		return "", "", fail(400, "invalid-path", "process path exceeds the byte limit")
	}
	if root != "" && !directAbsolutePath(root) {
		return "", "", fail(400, "invalid-root", "root must be an absolute POSIX path")
	}
	root = path.Clean(root)
	if root == "." {
		root = ""
	}
	if !directAbsolutePath(cwd) {
		if root == "" || cwd == "" {
			return "", "", fail(400, "invalid-path", "path must be absolute or relative to root")
		}
		cwd = path.Join(root, cwd)
	}
	cwd = path.Clean(cwd)
	if root != "" && !directPathWithin(root, cwd) {
		return "", "", fail(403, "outside-root", "process path is outside the requested root")
	}
	return root, cwd, nil
}

func directProcessEnv(env map[string]*string) ([]string, error) {
	if len(env) > maxProcessEnvironmentEntries {
		return nil, fail(400, "invalid-environment", "environment has too many entries")
	}
	keys := make([]string, 0, len(env))
	size := 0
	for key, value := range env {
		if !directEnvName(key) || strings.HasPrefix(key, "_dsh_") || key == "BASH" || key == "BASH_ENV" || key == "ENV" || strings.HasPrefix(key, "BASH_FUNC_") {
			return nil, fail(400, "invalid-environment", "environment contains an invalid name")
		}
		size += len(key) + 1
		if value != nil {
			if strings.ContainsRune(*value, 0) {
				return nil, fail(400, "invalid-environment", "environment contains an invalid value")
			}
			size += len(*value)
		}
		if size > maxProcessEnvironmentBytes {
			return nil, fail(400, "invalid-environment", "environment exceeds the byte limit")
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys, nil
}

// 固定的 SSH exec 字符串只解释 stdin 的 NUL 帧，不含路径、argv 或凭据。
const directProcessScript = `set +x; _dsh_read() { IFS= read -r -d '' "$1"; }; _dsh_read _dsh_root || exit 125; _dsh_read _dsh_cwd || exit 125; _dsh_read _dsh_count || exit 125; _dsh_argv=(); for ((_dsh_i=0; _dsh_i<_dsh_count; _dsh_i++)); do _dsh_read _dsh_item || exit 125; _dsh_argv+=("$_dsh_item"); done; _dsh_read _dsh_count || exit 125; for ((_dsh_i=0; _dsh_i<_dsh_count; _dsh_i++)); do _dsh_read _dsh_key || exit 125; _dsh_read _dsh_present || exit 125; if [ "$_dsh_present" = 1 ]; then _dsh_read _dsh_value || exit 125; export "$_dsh_key=$_dsh_value" || exit 125; else unset "$_dsh_key" || exit 125; fi; done; if [ -n "$_dsh_root" ]; then cd -- "$_dsh_root" || exit 125; _dsh_root_phys=$(pwd -P) || exit 125; fi; cd -- "$_dsh_cwd" || exit 125; _dsh_cwd_phys=$(pwd -P) || exit 125; if [ -n "$_dsh_root" ] && [ "$_dsh_root" != / ]; then case "$_dsh_cwd_phys" in "$_dsh_root_phys"|"$_dsh_root_phys"/*) ;; *) exit 125;; esac; fi; _dsh_exe=${_dsh_argv[0]}; if [[ "$_dsh_exe" = */* ]]; then [[ "$_dsh_exe" = /* && -f "$_dsh_exe" && -x "$_dsh_exe" ]] || exit 126; else _dsh_path=${PATH:-/usr/local/bin:/usr/bin:/bin}; _dsh_found=; while IFS= read -r -d ':' _dsh_dir; do [ -n "$_dsh_dir" ] || _dsh_dir=.; if [ -f "$_dsh_dir/$_dsh_exe" ] && [ -x "$_dsh_dir/$_dsh_exe" ]; then _dsh_found=$_dsh_dir/$_dsh_exe; break; fi; done < <(printf '%s:' "$_dsh_path"); [ -n "$_dsh_found" ] || exit 127; _dsh_exe=$_dsh_found; fi; printf 'DSH-PROCESS-READY %s\n' "$$" >&2; exec "$_dsh_exe" "${_dsh_argv[@]:1}"`

// 在清空启动环境前由远端 Bash 的固定内建命令解析工具；不继承请求 PATH。
func directProcessStartCommand() string {
	script := strings.Replace(directProcessScript, `set +x;`, `set +x; trap 'printf "DSH-PROCESS-FAILED\n" >&2' EXIT;`, 1)
	bootstrap := `set +x; _dsh_env=$(type -P env) || exit 125; _dsh_bash=$(type -P bash) || exit 125; [[ "$_dsh_env" = /* && -x "$_dsh_env" && "$_dsh_bash" = /* && -x "$_dsh_bash" ]] || exit 125; exec "$_dsh_env" -i "$_dsh_bash" -c ` + shellQuote(script)
	return "bash -c " + shellQuote(bootstrap)
}

func directProcessFrame(root, cwd string, argv []string, env map[string]*string, keys []string) []byte {
	var frame bytes.Buffer
	add := func(value string) { frame.WriteString(value); frame.WriteByte(0) }
	add(root)
	add(cwd)
	add(strconv.Itoa(len(argv)))
	for _, value := range argv {
		add(value)
	}
	add(strconv.Itoa(len(keys)))
	for _, key := range keys {
		add(key)
		if env[key] == nil {
			add("0")
		} else {
			add("1")
			add(*env[key])
		}
	}
	return frame.Bytes()
}

func (b *directProcessBackend) resolve(ctx context.Context, request ProcessResolveRequest) (ProcessResolveResponse, error) {
	root, cwd, err := directProcessPath(request.Root, request.Path)
	if err != nil {
		return ProcessResolveResponse{}, err
	}
	keys, err := directProcessEnv(request.Env)
	if err != nil {
		return ProcessResolveResponse{}, err
	}
	if request.Command == "" || strings.ContainsRune(request.Command, 0) || strings.Contains(request.Command, "/") && !directAbsolutePath(request.Command) {
		return ProcessResolveResponse{}, fail(400, "invalid-command", "command must be an absolute path or a bare name")
	}
	// 解析复用同一 POSIX 范围与 PATH 检查，但不启动用户命令。
	command := directProcessScript[:strings.Index(directProcessScript, "printf 'DSH-PROCESS-READY")]
	command += `if [[ "$_dsh_exe" = /* ]]; then printf '%s\0' "$_dsh_exe"; else printf '%s/%s\0' "$_dsh_cwd_phys" "$_dsh_exe"; fi`
	session, err := b.client.NewSession()
	if err != nil {
		return ProcessResolveResponse{}, err
	}
	defer session.Close()
	input := directProcessFrame(root, cwd, []string{request.Command}, request.Env, keys)
	session.Stdin = bytes.NewReader(input)
	output := &limitedBuffer{limit: maxRemotePathBytes + 1}
	session.Stdout = output
	done := make(chan struct {
		output    []byte
		truncated bool
		err       error
	}, 1)
	go func() {
		runErr := session.Run("bash -c " + shellQuote(command))
		done <- struct {
			output    []byte
			truncated bool
			err       error
		}{append([]byte(nil), output.data...), output.truncated, runErr}
	}()
	select {
	case outcome := <-done:
		if outcome.err != nil {
			var exit *ssh.ExitError
			if errors.As(outcome.err, &exit) && exit.ExitStatus() == 126 {
				return ProcessResolveResponse{}, fail(403, "permission-denied", "remote command is not executable")
			}
			return ProcessResolveResponse{}, fail(404, "executable-not-found", "command could not be resolved in the remote directory")
		}
		if outcome.truncated || len(outcome.output) == 0 || outcome.output[len(outcome.output)-1] != 0 {
			return ProcessResolveResponse{}, fail(503, "invalid-remote-result", "remote executable resolution returned an invalid path")
		}
		return ProcessResolveResponse{Path: path.Clean(string(outcome.output[:len(outcome.output)-1]))}, nil
	case <-ctx.Done():
		_ = session.Close()
		return ProcessResolveResponse{}, ctx.Err()
	}
}

func (b *directProcessBackend) start(ctx context.Context, request ProcessStartRequest) (response ProcessStartResponse, err error) {
	if err := validateProcessStart(request); err != nil {
		return ProcessStartResponse{}, err
	}
	root, cwd, err := directProcessPath(request.Root, request.Path)
	if err != nil {
		return ProcessStartResponse{}, err
	}
	keys, err := directProcessEnv(request.Env)
	if err != nil {
		return ProcessStartResponse{}, err
	}
	if strings.Contains(request.Argv[0], "/") && !directAbsolutePath(request.Argv[0]) {
		return ProcessStartResponse{}, fail(400, "invalid-command", "command path must be absolute")
	}
	fingerprint, err := processStartFingerprint(request)
	if err != nil {
		return ProcessStartResponse{}, err
	}
	key := processStartKey{root: root, nonce: request.StartNonce}
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return ProcessStartResponse{}, ErrProcessNotFound
	}
	if record := b.starts[key]; record != nil {
		_, unknown := b.unknown[key]
		b.mu.Unlock()
		if record.fingerprint != fingerprint {
			return ProcessStartResponse{}, ErrProcessStartConflict
		}
		if unknown {
			return ProcessStartResponse{}, fail(503, "process-state-unknown", "SSH closed without a remote exit status; retry cannot safely create another process")
		}
		select {
		case <-record.done:
			return record.response, record.err
		case <-ctx.Done():
			return ProcessStartResponse{}, ctx.Err()
		}
	}
	// 未知退出的 nonce 不能驱逐；满额后拒绝新启动，避免旧 nonce 重试生成第二棵进程树。
	if len(b.unknown) >= maxProcessSessions {
		b.mu.Unlock()
		return ProcessStartResponse{}, fail(429, "unknown-process-limit", "too many unknown remote process exits; reconnect before starting another process")
	}
	if len(b.unknown)+len(b.processes)+b.starting >= maxProcessSessions {
		b.mu.Unlock()
		return ProcessStartResponse{}, fail(429, "too-many-processes", "remote process limit is reached")
	}
	record := &processStartRecord{fingerprint: fingerprint, done: make(chan struct{})}
	b.starts[key] = record
	b.starting++
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		b.starting--
		delete(b.inflight, record)
		if b.closed {
			err = fail(503, "process-state-unknown", "SSH closed during process start; remote process state is unknown")
		}
		if err != nil {
			// 启动请求失去确认时也不能在相同 nonce 上安全重试。
			b.unknown[key] = struct{}{}
		}
		record.response = response
		record.err = err
		close(record.done)
		// 远端可能已经启动；保留 nonce 的稳定结果，重试不得再创建进程。
		b.mu.Unlock()
	}()
	response, err = b.launch(ctx, root, cwd, request, keys, key, record)
	return response, err
}

func (b *directProcessBackend) launch(ctx context.Context, root, cwd string, request ProcessStartRequest, keys []string, key processStartKey, record *processStartRecord) (ProcessStartResponse, error) {
	session, err := b.client.NewSession()
	if err != nil {
		return ProcessStartResponse{}, err
	}
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		_ = session.Close()
		return ProcessStartResponse{}, errors.New("direct SSH backend closed during process start; remote process state is unknown")
	}
	b.inflight[record] = session
	b.mu.Unlock()
	stdin, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		return ProcessStartResponse{}, err
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		_ = session.Close()
		return ProcessStartResponse{}, err
	}
	stderr, err := session.StderrPipe()
	if err != nil {
		_ = session.Close()
		return ProcessStartResponse{}, err
	}
	id, err := newProcessID()
	if err != nil {
		_ = session.Close()
		return ProcessStartResponse{}, err
	}
	p := &directProcess{id: id, root: root, startKey: key, owner: b, startedAt: time.Now().UnixMilli(), session: session, stdin: stdin,
		stdinMode: request.Stdin.Mode, notify: make(chan struct{}), done: make(chan struct{}),
		stdout: processStream{mode: request.Stdout.Mode, limit: directProcessLimit(request.Stdout)},
		stderr: processStream{mode: request.Stderr.Mode, limit: directProcessLimit(request.Stderr)}}
	// 在读取请求帧之前清空登录环境；凭据只由 Bash export，绝不拼入 exec argv。
	if err := session.Start(directProcessStartCommand()); err != nil {
		_ = session.Close()
		return ProcessStartResponse{}, err
	}
	if b.afterSessionStart != nil {
		b.afterSessionStart()
	}
	p.captureDone.Add(2)
	go p.capture(stdout, true)
	ready := make(chan int, 1)
	go p.captureStderr(stderr, ready)
	frame := directProcessFrame(root, cwd, request.Argv, request.Env, keys)
	written := make(chan error, 1)
	go func() { written <- writeAll(stdin, frame) }()
	select {
	case err := <-written:
		if err != nil {
			_ = session.Close()
			return ProcessStartResponse{}, fmt.Errorf("direct SSH start framing: %w", err)
		}
	case <-ctx.Done():
		_ = session.Close()
		return ProcessStartResponse{}, fail(503, "process-state-unknown", "SSH start was interrupted; remote process state is unknown")
	}
	select {
	case pid := <-ready:
		if pid <= 0 {
			_ = session.Close()
			return ProcessStartResponse{}, fail(422, "process-start-failed", "remote process did not acknowledge start")
		}
		p.pid = pid
	case <-ctx.Done():
		_ = session.Close()
		return ProcessStartResponse{}, fail(503, "process-state-unknown", "SSH start was interrupted; remote process state is unknown")
	}
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		_ = session.Close()
		return ProcessStartResponse{}, errors.New("direct SSH backend closed during process start; remote process state is unknown")
	}
	b.processes[id] = p
	delete(b.inflight, record)
	b.mu.Unlock()
	go p.wait()
	if request.Stdin.Mode == "data" {
		data, _ := decodeProcessInput(request.Stdin.DataBase64)
		written := make(chan error, 1)
		go func() { written <- p.writeInitialInput(data) }()
		select {
		case err := <-written:
			if err != nil {
				_ = session.Close()
				return ProcessStartResponse{}, fail(503, "process-state-unknown", "SSH initial stdin delivery or close failed; remote process state is unknown")
			}
		case <-ctx.Done():
			_ = session.Close()
			return ProcessStartResponse{}, fail(503, "process-state-unknown", "SSH initial stdin write was interrupted; remote process state is unknown")
		}
	} else if request.Stdin.Mode == "ignore" {
		if err := stdin.Close(); err != nil {
			_ = session.Close()
			return ProcessStartResponse{}, fail(503, "process-state-unknown", "SSH stdin close failed; remote process state is unknown")
		}
		p.mu.Lock()
		p.stdinClosed = true
		p.mu.Unlock()
	}
	return ProcessStartResponse{Process: p.snapshot()}, nil
}

func (p *directProcess) writeInitialInput(data []byte) error {
	p.stdinMu.Lock()
	defer p.stdinMu.Unlock()
	if err := writeAll(p.stdin, data); err != nil {
		return err
	}
	if err := p.stdin.Close(); err != nil {
		return err
	}
	p.mu.Lock()
	p.stdinClosed = true
	p.mu.Unlock()
	return nil
}

func directProcessLimit(spec ProcessOutputSpec) int {
	if spec.Mode == "collect" {
		return int(spec.MaxBytes)
	}
	return defaultProcessOutputBytes
}

func (p *directProcess) capture(reader io.Reader, stdout bool) {
	defer p.captureDone.Done()
	buffer := make([]byte, 32<<10)
	for {
		n, err := reader.Read(buffer)
		if n > 0 {
			p.append(stdout, buffer[:n])
		}
		if err != nil {
			break
		}
	}
	p.mu.Lock()
	if stdout {
		p.stdout.eof = true
	} else {
		p.stderr.eof = true
	}
	p.wakeLocked()
	p.mu.Unlock()
}

func (p *directProcess) captureStderr(reader io.Reader, ready chan<- int) {
	buffer := bufio.NewReader(reader)
	line, err := buffer.ReadSlice('\n')
	pid := 0
	if err == nil && bytes.HasPrefix(line, []byte("DSH-PROCESS-READY ")) {
		pid, _ = strconv.Atoi(strings.TrimSpace(string(bytes.TrimPrefix(line, []byte("DSH-PROCESS-READY ")))))
	} else if len(line) > 0 {
		p.append(false, line)
	}
	ready <- pid
	p.capture(buffer, false)
}

func (p *directProcess) append(stdout bool, data []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	s := &p.stderr
	if stdout {
		s = &p.stdout
	}
	s.total += int64(len(data))
	if len(data) >= s.limit {
		s.truncated = s.truncated || len(s.window) > 0 || len(data) > s.limit
		s.window = append(s.window[:0], data[len(data)-s.limit:]...)
	} else {
		s.window = append(s.window, data...)
		if excess := len(s.window) - s.limit; excess > 0 {
			s.window = append([]byte(nil), s.window[excess:]...)
			s.truncated = true
		}
	}
	p.wakeLocked()
}

func (p *directProcess) wakeLocked() { close(p.notify); p.notify = make(chan struct{}) }

func (p *directProcess) wait() {
	err := p.session.Wait()
	p.captureDone.Wait()
	p.mu.Lock()
	if err == nil {
		zero := 0
		p.exitCode = &zero
		p.exited = true
	} else {
		var exit *ssh.ExitError
		if errors.As(err, &exit) {
			if exit.Signal() != "" {
				value := exit.Signal()
				p.exitSignal = &value
			} else {
				value := exit.ExitStatus()
				p.exitCode = &value
			}
			p.exited = true
		}
	}
	if p.exited {
		now := time.Now().UnixMilli()
		p.exitedAt = &now
		p.closed = true
	}
	p.stdinClosed = true
	p.wakeLocked()
	p.mu.Unlock()
	if !p.exited {
		p.owner.mu.Lock()
		p.owner.unknown[p.startKey] = struct{}{}
		p.owner.mu.Unlock()
	}
	close(p.done)
	_ = p.session.Close()
	time.AfterFunc(p.owner.retention, func() {
		p.owner.mu.Lock()
		if p.owner.processes[p.id] == p {
			delete(p.owner.processes, p.id)
			// 未确认退出的 nonce 保留未知结果，重试不能创建第二棵进程树。
			if p.exited {
				record := p.owner.starts[p.startKey]
				if record != nil {
					select {
					case <-record.done:
						if _, unknown := p.owner.unknown[p.startKey]; !unknown {
							delete(p.owner.starts, p.startKey)
						}
					default:
						go func() {
							<-record.done
							p.owner.mu.Lock()
							if _, unknown := p.owner.unknown[p.startKey]; p.owner.starts[p.startKey] == record && !unknown {
								delete(p.owner.starts, p.startKey)
							}
							p.owner.mu.Unlock()
						}()
					}
				}
			}
		}
		p.owner.mu.Unlock()
	})
}

func (p *directProcess) snapshot() ProcessSnapshot {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.snapshotLocked()
}
func (p *directProcess) snapshotLocked() ProcessSnapshot {
	return ProcessSnapshot{ID: p.id, PID: p.pid, Running: !p.exited, Closed: p.closed,
		ExitCode: p.exitCode, Signal: p.exitSignal, StdinClosed: p.stdinClosed, StartedAt: p.startedAt, ExitedAt: p.exitedAt}
}

func (b *directProcessBackend) owned(id, root string) (*directProcess, error) {
	owner, _, err := directProcessPath(root, root)
	if err != nil && root != "" {
		return nil, ErrProcessNotFound
	}
	b.mu.Lock()
	p := b.processes[id]
	b.mu.Unlock()
	if p == nil || p.root != owner {
		return nil, ErrProcessNotFound
	}
	return p, nil
}

func (b *directProcessBackend) read(ctx context.Context, request ProcessReadRequest) (ProcessReadResponse, error) {
	p, err := b.owned(request.ID, request.Root)
	if err != nil {
		return ProcessReadResponse{}, err
	}
	if request.Stream != "stdout" && request.Stream != "stderr" {
		return ProcessReadResponse{}, fail(400, "invalid-stream", "stream must be stdout or stderr")
	}
	if request.From < 0 {
		return ProcessReadResponse{}, fail(400, "invalid-offset", "from cannot be negative")
	}
	limit := int64(maxProcessReadBytes)
	if request.MaxBytes > 0 {
		limit = request.MaxBytes
	}
	if limit > maxProcessReadBytes {
		return ProcessReadResponse{}, fail(400, "invalid-read-limit", "maxBytes exceeds the process read limit")
	}
	for {
		p.mu.Lock()
		s := &p.stderr
		if request.Stream == "stdout" {
			s = &p.stdout
		}
		begin := s.total - int64(len(s.window))
		lossy := request.From < begin
		from := request.From
		if lossy {
			from = begin
		}
		data := []byte{}
		next := request.From
		if from < s.total {
			end := min(from+limit, s.total)
			data = append(data, s.window[int(from-begin):int(end-begin)]...)
			next = end
		}
		response := ProcessReadResponse{DataBase64: base64.StdEncoding.EncodeToString(data), NextOffset: next,
			Lossy: lossy, Truncated: s.truncated, EOF: s.eof && next >= s.total, Closed: p.closed, Process: p.snapshotLocked()}
		notify := p.notify
		p.mu.Unlock()
		if len(data) > 0 || lossy || response.EOF {
			return response, nil
		}
		select {
		case <-notify:
		case <-ctx.Done():
			return response, nil
		}
	}
}

func (b *directProcessBackend) write(ctx context.Context, request ProcessWriteRequest) (ProcessWriteResponse, error) {
	p, err := b.owned(request.ID, request.Root)
	if err != nil {
		return ProcessWriteResponse{}, err
	}
	data, err := decodeProcessInput(request.DataBase64)
	if err != nil {
		return ProcessWriteResponse{}, err
	}
	type outcome struct {
		response ProcessWriteResponse
		err      error
	}
	done := make(chan outcome, 1)
	go func() {
		response, writeErr := p.write(data, request.CloseStdin)
		done <- outcome{response: response, err: writeErr}
	}()
	select {
	case result := <-done:
		return result.response, result.err
	case <-ctx.Done():
		_ = p.session.Close()
		return ProcessWriteResponse{}, fail(503, "process-state-unknown", "SSH stdin write was interrupted; remote process state is unknown")
	}
}

func (p *directProcess) write(data []byte, closeStdin bool) (ProcessWriteResponse, error) {
	p.stdinMu.Lock()
	defer p.stdinMu.Unlock()
	p.mu.Lock()
	if p.stdinMode != "pipe" || p.stdinClosed || p.closed {
		p.mu.Unlock()
		return ProcessWriteResponse{}, ErrProcessClosed
	}
	p.mu.Unlock()
	if err := writeAll(p.stdin, data); err != nil {
		return ProcessWriteResponse{}, fmt.Errorf("direct SSH stdin write: %w", err)
	}
	if closeStdin {
		if err := p.stdin.Close(); err != nil {
			return ProcessWriteResponse{}, err
		}
		p.mu.Lock()
		p.stdinClosed = true
		p.mu.Unlock()
	}
	return ProcessWriteResponse{Written: len(data), StdinClosed: p.snapshot().StdinClosed, Process: p.snapshot()}, nil
}

func (b *directProcessBackend) wait(ctx context.Context, request ProcessWaitRequest) (ProcessWaitResponse, error) {
	p, err := b.owned(request.ID, request.Root)
	if err != nil {
		return ProcessWaitResponse{}, err
	}
	if request.TimeoutMs < 0 || request.TimeoutMs > maxProcessWait.Milliseconds() {
		return ProcessWaitResponse{}, fail(400, "invalid-timeout", "timeoutMs must be within 0..60000")
	}
	timeout := maxProcessWait
	if request.TimeoutMs > 0 {
		timeout = time.Duration(request.TimeoutMs) * time.Millisecond
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-p.done:
		p.mu.Lock()
		known := p.exited
		p.mu.Unlock()
		if !known {
			return ProcessWaitResponse{}, fail(503, "process-state-unknown", "SSH closed without a remote exit status")
		}
		return ProcessWaitResponse{Completed: true, Process: p.snapshot()}, nil
	case <-timer.C:
		return ProcessWaitResponse{Completed: false, Process: p.snapshot()}, nil
	case <-ctx.Done():
		return ProcessWaitResponse{Completed: false, Process: p.snapshot()}, nil
	}
}

func (b *directProcessBackend) kill(request ProcessKillRequest) (ProcessKillResponse, error) {
	p, err := b.owned(request.ID, request.Root)
	if err != nil {
		return ProcessKillResponse{}, err
	}
	if request.Signal != "" && request.Signal != "SIGTERM" && request.Signal != "SIGKILL" {
		return ProcessKillResponse{}, fail(400, "invalid-signal", "signal must be SIGTERM or SIGKILL")
	}
	p.mu.Lock()
	exited := p.exited
	p.mu.Unlock()
	if exited {
		return ProcessKillResponse{Process: p.snapshot()}, nil
	}
	signal := ssh.SIGTERM
	if request.Signal == "SIGKILL" {
		signal = ssh.SIGKILL
	}
	if err := p.session.Signal(signal); err != nil {
		return ProcessKillResponse{}, fail(503, "process-state-unknown", "SSH could not confirm remote signal delivery or process tree termination")
	}
	return ProcessKillResponse{}, fail(503, "process-tree-unknown", "SSH signal does not confirm process tree termination")
}
