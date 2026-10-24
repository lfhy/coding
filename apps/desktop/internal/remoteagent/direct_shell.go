package remoteagent

/**
 * basic 模式的常驻 shell 控制面。
 *
 * 一次连接只维持一条 /bin/sh 会话，把「列目录、规范化路径、单文件元数据」
 * 这类控制操作合并成一条命令，每次操作只付一次往返；文件内容仍走 SFTP
 * 数据面，避免 base64 膨胀和 SSH 通道窗口限制。
 *
 * 协议：请求是一行纯 ASCII 脚本（路径经 printf %b 的八进制转义传入，
 * 不做 shell 插值），结尾由远端打印 NUL + 随机 nonce + 退出码。响应读取
 * 到该标记为止，因此文件名里的换行、引号、任意 UTF-8 字节都不会破坏分帧。
 *
 * 生命周期：会话在首次使用时启动；任何 IO 失败都把会话标记为 broken 并
 * 在下次请求重建。远端没有 sh 时标记 unavailable，调用方永久回退 SFTP。
 */

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"
)

const (
	// shellFramePrefix 是响应结束标记的固定前缀；nonce 每次请求重新生成。
	shellFramePrefix = "\x00__coding_shell__"
	// shellMaxScriptBytes 限制单条请求脚本长度，超出的路径直接回退 SFTP。
	shellMaxScriptBytes = 32 << 10
	// shellMaxResponseBytes 限制单次控制的响应字节数，与目录上限保持一致。
	shellMaxResponseBytes = 8 << 20
)

// shellStatFlavor 记录远端 stat 的参数风格；POSIX 没有统一元数据命令。
type shellStatFlavor uint8

const (
	shellStatUnknown shellStatFlavor = iota
	shellStatNone
	shellStatGNU
	shellStatBSD
)

// shellEntry 是控制面返回的一个目录项事实。meta 已按远端 stat 风格格式化，
// 只用于生成展示用版本令牌，不参与写入守卫。
type shellEntry struct {
	name string
	kind string
	meta string
}

// shellInfo 是控制面返回的单路径事实。
type shellInfo struct {
	kind string
	meta string
}

// directShell 是 basic 连接上唯一的控制面会话，调用方不能并发读取响应。
type directShell struct {
	client *ssh.Client

	mu          sync.Mutex
	session     *ssh.Session
	stdin       io.WriteCloser
	stdout      *bufio.Reader
	flavor      shellStatFlavor
	broken      bool
	unavailable bool
	closed      bool
}

// newDirectShell 创建一个尚未启动会话的控制面。
// @param client - 已通过主机密钥校验的 SSH 连接。
func newDirectShell(client *ssh.Client) *directShell {
	return &directShell{client: client}
}

// available 报告控制面是否还能用于本连接；unavailable 是终态。
func (shell *directShell) available() bool {
	shell.mu.Lock()
	defer shell.mu.Unlock()
	return !shell.closed && !shell.unavailable
}

// Close 关闭控制面会话；可重复调用。
func (shell *directShell) Close() error {
	shell.mu.Lock()
	defer shell.mu.Unlock()
	shell.closed = true
	return shell.closeSessionLocked()
}

// closeSessionLocked 释放当前会话；调用方必须持有 mu。
func (shell *directShell) closeSessionLocked() error {
	session := shell.session
	shell.session = nil
	shell.stdin = nil
	shell.stdout = nil
	shell.broken = false
	if session == nil {
		return nil
	}
	return session.Close()
}

// ensureLocked 确保会话可用，并在启动后探测 stat 风格；调用方必须持有 mu。
func (shell *directShell) ensureLocked(ctx context.Context) error {
	if shell.closed {
		return errors.New("remote shell control plane is closed")
	}
	if shell.unavailable {
		return errShellUnavailable
	}
	if shell.session != nil && !shell.broken {
		return nil
	}
	if shell.session != nil {
		_ = shell.closeSessionLocked()
	}
	session, err := shell.startSession()
	if err != nil {
		shell.unavailable = true
		return errShellUnavailable
	}
	shell.session = session
	flavor, err := shell.probeLocked(ctx)
	if err != nil {
		shell.broken = true
		_ = shell.closeSessionLocked()
		return err
	}
	shell.flavor = flavor
	return nil
}

// startSession 启动一条 /bin/sh；两种可执行名都失败时视为控制面不可用。
func (shell *directShell) startSession() (*ssh.Session, error) {
	var lastErr error
	for _, candidate := range []string{"/bin/sh", "sh"} {
		session, err := shell.client.NewSession()
		if err != nil {
			return nil, err
		}
		stdin, err := session.StdinPipe()
		if err != nil {
			_ = session.Close()
			lastErr = err
			continue
		}
		stdout, err := session.StdoutPipe()
		if err != nil {
			_ = session.Close()
			lastErr = err
			continue
		}
		// 脚本内部已经把 stderr 合并到 stdout；会话 stderr 保持排空即可。
		session.Stderr = io.Discard
		if err := session.Start(candidate); err != nil {
			_ = session.Close()
			lastErr = err
			continue
		}
		shell.stdin = stdin
		shell.stdout = bufio.NewReaderSize(stdout, 64<<10)
		return session, nil
	}
	if lastErr == nil {
		lastErr = errors.New("remote shell is unavailable")
	}
	return nil, lastErr
}

// probeLocked 探测远端 stat 的参数风格；探测失败只降级元数据，不废掉控制面。
func (shell *directShell) probeLocked(ctx context.Context) (shellStatFlavor, error) {
	output, status, err := shell.runLocked(ctx, "if stat -c %Y / >/dev/null 2>&1; then printf gnu; elif stat -f %m / >/dev/null 2>&1; then printf bsd; else printf none; fi")
	if err != nil {
		return shellStatUnknown, err
	}
	if status != 0 {
		return shellStatNone, nil
	}
	switch strings.TrimSuffix(string(output), "\n") {
	case "gnu":
		return shellStatGNU, nil
	case "bsd":
		return shellStatBSD, nil
	default:
		return shellStatNone, nil
	}
}

// run 串行执行一条控制脚本，返回脚本输出与远端退出码。
// 会话被对端关闭时重建一次再试；控制面的三个操作都只读，重试不会重复副作用。
// 取消时关闭会话并返回 ctx 错误，会话随后由下一次请求重建。
// @param script - 单行 POSIX 脚本；调用方负责保证内容来自本包而非用户输入拼接。
func (shell *directShell) run(ctx context.Context, script string) ([]byte, int, error) {
	shell.mu.Lock()
	defer shell.mu.Unlock()
	output, status, err := shell.runLocked(ctx, script)
	if err == nil || shell.closed || shell.unavailable || ctx.Err() != nil {
		return output, status, err
	}
	output, status, err = shell.runLocked(ctx, script)
	if err != nil && !shell.unavailable && ctx.Err() == nil {
		// 连续两次 IO/协议失败说明本连接的控制面不可靠：此后一律走 SFTP。
		shell.unavailable = true
	}
	return output, status, err
}

// runLocked 是 run 的持锁实现。
func (shell *directShell) runLocked(ctx context.Context, script string) ([]byte, int, error) {
	if err := shell.ensureLocked(ctx); err != nil {
		return nil, 0, err
	}
	nonce, err := shellNonce()
	if err != nil {
		return nil, 0, err
	}
	marker := fmt.Sprintf("%s%s ", shellFramePrefix, nonce)
	// 结尾标记用 NUL 开头：脚本输出里的普通文本不可能伪造它，nonce 又逐请求随机。
	request := "{ " + script + " ; } 2>&1; st=$?; printf '\\000" + shellFramePrefix[1:] + nonce + " %s\\n' \"$st\"\n"
	if len(request) > shellMaxScriptBytes {
		return nil, 0, errShellUnavailable
	}
	if _, err := io.WriteString(shell.stdin, request); err != nil {
		shell.broken = true
		_ = shell.closeSessionLocked()
		return nil, 0, err
	}
	output, status, err := shell.readResponse(ctx, marker)
	if err != nil {
		shell.broken = true
		_ = shell.closeSessionLocked()
		return nil, 0, err
	}
	return output, status, nil
}

// errShellUnavailable 表示本连接不能使用控制面，调用方应回退 SFTP。
var errShellUnavailable = errors.New("remote shell control plane is unavailable")

// readResponse 读到结束标记为止；标记之后是远端退出码。
func (shell *directShell) readResponse(ctx context.Context, marker string) ([]byte, int, error) {
	type outcome struct {
		output []byte
		status int
		err    error
	}
	done := make(chan outcome, 1)
	go func() {
		output, status, err := readShellFrame(shell.stdout, []byte(marker), shellMaxResponseBytes)
		done <- outcome{output: output, status: status, err: err}
	}()
	select {
	case result := <-done:
		return result.output, result.status, result.err
	case <-ctx.Done():
		// SSH 通道读不可取消：关闭会话让读协程退出，下次请求重建会话。
		_ = shell.session.Close()
		<-done
		return nil, 0, ctx.Err()
	}
}

// readShellFrame 从流里读到 marker + "<status>\n"，返回标记之前的全部字节。
func readShellFrame(reader *bufio.Reader, marker []byte, limit int) ([]byte, int, error) {
	output := make([]byte, 0, 4096)
	window := make([]byte, 0, len(marker))
	for {
		value, err := reader.ReadByte()
		if err != nil {
			return nil, 0, err
		}
		window = append(window, value)
		if len(window) > len(marker) {
			output = append(output, window[0])
			window = window[1:]
			if len(output) > limit {
				return nil, 0, fail(413, "response-too-large", "remote shell response exceeds the byte limit")
			}
		}
		// 滑动之后必须继续比较：标记真正对齐时窗口刚被裁到标记长度。
		if len(window) < len(marker) || string(window) != string(marker) {
			continue
		}
		// 标记命中：随后是十进制退出码与换行，两者都不进入输出。
		window = window[:0]
		digits := make([]byte, 0, 4)
		for {
			next, err := reader.ReadByte()
			if err != nil {
				return nil, 0, err
			}
			if next == '\n' {
				break
			}
			if next < '0' || next > '9' || len(digits) >= 6 {
				return nil, 0, errors.New("remote shell frame has an invalid status")
			}
			digits = append(digits, next)
		}
		status, err := strconv.Atoi(string(digits))
		if err != nil {
			return nil, 0, errors.New("remote shell frame has an invalid status")
		}
		return output, status, nil
	}
}

// shellNonce 生成逐请求随机标记，避免输出里伪造结束标记。
func shellNonce() (string, error) {
	buffer := make([]byte, 12)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return hex.EncodeToString(buffer), nil
}

// shellLiteral 把任意字节串变成纯八进制转义的 shell 字面量。
// 远端用 printf '%b' 还原，因此路径里的引号、换行、Unicode 都不会被解释。
// @param value - 待传入远端的原始字符串。
// @returns 形如 '\057\164\155\160' 的字面量，可安全放进单引号。
func shellLiteral(value string) string {
	var builder strings.Builder
	builder.Grow(len(value)*4 + 2)
	builder.WriteByte('\'')
	for index := 0; index < len(value); index++ {
		fmt.Fprintf(&builder, `\%03o`, value[index])
	}
	builder.WriteByte('\'')
	return builder.String()
}

// canonical 用 `cd` + `pwd -P` 得到物理路径，与 SFTP RealPath 的语义一致。
// @returns 第二个返回值为 false 表示控制面不可用或路径不存在，调用方应回退 SFTP。
func (shell *directShell) canonical(ctx context.Context, name string) (string, bool, error) {
	if !shell.available() {
		return "", false, nil
	}
	script := fmt.Sprintf("d=$(printf '%%b' %s); if cd \"$d\" 2>/dev/null; then pwd -P; fi", shellLiteral(name))
	output, status, err := shell.run(ctx, script)
	if errors.Is(err, errShellUnavailable) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	resolved := strings.TrimSuffix(string(output), "\n")
	if status != 0 || resolved == "" || !path.IsAbs(resolved) || strings.ContainsAny(resolved, "\x00\n") {
		return "", false, nil
	}
	return path.Clean(resolved), true, nil
}

// list 用一条命令列出目录的一层子项。
// @returns 第二个返回值为 false 表示控制面不可用，调用方应回退 SFTP。
func (shell *directShell) list(ctx context.Context, dir string) ([]shellEntry, bool, error) {
	if !shell.available() {
		return nil, false, nil
	}
	// 与 SFTP 的失败分类对齐：缺失、非目录、不可读分别报告，Host 据此映射错误码。
	script := fmt.Sprintf(
		"d=$(printf '%%b' %s); if [ ! -e \"$d\" ] && [ ! -L \"$d\" ]; then printf 'E\\000missing\\000'; "+
			"elif [ ! -d \"$d\" ]; then printf 'E\\000not-directory\\000'; "+
			"elif [ ! -r \"$d\" ]; then printf 'E\\000permission-denied\\000'; else %s; fi",
		shellLiteral(dir), shell.listScript(),
	)
	output, status, err := shell.run(ctx, script)
	if errors.Is(err, errShellUnavailable) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if status != 0 {
		return nil, false, fmt.Errorf("remote shell directory listing exited with status %d", status)
	}
	entries, err := parseShellListing(output)
	if err != nil {
		return nil, false, err
	}
	return entries, true, nil
}

// listScript 生成遍历一层目录的 POSIX 循环；entries 以 NUL 分隔字段输出。
func (shell *directShell) listScript() string {
	meta := shell.metaScript()
	return "for p in \"$d\"/* \"$d\"/.[!.]* \"$d\"/..?*; do " +
		"if [ -L \"$p\" ]; then t=symlink; elif [ -d \"$p\" ]; then t=directory; elif [ -f \"$p\" ]; then t=file; " +
		"elif [ -e \"$p\" ]; then t=other; else continue; fi; " +
		"n=${p##*/}; m=$(" + meta + "); printf 'D\\000%s\\000%s\\000%s\\000' \"$n\" \"$t\" \"$m\"; done"
}

// metaScript 生成单路径元数据命令；stat 不可用时为空，版本令牌只含名称与类型。
func (shell *directShell) metaScript() string {
	switch shell.flavor {
	case shellStatGNU:
		return "stat -c '%s|%Y|%Z|%i|%h|%f' \"$p\" 2>/dev/null"
	case shellStatBSD:
		return "stat -f '%z|%m|%c|%i|%l|%p' \"$p\" 2>/dev/null"
	default:
		return "printf ''"
	}
}

// info 用一条命令返回单路径的类型与元数据。
// 符号链接始终按链接本身描述：控制面不跟随链接，与 SFTP 列举的 Lstat 语义一致。
// @returns 第二个返回值为 false 表示控制面不可用，调用方应回退 SFTP。
func (shell *directShell) info(ctx context.Context, name string) (shellInfo, bool, error) {
	if !shell.available() {
		return shellInfo{}, false, nil
	}
	meta := shell.metaScript()
	script := fmt.Sprintf(
		"p=$(printf '%%b' %s); if [ -L \"$p\" ]; then t=symlink; elif [ -d \"$p\" ]; then t=directory; elif [ -f \"$p\" ]; then t=file; "+
			"elif [ -e \"$p\" ]; then t=other; else t=missing; fi; if [ \"$t\" = missing ]; then printf 'E\\000missing\\000'; "+
			"else m=$(%s); printf 'P\\000%%s\\000%%s\\000' \"$t\" \"$m\"; fi",
		shellLiteral(name), meta,
	)
	output, status, err := shell.run(ctx, script)
	if errors.Is(err, errShellUnavailable) {
		return shellInfo{}, false, nil
	}
	if err != nil {
		return shellInfo{}, false, err
	}
	if status != 0 {
		return shellInfo{}, false, fmt.Errorf("remote shell path probe exited with status %d", status)
	}
	return parseShellInfo(output)
}

// parseShellListing 解析目录响应：每项是 D + 名称 + 类型 + 元数据，E 表示失败。
func parseShellListing(output []byte) ([]shellEntry, error) {
	fields := splitShellFields(output)
	if len(fields) == 0 {
		return nil, nil
	}
	if fields[0] == "E" {
		if len(fields) < 2 {
			return nil, errors.New("remote shell directory listing is malformed")
		}
		switch fields[1] {
		case "missing":
			return nil, os.ErrNotExist
		case "not-directory":
			return nil, fail(400, "not-directory", "path is not a directory")
		case "permission-denied":
			return nil, fail(403, "permission-denied", "directory is not readable")
		default:
			return nil, errors.New("remote shell directory listing failed")
		}
	}
	if len(fields)%4 != 0 {
		return nil, errors.New("remote shell directory listing is malformed")
	}
	entries := make([]shellEntry, 0, len(fields)/4)
	for index := 0; index < len(fields); index += 4 {
		if fields[index] != "D" {
			return nil, errors.New("remote shell directory listing is malformed")
		}
		entries = append(entries, shellEntry{name: fields[index+1], kind: fields[index+2], meta: fields[index+3]})
	}
	sort.Slice(entries, func(left, right int) bool { return entries[left].name < entries[right].name })
	return entries, nil
}

// parseShellInfo 解析单路径响应。
func parseShellInfo(output []byte) (shellInfo, bool, error) {
	fields := splitShellFields(output)
	if len(fields) == 3 && fields[0] == "P" {
		return shellInfo{kind: fields[1], meta: fields[2]}, true, nil
	}
	if len(fields) == 2 && fields[0] == "E" && fields[1] == "missing" {
		return shellInfo{kind: "missing"}, true, nil
	}
	return shellInfo{}, false, errors.New("remote shell path probe is malformed")
}

// splitShellFields 按 NUL 切分响应；末尾的单个空字段来自结尾分隔符，需要丢弃。
func splitShellFields(output []byte) []string {
	if len(output) == 0 {
		return nil
	}
	parts := strings.Split(string(output), "\x00")
	if len(parts) > 0 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	return parts
}

// shellVersion 由控制面元数据派生展示用版本令牌。
// 令牌只用于展示与变更提示；写入守卫仍由 read_file 的 sftp-sha256 版本负责。
// @param name - 规范化后的远端绝对路径。
// @param kind - 目录项类型。
// @param meta - 远端 stat 输出的元数据串。
func shellVersion(name, kind, meta string) string {
	digest := sha256.Sum256([]byte("shell-meta:v1\x00" + name + "\x00" + kind + "\x00" + meta))
	return "shell-meta:" + hex.EncodeToString(digest[:])
}
