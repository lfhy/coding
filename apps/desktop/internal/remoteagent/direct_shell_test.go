package remoteagent

// 常驻 shell 控制面的测试：正确性、特殊文件名、回退与断线重建。
// 这些用例需要真实 POSIX shell，因此只在 darwin/linux 上运行。

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"encoding/json"

	"github.com/deepseek-ai/coding/apps/desktop/internal/sshfixture"
	"golang.org/x/crypto/ssh"
)

// newShellBackend 启动带 `/bin/sh` 的回环机，并返回启用了控制面的 backend。
func newShellBackend(t *testing.T) (*directSFTPBackend, *ssh.Client, string) {
	t.Helper()
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("shell control plane requires a POSIX fixture")
	}
	server, err := sshfixture.StartWithoutForwarding()
	if err != nil {
		t.Fatal(err)
	}
	server.EnableShell()
	t.Cleanup(server.Close)
	client, err := ssh.Dial("tcp", net.JoinHostPort(server.Host, fmt.Sprint(server.Port)), &ssh.ClientConfig{
		User: server.Username, Auth: []ssh.AuthMethod{ssh.Password(server.Password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	backend, err := newDirectSFTPBackend(client)
	if err != nil {
		t.Fatal(err)
	}
	backend.useShell()
	t.Cleanup(func() { _ = backend.Close() })
	return backend, client, server.RemoteRoot
}

func TestShellControlPlaneListsDirectories(t *testing.T) {
	backend, _, root := newShellBackend(t)
	ctx := context.Background()
	if err := os.MkdirAll(filepath.Join(root, "project", "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "project", "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 文件名里带空格、引号、换行与 Unicode，必须逐字节原样返回。
	names := []string{"with space", "quote'single", "line\nbreak", "中文目录"}
	for _, name := range names {
		if err := os.MkdirAll(filepath.Join(root, "project", name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	listing, err := backend.ListDirectories(ctx, filepath.Join(root, "project"))
	if err != nil {
		t.Fatal(err)
	}
	if listing.Path != filepath.Join(root, "project") {
		t.Fatalf("path = %q", listing.Path)
	}
	seen := make(map[string]DirectoryEntry, len(listing.Entries))
	for _, entry := range listing.Entries {
		seen[entry.Name] = entry
	}
	for _, name := range names {
		entry, ok := seen[name]
		if !ok {
			t.Fatalf("missing entry %q in %v", name, len(listing.Entries))
		}
		if entry.Type != "directory" {
			t.Fatalf("%q type = %q", name, entry.Type)
		}
		if entry.Path != filepath.Join(root, "project", name) {
			t.Fatalf("%q path = %q", name, entry.Path)
		}
		if !strings.HasPrefix(entry.Version, "shell-meta:") {
			t.Fatalf("%q version = %q", name, entry.Version)
		}
	}
	readme, ok := seen["README.md"]
	if !ok || readme.Type != "file" || readme.Size == nil || *readme.Size != 6 {
		t.Fatalf("README.md entry = %+v", readme)
	}
	if seen["src"].Type != "directory" {
		t.Fatalf("src entry = %+v", seen["src"])
	}
}

func TestShellControlPlaneReportsDirectoryFailures(t *testing.T) {
	backend, _, root := newShellBackend(t)
	ctx := context.Background()
	if err := os.WriteFile(filepath.Join(root, "seed.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := backend.ListDirectories(ctx, filepath.Join(root, "seed.txt")); err == nil {
		t.Fatal("expected a not-directory failure")
	}
	// 缺失目录必须保留 not-found 语义，Host 据此映射 FS_NOT_FOUND。
	if _, err := backend.ListDirectories(ctx, filepath.Join(root, "missing")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing directory error = %v", err)
	}
}

func TestShellControlPlaneResolvesSymlinks(t *testing.T) {
	backend, _, root := newShellBackend(t)
	ctx := context.Background()
	target := filepath.Join(root, "nested")
	link := filepath.Join(root, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	resolved, err := backend.ResolvePath(ctx, link)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Path != target {
		t.Fatalf("resolved = %q, want %q", resolved.Path, target)
	}
	if resolved.Info == nil || resolved.Info.Type != "directory" {
		t.Fatalf("info = %+v", resolved.Info)
	}
}

func TestShellControlPlaneRestartsAfterSessionLoss(t *testing.T) {
	backend, _, root := newShellBackend(t)
	ctx := context.Background()
	if _, err := backend.ListDirectories(ctx, root); err != nil {
		t.Fatal(err)
	}
	// 让远端 sh 自行退出，模拟会话在两次调用之间消失；下一次调用必须重建。
	if _, err := io.WriteString(backend.shell.stdin, "exit\n"); err != nil {
		t.Fatalf("close remote shell: %v", err)
	}
	time.Sleep(100 * time.Millisecond)
	listing, err := backend.ListDirectories(ctx, root)
	if err != nil {
		t.Fatalf("list after shell loss: %v", err)
	}
	if listing.Path != root {
		t.Fatalf("path = %q", listing.Path)
	}
}

func TestShellControlPlaneFallsBackWithoutShell(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("SFTP fixture requires POSIX")
	}
	server, err := sshfixture.StartWithoutForwarding()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	client, err := ssh.Dial("tcp", net.JoinHostPort(server.Host, fmt.Sprint(server.Port)), &ssh.ClientConfig{
		User: server.Username, Auth: []ssh.AuthMethod{ssh.Password(server.Password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	backend, err := newDirectSFTPBackend(client)
	if err != nil {
		t.Fatal(err)
	}
	backend.useShell()
	defer backend.Close()
	// 没有 EnableShell 的回环机拒绝 sh；控制面标记不可用后必须回退 SFTP。
	listing, err := backend.ListDirectories(context.Background(), server.RemoteRoot)
	if err != nil {
		t.Fatal(err)
	}
	if listing.Path != server.RemoteRoot {
		t.Fatalf("path = %q", listing.Path)
	}
	for _, entry := range listing.Entries {
		if strings.HasPrefix(entry.Version, "sftp-meta:") {
			return
		}
	}
	t.Fatalf("expected SFTP fallback versions, got %+v", listing.Entries)
}

// latencyProxy 在回环连接上注入固定延迟，用来暴露逐条目往返。
// 它只在测试里使用，不改变产品代码的传输路径。
func latencyProxy(t *testing.T, target string, delay time.Duration) net.Listener {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	pipe := func(destination net.Conn, source net.Conn) {
		buffer := make([]byte, 32<<10)
		for {
			count, readErr := source.Read(buffer)
			if count > 0 {
				time.Sleep(delay)
				if _, writeErr := destination.Write(buffer[:count]); writeErr != nil {
					return
				}
			}
			if readErr != nil {
				return
			}
		}
	}
	go func() {
		for {
			local, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			remote, dialErr := net.Dial("tcp", target)
			if dialErr != nil {
				_ = local.Close()
				continue
			}
			go pipe(remote, local)
			go pipe(local, remote)
		}
	}()
	return listener
}

func TestShellControlPlaneHasNoPerEntryRoundTrips(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("shell control plane requires a POSIX fixture")
	}
	server, err := sshfixture.StartWithoutForwarding()
	if err != nil {
		t.Fatal(err)
	}
	server.EnableShell()
	t.Cleanup(server.Close)
	delay := 20 * time.Millisecond
	proxy := latencyProxy(t, net.JoinHostPort(server.Host, fmt.Sprint(server.Port)), delay)
	client, err := ssh.Dial("tcp", proxy.Addr().String(), &ssh.ClientConfig{
		User: server.Username, Auth: []ssh.AuthMethod{ssh.Password(server.Password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: 20 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	backend, err := newDirectSFTPBackend(client)
	if err != nil {
		t.Fatal(err)
	}
	backend.useShell()
	t.Cleanup(func() { _ = backend.Close() })
	target := filepath.Join(server.RemoteRoot, "many")
	for index := range 40 {
		if err := os.MkdirAll(filepath.Join(target, fmt.Sprintf("entry-%02d", index)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()
	if _, err := backend.ListDirectories(ctx, target); err != nil {
		t.Fatal(err)
	}
	// 首次列举含会话启动与能力探测；这里只约束已建好会话的单次列举。
	started := time.Now()
	listing, err := backend.ListDirectories(ctx, target)
	elapsed := time.Since(started)
	if err != nil {
		t.Fatal(err)
	}
	if len(listing.Entries) != 40 {
		t.Fatalf("entries = %d", len(listing.Entries))
	}
	// 40 个条目若走逐条往返，仅条目就需 40 * 2 * delay = 1.6s。
	if elapsed > time.Second {
		t.Fatalf("directory listing took %v; the control plane still pays per-entry round trips", elapsed)
	}
}

func TestReadShellFrameFindsMarkerAfterArbitraryBytes(t *testing.T) {
	marker := []byte("\x00__coding_shell__abcd ")
	payload := []byte("name\x00directory\x000|1|2|3|4|5\x00")
	stream := bytes.NewReader(append(append(append([]byte{}, payload...), marker...), []byte("0\n")...))
	output, status, err := readShellFrame(bufio.NewReader(stream), marker, shellMaxResponseBytes)
	if err != nil {
		t.Fatal(err)
	}
	if status != 0 || !bytes.Equal(output, payload) {
		t.Fatalf("status = %d, output = %q", status, output)
	}
}

func TestReadShellFrameRejectsInvalidStatus(t *testing.T) {
	marker := []byte("\x00__coding_shell__abcd ")
	stream := bytes.NewReader(append(append([]byte("x"), marker...), []byte("nope\n")...))
	if _, _, err := readShellFrame(bufio.NewReader(stream), marker, shellMaxResponseBytes); err == nil {
		t.Fatal("expected an invalid status failure")
	}
}

func TestShellLiteralEscapesEveryByte(t *testing.T) {
	if got := shellLiteral("/tmp/a'b"); got != `'\057\164\155\160\057\141\047\142'` {
		t.Fatalf("literal = %s", got)
	}
}

func TestShellControlPlaneReadsTextInOneScript(t *testing.T) {
	backend, _, root := newShellBackend(t)
	ctx := context.Background()
	// 内容里带换行、制表符、引号与多字节字符：分帧不能依赖内容形状。
	body := "第一行\n\ttab \"quoted\" 'single'\nlast line without newline"
	path := filepath.Join(root, "notes.md")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	data, info, err := backend.readText(ctx, root, path, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != body {
		t.Fatalf("content = %q", string(data))
	}
	if info.Size() != int64(len(body)) || !info.Mode().IsRegular() {
		t.Fatalf("info = %+v", info)
	}
	version, err := directSFTPStrongVersion(path, info, data)
	if err != nil || !strings.HasPrefix(version, "sftp-sha256:") {
		t.Fatalf("version = %q, %v", version, err)
	}
}

func TestShellControlPlaneReadTextReportsFailures(t *testing.T) {
	backend, _, root := newShellBackend(t)
	ctx := context.Background()
	if err := os.WriteFile(filepath.Join(root, "big.txt"), []byte(strings.Repeat("x", 64)), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "dir.txt"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "big.txt"), filepath.Join(root, "link.txt")); err != nil {
		t.Fatal(err)
	}

	// 缺失保留 not-found 语义，Host 靠它映射 FS_NOT_FOUND。
	if _, _, err := backend.readText(ctx, root, filepath.Join(root, "missing.txt"), 1<<20); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing error = %v", err)
	}
	// 目录与符号链接都不是可读的常规文件，不能悄悄读到别处的内容。
	if _, _, err := backend.readText(ctx, root, filepath.Join(root, "dir.txt"), 1<<20); err == nil {
		t.Fatal("expected a not-regular failure for a directory")
	}
	if _, _, err := backend.readText(ctx, root, filepath.Join(root, "link.txt"), 1<<20); err == nil {
		t.Fatal("expected a symlink rejection")
	}
	// 超过请求上限时不返回被截断的内容。
	if _, _, err := backend.readText(ctx, root, filepath.Join(root, "big.txt"), 16); err == nil {
		t.Fatal("expected a too-large failure")
	}
}

func TestShellControlPlaneReadTextFallsBackForOversizedReads(t *testing.T) {
	backend, _, root := newShellBackend(t)
	ctx := context.Background()
	// 超过控制面单次读取上限时整条走 SFTP，结果必须与分块读取一致。
	body := strings.Repeat("ab", shellMaxReadBytes/2+16)
	path := filepath.Join(root, "huge.txt")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	data, info, err := backend.readText(ctx, root, path, int64(len(body)))
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != body || info.Size() != int64(len(body)) {
		t.Fatalf("fallback read returned %d bytes, size %d", len(data), info.Size())
	}
}

func TestShellControlPlaneTextReadKeepsSFTPVersionParity(t *testing.T) {
	backend, _, root := newShellBackend(t)
	ctx := context.Background()
	body := "line one\nline two\n"
	if err := os.WriteFile(filepath.Join(root, "parity.txt"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	call := func(route string, request any, target any) {
		t.Helper()
		encoded, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		response, err := backend.Proxy(ctx, http.MethodPost, route, encoded)
		if err != nil || response.Status != http.StatusOK {
			t.Fatalf("%s = %d %s, %v", route, response.Status, response.Body, err)
		}
		if target != nil {
			if err := json.Unmarshal(response.Body, target); err != nil {
				t.Fatal(err)
			}
		}
	}
	var stat StatResponse
	call("/v1/stat", StatRequest{Root: root, Path: "parity.txt"}, &stat)
	var text ReadResponse
	call("/v1/read_file", ReadRequest{Root: root, Path: "parity.txt"}, &text)
	var raw ReadBytesResponse
	call("/v1/read_bytes", ReadRequest{Root: root, Path: "parity.txt"}, &raw)

	if text.Content != body {
		t.Fatalf("content = %q", text.Content)
	}
	// 控制面读到的字节必须和 SFTP 版本令牌一致：写入守卫按字符串比较版本。
	if stat.Info == nil || stat.Info.Version != text.Version || text.Version != raw.Version {
		t.Fatalf("version mismatch: stat=%q text=%q bytes=%q", stat.Info.Version, text.Version, raw.Version)
	}
}
