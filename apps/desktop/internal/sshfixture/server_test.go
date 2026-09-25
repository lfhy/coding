package sshfixture

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

func TestFixtureRejectsUnscopedOperations(t *testing.T) {
	server, err := Start()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	if server.Host != "127.0.0.1" || server.Password == "" || server.Port == 0 {
		t.Fatalf("invalid fixture ready record: %#v", server.Ready)
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
