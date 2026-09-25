package remoteagent

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/deepseek-ai/coding/apps/desktop/internal/sshfixture"
	"golang.org/x/crypto/ssh"
)

func TestDirectSFTPReadOnlyWithoutForwarding(t *testing.T) {
	server, err := sshfixture.StartWithoutForwarding()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	client, err := ssh.Dial("tcp", net.JoinHostPort(server.Host, fmt.Sprint(server.Port)), &ssh.ClientConfig{
		User: server.Username, Auth: []ssh.AuthMethod{ssh.Password(server.Password)}, HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if conn, err := client.Dial("tcp", "127.0.0.1:1"); err == nil {
		_ = conn.Close()
		t.Fatal("forwarding unexpectedly allowed")
	}
	backend, err := newDirectSFTPBackend(client)
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	ctx := context.Background()
	home, err := backend.Home(ctx)
	if err != nil || home != server.RemoteRoot {
		t.Fatalf("home = %q, %v", home, err)
	}
	resolved, err := backend.ResolvePath(ctx, filepath.Join(home, "seed.txt"))
	if err != nil || resolved.Info == nil || resolved.Info.Type != "file" {
		t.Fatalf("resolved = %+v, %v", resolved, err)
	}
	listed, err := backend.ListDirectories(ctx, home)
	if err != nil || len(listed.Entries) == 0 {
		t.Fatalf("list = %+v, %v", listed, err)
	}
	for _, entry := range listed.Entries {
		if entry.Name == "seed.txt" && !strings.HasPrefix(entry.Version, "sftp-meta:") {
			t.Fatalf("directory listing unexpectedly read file contents: %+v", entry)
		}
	}
	for _, route := range []string{"/v1/resolve", "/v1/stat", "/v1/directories", "/v1/read_file", "/v1/read_bytes"} {
		requested := "seed.txt"
		if route == "/v1/directories" {
			requested = "."
		}
		body, _ := json.Marshal(ReadRequest{Root: home, Path: requested})
		response, err := backend.Proxy(ctx, http.MethodPost, route, body)
		if err != nil || response.Status != http.StatusOK {
			t.Fatalf("%s: %+v, %v", route, response, err)
		}
	}
	for _, route := range []string{"/v1/exec"} {
		if _, err := backend.Proxy(ctx, http.MethodPost, route, []byte(`{}`)); err == nil {
			t.Fatalf("accepted %s", route)
		}
	}
}

func TestDirectSFTPWriteAndEdit(t *testing.T) {
	server, err := sshfixture.StartWithoutForwarding()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	client, err := ssh.Dial("tcp", net.JoinHostPort(server.Host, fmt.Sprint(server.Port)), &ssh.ClientConfig{
		User: server.Username, Auth: []ssh.AuthMethod{ssh.Password(server.Password)}, HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	backend, err := newDirectSFTPBackend(client)
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	call := func(route string, request any, status int, result any) {
		t.Helper()
		body, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		response, err := backend.Proxy(context.Background(), http.MethodPost, route, body)
		if err != nil || response.Status != status {
			t.Fatalf("%s = %d %s, %v; want %d", route, response.Status, response.Body, err, status)
		}
		if result != nil && status == http.StatusOK {
			if err := json.Unmarshal(response.Body, result); err != nil {
				t.Fatal(err)
			}
		}
	}
	root := server.RemoteRoot
	if err := os.Symlink(t.TempDir(), filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	var created WriteResponse
	call("/v1/update_file", WriteRequest{Root: root, Path: "new.txt", Content: "one\r\ntwo\r\n", Expected: &WriteExpectation{Kind: "createIfAbsent"}}, http.StatusOK, &created)
	if created.Operation != "create" || created.Before != nil || created.After != "one\ntwo\n" || created.Version == "" {
		t.Fatalf("created = %+v", created)
	}
	data, err := os.ReadFile(filepath.Join(root, "new.txt"))
	if err != nil || string(data) != "one\r\ntwo\r\n" {
		t.Fatalf("stored = %q, %v", data, err)
	}
	call("/v1/update_file", WriteRequest{Root: root, Path: "new.txt", Content: "wrong", Expected: &WriteExpectation{Kind: "createIfAbsent"}}, http.StatusConflict, nil)
	call("/v1/update_file", WriteRequest{Root: root, Path: "new.txt", Content: "wrong", Expected: &WriteExpectation{Kind: "replaceIfVersion", Version: "stale"}}, http.StatusConflict, nil)
	var edited EditResponse
	call("/v1/edit_file", EditRequest{Root: root, Path: "new.txt", OldString: "two", NewString: "three", Expected: &WriteExpectation{Kind: "replaceIfVersion", Version: created.Version}}, http.StatusOK, &edited)
	if edited.Before != "one\ntwo\n" || edited.After != "one\nthree\n" || edited.Version == created.Version {
		t.Fatalf("edited = %+v", edited)
	}
	data, err = os.ReadFile(filepath.Join(root, "new.txt"))
	if err != nil || string(data) != "one\r\nthree\r\n" {
		t.Fatalf("edited bytes = %q, %v", data, err)
	}
	call("/v1/edit_file", EditRequest{Root: root, Path: "new.txt", OldString: "absent", NewString: "x"}, http.StatusConflict, nil)
	call("/v1/update_file", WriteRequest{Root: root, Path: "duplicate.txt", Content: "echo echo"}, http.StatusOK, nil)
	call("/v1/edit_file", EditRequest{Root: root, Path: "duplicate.txt", OldString: "echo", NewString: "say"}, http.StatusConflict, nil)
	var all EditResponse
	call("/v1/edit_file", EditRequest{Root: root, Path: "duplicate.txt", OldString: "echo", NewString: "say", ReplaceAll: true}, http.StatusOK, &all)
	if all.After != "say say" {
		t.Fatalf("replace all = %+v", all)
	}
	call("/v1/update_file", WriteRequest{Root: root, Path: "new.txt", Content: "bad\x00text"}, http.StatusUnprocessableEntity, nil)
	call("/v1/update_file", WriteRequest{Root: root, Path: "new.txt", Content: strings.Repeat("x", maxFileBytes+1)}, http.StatusRequestEntityTooLarge, nil)
	call("/v1/update_file", WriteRequest{Root: root, Path: "../escaped", Content: "secret"}, http.StatusForbidden, nil)
	escapeBody, _ := json.Marshal(WriteRequest{Root: root, Path: "escape/file", Content: "secret"})
	escapeResponse, escapeErr := backend.Proxy(context.Background(), http.MethodPost, "/v1/update_file", escapeBody)
	if escapeErr != nil || escapeResponse.Status == http.StatusOK {
		t.Fatalf("symlink escape = %+v, %v", escapeResponse, escapeErr)
	}
	backend.hasHardlink = false
	call("/v1/update_file", WriteRequest{Root: root, Path: "unsupported", Content: "secret", Expected: &WriteExpectation{Kind: "createIfAbsent"}}, http.StatusNotImplemented, nil)
	backend.hasPosixRename = false
	call("/v1/update_file", WriteRequest{Root: root, Path: "new.txt", Content: "secret"}, http.StatusNotImplemented, nil)
	if _, err := os.Stat(filepath.Join(root, "unsupported")); !os.IsNotExist(err) {
		t.Fatalf("unsupported write changed file: %v", err)
	}
	leftovers, err := filepath.Glob(filepath.Join(root, ".coding-agent-write-*"))
	if err != nil || len(leftovers) != 0 {
		t.Fatalf("temporary files = %v, %v", leftovers, err)
	}
}

func TestDirectSFTPStatAndResolveVersionsGuardWrites(t *testing.T) {
	server, err := sshfixture.StartWithoutForwarding()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	client, err := ssh.Dial("tcp", net.JoinHostPort(server.Host, fmt.Sprint(server.Port)), &ssh.ClientConfig{
		User: server.Username, Auth: []ssh.AuthMethod{ssh.Password(server.Password)}, HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	backend, err := newDirectSFTPBackend(client)
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	root := server.RemoteRoot
	call := func(route string, request any, result any) {
		t.Helper()
		body, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		response, err := backend.Proxy(context.Background(), http.MethodPost, route, body)
		if err != nil || response.Status != http.StatusOK {
			t.Fatalf("%s = %d %s, %v", route, response.Status, response.Body, err)
		}
		if err := json.Unmarshal(response.Body, result); err != nil {
			t.Fatal(err)
		}
	}
	var observed StatResponse
	call("/v1/stat", StatRequest{Root: root, Path: "seed.txt"}, &observed)
	if observed.Info == nil || !strings.HasPrefix(observed.Info.Version, "sftp-sha256:") {
		t.Fatalf("stat version = %+v", observed.Info)
	}
	var resolved ResolveResponse
	call("/v1/resolve", ResolveRequest{Root: root, Path: "seed.txt"}, &resolved)
	var read ReadResponse
	call("/v1/read_file", ReadRequest{Root: root, Path: "seed.txt"}, &read)
	var bytesRead ReadBytesResponse
	call("/v1/read_bytes", ReadRequest{Root: root, Path: "seed.txt"}, &bytesRead)
	if resolved.Info == nil || observed.Info.Version != resolved.Info.Version || observed.Info.Version != read.Version || read.Version != bytesRead.Version {
		t.Fatalf("version mismatch: stat=%q resolve=%+v read=%q bytes=%q", observed.Info.Version, resolved.Info, read.Version, bytesRead.Version)
	}
	var updated WriteResponse
	call("/v1/update_file", WriteRequest{Root: root, Path: "seed.txt", Content: "replaced", Expected: &WriteExpectation{Kind: "replaceIfVersion", Version: observed.Info.Version}}, &updated)
	if !strings.HasPrefix(updated.Version, "sftp-sha256:") || updated.Version == observed.Info.Version {
		t.Fatalf("updated version = %q", updated.Version)
	}
	var edited EditResponse
	call("/v1/edit_file", EditRequest{Root: root, Path: "seed.txt", OldString: "replaced", NewString: "edited", Expected: &WriteExpectation{Kind: "replaceIfVersion", Version: updated.Version}}, &edited)
	if edited.After != "edited" || edited.Version == updated.Version {
		t.Fatalf("edited = %+v", edited)
	}
}

func TestDirectSFTPRejectsSameSecondReplacement(t *testing.T) {
	server, err := sshfixture.StartWithoutForwarding()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	client, err := ssh.Dial("tcp", net.JoinHostPort(server.Host, fmt.Sprint(server.Port)), &ssh.ClientConfig{
		User: server.Username, Auth: []ssh.AuthMethod{ssh.Password(server.Password)}, HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	backend, err := newDirectSFTPBackend(client)
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	name := filepath.Join(server.RemoteRoot, "replacement.txt")
	stamp := time.Unix(1_700_000_000, 0)
	if err := os.WriteFile(name, []byte("first"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(name, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	call := func(route string, request any) ProxyResponse {
		t.Helper()
		body, err := json.Marshal(request)
		if err != nil {
			t.Fatal(err)
		}
		response, err := backend.Proxy(context.Background(), http.MethodPost, route, body)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	root := server.RemoteRoot
	read := call("/v1/read_file", ReadRequest{Root: root, Path: "replacement.txt"})
	if read.Status != http.StatusOK {
		t.Fatalf("read = %d %s", read.Status, read.Body)
	}
	var observed ReadResponse
	if err := json.Unmarshal(read.Body, &observed); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(observed.Version, "sftp-sha256:") {
		t.Fatalf("read returned an unguardable version: %q", observed.Version)
	}
	stat := call("/v1/stat", StatRequest{Root: root, Path: "replacement.txt"})
	if stat.Status != http.StatusOK {
		t.Fatalf("stat = %d %s", stat.Status, stat.Body)
	}
	var listed StatResponse
	if err := json.Unmarshal(stat.Body, &listed); err != nil {
		t.Fatal(err)
	}
	if listed.Info == nil || listed.Info.Version != observed.Version {
		t.Fatalf("stat should expose the read version: %+v", listed)
	}
	fileInfo, err := os.Stat(name)
	if err != nil {
		t.Fatal(err)
	}
	weakVersion, err := directSFTPMetadataVersion(name, fileInfo)
	if err != nil {
		t.Fatal(err)
	}
	weak := call("/v1/update_file", WriteRequest{Root: root, Path: "replacement.txt", Content: "third", Expected: &WriteExpectation{Kind: "replaceIfVersion", Version: weakVersion}})
	if weak.Status != http.StatusConflict || !strings.Contains(string(weak.Body), "version-unavailable") {
		t.Fatalf("weak version accepted = %d %s", weak.Status, weak.Body)
	}
	temporary := filepath.Join(root, "outside-replacement")
	if err := os.WriteFile(temporary, []byte("other"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(temporary, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(temporary, name); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, route string
		request     any
	}{
		{"write", "/v1/update_file", WriteRequest{Root: root, Path: "replacement.txt", Content: "third", Expected: &WriteExpectation{Kind: "replaceIfVersion", Version: listed.Info.Version}}},
		{"edit", "/v1/edit_file", EditRequest{Root: root, Path: "replacement.txt", OldString: "other", NewString: "third", Expected: &WriteExpectation{Kind: "replaceIfVersion", Version: listed.Info.Version}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := call(test.route, test.request)
			if response.Status != http.StatusConflict || !strings.Contains(string(response.Body), "stale-version") {
				t.Fatalf("stale write = %d %s", response.Status, response.Body)
			}
			data, err := os.ReadFile(name)
			if err != nil || string(data) != "other" {
				t.Fatalf("replacement = %q, %v", data, err)
			}
		})
	}
}

func TestDirectSFTPLargeFileStatIsNotGuardable(t *testing.T) {
	server, err := sshfixture.StartWithoutForwarding()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	name := filepath.Join(server.RemoteRoot, "large.txt")
	file, err := os.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(maxFileBytes + 1); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	client, err := ssh.Dial("tcp", net.JoinHostPort(server.Host, fmt.Sprint(server.Port)), &ssh.ClientConfig{
		User: server.Username, Auth: []ssh.AuthMethod{ssh.Password(server.Password)}, HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	backend, err := newDirectSFTPBackend(client)
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	for _, route := range []string{"/v1/stat", "/v1/resolve"} {
		t.Run(route, func(t *testing.T) {
			body, err := json.Marshal(StatRequest{Root: server.RemoteRoot, Path: "large.txt"})
			if err != nil {
				t.Fatal(err)
			}
			response, err := backend.Proxy(context.Background(), http.MethodPost, route, body)
			if err != nil || response.Status != http.StatusOK {
				t.Fatalf("%s = %d %s, %v", route, response.Status, response.Body, err)
			}
			var observed struct {
				Info *PathInfo `json:"info"`
			}
			if err := json.Unmarshal(response.Body, &observed); err != nil {
				t.Fatal(err)
			}
			if observed.Info == nil || !strings.HasPrefix(observed.Info.Version, "sftp-meta:") {
				t.Fatalf("large file should not expose a writable version: %+v", observed.Info)
			}
			write, err := json.Marshal(WriteRequest{Root: server.RemoteRoot, Path: "large.txt", Content: "replacement", Expected: &WriteExpectation{Kind: "replaceIfVersion", Version: observed.Info.Version}})
			if err != nil {
				t.Fatal(err)
			}
			response, err = backend.Proxy(context.Background(), http.MethodPost, "/v1/update_file", write)
			if err != nil || response.Status != http.StatusConflict || !strings.Contains(string(response.Body), "version-unavailable") {
				t.Fatalf("large file guarded write = %d %s, %v", response.Status, response.Body, err)
			}
		})
	}
}

func TestDirectSFTPDirectoryLimit(t *testing.T) {
	server, err := sshfixture.StartWithoutForwarding()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	directory := filepath.Join(server.RemoteRoot, "crowded")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	for i := range maxDirectoryItems + 1 {
		name := filepath.Join(directory, fmt.Sprintf("%05d", i))
		if err := os.WriteFile(name, nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	client, err := ssh.Dial("tcp", net.JoinHostPort(server.Host, fmt.Sprint(server.Port)), &ssh.ClientConfig{
		User: server.Username, Auth: []ssh.AuthMethod{ssh.Password(server.Password)}, HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	backend, err := newDirectSFTPBackend(client)
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	body, err := json.Marshal(ListRequest{Root: server.RemoteRoot, Path: "crowded"})
	if err != nil {
		t.Fatal(err)
	}
	response, err := backend.Proxy(context.Background(), http.MethodPost, "/v1/directories", body)
	if err != nil || response.Status != http.StatusRequestEntityTooLarge || !strings.Contains(string(response.Body), "too-many-entries") {
		t.Fatalf("bounded directory = %+v, %v", response, err)
	}
}

func TestDirectSFTPRejectsEscapesAndInvalidText(t *testing.T) {
	server, err := sshfixture.StartWithoutForwarding()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(server.RemoteRoot, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(server.RemoteRoot, "binary"), []byte{0, 0xff}, 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := ssh.Dial("tcp", net.JoinHostPort(server.Host, fmt.Sprint(server.Port)), &ssh.ClientConfig{
		User: server.Username, Auth: []ssh.AuthMethod{ssh.Password(server.Password)}, HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	backend, err := newDirectSFTPBackend(client)
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	for _, path := range []string{"../outside", "escape/secret", "/etc/passwd"} {
		body, _ := json.Marshal(ReadRequest{Root: server.RemoteRoot, Path: path})
		response, err := backend.Proxy(context.Background(), http.MethodPost, "/v1/read_bytes", body)
		if err != nil || response.Status == http.StatusOK {
			t.Fatalf("escape %q: %+v, %v", path, response, err)
		}
	}
	missing, err := json.Marshal(StatRequest{Root: server.RemoteRoot, Path: "missing.txt"})
	if err != nil {
		t.Fatal(err)
	}
	response, err := backend.Proxy(context.Background(), http.MethodPost, "/v1/stat", missing)
	if err != nil || response.Status != http.StatusOK || string(response.Body) != "{}\n" {
		t.Fatalf("missing stat = %+v, %v", response, err)
	}
	invalid, err := backend.Proxy(context.Background(), http.MethodPost, "/v1/resolve", []byte(`{"root":"`+server.RemoteRoot+`","path":"seed.txt","maxBytes":1}`))
	if err != nil || invalid.Status != http.StatusBadRequest {
		t.Fatalf("invalid resolve = %+v, %v", invalid, err)
	}
	for _, route := range []string{"/v1/read_file", "/v1/read_bytes"} {
		body, _ := json.Marshal(ReadRequest{Root: server.RemoteRoot, Path: "binary"})
		response, err := backend.Proxy(context.Background(), http.MethodPost, route, body)
		if err != nil {
			t.Fatal(err)
		}
		if route == "/v1/read_file" && response.Status != http.StatusUnprocessableEntity {
			t.Fatalf("text status = %d", response.Status)
		}
		if route == "/v1/read_bytes" && response.Status != http.StatusOK {
			t.Fatalf("bytes status = %d", response.Status)
		}
	}
}
