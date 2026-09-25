package sshfixture

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

func fixtureSourceScript(t *testing.T, filename, name string) string {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), filepath.Join("..", "remoteagent", filename), nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, declaration := range file.Decls {
		group, ok := declaration.(*ast.GenDecl)
		if !ok || group.Tok != token.CONST {
			continue
		}
		for _, item := range group.Specs {
			value := item.(*ast.ValueSpec)
			if len(value.Names) != 1 || value.Names[0].Name != name {
				continue
			}
			literal, ok := value.Values[0].(*ast.BasicLit)
			if !ok {
				t.Fatalf("%s is no longer a fixed literal", name)
			}
			script, err := strconv.Unquote(literal.Value)
			if err != nil {
				t.Fatal(err)
			}
			return script
		}
	}
	t.Fatalf("missing fixed bootstrap %s in %s", name, filename)
	return ""
}

func fixtureExecScript(t *testing.T) string {
	t.Helper()
	file, err := parser.ParseFile(token.NewFileSet(), filepath.Join("..", "remoteagent", "direct_exec.go"), nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var script strings.Builder
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok || len(call.Args) != 1 {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != "WriteString" {
			return true
		}
		receiver, ok := selector.X.(*ast.Ident)
		if !ok || receiver.Name != "script" {
			return true
		}
		literal, ok := call.Args[0].(*ast.BasicLit)
		if !ok {
			t.Fatal("direct exec bootstrap is no longer fixed")
		}
		value, err := strconv.Unquote(literal.Value)
		if err != nil {
			t.Fatal(err)
		}
		script.WriteString(value)
		return true
	})
	if script.Len() == 0 {
		t.Fatal("missing direct exec bootstrap")
	}
	return script.String()
}

func fixtureQuoteScript(script string) string {
	return "bash -c '" + strings.ReplaceAll(script, "'", "'\\''") + "'"
}

func fixtureResolveScript(t *testing.T) string {
	t.Helper()
	process := fixtureSourceScript(t, "direct_process.go", "directProcessScript")
	marker := "printf 'DSH-PROCESS-READY"
	index := strings.Index(process, marker)
	if index < 0 {
		t.Fatal("direct process ready marker is missing")
	}
	return process[:index] + `if [[ "$_dsh_exe" = /* ]]; then printf '%s\0' "$_dsh_exe"; else printf '%s/%s\0' "$_dsh_cwd_phys" "$_dsh_exe"; fi`
}

func fixtureProcessLaunchScript(t *testing.T) string {
	t.Helper()
	process := fixtureSourceScript(t, "direct_process.go", "directProcessScript")
	if !strings.HasPrefix(process, `set +x;`) {
		t.Fatal("direct process bootstrap no longer has the expected prefix")
	}
	process = strings.Replace(process, `set +x;`, `set +x; trap 'printf "DSH-PROCESS-FAILED\n" >&2' EXIT;`, 1)
	return `set +x; _dsh_env=$(type -P env) || exit 125; _dsh_bash=$(type -P bash) || exit 125; [[ "$_dsh_env" = /* && -x "$_dsh_env" && "$_dsh_bash" = /* && -x "$_dsh_bash" ]] || exit 125; exec "$_dsh_env" -i "$_dsh_bash" -c ` + strings.TrimPrefix(fixtureQuoteScript(process), "bash -c ")
}

func fixtureTerminalLaunchScript(t *testing.T) string {
	t.Helper()
	return `set +x; _dsh_stty=$(type -P stty) || exit 125; [[ "$_dsh_stty" = /* && -x "$_dsh_stty" ]] || exit 125; "$_dsh_stty" raw -echo || exit 125; printf '\036DSH-FRAME-READY\037'; ` + fixtureSourceScript(t, "direct_terminal.go", "directTerminalScript")
}

func fixtureClient(t *testing.T, server *Server) *ssh.Client {
	t.Helper()
	connection, err := net.DialTimeout("tcp", net.JoinHostPort(server.Host, fmt.Sprint(server.Port)), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	clientConn, channels, requests, err := ssh.NewClientConn(connection, "fixture", &ssh.ClientConfig{
		User: server.Username, Auth: []ssh.AuthMethod{ssh.Password(server.Password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: 2 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	client := ssh.NewClient(clientConn, channels, requests)
	t.Cleanup(func() { _ = client.Close() })
	return client
}

func fixtureReadUntil(t *testing.T, reader *bufio.Reader, marker string) string {
	t.Helper()
	var output strings.Builder
	for output.Len() < 8192 {
		value, err := reader.ReadByte()
		if err != nil {
			t.Fatalf("read %q: %v (got %q)", marker, err, output.String())
		}
		output.WriteByte(value)
		if strings.HasSuffix(output.String(), marker) {
			return output.String()
		}
	}
	t.Fatalf("fixture output did not contain %q", marker)
	return ""
}

func TestFixtureDirectBootstrapOnlyWithoutForwarding(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("POSIX fixture")
	}
	for _, item := range []struct {
		name, script string
		pty          bool
	}{
		{"exec", fixtureExecScript(t), false}, {"resolve", fixtureResolveScript(t), false},
		{"process", fixtureProcessLaunchScript(t), false}, {"terminal", fixtureTerminalLaunchScript(t), true},
	} {
		t.Run(item.name, func(t *testing.T) {
			command := fixtureQuoteScript(item.script)
			if !fixtureDirectScript(command, item.pty) {
				t.Fatalf("fixed product bootstrap is not recognized: sha256=%x", sha256.Sum256([]byte(item.script)))
			}
			if fixtureDirectScript(command+"; touch /tmp/unsafe", item.pty) || fixtureDirectScript(command, !item.pty) {
				t.Fatal("altered bootstrap or wrong PTY mode accepted")
			}
			if fixtureDirectScript(fixtureQuoteScript(item.script+"; touch /tmp/unsafe"), item.pty) {
				t.Fatal("unknown script accepted")
			}
		})
	}
	defaultServer, err := Start()
	if err != nil {
		t.Fatal(err)
	}
	defer defaultServer.Close()
	defaultClient := fixtureClient(t, defaultServer)
	ordinary, err := defaultClient.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	if err := ordinary.Run(fixtureQuoteScript(fixtureExecScript(t))); err == nil {
		t.Fatal("agent fixture accepted direct bootstrap")
	}
	_ = ordinary.Close()
	server, err := StartWithoutForwarding()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	client := fixtureClient(t, server)
	if conn, err := client.Dial("tcp", "127.0.0.1:80"); err == nil {
		_ = conn.Close()
		t.Fatal("direct-tcpip accepted")
	}
	for _, command := range []string{"pwd", fixtureQuoteScript("printf unsafe"), fixtureQuoteScript(fixtureExecScript(t) + "; printf unsafe")} {
		denied, err := client.NewSession()
		if err != nil {
			t.Fatal(err)
		}
		if err := denied.Run(command); err == nil {
			t.Fatal("basic fixture accepted an arbitrary SSH command")
		}
		_ = denied.Close()
	}
	session, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	var frame bytes.Buffer
	for _, value := range []string{server.RemoteRoot, server.RemoteRoot, "pwd -P; printf TEST", "0"} {
		frame.WriteString(value)
		frame.WriteByte(0)
	}
	session.Stdin = &frame
	output, err := session.Output(fixtureQuoteScript(fixtureExecScript(t)))
	if err != nil || !strings.Contains(string(output), server.RemoteRoot+"\nTEST") {
		t.Fatalf("basic exec output = %q, %v", output, err)
	}
	outside, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer outside.Close()
	frame.Reset()
	for _, value := range []string{server.RemoteRoot, "/tmp", "printf ESCAPED", "0"} {
		frame.WriteString(value)
		frame.WriteByte(0)
	}
	outside.Stdin = bytes.NewReader(frame.Bytes())
	if output, err := outside.Output(fixtureQuoteScript(fixtureExecScript(t))); err == nil || strings.Contains(string(output), "ESCAPED") {
		t.Fatalf("outside fixture cwd accepted: %q, %v", output, err)
	}
}

func TestFixtureDirectPTYResizeInputAndExit(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("POSIX PTY fixture")
	}
	server, err := StartWithoutForwarding()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	client := fixtureClient(t, server)
	session, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	stdin, err := session.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := session.RequestPty("xterm", 24, 80, ssh.TerminalModes{ssh.ECHO: 0, ssh.ICANON: 0}); err != nil {
		t.Fatal(err)
	}
	script := fixtureTerminalLaunchScript(t)
	if err := session.Start(fixtureQuoteScript(script)); err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(stdout)
	fixtureReadUntil(t, reader, "\x1eDSH-FRAME-READY\x1f")
	var frame bytes.Buffer
	for _, value := range []string{server.RemoteRoot, server.RemoteRoot, "3", "/bin/bash", "--noprofile", "--norc", "0"} {
		frame.WriteString(value)
		frame.WriteByte(0)
	}
	if _, err := stdin.Write(frame.Bytes()); err != nil {
		t.Fatal(err)
	}
	fixtureReadUntil(t, reader, "\x1eDSH-TERMINAL-READY ")
	fixtureReadUntil(t, reader, "\x1f")
	if err := session.WindowChange(41, 113); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(stdin, "stty size; pwd -P; printf 'TEST\\n'; exit\r"); err != nil {
		t.Fatal(err)
	}
	output, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := session.Wait(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(output), "41 113") || !strings.Contains(string(output), server.RemoteRoot) || !strings.Contains(string(output), "TEST") {
		t.Fatalf("PTY resize/cwd/output = %q", output)
	}
}

func TestFixtureDirectProcessInputAndSignal(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("POSIX process fixture")
	}
	server, err := StartWithoutForwarding()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	client := fixtureClient(t, server)
	script := fixtureProcessLaunchScript(t)
	for _, tc := range []struct {
		name        string
		argv        []string
		input, want string
		signal      ssh.Signal
	}{
		{"stdin", []string{"/bin/cat"}, "TEST\n", "TEST\n", ""},
		{"signal", []string{"/bin/sleep", "10"}, "", "", ssh.SIGTERM},
	} {
		t.Run(tc.name, func(t *testing.T) {
			session, err := client.NewSession()
			if err != nil {
				t.Fatal(err)
			}
			defer session.Close()
			stdin, err := session.StdinPipe()
			if err != nil {
				t.Fatal(err)
			}
			stdout, err := session.StdoutPipe()
			if err != nil {
				t.Fatal(err)
			}
			stderr, err := session.StderrPipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := session.Start(fixtureQuoteScript(script)); err != nil {
				t.Fatal(err)
			}
			var frame bytes.Buffer
			for _, value := range append([]string{server.RemoteRoot, server.RemoteRoot, strconv.Itoa(len(tc.argv))}, tc.argv...) {
				frame.WriteString(value)
				frame.WriteByte(0)
			}
			frame.WriteString("0")
			frame.WriteByte(0)
			if _, err := stdin.Write(frame.Bytes()); err != nil {
				t.Fatal(err)
			}
			fixtureReadUntil(t, bufio.NewReader(stderr), "\n")
			if tc.signal != "" {
				if err := session.Signal(tc.signal); err != nil {
					t.Fatal(err)
				}
				if err := session.Wait(); err == nil {
					t.Fatal("signalled child exited successfully")
				}
				return
			}
			if _, err := io.WriteString(stdin, tc.input); err != nil {
				t.Fatal(err)
			}
			_ = stdin.Close()
			output, err := io.ReadAll(stdout)
			if err != nil {
				t.Fatal(err)
			}
			if err := session.Wait(); err != nil {
				t.Fatal(err)
			}
			if string(output) != tc.want {
				t.Fatalf("process stdout = %q, want %q", output, tc.want)
			}
		})
	}
}

func TestFixtureRejectsUnscopedOperations(t *testing.T) {
	server, err := Start()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	if server.Host != "127.0.0.1" || server.Password == "" || server.Port == 0 {
		t.Fatal("invalid fixture ready record")
	}
	address := net.JoinHostPort(server.Host, fmt.Sprint(server.Port))
	config := &ssh.ClientConfig{User: server.Username, Auth: []ssh.AuthMethod{ssh.Password("incorrect")}, HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: time.Second}
	if conn, err := ssh.Dial("tcp", address, config); err == nil {
		_ = conn.Close()
		t.Fatal("wrong password accepted")
	}
	config.Auth = []ssh.AuthMethod{ssh.Password(server.Password)}
	client, err := ssh.Dial("tcp", address, config)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	session, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	output, err := session.Output(probe)
	if err != nil || !strings.Contains(string(output), "HOME="+server.RemoteRoot) {
		t.Fatalf("probe = %q, %v", output, err)
	}
	for _, command := range []string{"uname -s", "ls", "exec '/bin/sh' --token-stdin", "exec '" + server.RemoteRoot + "/nested/evil' --token-stdin"} {
		session, err := client.NewSession()
		if err != nil {
			t.Fatal(err)
		}
		if err := session.Run(command); err == nil {
			t.Fatalf("unsafe command %q accepted", command)
		}
		_ = session.Close()
	}
	for _, target := range []string{"127.0.0.1:22", "localhost:1", "example.org:80"} {
		if conn, err := client.Dial("tcp", target); err == nil {
			_ = conn.Close()
			t.Fatalf("unauthorized forwarding to %s", target)
		}
	}
	sftpClient, err := sftp.NewClient(client)
	if err != nil {
		t.Fatal(err)
	}
	defer sftpClient.Close()
	seed, err := sftpClient.Open(filepath.Join(server.RemoteRoot, "seed.txt"))
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(seed)
	_ = seed.Close()
	if err != nil || string(data) != "remote fixture seed\n" {
		t.Fatalf("seed = %q, %v", data, err)
	}
	if _, err := sftpClient.Open("/etc/passwd"); err == nil {
		t.Fatal("SFTP escaped fixture root")
	}
	installDir := filepath.Join(server.RemoteRoot, ".coding", "remote-agent")
	if err := sftpClient.MkdirAll(installDir); err != nil {
		t.Fatal(err)
	}
	fake := filepath.Join(installDir, "coding-remote-agent-fake")
	file, err := sftpClient.OpenFile(fake, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.WriteString(file, "#!/bin/sh\ntouch "+filepath.Join(server.RemoteRoot, "escaped")+"\n")
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if err := sftpClient.Chmod(fake, 0o700); err != nil {
		t.Fatal(err)
	}
	session, err = client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	if err := session.Run("exec '" + fake + "' --token-stdin"); err == nil {
		t.Fatal("uploaded shell script was executed")
	}
	if _, err := os.Stat(filepath.Join(server.RemoteRoot, "escaped")); !os.IsNotExist(err) {
		t.Fatalf("uploaded script ran: %v", err)
	}
}

func TestFixtureRunsUploadedRemoteAgent(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("Unix test fixture")
	}
	server, err := Start()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	asset := filepath.Join(t.TempDir(), "coding-remote-agent")
	build := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", asset, "./cmd/remote-agent")
	build.Dir = filepath.Join("..", "..")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build remote agent: %v: %s", err, output)
	}
	client, err := ssh.Dial("tcp", net.JoinHostPort(server.Host, fmt.Sprint(server.Port)), &ssh.ClientConfig{
		User: server.Username, Auth: []ssh.AuthMethod{ssh.Password(server.Password)}, HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	sftpClient, err := sftp.NewClient(client)
	if err != nil {
		t.Fatal(err)
	}
	remoteDir := filepath.Join(server.RemoteRoot, ".coding", "remote-agent")
	if err := sftpClient.MkdirAll(remoteDir); err != nil {
		t.Fatal(err)
	}
	remotePath := filepath.Join(remoteDir, "coding-remote-agent-test")
	remoteFile, err := sftpClient.OpenFile(remotePath+".upload", os.O_CREATE|os.O_EXCL|os.O_WRONLY)
	if err != nil {
		t.Fatal(err)
	}
	localFile, err := os.Open(asset)
	if err != nil {
		t.Fatal(err)
	}
	_, copyErr := io.Copy(remoteFile, localFile)
	_ = localFile.Close()
	if err := remoteFile.Close(); err != nil {
		t.Fatal(err)
	}
	if copyErr != nil {
		t.Fatal(copyErr)
	}
	if err := sftpClient.Chmod(remotePath+".upload", 0o700); err != nil {
		t.Fatal(err)
	}
	if err := sftpClient.Rename(remotePath+".upload", remotePath); err != nil {
		t.Fatal(err)
	}
	_ = sftpClient.Close()
	session, err := client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := session.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdin, err := session.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := session.Start("exec '" + remotePath + "' --token-stdin"); err != nil {
		t.Fatal(err)
	}
	const token = "test-agent-token-32-random-bytes-only"
	if _, err := io.WriteString(stdin, token+"\n"); err != nil {
		t.Fatal(err)
	}
	_ = stdin.Close()
	ready := make(chan []byte, 1)
	go func() { line, _ := bufio.NewReader(stdout).ReadBytes('\n'); ready <- line }()
	var line []byte
	select {
	case line = <-ready:
	case <-time.After(10 * time.Second):
		t.Fatal("agent readiness timed out")
	}
	var record struct {
		Type string `json:"type"`
		Port int    `json:"port"`
	}
	if err := json.Unmarshal(line, &record); err != nil || record.Type != "coding-remote-agent-ready" || record.Port < 1 {
		t.Fatalf("agent ready = %q: %v", line, err)
	}
	conn, err := client.Dial("tcp", net.JoinHostPort("127.0.0.1", fmt.Sprint(record.Port)))
	if err != nil {
		t.Fatal(err)
	}
	_, err = fmt.Fprintf(conn, "GET /v1/health HTTP/1.1\r\nHost: coding-remote-agent\r\nAuthorization: Bearer %s\r\nConnection: close\r\n\r\n", token)
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	_ = conn.Close()
	if err != nil || response.StatusCode != http.StatusOK || !bytes.Contains(body, []byte(`"coding-remote-agent-health"`)) {
		t.Fatalf("agent health = %d, %s, %v", response.StatusCode, body, err)
	}
	server.Close()
	finished := make(chan error, 1)
	go func() { finished <- session.Wait() }()
	select {
	case <-finished:
	case <-time.After(3 * time.Second):
		t.Fatal("agent survived fixture shutdown")
	}
}
