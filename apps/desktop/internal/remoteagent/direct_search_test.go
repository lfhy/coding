package remoteagent

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/deepseek-ai/coding/apps/desktop/internal/sshfixture"
	"golang.org/x/crypto/ssh"
)

func directSearchFixture(t *testing.T) (*directSFTPBackend, string) {
	t.Helper()
	server, err := sshfixture.StartWithoutForwarding()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	client, err := ssh.Dial("tcp", net.JoinHostPort(server.Host, fmt.Sprint(server.Port)), &ssh.ClientConfig{
		User: server.Username, Auth: []ssh.AuthMethod{ssh.Password(server.Password)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	backend, err := newDirectSFTPBackend(client)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = backend.Close() })
	return backend, server.RemoteRoot
}

func directSearchCall(t *testing.T, backend *directSFTPBackend, request SearchRequest) (SearchResponse, ProxyResponse) {
	t.Helper()
	body, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	response, err := backend.Search(context.Background(), body)
	if err != nil {
		t.Fatal(err)
	}
	if response.Status != http.StatusOK || response.ContentType != "application/json" ||
		len(response.Body) == 0 || response.Body[len(response.Body)-1] != '\n' {
		t.Fatalf("search response = %+v", response)
	}
	var result SearchResponse
	if err := json.Unmarshal(response.Body, &result); err != nil {
		t.Fatal(err)
	}
	return result, response
}

func TestDirectSearchGlobAndGrep(t *testing.T) {
	backend, root := directSearchFixture(t)
	for name, content := range map[string]string{
		"new.ts":           "export const newest = true\n",
		"nested/old.ts":    "export const oldest = true\n",
		"first.txt":        "before\nneedle one\nafter\n",
		"nested/second.md": "needle two\n",
		".git/skip.ts":     "needle hidden\n",
		"binary.txt":       "needle\x00ignored\n",
		"invalid.txt":      "needle\xff\n",
	} {
		filename := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filename, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Chtimes(filepath.Join(root, "nested/old.ts"), time.Now().Add(-time.Hour), time.Now().Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name    string
		request SearchRequest
		paths   []string
		matches []SearchMatch
	}{
		{name: "glob recursive", request: SearchRequest{Kind: "glob", Pattern: "**/*.ts"}, paths: []string{"new.ts", "nested/old.ts"}},
		{name: "glob basename", request: SearchRequest{Kind: "glob", Pattern: "*.ts"}, paths: []string{"new.ts", "nested/old.ts"}},
		{name: "grep include", request: SearchRequest{Kind: "grep", Pattern: "needle", Include: "*.{txt,md}"}, matches: []SearchMatch{
			{Path: "first.txt", LineNumber: 2, Line: "needle one"},
			{Path: "nested/second.md", LineNumber: 1, Line: "needle two"},
		}},
		{name: "one target", request: SearchRequest{Path: "nested/old.ts", Kind: "glob", Pattern: "*.ts"}, paths: []string{"nested/old.ts"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			test.request.Root = root
			result, _ := directSearchCall(t, backend, test.request)
			if result.Root != root || result.Truncated || !reflect.DeepEqual(result.Paths, test.paths) ||
				!reflect.DeepEqual(result.Matches, test.matches) {
				t.Fatalf("result = %+v, want paths=%v matches=%v", result, test.paths, test.matches)
			}
		})
	}
}

type directSearchDiscardCloser struct{ io.Writer }

func (directSearchDiscardCloser) Close() error { return nil }

func directSearchNoPermissionsStream(t *testing.T) *directSearchDirectoryStream {
	t.Helper()
	var wire bytes.Buffer
	packet := func(id uint32, kind byte, payload []byte) {
		t.Helper()
		var header [9]byte
		binary.BigEndian.PutUint32(header[:4], uint32(1+4+len(payload)))
		header[4] = kind
		binary.BigEndian.PutUint32(header[5:], id)
		wire.Write(header[:])
		wire.Write(payload)
	}
	namePacket := func(names ...string) []byte {
		var payload bytes.Buffer
		var count [4]byte
		binary.BigEndian.PutUint32(count[:], uint32(len(names)))
		payload.Write(count[:])
		for _, name := range names {
			payload.Write(directSearchString(name))
			payload.Write(directSearchString(name))
			payload.Write([]byte{0, 0, 0, 0}) // 合法的空 ATTRS，不提供 permissions 类型。
		}
		return payload.Bytes()
	}
	status := func(code byte) []byte { return []byte{0, 0, 0, code} }
	packet(1, 102, directSearchString("root-handle"))
	packet(2, 104, namePacket("plain.txt", "nested", "escape"))
	packet(3, 101, status(1))
	packet(4, 101, status(0))
	packet(5, 102, directSearchString("nested-handle"))
	packet(6, 104, namePacket("nested.txt"))
	packet(7, 101, status(1))
	packet(8, 101, status(0))
	return &directSearchDirectoryStream{input: directSearchDiscardCloser{io.Discard}, output: &wire}
}

func TestDirectSearchWithoutDirectoryPermissionAttributes(t *testing.T) {
	backend, root := directSearchFixture(t)
	for name, content := range map[string]string{
		"plain.txt":         "needle plain\n",
		"nested/nested.txt": "needle nested\n",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink("plain.txt", filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name      string
		request   SearchRequest
		paths     []string
		matches   []SearchMatch
		truncated bool
	}{
		{name: "glob", request: SearchRequest{Kind: "glob", Pattern: "*.txt"}, paths: []string{"nested/nested.txt", "plain.txt"}},
		{name: "bounded glob", request: SearchRequest{Kind: "glob", Pattern: "*.txt", MaxFiles: 1}, paths: []string{"plain.txt"}, truncated: true},
		{name: "grep", request: SearchRequest{Kind: "grep", Pattern: "needle"}, matches: []SearchMatch{
			{Path: "nested/nested.txt", LineNumber: 1, Line: "needle nested"},
			{Path: "plain.txt", LineNumber: 1, Line: "needle plain"},
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := test.request
			request.Root = root
			stream := directSearchNoPermissionsStream(t)
			result, err := backend.searchWithFiles(context.Background(), request, func(ctx context.Context, root, target string, limit int) ([]discoveredFile, bool, error) {
				return backend.searchFilesWithStream(ctx, root, target, limit, stream)
			})
			if err != nil || result.Truncated != test.truncated ||
				test.truncated && !containsSearchTruncation(result.TruncatedBy, "files") ||
				!reflect.DeepEqual(result.Paths, test.paths) || !reflect.DeepEqual(result.Matches, test.matches) {
				t.Fatalf("search = %+v, err=%v, want paths=%v matches=%v", result, err, test.paths, test.matches)
			}
		})
	}
}

func TestDirectSearchBoundsAndSymlinks(t *testing.T) {
	backend, root := directSearchFixture(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("needle\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "first.txt"), filepath.Join(root, "alias.txt")); err != nil {
		t.Fatal(err)
	}
	for index := range 120 {
		name := fmt.Sprintf("file-%03d.txt", index)
		if err := os.WriteFile(filepath.Join(root, name), []byte("needle\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "first.txt"), []byte("needle\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name   string
		kind   string
		max    SearchRequest
		reason string
	}{
		{name: "files", kind: "glob", max: SearchRequest{MaxFiles: 2}, reason: "files"},
		{name: "results", kind: "grep", max: SearchRequest{MaxResults: 1}, reason: "results"},
		{name: "bytes", kind: "glob", max: SearchRequest{MaxBytes: 800}, reason: "bytes"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := test.max
			request.Root, request.Kind = root, test.kind
			request.Pattern = "*"
			if test.kind == "grep" {
				request.Pattern = "needle"
			}
			result, response := directSearchCall(t, backend, request)
			if !result.Truncated || !containsSearchTruncation(result.TruncatedBy, test.reason) {
				t.Fatalf("bounds result = %+v", result)
			}
			if request.MaxBytes != 0 && int64(len(response.Body)) > request.MaxBytes {
				t.Fatalf("response length = %d > %d", len(response.Body), request.MaxBytes)
			}
			for _, name := range result.Paths {
				if name == "alias.txt" || strings.HasPrefix(name, "escape/") {
					t.Fatalf("followed symlink %q", name)
				}
			}
		})
	}
	result, _ := directSearchCall(t, backend, SearchRequest{Root: root, Kind: "grep", Pattern: "needle", Include: "file-001.txt"})
	if !reflect.DeepEqual(result.Matches, []SearchMatch{{Path: "file-001.txt", LineNumber: 1, Line: "needle"}}) {
		t.Fatalf("include result = %+v", result)
	}
}

type directSearchSwapOnRead struct {
	directSearchFile
	swap func() error
}

func (file *directSearchSwapOnRead) Read(buffer []byte) (int, error) {
	n, err := file.directSearchFile.Read(buffer)
	if n > 0 && file.swap != nil {
		swap := file.swap
		file.swap = nil
		if swapErr := swap(); swapErr != nil {
			return n, swapErr
		}
	}
	return n, err
}

func TestDirectSearchRejectsFileSwapAroundRead(t *testing.T) {
	for _, test := range []struct {
		name       string
		swapOnRead bool
	}{
		{name: "between lstat and open"},
		{name: "during read", swapOnRead: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			backend, root := directSearchFixture(t)
			root = filepath.Join(root, "workspace")
			if err := os.Mkdir(root, 0o700); err != nil {
				t.Fatal(err)
			}
			target := filepath.Join(root, "target.txt")
			outside := filepath.Join(filepath.Dir(root), "secret.txt")
			if err := os.WriteFile(target, []byte("needle inside\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(outside, []byte("needle outside\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			swapped := false
			swap := func() error {
				swapped = true
				if err := os.Remove(target); err != nil {
					return err
				}
				return os.Symlink("../secret.txt", target)
			}
			open := func() (directSearchFile, error) {
				if !test.swapOnRead {
					if err := swap(); err != nil {
						return nil, err
					}
				}
				file, err := backend.sftp.Open(target)
				if err != nil || !test.swapOnRead {
					return file, err
				}
				return &directSearchSwapOnRead{directSearchFile: file, swap: swap}, nil
			}
			response := SearchResponse{Root: root}
			responseBytes := estimatedSearchResponseBytes(response)
			_, _, err := backend.grepSearchFileWithOpen(context.Background(), root,
				discoveredFile{path: target, display: "target.txt"}, regexp.MustCompile("needle"),
				searchCaps{results: 10, response: maxSearchBytes, readBytes: maxSearchReadBytes},
				0, &response, &responseBytes, newSearchTruncation(false), open)
			var failure *agentFailure
			if !swapped || !errors.As(err, &failure) || failure.code != "outside-root" {
				t.Fatalf("swap=%v, err=%v, matches=%+v", swapped, err, response.Matches)
			}
			if !test.swapOnRead && len(response.Matches) != 0 {
				t.Fatalf("published outside-root content: %+v", response.Matches)
			}
		})
	}
}

func TestDirectSearchRejectsInvalidRequests(t *testing.T) {
	backend, root := directSearchFixture(t)
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name    string
		request SearchRequest
		status  int
		code    string
	}{
		{name: "missing root", request: SearchRequest{Kind: "glob", Pattern: "*"}, status: 400, code: "invalid-root"},
		{name: "relative root", request: SearchRequest{Root: "relative", Kind: "glob", Pattern: "*"}, status: 400, code: "invalid-root"},
		{name: "bad kind", request: SearchRequest{Root: root, Kind: "other", Pattern: "*"}, status: 400, code: "invalid-search-kind"},
		{name: "bad glob", request: SearchRequest{Root: root, Kind: "glob", Pattern: "["}, status: 400, code: "invalid-pattern"},
		{name: "bad regex", request: SearchRequest{Root: root, Kind: "grep", Pattern: "["}, status: 400, code: "invalid-pattern"},
		{name: "bad include", request: SearchRequest{Root: root, Kind: "grep", Pattern: ".", Include: "!*.txt"}, status: 400, code: "invalid-include"},
		{name: "negative bound", request: SearchRequest{Root: root, Kind: "glob", Pattern: "*", MaxFiles: -1}, status: 400, code: "invalid-search-limit"},
		{name: "parent escape", request: SearchRequest{Root: root, Path: "../secret", Kind: "glob", Pattern: "*"}, status: 403, code: "outside-root"},
		{name: "symlink escape", request: SearchRequest{Root: root, Path: "escape", Kind: "glob", Pattern: "*"}, status: 403, code: "outside-root"},
	} {
		t.Run(test.name, func(t *testing.T) {
			data, err := json.Marshal(test.request)
			if err != nil {
				t.Fatal(err)
			}
			response, err := backend.Search(context.Background(), data)
			if err != nil {
				t.Fatal(err)
			}
			var payload struct {
				Error AgentError `json:"error"`
			}
			if err := json.Unmarshal(response.Body, &payload); err != nil {
				t.Fatal(err)
			}
			if response.Status != test.status || payload.Error.Code != test.code {
				t.Fatalf("response = %+v, error=%+v", response, payload.Error)
			}
		})
	}
	for _, body := range [][]byte{[]byte(`{"root":"x","unknown":true}`), []byte(`{} {}`)} {
		response, err := backend.Search(context.Background(), body)
		if err != nil || response.Status != http.StatusBadRequest {
			t.Fatalf("malformed JSON response = %+v, %v", response, err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	data, _ := json.Marshal(SearchRequest{Root: root, Kind: "glob", Pattern: "*"})
	response, err := backend.Search(ctx, data)
	if err != nil || response.Status != http.StatusRequestTimeout {
		t.Fatalf("cancelled response = %+v, %v", response, err)
	}
}

func TestDirectSearchLineAndReadBounds(t *testing.T) {
	backend, root := directSearchFixture(t)
	for _, test := range []struct {
		name   string
		value  string
		reason string
	}{
		{name: "long line", value: strings.Repeat("x", maxSearchLine+2) + "needle\n", reason: "line-bytes"},
		{name: "read budget", value: strings.Repeat("short line\n", maxSearchReadBytes/11+2) + "needle\n", reason: "read-bytes"},
	} {
		t.Run(test.name, func(t *testing.T) {
			name := filepath.Join(root, test.name+".txt")
			if err := os.WriteFile(name, []byte(test.value), 0o600); err != nil {
				t.Fatal(err)
			}
			result, _ := directSearchCall(t, backend, SearchRequest{Root: root, Path: name, Kind: "grep", Pattern: "needle"})
			if len(result.Matches) != 0 || !containsSearchTruncation(result.TruncatedBy, test.reason) {
				t.Fatalf("bounded line = %+v", result)
			}
		})
	}
}

func TestDirectSearchPacketBounds(t *testing.T) {
	for _, test := range []struct {
		name string
		size uint32
	}{
		{name: "zero packet", size: 0},
		{name: "oversized packet", size: maxDirectSearchPacket + 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			var wire bytes.Buffer
			var header [5]byte
			binary.BigEndian.PutUint32(header[:4], test.size)
			wire.Write(header[:])
			stream := &directSearchDirectoryStream{output: &wire}
			if _, _, err := stream.read(); err == nil {
				t.Fatal("accepted a malformed SFTP directory packet")
			}
		})
	}
}
