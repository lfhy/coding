package remoteagent

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
)

// directCodeBackend 在桌面 helper 的本地隔离子进程执行 TypeScript；仅 Host
// binding 回包能给代码提供能力。root 只标识会话所有权，不访问本机工作区。
type directCodeBackend struct {
	sessions *CodeRunSessions
}

// newDirectCodeBackend 必须收到本机架构的 remote-agent 隔离入口；缺少已打包
// 二进制时失败关闭，不能退回桌面 helper 本身或 Node worker。
func newDirectCodeBackend(isolateCommand []string) (*directCodeBackend, error) {
	if len(isolateCommand) != 2 || !filepath.IsAbs(isolateCommand[0]) ||
		(isolateCommand[1] != "--code-isolate" &&
			!(isGoTestBinary(isolateCommand[0]) && isolateCommand[1] == "-test.run=^$")) {
		return nil, errors.New("direct code requires an absolute local code isolate command")
	}
	info, err := os.Stat(isolateCommand[0])
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode()&0o111 == 0) {
		return nil, errors.New("direct code isolate is not an executable file")
	}
	sessions, err := NewCodeRunSessions(CodeRunSessionsOptions{
		ValidateRoot: validateDirectCodeRoot,
		RunnerOptions: CodeRunnerOptions{
			DefaultTimeout: defaultCodeTimeout,
			MaxTimeout:     maxCodeTimeout,
			MaxOutputBytes: maxResponseBytes - (1 << 20),
			IsolateCommand: append([]string(nil), isolateCommand...),
		},
	})
	if err != nil {
		return nil, err
	}
	return &directCodeBackend{sessions: sessions}, nil
}

// validateDirectCodeRoot 不探测本机 FS：bridge 绑定的 POSIX 远端 root 仅用于
// CodeRunSessions 的 nonce 与 session owner 键，绝不是 Goja 的访问权限。
func validateDirectCodeRoot(root string) error {
	if root == "" || len(root) > maxRemotePathBytes || !path.IsAbs(root) ||
		strings.ContainsRune(root, 0) || strings.TrimSpace(root) != root {
		return fail(http.StatusBadRequest, "invalid-root", "code session root must be an absolute remote path")
	}
	return nil
}

// Proxy 调用与远端 agent 相同的 Code handler，不启动 HTTP listener、SSH
// direct-tcpip 或远端 agent；未知 route 必须拒绝，不能回退到本地 Host 服务。
func (backend *directCodeBackend) Proxy(ctx context.Context, route string, body []byte) (ProxyResponse, error) {
	if backend == nil || backend.sessions == nil {
		return ProxyResponse{}, errors.New("direct code backend is unavailable")
	}
	if ctx == nil {
		return ProxyResponse{}, errors.New("direct code request requires a context")
	}
	server := &Server{codeRuns: backend.sessions}
	var handler http.HandlerFunc
	switch route {
	case "/v1/code/start":
		handler = server.handleCodeStart
	case "/v1/code/next":
		handler = server.handleCodeNext
	case "/v1/code/reply":
		handler = server.handleCodeReply
	case "/v1/code/cancel":
		handler = server.handleCodeCancel
	default:
		return ProxyResponse{}, errors.New("unsupported direct code route")
	}
	if err := ctx.Err(); err != nil {
		return ProxyResponse{}, err
	}
	request := httptest.NewRequestWithContext(ctx, http.MethodPost, route, bytes.NewReader(body))
	response := httptest.NewRecorder()
	handler(response, request)
	return ProxyResponse{
		Status: response.Code, ContentType: response.Header().Get("Content-Type"),
		Body: bytes.Clone(response.Body.Bytes()),
	}, nil
}

// Close 中止未完成运行，等待 Goja 隔离子进程完成回收。
func (backend *directCodeBackend) Close() error {
	if backend == nil || backend.sessions == nil {
		return nil
	}
	return backend.sessions.Close(context.Background())
}
