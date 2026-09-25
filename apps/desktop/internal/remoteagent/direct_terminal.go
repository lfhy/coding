package remoteagent

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// SSH 不提供远端 PTY 的前台进程组查询。启动脚本只在关闭回显的 PTY
// 上读取 NUL 帧；SSH exec 请求始终是这段固定脚本，不含用户参数或凭据。
const directTerminalScript = `set +x; _dsh_read() { IFS= read -r -d '' "$1"; }; _dsh_read _dsh_root || exit 125; _dsh_read _dsh_cwd || exit 125; _dsh_read _dsh_count || exit 125; _dsh_argv=(); for ((_dsh_i=0; _dsh_i<_dsh_count; _dsh_i++)); do _dsh_read _dsh_item || exit 125; _dsh_argv+=("$_dsh_item"); done; _dsh_read _dsh_count || exit 125; for ((_dsh_i=0; _dsh_i<_dsh_count; _dsh_i++)); do _dsh_read _dsh_key || exit 125; _dsh_read _dsh_value || exit 125; export "$_dsh_key=$_dsh_value" || exit 125; done; unset _dsh_key _dsh_value; if [ -n "$_dsh_root" ]; then cd -- "$_dsh_root" || exit 125; _dsh_root_phys=$(pwd -P) || exit 125; fi; cd -- "$_dsh_cwd" || exit 125; _dsh_cwd_phys=$(pwd -P) || exit 125; if [ -n "$_dsh_root" ] && [ "$_dsh_root" != / ]; then case "$_dsh_cwd_phys" in "$_dsh_root_phys"|"$_dsh_root_phys"/*) ;; *) exit 125;; esac; fi; _dsh_exe=${_dsh_argv[0]}; if [[ "$_dsh_exe" = */* ]]; then [[ "$_dsh_exe" = /* && -f "$_dsh_exe" && -x "$_dsh_exe" ]] || exit 126; else _dsh_path=${PATH:-/usr/local/bin:/usr/bin:/bin}; _dsh_found=; while IFS= read -r -d ':' _dsh_dir; do [ -n "$_dsh_dir" ] || _dsh_dir=.; if [ -f "$_dsh_dir/$_dsh_exe" ] && [ -x "$_dsh_dir/$_dsh_exe" ]; then _dsh_found=$_dsh_dir/$_dsh_exe; break; fi; done < <(printf '%s:' "$_dsh_path"); [ -n "$_dsh_found" ] || exit 127; _dsh_exe=$_dsh_found; fi; "$_dsh_stty" sane || exit 125; printf '\036DSH-TERMINAL-READY %s\037' "$$"; exec "$_dsh_exe" "${_dsh_argv[@]:1}"`

// 从远端启动 PATH 固定 stty 路径，再接收用户环境；缺失时不读取 PTY 上的请求帧。
func directTerminalStartCommand() string {
	bootstrap := `set +x; _dsh_stty=$(type -P stty) || exit 125; [[ "$_dsh_stty" = /* && -x "$_dsh_stty" ]] || exit 125; "$_dsh_stty" raw -echo || exit 125; printf '\036DSH-FRAME-READY\037'; ` + directTerminalScript
	return "bash -c " + shellQuote(bootstrap)
}

const directTerminalReadyPrefix = "\x1eDSH-TERMINAL-READY "
const directTerminalFrameReady = "\x1eDSH-FRAME-READY\x1f"
const directTerminalStartTimeout = 15 * time.Second

type directTerminalBackend struct {
	client            *ssh.Client
	mu                sync.Mutex
	sessions          map[string]*directTerminal
	starts            map[terminalStartKey]*directTerminalStart
	closed            bool
	closeUnknown      bool
	afterSessionStart func()
}

type directTerminalStart struct {
	fingerprint [sha256.Size]byte
	done        chan struct{}
	response    TerminalStartResponse
	err         error
	session     *ssh.Session
}

type directTerminal struct {
	id, root          string
	pid               int
	session           *ssh.Session
	stdin             io.WriteCloser
	writeMu           sync.Mutex
	writeSlots        chan struct{}
	mu                sync.Mutex
	chunks            []TerminalOutputChunk
	outputBytes       int
	cursor, discarded uint64
	closed            bool
	unknown           bool
	exitCode          *int
	signal            string
	notify            chan struct{}
	done              chan struct{}
	readerDone        chan struct{}
	closeOnce         sync.Once
	onClosed          func()
}

func newDirectTerminalBackend(client *ssh.Client) *directTerminalBackend {
	return &directTerminalBackend{client: client, sessions: make(map[string]*directTerminal), starts: make(map[terminalStartKey]*directTerminalStart)}
}

// Proxy 只处理已授权路由的封闭 JSON 请求；关闭 SSH channel 不冒充进程树退出。
func (b *directTerminalBackend) Proxy(ctx context.Context, route string, body []byte) (ProxyResponse, error) {
	if runtime.GOOS == "windows" {
		return directExecError(501, "pty-unavailable", "direct SSH PTY requires a POSIX platform"), nil
	}
	if len(body) > maxProxyRequestBytes {
		return directExecError(413, "request-too-large", "request exceeds the byte limit"), nil
	}
	var request any
	switch route {
	case "/v1/terminals/start":
		request = &TerminalStartRequest{}
	case "/v1/terminals/read":
		request = &TerminalReadRequest{}
	case "/v1/terminals/write":
		request = &TerminalWriteRequest{}
	case "/v1/terminals/resize":
		request = &TerminalResizeRequest{}
	case "/v1/terminals/foreground":
		request = &TerminalForegroundRequest{}
	case "/v1/terminals/signal":
		request = &TerminalSignalRequest{}
	case "/v1/terminals/terminate":
		request = &TerminalTerminateRequest{}
	default:
		return directExecError(404, "not-found", "unknown terminal route"), nil
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(request); err != nil {
		return directExecError(400, "invalid-json", "invalid terminal request JSON"), nil
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return directExecError(400, "invalid-json", "request must contain exactly one JSON value"), nil
	}
	if err := ctx.Err(); err != nil {
		return ProxyResponse{}, err
	}
	var result any = map[string]bool{"accepted": true}
	var err error
	switch value := request.(type) {
	case *TerminalStartRequest:
		result, err = b.start(ctx, *value)
	case *TerminalReadRequest:
		result, err = b.read(ctx, *value)
	case *TerminalWriteRequest:
		err = b.write(ctx, *value)
	case *TerminalResizeRequest:
		err = b.resize(*value)
	case *TerminalForegroundRequest:
		_, err = b.session(value.Root, value.ID)
		if err == nil {
			err = fail(501, "terminal-foreground-unavailable", "SSH does not expose the foreground process group")
		}
	case *TerminalSignalRequest:
		err = b.signal(*value)
	case *TerminalTerminateRequest:
		err = b.terminate(ctx, *value)
	}
	if err != nil {
		var failure *agentFailure
		switch {
		case errors.As(err, &failure):
			return directExecError(failure.status, failure.code, failure.message), nil
		case errors.Is(err, ErrTerminalNotFound):
			return directExecError(404, "terminal-not-found", "terminal session was not found"), nil
		case errors.Is(err, ErrTerminalClosed):
			return directExecError(409, "terminal-closed", "terminal session is closed"), nil
		case errors.Is(err, ErrTerminalStartConflict):
			return directExecError(409, "terminal-start-conflict", "start nonce conflicts with an existing terminal request"), nil
		default:
			return ProxyResponse{}, err
		}
	}
	return directExecJSON(200, result)
}

func (b *directTerminalBackend) Close() error {
	b.mu.Lock()
	b.closed = true
	all := make([]*directTerminal, 0, len(b.sessions))
	for _, session := range b.sessions {
		all = append(all, session)
	}
	starting := make([]*ssh.Session, 0)
	unknown := b.closeUnknown
	for _, record := range b.starts {
		select {
		case <-record.done:
			if record.err != nil {
				unknown = true
			}
		default:
			unknown = true
		}
		if record.session != nil {
			starting = append(starting, record.session)
		}
	}
	b.closeUnknown = unknown
	b.mu.Unlock()
	for _, session := range starting {
		_ = session.Close()
	}
	for _, session := range all {
		select {
		case <-session.done:
			session.mu.Lock()
			unknown = unknown || session.unknown
			session.mu.Unlock()
		default:
			unknown = true
			_ = session.session.Signal(ssh.SIGKILL)
			_ = session.session.Close()
		}
	}
	if unknown {
		b.mu.Lock()
		b.closeUnknown = true
		b.mu.Unlock()
		return errors.New("direct SSH terminal process tree termination is unknown")
	}
	return nil
}

func (b *directTerminalBackend) start(ctx context.Context, request TerminalStartRequest) (response TerminalStartResponse, err error) {
	ctx, cancel := context.WithTimeout(ctx, directTerminalStartTimeout)
	defer cancel()
	if err := validateTerminalStart(request); err != nil {
		return TerminalStartResponse{}, fail(400, "invalid-terminal-request", err.Error())
	}
	root, cwd, err := directProcessPath(request.Root, request.Path)
	if err != nil {
		return TerminalStartResponse{}, err
	}
	if len(request.Env) > maxTerminalEnvironmentEntries {
		return TerminalStartResponse{}, fail(400, "invalid-environment", "environment has too many entries")
	}
	keys := make([]string, 0, len(request.Env))
	envBytes := 0
	for key, value := range request.Env {
		if !directEnvName(key) || strings.HasPrefix(key, "_dsh_") || key == "BASH_ENV" || key == "ENV" || strings.HasPrefix(key, "BASH_FUNC_") || len(value) > maxTerminalEnvironmentBytes {
			return TerminalStartResponse{}, fail(400, "invalid-environment", "environment contains an invalid name or value")
		}
		envBytes += len(key) + len(value) + 1
		if envBytes > maxTerminalEnvironmentBytes {
			return TerminalStartResponse{}, fail(400, "invalid-environment", "environment exceeds the byte limit")
		}
		keys = append(keys, key)
	}
	if strings.Contains(request.Argv[0], "/") && !directAbsolutePath(request.Argv[0]) {
		return TerminalStartResponse{}, fail(400, "invalid-command", "command path must be absolute")
	}
	sort.Strings(keys)
	fingerprint, err := terminalStartFingerprint(request)
	if err != nil {
		return TerminalStartResponse{}, err
	}
	key := terminalStartKey{root: root, nonce: request.StartNonce}
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return TerminalStartResponse{}, ErrTerminalNotFound
	}
	if previous := b.starts[key]; previous != nil {
		b.mu.Unlock()
		if previous.fingerprint != fingerprint {
			return TerminalStartResponse{}, ErrTerminalStartConflict
		}
		select {
		case <-previous.done:
			return previous.response, previous.err
		case <-ctx.Done():
			return TerminalStartResponse{}, ctx.Err()
		}
	}
	starting := 0
	for _, existing := range b.starts {
		if existing.response.ID == "" {
			starting++
		}
	}
	if len(b.sessions)+starting >= maxTerminalSessions {
		b.mu.Unlock()
		return TerminalStartResponse{}, fail(429, "too-many-terminals", "remote terminal limit is reached")
	}
	record := &directTerminalStart{fingerprint: fingerprint, done: make(chan struct{})}
	b.starts[key] = record
	b.mu.Unlock()
	attempted := false
	defer func() {
		b.mu.Lock()
		record.session = nil
		if b.closed {
			err = fail(503, "terminal-state-unknown", "SSH terminal start was interrupted")
		}
		record.response, record.err = response, err
		close(record.done)
		// SSH exec 一旦可能已发出，失败并不能证明远端命令没有启动。
		if err != nil && !attempted {
			delete(b.starts, key)
		}
		b.mu.Unlock()
	}()
	response, err = b.launch(ctx, key, cwd, request, keys, record, &attempted)
	return response, err
}

func directTerminalFrame(root, cwd string, argv []string, env map[string]string, keys []string) []byte {
	var buffer bytes.Buffer
	add := func(value string) { buffer.WriteString(value); buffer.WriteByte(0) }
	add(root)
	add(cwd)
	add(strconv.Itoa(len(argv)))
	for _, arg := range argv {
		add(arg)
	}
	add(strconv.Itoa(len(keys)))
	for _, key := range keys {
		add(key)
		add(env[key])
	}
	return buffer.Bytes()
}

func (b *directTerminalBackend) launch(ctx context.Context, key terminalStartKey, cwd string, request TerminalStartRequest, keys []string, record *directTerminalStart, attempted *bool) (TerminalStartResponse, error) {
	session, err := b.client.NewSession()
	if err != nil {
		return TerminalStartResponse{}, fmt.Errorf("open SSH PTY session: %w", err)
	}
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		_ = session.Close()
		return TerminalStartResponse{}, fail(503, "terminal-state-unknown", "SSH terminal start was interrupted")
	}
	record.session = session
	b.mu.Unlock()
	keep := false
	defer func() {
		if !keep {
			_ = session.Close()
		}
	}()
	stdin, err := session.StdinPipe()
	if err != nil {
		return TerminalStartResponse{}, err
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		return TerminalStartResponse{}, err
	}
	if err = session.RequestPty("xterm", request.Rows, request.Cols, ssh.TerminalModes{
		ssh.ECHO: 0, ssh.ICANON: 0, ssh.ISIG: 0, ssh.IEXTEN: 0, ssh.OPOST: 0,
		ssh.ISTRIP: 0, ssh.INLCR: 0, ssh.IGNCR: 0, ssh.ICRNL: 0, ssh.IXON: 0,
	}); err != nil {
		return TerminalStartResponse{}, fail(501, "pty-unavailable", "SSH server refused PTY allocation")
	}
	started := make(chan error, 1)
	*attempted = true
	go func() {
		started <- session.Start(directTerminalStartCommand())
	}()
	select {
	case err = <-started:
		if err != nil {
			return TerminalStartResponse{}, fail(403, "permission-denied", "SSH server refused terminal execution")
		}
		if b.afterSessionStart != nil {
			b.afterSessionStart()
		}
	case <-ctx.Done():
		return TerminalStartResponse{}, fail(503, "terminal-state-unknown", "SSH terminal start was interrupted")
	}
	reader := bufio.NewReader(stdout)
	frameReady := make(chan error, 1)
	go func() {
		var header []byte
		for len(header) < 4096 {
			value, readErr := reader.ReadByte()
			if readErr != nil {
				frameReady <- readErr
				return
			}
			header = append(header, value)
			if bytes.HasSuffix(header, []byte(directTerminalFrameReady)) {
				frameReady <- nil
				return
			}
		}
		frameReady <- errors.New("missing SSH PTY no-echo handshake")
	}()
	select {
	case err = <-frameReady:
		if err != nil {
			return TerminalStartResponse{}, fail(503, "terminal-state-unknown", "SSH PTY no-echo mode was not confirmed")
		}
	case <-ctx.Done():
		return TerminalStartResponse{}, fail(503, "terminal-state-unknown", "SSH terminal start was interrupted")
	}
	frame := directTerminalFrame(key.root, cwd, request.Argv, request.Env, keys)
	framed := make(chan error, 1)
	go func() { framed <- writeTerminalAll(stdin, frame) }()
	select {
	case err = <-framed:
		if err != nil {
			return TerminalStartResponse{}, fail(503, "terminal-state-unknown", "SSH terminal startup framing failed")
		}
	case <-ctx.Done():
		return TerminalStartResponse{}, fail(503, "terminal-state-unknown", "SSH terminal start was interrupted")
	}
	// 等待固定握手并保留其后的用户输出；限定长度防止异常服务端耗尽内存。
	ready := make(chan struct {
		pid    int
		output []byte
		err    error
	}, 1)
	go func() {
		prefix := []byte(directTerminalReadyPrefix)
		var header []byte
		for len(header) < 4096 {
			value, readErr := reader.ReadByte()
			if readErr != nil {
				ready <- struct {
					pid    int
					output []byte
					err    error
				}{err: readErr}
				return
			}
			header = append(header, value)
			if bytes.HasSuffix(header, prefix) {
				break
			}
		}
		if !bytes.HasSuffix(header, prefix) {
			ready <- struct {
				pid    int
				output []byte
				err    error
			}{err: errors.New("missing SSH PTY startup handshake")}
			return
		}
		var digits []byte
		for len(digits) < 16 {
			value, readErr := reader.ReadByte()
			if readErr != nil {
				ready <- struct {
					pid    int
					output []byte
					err    error
				}{err: readErr}
				return
			}
			if value == '\x1f' {
				pid, parseErr := strconv.Atoi(string(digits))
				ready <- struct {
					pid    int
					output []byte
					err    error
				}{pid: pid, output: header[:len(header)-len(prefix)], err: parseErr}
				return
			}
			digits = append(digits, value)
		}
		ready <- struct {
			pid    int
			output []byte
			err    error
		}{err: errors.New("invalid SSH PTY startup handshake")}
	}()
	var handshake struct {
		pid    int
		output []byte
		err    error
	}
	select {
	case handshake = <-ready:
		if handshake.err != nil || handshake.pid <= 0 {
			return TerminalStartResponse{}, fail(503, "terminal-state-unknown", "SSH terminal startup was not confirmed")
		}
	case <-ctx.Done():
		return TerminalStartResponse{}, fail(503, "terminal-state-unknown", "SSH terminal start was interrupted")
	}
	id, err := newTerminalID()
	if err != nil {
		return TerminalStartResponse{}, err
	}
	terminal := &directTerminal{id: id, root: key.root, pid: handshake.pid, session: session, stdin: stdin, writeSlots: make(chan struct{}, terminalInputQueueSize), notify: make(chan struct{}), done: make(chan struct{}), readerDone: make(chan struct{})}
	terminal.onClosed = func() {
		time.AfterFunc(defaultTerminalRetention, func() {
			b.mu.Lock()
			if b.sessions[id] == terminal {
				delete(b.sessions, id)
				delete(b.starts, key)
			}
			b.mu.Unlock()
		})
	}
	b.mu.Lock()
	if b.closed || ctx.Err() != nil {
		b.mu.Unlock()
		return TerminalStartResponse{}, fail(503, "terminal-state-unknown", "SSH terminal start was interrupted")
	}
	b.sessions[id] = terminal
	record.session = nil
	b.mu.Unlock()
	keep = true
	if len(handshake.output) > 0 {
		terminal.append(handshake.output)
	}
	go terminal.capture(reader)
	go terminal.wait()
	return TerminalStartResponse{ID: id, PID: handshake.pid}, nil
}

func (t *directTerminal) append(data []byte) {
	for len(data) > 0 {
		part := data
		if len(part) > terminalReadBufferSize {
			part = data[:terminalReadBufferSize]
		}
		t.mu.Lock()
		t.cursor++
		t.chunks = append(t.chunks, TerminalOutputChunk{Sequence: t.cursor, DataBase64: base64.StdEncoding.EncodeToString(part)})
		t.outputBytes += len(part)
		for t.outputBytes > maxTerminalOutputBytes {
			first := t.chunks[0]
			t.chunks = t.chunks[1:]
			decoded, _ := base64.StdEncoding.DecodeString(first.DataBase64)
			t.outputBytes -= len(decoded)
			t.discarded = first.Sequence
		}
		t.wake()
		t.mu.Unlock()
		data = data[len(part):]
	}
}

func (t *directTerminal) wake() { close(t.notify); t.notify = make(chan struct{}) }

func (t *directTerminal) capture(reader io.Reader) {
	defer close(t.readerDone)
	buffer := make([]byte, terminalReadBufferSize)
	for {
		count, err := reader.Read(buffer)
		if count > 0 {
			t.append(buffer[:count])
		}
		if err != nil {
			return
		}
	}
}

func (t *directTerminal) wait() {
	err := t.session.Wait()
	select {
	case <-t.readerDone:
	case <-time.After(terminalDrainTimeout):
		_ = t.session.Close()
		<-t.readerDone
	}
	t.mu.Lock()
	if err == nil {
		code := 0
		t.exitCode = &code
	} else {
		var exit *ssh.ExitError
		if errors.As(err, &exit) {
			if exit.Signal() != "" {
				t.signal = "SIG" + strings.TrimPrefix(strings.ToUpper(exit.Signal()), "SIG")
			} else if exit.ExitStatus() >= 0 {
				code := exit.ExitStatus()
				t.exitCode = &code
			}
		}
	}
	t.unknown = t.exitCode == nil && t.signal == ""
	t.closed = true
	t.wake()
	close(t.done)
	t.mu.Unlock()
	t.closeOnce.Do(func() { _ = t.session.Close() })
	if t.onClosed != nil {
		t.onClosed()
	}
}

func (b *directTerminalBackend) session(root, id string) (*directTerminal, error) {
	owner, err := sessionOwnerRoot(root)
	if err != nil {
		return nil, err
	}
	b.mu.Lock()
	t := b.sessions[id]
	b.mu.Unlock()
	if t == nil || t.root != owner {
		return nil, ErrTerminalNotFound
	}
	return t, nil
}

func (b *directTerminalBackend) read(ctx context.Context, request TerminalReadRequest) (TerminalReadResponse, error) {
	t, err := b.session(request.Root, request.ID)
	if err != nil {
		return TerminalReadResponse{}, err
	}
	if request.WaitMs < 0 || request.WaitMs > maxTerminalPollWait.Milliseconds() {
		return TerminalReadResponse{}, fail(400, "invalid-wait", "waitMs is outside the supported range")
	}
	wait := time.Duration(request.WaitMs) * time.Millisecond
	if wait == 0 {
		wait = defaultTerminalPollWait
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		t.mu.Lock()
		response := TerminalReadResponse{Chunks: []TerminalOutputChunk{}, Cursor: t.cursor, Closed: t.closed, Truncated: request.After < t.discarded}
		for _, chunk := range t.chunks {
			if chunk.Sequence > request.After {
				response.Chunks = append(response.Chunks, chunk)
			}
		}
		if t.closed {
			response.ExitCode, response.Signal = t.exitCode, t.signal
		}
		unknown := t.unknown
		notify := t.notify
		ready := len(response.Chunks) > 0 || response.Closed || response.Truncated
		t.mu.Unlock()
		if unknown {
			return TerminalReadResponse{}, fail(503, "terminal-state-unknown", "SSH did not report a terminal exit status")
		}
		if ready {
			return response, nil
		}
		select {
		case <-ctx.Done():
			return TerminalReadResponse{}, ctx.Err()
		case <-timer.C:
			return response, nil
		case <-notify:
		}
	}
}

func (b *directTerminalBackend) write(ctx context.Context, request TerminalWriteRequest) error {
	t, err := b.session(request.Root, request.ID)
	if err != nil {
		return err
	}
	if len(request.DataBase64) > base64.StdEncoding.EncodedLen(maxTerminalWriteBytes) {
		return fail(413, "terminal-input-too-large", "terminal input exceeds the byte limit")
	}
	data, err := base64.StdEncoding.DecodeString(request.DataBase64)
	if err != nil {
		return fail(400, "invalid-input", "terminal input must be valid base64")
	}
	if len(data) > maxTerminalWriteBytes {
		return fail(413, "terminal-input-too-large", "terminal input exceeds the byte limit")
	}
	select {
	case t.writeSlots <- struct{}{}:
	default:
		return fail(429, "terminal-input-backpressure", "terminal input queue is full")
	}
	written := make(chan error, 1)
	go func() {
		defer func() { <-t.writeSlots }()
		t.writeMu.Lock()
		defer t.writeMu.Unlock()
		t.mu.Lock()
		closed := t.closed
		t.mu.Unlock()
		if closed {
			written <- ErrTerminalClosed
			return
		}
		written <- writeTerminalAll(t.stdin, data)
	}()
	select {
	case err := <-written:
		if err == nil || errors.Is(err, ErrTerminalClosed) {
			return err
		}
		return fail(503, "terminal-state-unknown", "SSH terminal input delivery is unknown")
	case <-ctx.Done():
		_ = t.session.Close()
		return fail(503, "terminal-state-unknown", "SSH terminal input was interrupted; delivery is unknown")
	}
}

func (b *directTerminalBackend) resize(request TerminalResizeRequest) error {
	t, err := b.session(request.Root, request.ID)
	if err != nil {
		return err
	}
	if err := validateTerminalSize(request.Cols, request.Rows); err != nil {
		return fail(400, "invalid-size", err.Error())
	}
	t.mu.Lock()
	closed := t.closed
	t.mu.Unlock()
	if closed {
		return ErrTerminalClosed
	}
	if err := t.session.WindowChange(request.Rows, request.Cols); err != nil {
		return fail(503, "terminal-state-unknown", "SSH terminal resize was not confirmed")
	}
	return nil
}

func (b *directTerminalBackend) signal(request TerminalSignalRequest) error {
	t, err := b.session(request.Root, request.ID)
	if err != nil {
		return err
	}
	if !strings.HasPrefix(request.Signal, "SIG") {
		return fail(400, "invalid-signal", "signal must be a POSIX signal")
	}
	name := strings.TrimPrefix(request.Signal, "SIG")
	allowed := map[string]bool{"INT": true, "TERM": true, "HUP": true, "QUIT": true, "TSTP": true, "CONT": true, "WINCH": true}
	if !allowed[name] {
		return fail(501, "terminal-signal-unavailable", "SSH cannot safely deliver this foreground signal")
	}
	t.mu.Lock()
	closed := t.closed
	t.mu.Unlock()
	if closed {
		return ErrTerminalClosed
	}
	if err := t.session.Signal(ssh.Signal(name)); err != nil {
		return fail(503, "terminal-state-unknown", "SSH terminal signal delivery is unknown")
	}
	return fail(503, "terminal-state-unknown", "SSH signal request cannot identify the foreground process group or confirm delivery")
}

func (b *directTerminalBackend) terminate(ctx context.Context, request TerminalTerminateRequest) error {
	t, err := b.session(request.Root, request.ID)
	if err != nil {
		return err
	}
	select {
	case <-t.done:
		return fail(503, "terminal-state-unknown", "SSH exit does not confirm process tree termination")
	default:
	}
	if err := t.session.Signal(ssh.SIGTERM); err != nil {
		return fail(503, "terminal-state-unknown", "SSH terminal termination delivery is unknown")
	}
	timer := time.NewTimer(defaultTerminalGrace)
	defer timer.Stop()
	select {
	case <-t.done:
		return fail(503, "terminal-state-unknown", "SSH exit does not confirm process tree termination")
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		_ = t.session.Signal(ssh.SIGKILL)
		select {
		case <-t.done:
			return fail(503, "terminal-state-unknown", "SSH exit does not confirm process tree termination")
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(terminalDrainTimeout):
			_ = t.session.Close()
			return fail(503, "terminal-state-unknown", "SSH cannot confirm terminal process tree termination")
		}
	}
}
