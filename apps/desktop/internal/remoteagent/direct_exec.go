package remoteagent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

const maxDirectExecCommandBytes = 64 << 10

// proxyDirectExec 仅实现基础 SSH 模式的单次前台 Bash 命令。调用方须先核验
// 远端是 POSIX 平台；关闭 SSH session 不保证远端子进程树已经退出。
func proxyDirectExec(ctx context.Context, client *ssh.Client, body []byte) (ProxyResponse, error) {
	if len(body) > maxProxyRequestBytes {
		return directExecError(http.StatusRequestEntityTooLarge, "request-too-large", "request exceeds the byte limit"), nil
	}
	var request ExecRequest
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return directExecError(http.StatusBadRequest, "invalid-json", "invalid exec request JSON"), nil
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return directExecError(http.StatusBadRequest, "invalid-json", "request must contain exactly one JSON value"), nil
	}
	command, stdin, err := directExecCommand(request)
	if err != nil {
		var failure *agentFailure
		if errors.As(err, &failure) {
			return directExecError(failure.status, failure.code, failure.message), nil
		}
		return ProxyResponse{}, err
	}
	if err := ctx.Err(); err != nil {
		return ProxyResponse{}, err
	}
	timeout := defaultTimeout
	if request.TimeoutMs > 0 {
		if request.TimeoutMs >= int(maxTimeout/time.Millisecond) {
			timeout = maxTimeout
		} else {
			timeout = time.Duration(request.TimeoutMs) * time.Millisecond
		}
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	session, err := client.NewSession()
	if err != nil {
		return ProxyResponse{}, fmt.Errorf("create direct SSH exec session: %w", err)
	}
	defer session.Close()
	stdout := &limitedBuffer{limit: maxOutputBytes}
	stderr := &limitedBuffer{limit: maxOutputBytes}
	session.Stdout = stdout
	session.Stderr = stderr
	session.Stdin = bytes.NewReader(stdin)
	done := make(chan error, 1)
	go func() { done <- session.Run(command) }()
	var runErr error
	select {
	case runErr = <-done:
	case <-ctx.Done():
		// 同时抵达的真实退出优先于本地超时；不能推断关闭 session
		// 已杀死远端进程或其子进程。
		select {
		case runErr = <-done:
		default:
			_ = session.Close()
			<-done
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return directExecJSON(http.StatusOK, ExecResponse{
					TimedOut: true, Stdout: stdout.String(), Stderr: stderr.String(),
					StdoutTruncated: stdout.truncated, StderrTruncated: stderr.truncated,
				})
			}
			return ProxyResponse{}, ctx.Err()
		}
	}
	result := ExecResponse{
		Stdout: stdout.String(), Stderr: stderr.String(),
		StdoutTruncated: stdout.truncated, StderrTruncated: stderr.truncated,
	}
	if runErr == nil {
		zero := 0
		result.ExitCode = &zero
	} else {
		var exit *ssh.ExitError
		if !errors.As(runErr, &exit) {
			return ProxyResponse{}, fmt.Errorf("direct SSH exec did not report exit status: %w", runErr)
		}
		if exit.Signal() != "" {
			result.Signal = exit.Signal()
		} else {
			code := exit.ExitStatus()
			result.ExitCode = &code
		}
	}
	return directExecJSON(http.StatusOK, result)
}

func directExecCommand(request ExecRequest) (string, []byte, error) {
	if request.Shell != "bash" {
		return "", nil, fail(http.StatusBadRequest, "unsupported-shell", "shell must be bash")
	}
	if request.TimeoutMs < 0 {
		return "", nil, fail(http.StatusBadRequest, "invalid-timeout", "timeout must be non-negative")
	}
	if len(request.Command) > maxDirectExecCommandBytes || strings.ContainsRune(request.Command, 0) || len(request.Stdin) > maxProxyRequestBytes {
		return "", nil, fail(http.StatusBadRequest, "invalid-command", "command or stdin exceeds the supported limit")
	}
	root := request.Root
	target := request.Path
	if len(root) > maxRemotePathBytes || len(target) > maxRemotePathBytes {
		return "", nil, fail(http.StatusBadRequest, "invalid-path", "path exceeds the byte limit")
	}
	if root != "" {
		if !directAbsolutePath(root) {
			return "", nil, fail(http.StatusBadRequest, "invalid-path", "root must be an absolute POSIX path")
		}
		root = path.Clean(root)
	}
	if !directAbsolutePath(target) {
		if root == "" || target == "" || strings.ContainsRune(target, 0) {
			return "", nil, fail(http.StatusBadRequest, "invalid-path", "path must be absolute or relative to root")
		}
		target = path.Join(root, target)
	}
	if !directAbsolutePath(target) {
		return "", nil, fail(http.StatusBadRequest, "invalid-path", "path must be an absolute POSIX path")
	}
	target = path.Clean(target)
	if root != "" && !directPathWithin(root, target) {
		return "", nil, fail(http.StatusForbidden, "outside-root", "path is outside the requested root")
	}
	keys := make([]string, 0, len(request.Env))
	envBytes := 0
	for key, value := range request.Env {
		if !directEnvName(key) || key == "BASH" || strings.HasPrefix(key, "_dsh_") || strings.ContainsRune(value, 0) || len(value) > 64<<10 {
			return "", nil, fail(http.StatusBadRequest, "invalid-environment", "environment contains an invalid name or value")
		}
		envBytes += len(key) + len(value) + 2
		if envBytes > 64<<10 {
			return "", nil, fail(http.StatusBadRequest, "invalid-environment", "environment exceeds the byte limit")
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	// SSH exec payload 中只能有固定脚本。请求字段均通过 SSH stdin
	// 的 NUL 帧传递；帧读完后剩余字节恰是用户命令的 stdin。
	var framed bytes.Buffer
	for _, field := range []string{root, target, request.Command, strconv.Itoa(len(keys))} {
		framed.WriteString(field)
		framed.WriteByte(0)
	}
	for _, key := range keys {
		framed.WriteString(key)
		framed.WriteByte(0)
		framed.WriteString(request.Env[key])
		framed.WriteByte(0)
	}
	framed.WriteString(request.Stdin)
	var script strings.Builder
	// 防止远端继承 xtrace 时把随后从 stdin 读取的环境值打印到 stderr。
	script.WriteString("set +x; ")
	script.WriteString("_dsh_read() { IFS= read -r -d '' \"$1\"; }; ")
	script.WriteString("_dsh_read _dsh_root || exit 125; _dsh_read _dsh_target || exit 125; ")
	script.WriteString("_dsh_read _dsh_command || exit 125; _dsh_read _dsh_count || exit 125; ")
	script.WriteString("_dsh_bash=$BASH; ")
	script.WriteString("if [ -n \"$_dsh_root\" ]; then cd -- \"$_dsh_root\" || exit 125; _dsh_root_phys=$(pwd -P) || exit 125; fi; ")
	script.WriteString("cd -- \"$_dsh_target\" || exit 125; _dsh_cwd_phys=$(pwd -P) || exit 125; ")
	script.WriteString("if [ -n \"$_dsh_root\" ] && [ \"$_dsh_root\" != / ]; then ")
	script.WriteString("case \"$_dsh_cwd_phys\" in \"$_dsh_root_phys\"|\"$_dsh_root_phys\"/*) ;; *) printf 'path outside root\\n' >&2; exit 125;; esac; fi; ")
	script.WriteString("for ((_dsh_i=0; _dsh_i<_dsh_count; _dsh_i++)); do ")
	script.WriteString("_dsh_read _dsh_key || exit 125; _dsh_read _dsh_value || exit 125; ")
	script.WriteString("export \"$_dsh_key=$_dsh_value\" || exit 125; done; ")
	// 进程替换让内层 Bash 从匿名管道读取脚本，同时继承尚未消费的
	// stdin。命令文本不会成为内层 Bash 的 argv 或外层 SSH exec 字符串。
	script.WriteString("exec \"$_dsh_bash\" <(printf '%s\\n' \"$_dsh_command\")")
	return "bash -c " + shellQuote(script.String()), framed.Bytes(), nil
}

func directAbsolutePath(value string) bool {
	return strings.HasPrefix(value, "/") && !strings.ContainsRune(value, 0)
}

func directPathWithin(root, candidate string) bool {
	return root == "/" || candidate == root || strings.HasPrefix(candidate, root+"/")
}

func directEnvName(key string) bool {
	if key == "" || len(key) > 255 {
		return false
	}
	for index := 0; index < len(key); index++ {
		letter := key[index]
		if letter == '_' || letter >= 'A' && letter <= 'Z' || letter >= 'a' && letter <= 'z' || index > 0 && letter >= '0' && letter <= '9' {
			continue
		}
		return false
	}
	return true
}

func directExecError(status int, code, message string) ProxyResponse {
	response, _ := directExecJSON(status, map[string]AgentError{"error": {Code: code, Message: message}})
	return response
}

func directExecJSON(status int, value any) (ProxyResponse, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return ProxyResponse{}, err
	}
	return ProxyResponse{Status: status, ContentType: "application/json", Body: append(body, '\n')}, nil
}
