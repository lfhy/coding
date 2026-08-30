package remoteagent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

func agentRequest(server *Server, method, path, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+server.token)
	response := httptest.NewRecorder()
	server.routes().ServeHTTP(response, request)
	return response
}

func agentJSONRequest(t *testing.T, server *Server, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return agentRequest(server, http.MethodPost, path, string(encoded))
}

func responseErrorCode(t *testing.T, response *httptest.ResponseRecorder) string {
	t.Helper()
	var envelope struct {
		Error AgentError `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope.Error.Code
}

func TestRoutesRejectWrongMethodAndTrailingJSON(t *testing.T) {
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	if response := agentRequest(server, http.MethodGet, "/v1/shutdown", ""); response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET shutdown status = %d, want %d", response.Code, http.StatusMethodNotAllowed)
	}
	response := agentRequest(server, http.MethodPost, "/v1/resolve", `{"path":"."}{"path":"."}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("trailing JSON status = %d, want %d", response.Code, http.StatusBadRequest)
	}
	response = agentRequest(server, http.MethodPost, "/v1/resolve", `{"path":".","unknown":true}`)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown field status = %d, want %d", response.Code, http.StatusBadRequest)
	}
	bareToken := httptest.NewRequest(http.MethodGet, "/v1/health", nil)
	bareToken.Header.Set("Authorization", server.token)
	bareTokenResponse := httptest.NewRecorder()
	server.routes().ServeHTTP(bareTokenResponse, bareToken)
	if bareTokenResponse.Code != http.StatusUnauthorized {
		t.Fatalf("bare authorization status = %d, want %d", bareTokenResponse.Code, http.StatusUnauthorized)
	}
	emptyPath := agentJSONRequest(t, server, "/v1/resolve", ResolveRequest{Path: ""})
	if emptyPath.Code != http.StatusBadRequest || responseErrorCode(t, emptyPath) != "invalid-path" {
		t.Fatalf("empty path response = %d %s", emptyPath.Code, emptyPath.Body.String())
	}
	for _, removed := range []string{"/v1/node", "/v1/list_files"} {
		if response := agentRequest(server, http.MethodPost, removed, `{}`); response.Code != http.StatusMethodNotAllowed {
			t.Fatalf("removed route %s status = %d", removed, response.Code)
		}
	}
}

func TestResolveCanonicalizesExistingPathsAndAcceptsRoot(t *testing.T) {
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	realRoot := t.TempDir()
	linkRoot := filepath.Join(t.TempDir(), "workspace-link")
	if err := os.Symlink(realRoot, linkRoot); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	response := agentJSONRequest(t, server, "/v1/resolve", ResolveRequest{Path: linkRoot})
	if response.Code != http.StatusOK {
		t.Fatalf("resolve status = %d: %s", response.Code, response.Body.String())
	}
	var resolved ResolveResponse
	if err := json.Unmarshal(response.Body.Bytes(), &resolved); err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(realRoot)
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Path != canonical {
		t.Fatalf("resolved path = %q, want %q", resolved.Path, canonical)
	}
	response = agentJSONRequest(t, server, "/v1/stat", StatRequest{Root: canonical, Path: canonical})
	if response.Code != http.StatusOK {
		t.Fatalf("root-scoped stat status = %d: %s", response.Code, response.Body.String())
	}
}

func TestScopedRoutesRejectSymlinkEscapes(t *testing.T) {
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.bin")
	if err := os.WriteFile(secret, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	read := agentJSONRequest(t, server, "/v1/read_file", ReadRequest{
		Root: root, Path: filepath.Join(link, "secret.bin"),
	})
	if read.Code != http.StatusForbidden || responseErrorCode(t, read) != "outside-root" {
		t.Fatalf("escape read = %d %s", read.Code, read.Body.String())
	}
	created := filepath.Join(outside, "created.txt")
	write := agentJSONRequest(t, server, "/v1/update_file", WriteRequest{
		Root: root, Path: filepath.Join(link, "created.txt"), Content: "blocked",
	})
	if write.Code != http.StatusForbidden || responseErrorCode(t, write) != "outside-root" {
		t.Fatalf("escape write = %d %s", write.Code, write.Body.String())
	}
	if _, err := os.Stat(created); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("escaped write created %q", created)
	}
}

func TestReadBytesRoundTripAndRootlessDirectoryBrowse(t *testing.T) {
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	data := []byte{0x00, 0x01, 0x7f, 0x80, 0xff}
	path := filepath.Join(root, "binary.dat")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	response := agentJSONRequest(t, server, "/v1/read_bytes", ReadRequest{Root: root, Path: path, MaxBytes: 32})
	if response.Code != http.StatusOK {
		t.Fatalf("read bytes status = %d: %s", response.Code, response.Body.String())
	}
	var read ReadBytesResponse
	if err := json.Unmarshal(response.Body.Bytes(), &read); err != nil {
		t.Fatal(err)
	}
	if read.ContentBase64 != base64.StdEncoding.EncodeToString(data) || read.Version == "" {
		t.Fatalf("read bytes = %#v", read)
	}
	browse := agentJSONRequest(t, server, "/v1/directories", ListRequest{Path: root})
	if browse.Code != http.StatusOK {
		t.Fatalf("rootless browse status = %d: %s", browse.Code, browse.Body.String())
	}
	insideLink := filepath.Join(root, "inside-link")
	outsideLink := filepath.Join(root, "outside-link")
	outsideTarget := filepath.Join(t.TempDir(), "outside.txt")
	if err := os.WriteFile(outsideTarget, []byte("outside-secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(path, insideLink); err == nil {
		if err := os.Symlink(outsideTarget, outsideLink); err != nil {
			t.Fatal(err)
		}
		browse = agentJSONRequest(t, server, "/v1/directories", ListRequest{Root: root, Path: root})
		if browse.Code != http.StatusOK {
			t.Fatalf("symlink browse status = %d: %s", browse.Code, browse.Body.String())
		}
		var listing ListResponse
		if err := json.Unmarshal(browse.Body.Bytes(), &listing); err != nil {
			t.Fatal(err)
		}
		canonicalRoot, err := filepath.EvalSymlinks(root)
		if err != nil {
			t.Fatal(err)
		}
		for _, name := range []string{"inside-link", "outside-link"} {
			found := false
			for _, entry := range listing.Entries {
				if entry.Name == name {
					found = true
					if entry.Type != "other" || !pathWithin(canonicalRoot, entry.Path) {
						t.Fatalf("symlink entry = %#v", entry)
					}
				}
			}
			if !found {
				t.Fatalf("missing symlink entry %q", name)
			}
		}
	}
}

func TestReadRejectsOversizedFileBeforeBuffering(t *testing.T) {
	server, err := NewServer(strings.Repeat("a", 32))
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	path := filepath.Join(root, "large.bin")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(maxFileBytes + 1); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	response := agentJSONRequest(t, server, "/v1/read_bytes", ReadRequest{Root: root, Path: path})
	if response.Code != http.StatusRequestEntityTooLarge || responseErrorCode(t, response) != "too-large" {
		t.Fatalf("oversized read = %d %s", response.Code, response.Body.String())
	}
}

func TestAtomicWriteUsesContentVersionAndPreservesMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "document.txt")
	if err := os.WriteFile(path, []byte("first"), 0o640); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	observed, err := version(path, info)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("other"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	_, err = atomicWrite(path, "updated", &WriteExpectation{Kind: "replaceIfVersion", Version: observed})
	var failure *agentFailure
	if !errors.As(err, &failure) || failure.code != "stale-version" {
		t.Fatalf("content-only change error = %#v, want stale-version", err)
	}
	current, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	currentVersion, err := version(path, current)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := atomicWrite(path, "updated", &WriteExpectation{Kind: "replaceIfVersion", Version: currentVersion}); err != nil {
		t.Fatal(err)
	}
	updated, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Mode().Perm() != 0o640 {
		t.Fatalf("mode = %o, want 640", updated.Mode().Perm())
	}
}

func TestAtomicCreateIfAbsentPublishesWithoutReplacement(t *testing.T) {
	path := filepath.Join(t.TempDir(), "created.txt")
	const writers = 16
	start := make(chan struct{})
	results := make(chan error, writers)
	var group sync.WaitGroup
	for index := 0; index < writers; index++ {
		group.Add(1)
		go func(value string) {
			defer group.Done()
			<-start
			_, err := atomicWrite(path, value, &WriteExpectation{Kind: "createIfAbsent"})
			results <- err
		}(string(rune('a' + index)))
	}
	close(start)
	group.Wait()
	close(results)
	succeeded := 0
	for err := range results {
		if err == nil {
			succeeded++
			continue
		}
		var failure *agentFailure
		if !errors.As(err, &failure) || failure.code != "not-observed" {
			t.Fatalf("create race error = %#v", err)
		}
	}
	if succeeded != 1 {
		t.Fatalf("successful creates = %d, want 1", succeeded)
	}
	content, err := os.ReadFile(path)
	if err != nil || len(content) != 1 {
		t.Fatalf("created content = %q, err = %v", content, err)
	}
}

func TestAtomicWriteChecksResponseBudgetAndCancellationBeforePublish(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "large.txt")
	original := strings.Repeat("\t", maxFileBytes)
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := atomicWrite(path, strings.Repeat("\n", maxFileBytes), nil)
	var failure *agentFailure
	if !errors.As(err, &failure) || failure.code != "response-too-large" {
		t.Fatalf("response budget error = %#v", err)
	}
	stored, err := os.ReadFile(path)
	if err != nil || string(stored) != original {
		t.Fatalf("oversized response changed file: len = %d, err = %v", len(stored), err)
	}
	canceledPath := filepath.Join(root, "canceled.txt")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = atomicWriteContext(ctx, canceledPath, "blocked", nil)
	if !errors.As(err, &failure) || failure.code != "request-canceled" {
		t.Fatalf("canceled write error = %#v", err)
	}
	if _, err := os.Stat(canceledPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("canceled write published %q", canceledPath)
	}
}

func TestEditNormalizesMatchingAndRestoresCRLF(t *testing.T) {
	path := filepath.Join(t.TempDir(), "document.txt")
	if err := os.WriteFile(path, []byte("a\r\nOLD\r\nb\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := editFile(context.Background(), path, EditRequest{
		OldString: "OLD\n", NewString: "NEW\r\n", ReplaceAll: false,
	}, func() (string, error) { return path, nil })
	if err != nil {
		t.Fatal(err)
	}
	if result.Before != "a\nOLD\nb\n" || result.After != "a\nNEW\nb\n" {
		t.Fatalf("edit result = %#v", result)
	}
	stored, err := os.ReadFile(path)
	if err != nil || string(stored) != "a\r\nNEW\r\nb\r\n" {
		t.Fatalf("stored edit = %q, err = %v", stored, err)
	}
}

func TestListDirectoryFailsClosedAtItemLimit(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	_, err := listDirectory(root, 2)
	var failure *agentFailure
	if !errors.As(err, &failure) || failure.code != "too-many-entries" {
		t.Fatalf("directory limit error = %#v", err)
	}
}

func TestRemoteBashScrubsAmbientSecretsAndReportsSignalsAndTimeouts(t *testing.T) {
	if _, err := exec.LookPath("bash"); err != nil {
		t.Skip("bash is unavailable")
	}
	t.Setenv("DEEPSEEK_API_KEY", "ambient-key")
	t.Setenv("DSH_REMOTE_BRIDGE_TOKEN", "ambient-token")
	root := t.TempDir()
	result, err := executeCommand(context.Background(), root, ExecRequest{
		Shell:   "bash",
		Command: `printf '%s|%s|%s' "${DEEPSEEK_API_KEY-unset}" "${DSH_REMOTE_BRIDGE_TOKEN-unset}" "$EXPLICIT_TOKEN"`,
		Env:     map[string]string{"EXPLICIT_TOKEN": "allowed"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Stdout != "unset|unset|allowed" || result.ExitCode == nil || *result.ExitCode != 0 {
		t.Fatalf("scrub result = %#v", result)
	}
	if runtime.GOOS != "windows" {
		signaled, err := executeCommand(context.Background(), root, ExecRequest{Shell: "bash", Command: "kill -TERM $$"})
		if err != nil {
			t.Fatal(err)
		}
		if signaled.ExitCode != nil || signaled.Signal != "SIGTERM" {
			t.Fatalf("signal result = %#v", signaled)
		}
	}
	timedOut, err := executeCommand(context.Background(), root, ExecRequest{
		Shell: "bash", Command: "printf before; sleep 5", TimeoutMs: 50,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !timedOut.TimedOut || timedOut.Signal != "SIGKILL" || timedOut.ExitCode != nil || timedOut.Stdout != "before" {
		t.Fatalf("timeout result = %#v", timedOut)
	}
	largeTimeout, err := executeCommand(context.Background(), root, ExecRequest{
		Shell: "bash", Command: "true", TimeoutMs: int(^uint(0) >> 1),
	})
	if err != nil || largeTimeout.TimedOut || largeTimeout.ExitCode == nil || *largeTimeout.ExitCode != 0 {
		t.Fatalf("large timeout result = %#v, err = %v", largeTimeout, err)
	}
}

func TestRemoteBashRequiresBashAndKeepsUTF8Tail(t *testing.T) {
	_, err := executeCommand(context.Background(), t.TempDir(), ExecRequest{Shell: "sh", Command: "true"})
	var failure *agentFailure
	if !errors.As(err, &failure) || failure.code != "unsupported-shell" {
		t.Fatalf("shell error = %#v", err)
	}
	buffer := &limitedBuffer{limit: 5}
	_, _ = buffer.Write([]byte("ab世界"))
	if !buffer.truncated || buffer.String() != "界" {
		t.Fatalf("UTF-8 tail = %q, truncated = %v", buffer.String(), buffer.truncated)
	}
}

func TestRemoteBashReportsMissingBash(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	_, err := executeCommand(context.Background(), t.TempDir(), ExecRequest{Shell: "bash", Command: "true"})
	var failure *agentFailure
	if !errors.As(err, &failure) || failure.code != "shell-unavailable" {
		t.Fatalf("missing bash error = %#v", err)
	}
}
