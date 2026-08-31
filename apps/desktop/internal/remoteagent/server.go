package remoteagent

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	maxRequestBytes    = 40 << 20
	maxResponseBytes   = 40 << 20
	maxFileBytes       = 16 << 20
	maxOutputBytes     = 1 << 20
	maxDirectoryItems  = 10_000
	maxSearchResults   = 100_000
	maxSearchBytes     = 20 << 20
	maxSearchFiles     = 100_000
	maxSearchLine      = 64 << 10
	maxSearchReadBytes = 20 << 20
	defaultTimeout     = 120 * time.Second
	maxTimeout         = 10 * time.Minute
	shutdownEscalation = 2 * time.Second
)

// Server 是不依赖 Node 的远程 agent HTTP 服务。它只绑定回环地址，SSH
// 控制端负责把该端口转发到本机；每个请求还必须携带一次性 bearer token。
type Server struct {
	token       string
	server      *http.Server
	listener    net.Listener
	codeRuns    *CodeRunSessions
	terminals   *TerminalSessions
	processes   *ProcessSessions
	shutdown    chan struct{}
	shutdownMu  sync.Once
	shutdownErr error
}

// NewServer 创建一个尚未监听的 agent 服务。
func NewServer(token string) (*Server, error) {
	if len(token) < 32 {
		return nil, errors.New("remote agent: bearer token is too short")
	}
	codeRuns, err := NewCodeRunSessions(CodeRunSessionsOptions{
		RunnerOptions: CodeRunnerOptions{
			DefaultTimeout: defaultCodeTimeout,
			MaxTimeout:     maxCodeTimeout,
			// 给终态事件的协议封装留出余量，避免有效的运行结果在 HTTP
			// 响应边界才被拒绝。
			MaxOutputBytes: maxResponseBytes - (1 << 20),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("remote agent: initialize code runner: %w", err)
	}
	return &Server{
		token: token, codeRuns: codeRuns, terminals: NewTerminalSessions(TerminalSessionsOptions{}),
		processes: NewProcessSessions(ProcessSessionsOptions{}),
		shutdown:  make(chan struct{}),
	}, nil
}

// ListenAndServe 在远端回环接口随机监听端口，并返回就绪信息。
func (s *Server) ListenAndServe() (ReadyRecord, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return ReadyRecord{}, fmt.Errorf("remote agent: listen: %w", err)
	}
	s.listener = listener
	s.server = &http.Server{Handler: s.routes(), ReadHeaderTimeout: 10 * time.Second, MaxHeaderBytes: 16 << 10}
	port := listener.Addr().(*net.TCPAddr).Port
	ready := ReadyRecord{Type: "coding-remote-agent-ready", Protocol: ProtocolVersion, Port: port, Version: AgentVersion}
	go func() {
		if err := s.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			return
		}
	}()
	return ready, nil
}

// Shutdown 开始一次共享的服务关闭。Done 只会在 HTTP、代码运行、普通进程和
// PTY 都已完成各自的回收后关闭；调用方的 context 只限制这次等待。
func (s *Server) Shutdown(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	s.shutdownMu.Do(func() {
		go s.shutdownWorker()
	})
	select {
	case <-s.shutdown:
		return s.shutdownErr
	case <-ctx.Done():
		// 三个 registry 的 Close 都是共享关闭；对已完成或正在等待中的 Close
		// 再传入已取消 context 会立即升级为强杀，而不会提前关闭 Done。
		if s.codeRuns != nil {
			_ = s.codeRuns.Close(ctx)
		}
		if s.processes != nil {
			s.processes.Close(ctx)
		}
		if s.terminals != nil {
			s.terminals.Close(ctx)
		}
		return ctx.Err()
	}
}

// Done 在关闭链真正收敛后关闭，命令入口据此退出 SSH 会话。
func (s *Server) Done() <-chan struct{} { return s.shutdown }

func (s *Server) shutdownWorker() {
	var group sync.WaitGroup
	var errMu sync.Mutex
	recordShutdownErr := func(err error) {
		if err == nil {
			return
		}
		errMu.Lock()
		defer errMu.Unlock()
		if s.shutdownErr == nil {
			s.shutdownErr = err
		}
	}
	if s.codeRuns != nil {
		group.Add(1)
		go func() {
			defer group.Done()
			recordShutdownErr(s.codeRuns.Close(context.Background()))
		}()
	}
	if s.processes != nil {
		group.Add(1)
		go func() {
			defer group.Done()
			s.processes.Close(context.Background())
		}()
	}
	if s.terminals != nil {
		group.Add(1)
		go func() {
			defer group.Done()
			s.terminals.Close(context.Background())
		}()
	}
	if s.server != nil {
		group.Add(1)
		go func() {
			defer group.Done()
			if err := s.server.Shutdown(context.Background()); err != nil && !errors.Is(err, http.ErrServerClosed) {
				recordShutdownErr(err)
			}
		}()
	}
	group.Wait()
	close(s.shutdown)
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/health", s.handleHealth)
	mux.HandleFunc("/v1/resolve", s.handleResolve)
	mux.HandleFunc("/v1/stat", s.handleStat)
	mux.HandleFunc("/v1/directories", s.handleDirectories)
	mux.HandleFunc("/v1/read_file", s.handleRead)
	mux.HandleFunc("/v1/read_bytes", s.handleReadBytes)
	mux.HandleFunc("/v1/update_file", s.handleUpdate)
	mux.HandleFunc("/v1/edit_file", s.handleEdit)
	mux.HandleFunc("/v1/exec", s.handleExec)
	mux.HandleFunc("/v1/search", s.handleSearch)
	mux.HandleFunc("/v1/code/start", s.handleCodeStart)
	mux.HandleFunc("/v1/code/next", s.handleCodeNext)
	mux.HandleFunc("/v1/code/reply", s.handleCodeReply)
	mux.HandleFunc("/v1/code/cancel", s.handleCodeCancel)
	mux.HandleFunc("/v1/terminals/start", s.handleTerminalStart)
	mux.HandleFunc("/v1/terminals/read", s.handleTerminalRead)
	mux.HandleFunc("/v1/terminals/write", s.handleTerminalWrite)
	mux.HandleFunc("/v1/terminals/foreground", s.handleTerminalForeground)
	mux.HandleFunc("/v1/terminals/signal", s.handleTerminalSignal)
	mux.HandleFunc("/v1/terminals/terminate", s.handleTerminalTerminate)
	mux.HandleFunc("/v1/processes/resolve", s.handleProcessResolve)
	mux.HandleFunc("/v1/processes/start", s.handleProcessStart)
	mux.HandleFunc("/v1/processes/read", s.handleProcessRead)
	mux.HandleFunc("/v1/processes/write", s.handleProcessWrite)
	mux.HandleFunc("/v1/processes/wait", s.handleProcessWait)
	mux.HandleFunc("/v1/processes/kill", s.handleProcessKill)
	mux.HandleFunc("/v1/shutdown", s.handleShutdown)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !allowedAgentRoute(r.Method, r.URL.Path) {
			writeError(w, http.StatusMethodNotAllowed, "method-not-allowed", "method is not supported")
			return
		}
		if !s.authorized(r) {
			writeError(w, http.StatusUnauthorized, "unauthorized", "invalid remote agent token")
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func allowedAgentRoute(method, path string) bool {
	switch path {
	case "/v1/health":
		return method == http.MethodGet
	case "/v1/resolve", "/v1/stat", "/v1/directories", "/v1/read_file", "/v1/read_bytes", "/v1/update_file", "/v1/edit_file", "/v1/exec", "/v1/search", "/v1/code/start", "/v1/code/next", "/v1/code/reply", "/v1/code/cancel", "/v1/terminals/start", "/v1/terminals/read", "/v1/terminals/write", "/v1/terminals/foreground", "/v1/terminals/signal", "/v1/terminals/terminate", "/v1/processes/resolve", "/v1/processes/start", "/v1/processes/read", "/v1/processes/write", "/v1/processes/wait", "/v1/processes/kill", "/v1/shutdown":
		return method == http.MethodPost
	default:
		return false
	}
}

func (s *Server) authorized(r *http.Request) bool {
	got := ""
	parts := strings.Fields(r.Header.Get("Authorization"))
	if len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") {
		got = parts[1]
	}
	if got == "" {
		got = strings.TrimSpace(r.Header.Get("X-Coding-Agent-Token"))
	}
	return len(got) == len(s.token) && subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) == 1
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"type": "coding-remote-agent-health", "protocol": ProtocolVersion, "version": AgentVersion,
		"platform": runtime.GOOS, "arch": runtime.GOARCH,
	})
}

func (s *Server) handleResolve(w http.ResponseWriter, r *http.Request) {
	var request ResolveRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	path, err := resolveScopedPath(request.Root, request.Path, false)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	info, err := pathInfo(path, false)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		writeAgentError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ResolveResponse{Path: path, Info: info})
}

func (s *Server) handleStat(w http.ResponseWriter, r *http.Request) {
	var request StatRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	path, err := resolveScopedPath(request.Root, request.Path, request.NoFollow)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	info, err := pathInfo(path, request.NoFollow)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		writeAgentError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, StatResponse{Info: info})
}

func (s *Server) handleDirectories(w http.ResponseWriter, r *http.Request) {
	var request ListRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	path, err := resolveScopedPath(request.Root, request.Path, false)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	entries, err := listDirectory(path, maxDirectoryItems)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ListResponse{Path: path, Entries: entries})
}

func (s *Server) handleRead(w http.ResponseWriter, r *http.Request) {
	var request ReadRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	path, err := resolveScopedPath(request.Root, request.Path, false)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	limit := request.MaxBytes
	if limit <= 0 || limit > maxFileBytes {
		limit = maxFileBytes
	}
	data, info, err := readBoundedFile(path, limit)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	if !utf8.Valid(data) || strings.IndexByte(string(data), 0) >= 0 {
		writeError(w, http.StatusUnprocessableEntity, "not-text", "file is not valid UTF-8 text")
		return
	}
	currentVersion, err := version(path, info)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ReadResponse{Path: path, Content: string(data), Version: currentVersion})
}

func (s *Server) handleReadBytes(w http.ResponseWriter, r *http.Request) {
	var request ReadRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	path, err := resolveScopedPath(request.Root, request.Path, false)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	limit := request.MaxBytes
	if limit <= 0 || limit > maxFileBytes {
		limit = maxFileBytes
	}
	data, info, err := readBoundedFile(path, limit)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	currentVersion, err := version(path, info)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ReadBytesResponse{
		Path: path, ContentBase64: base64.StdEncoding.EncodeToString(data), Version: currentVersion,
	})
}

func (s *Server) handleUpdate(w http.ResponseWriter, r *http.Request) {
	var request WriteRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	_, err := resolveScopedPath(request.Root, request.Path, true)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	if err := activeRequest(r.Context()); err != nil {
		writeAgentError(w, err)
		return
	}
	path, err := resolveScopedPath(request.Root, request.Path, true)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	result, err := atomicWriteContext(r.Context(), path, request.Content, request.Expected)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleEdit(w http.ResponseWriter, r *http.Request) {
	var request EditRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	path, err := resolveScopedPath(request.Root, request.Path, true)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	result, err := editFile(r.Context(), path, request, func() (string, error) {
		if err := activeRequest(r.Context()); err != nil {
			return "", err
		}
		return resolveScopedPath(request.Root, request.Path, true)
	})
	if err != nil {
		writeAgentError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleExec(w http.ResponseWriter, r *http.Request) {
	var request ExecRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	_, err := resolveScopedPath(request.Root, request.Path, false)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	if err := activeRequest(r.Context()); err != nil {
		writeAgentError(w, err)
		return
	}
	path, err := resolveScopedPath(request.Root, request.Path, false)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	result, err := executeCommand(r.Context(), path, request)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	var request SearchRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	result, err := searchWorkspace(r.Context(), request)
	if err != nil {
		writeAgentError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleCodeStart(w http.ResponseWriter, r *http.Request) {
	var request CodeRunStartRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	response, err := s.codeRuns.Start(request)
	if err != nil {
		writeCodeRunError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) handleCodeNext(w http.ResponseWriter, r *http.Request) {
	var request CodeRunNextRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	response, err := s.codeRuns.Next(r.Context(), request)
	if err != nil {
		writeCodeRunError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) handleCodeReply(w http.ResponseWriter, r *http.Request) {
	var request CodeRunReplyRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	if err := s.codeRuns.Reply(request); err != nil {
		writeCodeRunError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"accepted": true})
}

func (s *Server) handleCodeCancel(w http.ResponseWriter, r *http.Request) {
	var request CodeRunCancelRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	if err := s.codeRuns.Cancel(r.Context(), request); err != nil {
		writeCodeRunError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"accepted": true})
}

func (s *Server) handleTerminalStart(w http.ResponseWriter, r *http.Request) {
	var request TerminalStartRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	response, err := s.terminals.Start(request)
	if err != nil {
		writeTerminalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) handleTerminalRead(w http.ResponseWriter, r *http.Request) {
	var request TerminalReadRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	response, err := s.terminals.Read(r.Context(), request)
	if err != nil {
		writeTerminalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) handleTerminalWrite(w http.ResponseWriter, r *http.Request) {
	var request TerminalWriteRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	if err := s.terminals.Write(request); err != nil {
		writeTerminalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"accepted": true})
}

func (s *Server) handleTerminalForeground(w http.ResponseWriter, r *http.Request) {
	var request TerminalForegroundRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	response, err := s.terminals.Foreground(request)
	if err != nil {
		writeTerminalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) handleTerminalSignal(w http.ResponseWriter, r *http.Request) {
	var request TerminalSignalRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	response, err := s.terminals.SignalForeground(request)
	if err != nil {
		writeTerminalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) handleTerminalTerminate(w http.ResponseWriter, r *http.Request) {
	var request TerminalTerminateRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	if err := s.terminals.Terminate(r.Context(), request); err != nil {
		writeTerminalError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"accepted": true})
}

func (s *Server) handleProcessResolve(w http.ResponseWriter, r *http.Request) {
	var request ProcessResolveRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	response, err := s.processes.Resolve(request)
	if err != nil {
		writeProcessError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) handleProcessStart(w http.ResponseWriter, r *http.Request) {
	var request ProcessStartRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	response, err := s.processes.Start(request)
	if err != nil {
		writeProcessError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) handleProcessRead(w http.ResponseWriter, r *http.Request) {
	var request ProcessReadRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	response, err := s.processes.Read(r.Context(), request)
	if err != nil {
		writeProcessError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) handleProcessWrite(w http.ResponseWriter, r *http.Request) {
	var request ProcessWriteRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	response, err := s.processes.Write(request)
	if err != nil {
		writeProcessError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) handleProcessWait(w http.ResponseWriter, r *http.Request) {
	var request ProcessWaitRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	response, err := s.processes.Wait(r.Context(), request)
	if err != nil {
		writeProcessError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) handleProcessKill(w http.ResponseWriter, r *http.Request) {
	var request ProcessKillRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	response, err := s.processes.Kill(request)
	if err != nil {
		writeProcessError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) handleShutdown(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"accepted": true})
	go func() {
		// 响应写回后使用独立的关闭看门狗：到期会强杀仍存活的子树，但共享
		// shutdown worker 继续等待 reap，故 cmd/main 不会因这次超时提前退出。
		ctx, cancel := context.WithTimeout(context.Background(), shutdownEscalation)
		defer cancel()
		_ = s.Shutdown(ctx)
	}()
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "invalid-json", err.Error())
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "invalid-json", "request must contain exactly one JSON value")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	data, err := json.Marshal(value)
	if err != nil {
		writeRawError(w, http.StatusInternalServerError, "response-invalid", "response could not be encoded")
		return
	}
	if len(data)+1 > maxResponseBytes {
		writeRawError(w, http.StatusRequestEntityTooLarge, "response-too-large", "response exceeds the byte limit")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(append(data, '\n'))
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": AgentError{Code: code, Message: message}})
}

func writeRawError(w http.ResponseWriter, status int, code, message string) {
	data, _ := json.Marshal(map[string]any{"error": AgentError{Code: code, Message: message}})
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(append(data, '\n'))
}

func writeAgentError(w http.ResponseWriter, err error) {
	var failure *agentFailure
	if errors.As(err, &failure) {
		writeError(w, failure.status, failure.code, failure.message)
		return
	}
	status := http.StatusInternalServerError
	code := "io-error"
	if errors.Is(err, os.ErrNotExist) {
		status, code = http.StatusNotFound, "not-found"
	} else if errors.Is(err, os.ErrPermission) {
		status, code = http.StatusForbidden, "permission-denied"
	}
	writeError(w, status, code, err.Error())
}

// writeCodeRunError 固定远端 Code 会话的可恢复错误，避免调用方依赖 Go 文本。
func writeCodeRunError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrCodeRunSessionLimit):
		writeError(w, http.StatusTooManyRequests, "code-session-limit", "code execution session capacity is exhausted")
	case errors.Is(err, ErrCodeRunStartNonceConflict):
		writeError(w, http.StatusConflict, "code-start-nonce-conflict", "start nonce was already used for different code execution input")
	case errors.Is(err, ErrCodeRunSessionNotFound):
		writeError(w, http.StatusNotFound, "code-session-not-found", "code execution session was not found")
	case errors.Is(err, ErrCodeRunCallNotFound):
		writeError(w, http.StatusConflict, "code-call-not-pending", "code execution call is not pending")
	case errors.Is(err, ErrCodeRunFinished), errors.Is(err, ErrCodeToolCallSettled):
		writeError(w, http.StatusConflict, "code-run-finished", "code execution session has already finished")
	default:
		writeError(w, http.StatusBadRequest, "invalid-code-request", "invalid code execution request")
	}
}

// writeTerminalError 固定 PTY 会话可恢复的失败分类，避免 Node provider 解析系统错误文本。
func writeTerminalError(w http.ResponseWriter, err error) {
	var failure *agentFailure
	if errors.As(err, &failure) {
		writeAgentError(w, err)
		return
	}
	switch {
	case errors.Is(err, ErrTerminalNotFound):
		writeError(w, http.StatusNotFound, "terminal-not-found", "terminal session was not found")
	case errors.Is(err, ErrTerminalClosed):
		writeError(w, http.StatusConflict, "terminal-closed", "terminal session is closed")
	case errors.Is(err, ErrTerminalUnavailable):
		writeError(w, http.StatusNotImplemented, "pty-unavailable", "a real PTY is unavailable on this platform")
	case errors.Is(err, ErrTerminalNoForeground):
		writeError(w, http.StatusConflict, "terminal-no-foreground", "terminal has no foreground process group")
	case errors.Is(err, ErrTerminalRootKillRefused):
		writeError(w, http.StatusConflict, "terminal-root-kill-refused", "terminate the terminal session instead")
	case errors.Is(err, ErrTerminalInputBackpressure):
		writeError(w, http.StatusTooManyRequests, "terminal-input-backpressure", "terminal input queue is full")
	case errors.Is(err, ErrTerminalStartConflict):
		writeError(w, http.StatusConflict, "terminal-start-conflict", "start nonce conflicts with an existing terminal request")
	case errors.Is(err, os.ErrNotExist):
		writeError(w, http.StatusNotFound, "not-found", "terminal path was not found")
	case errors.Is(err, os.ErrPermission):
		writeError(w, http.StatusForbidden, "permission-denied", "terminal operation is not permitted")
	default:
		writeError(w, http.StatusBadRequest, "invalid-terminal-request", "invalid terminal request")
	}
}

// writeProcessError 固定普通进程会话的恢复错误，避免 Node provider 依赖系统文本。
func writeProcessError(w http.ResponseWriter, err error) {
	var failure *agentFailure
	if errors.As(err, &failure) {
		writeAgentError(w, err)
		return
	}
	switch {
	case errors.Is(err, ErrProcessNotFound):
		writeError(w, http.StatusNotFound, "process-not-found", "process was not found")
	case errors.Is(err, ErrProcessClosed):
		writeError(w, http.StatusConflict, "process-closed", "process stdin is closed")
	case errors.Is(err, ErrProcessInputBackpressure):
		writeError(w, http.StatusTooManyRequests, "process-input-backpressure", "process input queue is full")
	case errors.Is(err, ErrProcessStartConflict):
		writeError(w, http.StatusConflict, "process-start-conflict", "start nonce conflicts with an existing process request")
	default:
		writeAgentError(w, err)
	}
}

// agentFailure 保留工具层可依赖的错误分类，不把底层错误文本作为协议。
type agentFailure struct {
	status  int
	code    string
	message string
}

func (err *agentFailure) Error() string { return err.message }

func fail(status int, code, message string) error {
	return &agentFailure{status: status, code: code, message: message}
}

func activeRequest(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return fail(http.StatusRequestTimeout, "request-canceled", "request was canceled before execution")
	}
	return nil
}

func resolvePath(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", fail(http.StatusBadRequest, "invalid-path", "path must be non-empty")
	}
	if strings.HasPrefix(value, "~") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		if value == "~" {
			value = home
		} else if strings.HasPrefix(value, "~/") || strings.HasPrefix(value, `~\`) {
			value = filepath.Join(home, value[2:])
		}
	}
	abs, err := filepath.Abs(value)
	if err != nil {
		return "", err
	}
	return filepath.Clean(abs), nil
}

// resolveScopedPath 在跟随已存在的符号链接后执行根目录包含检查。noFollow
// 仅保留最后一个路径项，供 lstat 与拒绝符号链接写入的 mutation 使用。
func resolveScopedPath(root, raw string, noFollow bool) (string, error) {
	if strings.TrimSpace(root) == "" {
		path, err := resolvePath(raw)
		if err != nil {
			return "", err
		}
		if noFollow {
			canonicalParent, parentErr := canonicalizeWithMissing(filepath.Dir(path))
			if parentErr != nil {
				return "", parentErr
			}
			return filepath.Join(canonicalParent, filepath.Base(path)), nil
		}
		return canonicalizeWithMissing(path)
	}
	rootPath, err := resolvePath(root)
	if err != nil {
		return "", err
	}
	canonicalRoot, err := filepath.EvalSymlinks(rootPath)
	if err != nil {
		return "", err
	}
	rootInfo, err := os.Stat(canonicalRoot)
	if err != nil {
		return "", err
	}
	if !rootInfo.IsDir() {
		return "", fail(http.StatusBadRequest, "not-directory", "root is not a directory")
	}

	value := strings.TrimSpace(raw)
	if value == "" {
		return "", fail(http.StatusBadRequest, "invalid-path", "path must be non-empty")
	}
	var candidate string
	if filepath.IsAbs(value) || strings.HasPrefix(value, "~") {
		candidate, err = resolvePath(value)
	} else {
		candidate, err = resolvePath(filepath.Join(rootPath, value))
	}
	if err != nil {
		return "", err
	}

	var canonicalPath string
	if noFollow && filepath.Clean(candidate) != filepath.Clean(rootPath) {
		canonicalParent, parentErr := canonicalizeWithMissing(filepath.Dir(candidate))
		if parentErr != nil {
			return "", parentErr
		}
		canonicalPath = filepath.Join(canonicalParent, filepath.Base(candidate))
	} else {
		canonicalPath, err = canonicalizeWithMissing(candidate)
		if err != nil {
			return "", err
		}
	}
	if !pathWithin(canonicalRoot, canonicalPath) {
		return "", fail(http.StatusForbidden, "outside-root", "path is outside the requested root")
	}
	return filepath.Clean(canonicalPath), nil
}

// canonicalizeWithMissing 解析最深已存在祖先的符号链接，并把尚不存在的后缀
// 原样接回。写入新文件因此与读取既有文件使用同一根目录判断。
func canonicalizeWithMissing(path string) (string, error) {
	current := filepath.Clean(path)
	missing := make([]string, 0, 4)
	for {
		_, err := os.Lstat(current)
		if err == nil {
			resolved, resolveErr := filepath.EvalSymlinks(current)
			if resolveErr != nil {
				return "", resolveErr
			}
			for index := len(missing) - 1; index >= 0; index-- {
				resolved = filepath.Join(resolved, missing[index])
			}
			return filepath.Clean(resolved), nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", err
		}
		missing = append(missing, filepath.Base(current))
		current = parent
	}
}

func pathWithin(root, candidate string) bool {
	relativePath, err := filepath.Rel(root, candidate)
	if err != nil || filepath.IsAbs(relativePath) {
		return false
	}
	return relativePath == "." || (relativePath != ".." && !strings.HasPrefix(relativePath, ".."+string(filepath.Separator)))
}

// readBoundedFile 在分配文件内容前检查已打开的常规文件，并在读取后复核增长。
func readBoundedFile(path string, limit int64) ([]byte, os.FileInfo, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nil, fail(http.StatusUnprocessableEntity, "not-regular-file", "target is not a regular file")
	}
	if info.Size() > limit {
		return nil, nil, fail(http.StatusRequestEntityTooLarge, "too-large", "file exceeds the requested byte limit")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, nil, err
	}
	if int64(len(data)) > limit {
		return nil, nil, fail(http.StatusRequestEntityTooLarge, "too-large", "file exceeds the requested byte limit")
	}
	after, err := file.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !after.Mode().IsRegular() || after.Size() > limit {
		return nil, nil, fail(http.StatusRequestEntityTooLarge, "too-large", "file grew beyond the requested byte limit")
	}
	return data, after, nil
}

func pathInfo(path string, noFollow bool) (*PathInfo, error) {
	var info os.FileInfo
	var err error
	if noFollow {
		info, err = os.Lstat(path)
	} else {
		info, err = os.Stat(path)
	}
	if err != nil {
		return nil, err
	}
	typeName := "other"
	if info.IsDir() {
		typeName = "directory"
	} else if info.Mode().IsRegular() {
		typeName = "file"
	} else if info.Mode()&os.ModeSymlink != 0 {
		typeName = "symlink"
	}
	currentVersion, err := version(path, info)
	if err != nil {
		return nil, err
	}
	result := &PathInfo{Path: path, Type: typeName, Version: currentVersion}
	if info.Mode().IsRegular() {
		size := info.Size()
		result.Size = &size
	}
	return result, nil
}

func listDirectory(path string, limit int) ([]DirectoryEntry, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fail(http.StatusBadRequest, "not-directory", "path is not a directory")
	}
	directory, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	result := make([]DirectoryEntry, 0, min(limit, 256))
	responseBytes := len(path) + 64
	for {
		entries, readErr := directory.ReadDir(128)
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return nil, readErr
		}
		for _, entry := range entries {
			if len(result) >= limit {
				return nil, fail(http.StatusRequestEntityTooLarge, "too-many-entries", "directory exceeds the item limit")
			}
			child := filepath.Join(path, entry.Name())
			childInfo, infoErr := entry.Info()
			if infoErr != nil {
				continue
			}
			typeName := "other"
			if childInfo.IsDir() {
				typeName = "directory"
			} else if childInfo.Mode().IsRegular() {
				typeName = "file"
			}
			currentVersion, versionErr := version(child, childInfo)
			if versionErr != nil {
				return nil, versionErr
			}
			row := DirectoryEntry{Name: entry.Name(), Path: child, Type: typeName, Version: currentVersion}
			if childInfo.Mode().IsRegular() {
				size := childInfo.Size()
				row.Size = &size
			}
			encoded, encodeErr := json.Marshal(row)
			if encodeErr != nil {
				return nil, encodeErr
			}
			responseBytes += len(encoded) + 1
			if responseBytes > maxResponseBytes {
				return nil, fail(http.StatusRequestEntityTooLarge, "response-too-large", "directory response exceeds the byte limit")
			}
			result = append(result, row)
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	if err := ensureResponseFits(ListResponse{Path: path, Entries: result}); err != nil {
		return nil, err
	}
	return result, nil
}

// version 只摘要文件系统身份与变更元数据；stat 和目录列举不能为生成版本而
// 扫描文件内容。平台 FileInfo.Sys() 补充 inode/file-id 与 ctime 等事实。
func version(_ string, info os.FileInfo) (string, error) {
	digest := sha256.New()
	_, _ = fmt.Fprintf(digest, "v2:%s:%d:%d:%o", info.Name(), info.Size(), info.ModTime().UnixNano(), info.Mode())
	system := reflect.ValueOf(info.Sys())
	if system.IsValid() && system.Kind() == reflect.Pointer && !system.IsNil() {
		system = system.Elem()
	}
	if system.IsValid() && system.Kind() == reflect.Struct {
		for _, name := range []string{
			"Dev", "Ino", "Nlink", "Ctim", "Ctimespec", "Birthtimespec",
			"VolumeSerialNumber", "FileIndexHigh", "FileIndexLow", "CreationTime",
			"LastWriteTime", "ChangeTime", "FileAttributes",
		} {
			field := system.FieldByName(name)
			if field.IsValid() && field.CanInterface() {
				_, _ = fmt.Fprintf(digest, ":%s=%v", name, field.Interface())
			}
		}
	}
	return hex.EncodeToString(digest.Sum(nil)[:16]), nil
}

func ensureResponseFits(value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fail(http.StatusInternalServerError, "response-invalid", "response could not be encoded")
	}
	if len(data)+1 > maxResponseBytes {
		return fail(http.StatusRequestEntityTooLarge, "response-too-large", "response exceeds the byte limit")
	}
	return nil
}

func atomicWrite(path, content string, expected *WriteExpectation) (WriteResponse, error) {
	return atomicWriteContext(context.Background(), path, content, expected)
}

func atomicWriteContext(ctx context.Context, path, content string, expected *WriteExpectation) (WriteResponse, error) {
	if int64(len(content)) > maxFileBytes {
		return WriteResponse{}, fail(http.StatusRequestEntityTooLarge, "too-large", "content exceeds the writable byte limit")
	}
	info, err := os.Lstat(path)
	exists := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return WriteResponse{}, err
	}
	if exists && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
		return WriteResponse{}, fail(http.StatusUnprocessableEntity, "not-regular-file", "target is not a regular file")
	}
	createIfAbsent := false
	if expected != nil {
		switch expected.Kind {
		case "createIfAbsent":
			createIfAbsent = true
			if exists {
				return WriteResponse{}, fail(http.StatusConflict, "not-observed", "file already exists")
			}
		case "replaceIfVersion":
			if !exists {
				return WriteResponse{}, fail(http.StatusConflict, "stale-version", "file no longer exists")
			}
			currentVersion, versionErr := version(path, info)
			if versionErr != nil {
				return WriteResponse{}, versionErr
			}
			if currentVersion != expected.Version {
				return WriteResponse{}, fail(http.StatusConflict, "stale-version", "file changed since it was read")
			}
		default:
			return WriteResponse{}, fail(http.StatusBadRequest, "invalid-write-expectation", "unsupported write expectation")
		}
	}
	var before *string
	if exists && info.Size() <= maxFileBytes {
		old, _, readErr := readBoundedFile(path, maxFileBytes)
		if readErr == nil && utf8.Valid(old) && !strings.ContainsRune(string(old), 0) {
			value := normalizeLineEndings(string(old))
			before = &value
		} else if readErr != nil {
			var failure *agentFailure
			if !errors.As(readErr, &failure) || failure.code != "too-large" {
				return WriteResponse{}, readErr
			}
		}
	}
	operation := "create"
	if exists {
		operation = "update"
	}
	preview := WriteResponse{
		Operation: operation,
		Version:   strings.Repeat("0", 32),
		Before:    before,
		After:     normalizeLineEndings(content),
	}
	if err := ensureResponseFits(preview); err != nil {
		return WriteResponse{}, err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".coding-agent-write-*")
	if err != nil {
		return WriteResponse{}, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	mode := os.FileMode(0o600)
	if exists {
		mode = info.Mode().Perm()
	}
	if err = tmp.Chmod(mode); err == nil {
		_, err = tmp.WriteString(content)
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return WriteResponse{}, err
	}
	if err := activeRequest(ctx); err != nil {
		return WriteResponse{}, err
	}
	if createIfAbsent {
		if err = os.Link(tmpName, path); err != nil {
			if errors.Is(err, os.ErrExist) {
				return WriteResponse{}, fail(http.StatusConflict, "not-observed", "file already exists")
			}
			return WriteResponse{}, err
		}
	} else if err = os.Rename(tmpName, path); err != nil {
		return WriteResponse{}, err
	}
	info, err = os.Stat(path)
	if err != nil {
		return WriteResponse{}, err
	}
	currentVersion, err := version(path, info)
	if err != nil {
		return WriteResponse{}, err
	}
	return WriteResponse{
		Operation: operation, Version: currentVersion, Before: before, After: normalizeLineEndings(content),
	}, nil
}

func normalizeLineEndings(content string) string {
	return strings.ReplaceAll(content, "\r\n", "\n")
}

func detectLineEndings(content string) string {
	if len(content) > 4096 {
		content = content[:4096]
	}
	crlf := strings.Count(content, "\r\n")
	lf := strings.Count(content, "\n") - crlf
	if crlf > lf {
		return "CRLF"
	}
	return "LF"
}

func restoreLineEndings(content, lineEndings string) string {
	if lineEndings == "CRLF" {
		return strings.ReplaceAll(normalizeLineEndings(content), "\n", "\r\n")
	}
	return content
}

func editFile(ctx context.Context, path string, request EditRequest, resolveBeforeWrite func() (string, error)) (EditResponse, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return EditResponse{}, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return EditResponse{}, fail(http.StatusUnprocessableEntity, "not-regular-file", "target is not a regular file")
	}
	data, info, err := readBoundedFile(path, maxFileBytes)
	if err != nil {
		return EditResponse{}, err
	}
	raw := string(data)
	if !utf8.Valid(data) || strings.IndexByte(raw, 0) >= 0 {
		return EditResponse{}, fail(http.StatusUnprocessableEntity, "not-text", "file is not valid UTF-8 text")
	}
	lineEndings := detectLineEndings(raw)
	before := normalizeLineEndings(raw)
	currentVersion, err := version(path, info)
	if err != nil {
		return EditResponse{}, err
	}
	expected := request.Expected
	if request.Expected != nil {
		if request.Expected.Kind != "replaceIfVersion" {
			return EditResponse{}, fail(http.StatusBadRequest, "invalid-write-expectation", "unsupported edit expectation")
		}
		if currentVersion != request.Expected.Version {
			return EditResponse{}, fail(http.StatusConflict, "stale-version", "file changed since it was read")
		}
	} else {
		expected = &WriteExpectation{Kind: "replaceIfVersion", Version: currentVersion}
	}
	oldString := normalizeLineEndings(request.OldString)
	if oldString == "" {
		return EditResponse{}, fail(http.StatusBadRequest, "invalid-edit", "oldString must be non-empty")
	}
	newString := normalizeLineEndings(request.NewString)
	count := strings.Count(before, oldString)
	if count == 0 {
		return EditResponse{}, fail(http.StatusConflict, "edit-not-found", "oldString was not found")
	}
	if count > 1 && !request.ReplaceAll {
		return EditResponse{}, fail(http.StatusConflict, "ambiguous-edit", "oldString matched more than once")
	}
	after := before
	if request.ReplaceAll {
		after = strings.ReplaceAll(before, oldString, newString)
	} else {
		after = strings.Replace(before, oldString, newString, 1)
	}
	storedAfter := restoreLineEndings(after, lineEndings)
	if int64(len(storedAfter)) > maxFileBytes {
		return EditResponse{}, fail(http.StatusRequestEntityTooLarge, "too-large", "edited file exceeds the byte limit")
	}
	if err := ensureResponseFits(EditResponse{
		Version: strings.Repeat("0", 32), Before: before, After: after,
	}); err != nil {
		return EditResponse{}, err
	}
	publishPath, err := resolveBeforeWrite()
	if err != nil {
		return EditResponse{}, err
	}
	if publishPath != path {
		return EditResponse{}, fail(http.StatusConflict, "stale-version", "file path changed since it was read")
	}
	writeResult, err := atomicWriteContext(ctx, publishPath, storedAfter, expected)
	if err != nil {
		return EditResponse{}, err
	}
	return EditResponse{Version: writeResult.Version, Before: before, After: after}, nil
}

func executeCommand(parent context.Context, path string, request ExecRequest) (ExecResponse, error) {
	if request.Shell != "bash" {
		return ExecResponse{}, fail(http.StatusBadRequest, "unsupported-shell", "shell must be bash")
	}
	bashPath, err := exec.LookPath("bash")
	if err != nil {
		return ExecResponse{}, fail(http.StatusServiceUnavailable, "shell-unavailable", "bash is unavailable on the remote host")
	}
	workdir, err := os.Stat(path)
	if err != nil {
		return ExecResponse{}, err
	}
	if !workdir.IsDir() {
		return ExecResponse{}, fail(http.StatusBadRequest, "not-directory", "command path is not a directory")
	}
	timeout := defaultTimeout
	if request.TimeoutMs > 0 {
		if request.TimeoutMs >= int(maxTimeout/time.Millisecond) {
			timeout = maxTimeout
		} else {
			timeout = time.Duration(request.TimeoutMs) * time.Millisecond
		}
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	command := exec.Command(bashPath, "-c", request.Command)
	configureCommand(command)
	command.Dir = path
	command.Stdin = strings.NewReader(request.Stdin)
	command.Env, err = commandEnvironment(request.Env)
	if err != nil {
		return ExecResponse{}, err
	}
	stdout, stderr := &limitedBuffer{limit: maxOutputBytes}, &limitedBuffer{limit: maxOutputBytes}
	command.Stdout = stdout
	command.Stderr = stderr
	err = runCommand(ctx, command)
	result := ExecResponse{Stdout: stdout.String(), Stderr: stderr.String(), StdoutTruncated: stdout.truncated, StderrTruncated: stderr.truncated}
	if ctx.Err() == context.DeadlineExceeded {
		result.TimedOut = true
		result.Signal = "SIGKILL"
		return result, nil
	}
	if command.ProcessState != nil {
		if signal := commandSignal(command.ProcessState); signal != "" {
			result.Signal = signal
		} else if code := command.ProcessState.ExitCode(); code >= 0 {
			result.ExitCode = &code
		}
	}
	if ctx.Err() != nil {
		result.Signal = "SIGKILL"
		return result, nil
	}
	if err != nil && result.ExitCode == nil && result.Signal == "" {
		return ExecResponse{}, err
	}
	return result, nil
}

func runCommand(ctx context.Context, command *exec.Cmd) error {
	if err := command.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		select {
		case err := <-done:
			return err
		default:
		}
		killProcessTree(command)
		<-done
		return ctx.Err()
	}
}

func commandEnvironment(explicit map[string]string) ([]string, error) {
	type entry struct {
		key   string
		value string
	}
	values := make(map[string]entry)
	canonicalKey := func(key string) string {
		if runtime.GOOS == "windows" {
			return strings.ToUpper(key)
		}
		return key
	}
	for _, pair := range os.Environ() {
		key, value, found := strings.Cut(pair, "=")
		if !found || sensitiveEnvironmentKey(key) {
			continue
		}
		values[canonicalKey(key)] = entry{key: key, value: value}
	}
	for key, value := range explicit {
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, '\x00') {
			return nil, fail(http.StatusBadRequest, "invalid-environment", "environment contains an invalid name or value")
		}
		values[canonicalKey(key)] = entry{key: key, value: value}
	}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		value := values[key]
		result = append(result, value.key+"="+value.value)
	}
	return result, nil
}

func sensitiveEnvironmentKey(key string) bool {
	upper := strings.ToUpper(key)
	return strings.HasPrefix(upper, "DSH_") ||
		strings.Contains(upper, "KEY") ||
		strings.Contains(upper, "PASSWORD") ||
		strings.Contains(upper, "SECRET") ||
		strings.Contains(upper, "TOKEN")
}

type limitedBuffer struct {
	data      []byte
	limit     int
	truncated bool
}

func (b *limitedBuffer) Write(data []byte) (int, error) {
	if len(data) >= b.limit {
		if len(b.data) > 0 || len(data) > b.limit {
			b.truncated = true
		}
		b.data = append(b.data[:0], data[len(data)-b.limit:]...)
		return len(data), nil
	}
	b.data = append(b.data, data...)
	if overflow := len(b.data) - b.limit; overflow > 0 {
		copy(b.data, b.data[overflow:])
		b.data = b.data[:b.limit]
		b.truncated = true
	}
	return len(data), nil
}

func (b *limitedBuffer) String() string {
	text := strings.ToValidUTF8(string(b.data), "\uFFFD")
	data := []byte(text)
	if len(data) <= b.limit {
		return text
	}
	data = data[len(data)-b.limit:]
	for len(data) > 0 && data[0]&0b1100_0000 == 0b1000_0000 {
		data = data[1:]
	}
	return string(data)
}

// AgentPlatform 返回远程 agent 运行时的平台标识，供桌面部署层选择资源。
func AgentPlatform() string {
	return runtime.GOOS + "-" + runtime.GOARCH + "-" + strconv.Itoa(ProtocolVersion)
}
