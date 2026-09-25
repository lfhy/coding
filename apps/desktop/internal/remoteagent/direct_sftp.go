package remoteagent

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// directSFTPBackend 通过已验证的 SSH 连接执行有界文件操作，不启动远端 agent。
type directSFTPBackend struct {
	ssh            *ssh.Client
	sftp           *sftp.Client
	hasHardlink    bool
	hasPosixRename bool
}

func newDirectSFTPBackend(client *ssh.Client) (*directSFTPBackend, error) {
	if client == nil {
		return nil, errors.New("direct SFTP requires an SSH connection")
	}
	files, err := sftp.NewClient(client)
	if err != nil {
		return nil, fmt.Errorf("open remote SFTP subsystem: %w", err)
	}
	_, hardlink := files.HasExtension("hardlink@openssh.com")
	_, posixRename := files.HasExtension("posix-rename@openssh.com")
	return &directSFTPBackend{ssh: client, sftp: files, hasHardlink: hardlink, hasPosixRename: posixRename}, nil
}

func (backend *directSFTPBackend) Close() error { return backend.sftp.Close() }

// Home 只使用现有 SSH 探测命令获取远端用户目录，不在本机猜测路径。
func (backend *directSFTPBackend) Home(ctx context.Context) (string, error) {
	_, home, err := probeRemotePlatform(ctx, backend.ssh, defaultTimeout)
	if err != nil {
		return "", err
	}
	if !path.IsAbs(home) || strings.IndexByte(home, 0) >= 0 {
		return "", errors.New("remote home is not an absolute path")
	}
	return home, nil
}

func (backend *directSFTPBackend) ResolvePath(ctx context.Context, raw string) (ResolveResponse, error) {
	name, err := backend.resolve(ctx, "", raw, false)
	if err != nil {
		return ResolveResponse{}, err
	}
	info, err := backend.info(ctx, name, false)
	if errors.Is(err, os.ErrNotExist) {
		return ResolveResponse{Path: name}, nil
	}
	if err != nil {
		return ResolveResponse{}, err
	}
	return ResolveResponse{Path: name, Info: info}, nil
}

func (backend *directSFTPBackend) ListDirectories(ctx context.Context, raw string) (RemoteDirectory, error) {
	name, err := backend.resolve(ctx, "", raw, false)
	if err != nil {
		return RemoteDirectory{}, err
	}
	entries, err := backend.list(ctx, name, "")
	if err != nil {
		return RemoteDirectory{}, err
	}
	return RemoteDirectory{Path: name, Entries: entries}, nil
}

// Proxy 对受 bridge 绑定的 root 再执行路径约束；其他 agent 路由不可用。
func (backend *directSFTPBackend) Proxy(ctx context.Context, method, route string, body []byte) (ProxyResponse, error) {
	if method != http.MethodPost || (route != "/v1/resolve" && route != "/v1/stat" && route != "/v1/directories" && route != "/v1/read_file" && route != "/v1/read_bytes" && route != "/v1/update_file" && route != "/v1/edit_file") {
		return ProxyResponse{}, errors.New("unsupported direct SFTP route")
	}
	if len(body) > maxRequestBytes {
		return ProxyResponse{}, errors.New("direct SFTP request exceeds byte limit")
	}
	request := ReadRequest{}
	var target any
	switch route {
	case "/v1/resolve":
		target = &ResolveRequest{}
	case "/v1/stat":
		target = &StatRequest{}
	case "/v1/directories":
		target = &ListRequest{}
	case "/v1/update_file":
		target = &WriteRequest{}
	case "/v1/edit_file":
		target = &EditRequest{}
	default:
		target = &request
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return directError(fail(http.StatusBadRequest, "invalid-json", err.Error())), nil
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return directError(fail(http.StatusBadRequest, "invalid-json", "request must contain exactly one JSON value")), nil
	}
	noFollow := false
	switch value := target.(type) {
	case *ResolveRequest:
		request.Root, request.Path = value.Root, value.Path
	case *StatRequest:
		request.Root, request.Path, noFollow = value.Root, value.Path, value.NoFollow
	case *ListRequest:
		request.Root, request.Path = value.Root, value.Path
	case *WriteRequest:
		request.Root, request.Path = value.Root, value.Path
	case *EditRequest:
		request.Root, request.Path = value.Root, value.Path
	}
	if !path.IsAbs(request.Root) || strings.IndexByte(request.Root, 0) >= 0 {
		return directError(fail(http.StatusBadRequest, "invalid-path", "root must be an absolute path")), nil
	}
	name, err := backend.resolve(ctx, request.Root, request.Path, noFollow || route == "/v1/update_file" || route == "/v1/edit_file")
	if err != nil {
		return directError(err), nil
	}
	var result any
	switch route {
	case "/v1/resolve", "/v1/stat":
		info, infoErr := backend.info(ctx, name, noFollow)
		if infoErr != nil && !errors.Is(infoErr, os.ErrNotExist) {
			return directError(infoErr), nil
		}
		if info != nil && info.Type == "file" && info.Size != nil && *info.Size <= maxFileBytes {
			// 绑定根目录的文件观察会被工具用于条件写入；目录列举仍只读取元数据。
			opened, statErr := backend.sftp.Stat(name)
			if statErr != nil {
				return directError(statErr), nil
			}
			info.Version, infoErr = backend.strongVersion(ctx, request.Root, name, opened)
			if infoErr != nil {
				return directError(infoErr), nil
			}
		}
		if route == "/v1/resolve" {
			result = ResolveResponse{Path: name, Info: info}
		} else {
			result = StatResponse{Info: info}
		}
	case "/v1/directories":
		canonicalRoot, rootErr := backend.canonical(ctx, path.Clean(request.Root))
		if rootErr != nil {
			return directError(rootErr), nil
		}
		entries, listErr := backend.list(ctx, name, canonicalRoot)
		if listErr != nil {
			return directError(listErr), nil
		}
		result = ListResponse{Path: name, Entries: entries}
	case "/v1/read_file", "/v1/read_bytes":
		limit := request.MaxBytes
		if limit <= 0 || limit > maxFileBytes {
			limit = maxFileBytes
		}
		data, info, readErr := backend.read(ctx, request.Root, name, limit)
		if readErr != nil {
			return directError(readErr), nil
		}
		v, versionErr := directSFTPStrongVersion(name, info, data)
		if versionErr != nil {
			return directError(versionErr), nil
		}
		if route == "/v1/read_file" {
			if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
				return directError(fail(http.StatusUnprocessableEntity, "not-text", "file is not valid UTF-8 text")), nil
			}
			result = ReadResponse{Path: name, Content: string(data), Version: v}
		} else {
			result = ReadBytesResponse{Path: name, ContentBase64: base64.StdEncoding.EncodeToString(data), Version: v}
		}
	case "/v1/update_file":
		result, err = backend.update(ctx, request.Root, name, *target.(*WriteRequest))
	case "/v1/edit_file":
		result, err = backend.edit(ctx, request.Root, name, *target.(*EditRequest))
	}
	if err != nil {
		return directError(err), nil
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return directError(err), nil
	}
	if len(encoded)+1 > maxResponseBytes {
		return directError(fail(http.StatusRequestEntityTooLarge, "response-too-large", "response exceeds the byte limit")), nil
	}
	return ProxyResponse{Status: http.StatusOK, ContentType: "application/json", Body: append(encoded, '\n')}, nil
}

func directError(err error) ProxyResponse {
	err = directRemoteError(err)
	status, code, message := http.StatusInternalServerError, "io-error", err.Error()
	var failure *agentFailure
	switch {
	case errors.As(err, &failure):
		status, code, message = failure.status, failure.code, failure.message
	case errors.Is(err, os.ErrNotExist):
		status, code = http.StatusNotFound, "not-found"
	case errors.Is(err, os.ErrPermission):
		status, code = http.StatusForbidden, "permission-denied"
	}
	var remoteStatus *sftp.StatusError
	if errors.As(err, &remoteStatus) {
		message = "remote SFTP operation failed"
	}
	data, _ := json.Marshal(struct {
		Error AgentError `json:"error"`
	}{Error: AgentError{Code: code, Message: message}})
	return ProxyResponse{Status: status, ContentType: "application/json", Body: append(data, '\n')}
}

func directRemoteError(err error) error {
	var status *sftp.StatusError
	if errors.As(err, &status) {
		switch status.FxCode() {
		case sftp.ErrSSHFxNoSuchFile:
			return os.ErrNotExist
		case sftp.ErrSSHFxPermissionDenied:
			return os.ErrPermission
		}
	}
	return err
}

func (backend *directSFTPBackend) check(ctx context.Context) error { return activeRequest(ctx) }

func (backend *directSFTPBackend) canonical(ctx context.Context, name string) (string, error) {
	missing := make([]string, 0, 4)
	for {
		if err := backend.check(ctx); err != nil {
			return "", err
		}
		_, err := backend.sftp.Lstat(name)
		err = directRemoteError(err)
		if err == nil {
			resolved, err := backend.sftp.RealPath(name)
			if err != nil {
				return "", directRemoteError(err)
			}
			if !path.IsAbs(resolved) {
				return "", fail(http.StatusForbidden, "outside-root", "SFTP returned a non-absolute path")
			}
			for i := len(missing) - 1; i >= 0; i-- {
				resolved = path.Join(resolved, missing[i])
			}
			return path.Clean(resolved), nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := path.Dir(name)
		if parent == name {
			return "", err
		}
		missing = append(missing, path.Base(name))
		name = parent
	}
}

func (backend *directSFTPBackend) resolve(ctx context.Context, root, raw string, noFollow bool) (string, error) {
	if err := backend.check(ctx); err != nil {
		return "", err
	}
	value := strings.TrimSpace(raw)
	if value == "" || strings.IndexByte(value, 0) >= 0 {
		return "", fail(http.StatusBadRequest, "invalid-path", "path must be non-empty")
	}
	if strings.HasPrefix(value, "~") {
		home, err := backend.Home(ctx)
		if err != nil {
			return "", err
		}
		if value == "~" {
			value = home
		} else if strings.HasPrefix(value, "~/") {
			value = path.Join(home, value[2:])
		}
	}
	var canonicalRoot string
	if root != "" {
		var err error
		canonicalRoot, err = backend.canonical(ctx, path.Clean(root))
		if err != nil {
			return "", err
		}
		info, err := backend.sftp.Stat(canonicalRoot)
		if err != nil {
			return "", err
		}
		if !info.IsDir() {
			return "", fail(http.StatusBadRequest, "not-directory", "root is not a directory")
		}
	}
	if root != "" && path.IsAbs(value) && !directWithin(path.Clean(root), path.Clean(value)) {
		return "", fail(http.StatusForbidden, "outside-root", "path is outside the requested root")
	}
	if !path.IsAbs(value) {
		if root == "" {
			home, err := backend.Home(ctx)
			if err != nil {
				return "", err
			}
			value = path.Join(home, value)
		} else {
			value = path.Join(root, value)
		}
	}
	if root != "" && !directWithin(path.Clean(root), path.Clean(value)) {
		return "", fail(http.StatusForbidden, "outside-root", "path is outside the requested root")
	}
	name := path.Clean(value)
	var err error
	if noFollow && name != path.Clean(root) {
		parent, parentErr := backend.canonical(ctx, path.Dir(name))
		if parentErr != nil {
			return "", parentErr
		}
		name = path.Join(parent, path.Base(name))
	} else {
		name, err = backend.canonical(ctx, name)
		if err != nil {
			return "", err
		}
	}
	if root != "" && !directWithin(canonicalRoot, name) {
		return "", fail(http.StatusForbidden, "outside-root", "path is outside the requested root")
	}
	return name, nil
}

func directWithin(root, candidate string) bool {
	return candidate == root || strings.HasPrefix(candidate, strings.TrimSuffix(root, "/")+"/")
}

func (backend *directSFTPBackend) info(ctx context.Context, name string, noFollow bool) (*PathInfo, error) {
	if err := backend.check(ctx); err != nil {
		return nil, err
	}
	var info os.FileInfo
	var err error
	if noFollow {
		info, err = backend.sftp.Lstat(name)
	} else {
		info, err = backend.sftp.Stat(name)
	}
	if err != nil {
		return nil, directRemoteError(err)
	}
	item := &PathInfo{Path: name, Type: directType(info)}
	if info.Mode().IsRegular() {
		size := info.Size()
		item.Size = &size
	}
	item.Version, err = directSFTPMetadataVersion(name, info)
	return item, err
}

// SFTP v3 不提供 inode 或亚秒时间戳。元数据令牌只能展示，不能用于条件写入。
func directSFTPMetadataVersion(name string, info os.FileInfo) (string, error) {
	v, err := version(name, info)
	if err != nil {
		return "", err
	}
	return "sftp-meta:" + v, nil
}

// 可写文件的条件版本绑定完整内容，避免等长、同秒替换复用元数据令牌。
func directSFTPStrongVersion(name string, info os.FileInfo, content []byte) (string, error) {
	metadata, err := directSFTPMetadataVersion(name, info)
	if err != nil {
		return "", err
	}
	digest := sha256.New()
	_, _ = digest.Write([]byte(metadata))
	_, _ = digest.Write(content)
	return "sftp-sha256:" + hex.EncodeToString(digest.Sum(nil)), nil
}

func (backend *directSFTPBackend) strongVersion(ctx context.Context, root, name string, info os.FileInfo) (string, error) {
	if info.Size() > maxFileBytes {
		return "", fail(http.StatusConflict, "version-unavailable", "read_file cannot provide a version for a file above the writable byte limit")
	}
	data, opened, err := backend.read(ctx, root, name, maxFileBytes)
	if err != nil {
		return "", err
	}
	if opened.Size() != info.Size() || !opened.ModTime().Equal(info.ModTime()) || opened.Mode() != info.Mode() {
		return "", fail(http.StatusConflict, "stale-version", "file changed since it was read")
	}
	return directSFTPStrongVersion(name, opened, data)
}

func directSFTPRequireStrongVersion(value string) error {
	if !strings.HasPrefix(value, "sftp-sha256:") || len(value) != len("sftp-sha256:")+sha256.Size*2 {
		return fail(http.StatusConflict, "version-unavailable", "read_file or read_bytes to obtain a guarded SFTP version")
	}
	return nil
}

func directType(info os.FileInfo) string {
	if info.IsDir() {
		return "directory"
	}
	if info.Mode().IsRegular() {
		return "file"
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "symlink"
	}
	return "other"
}

func (backend *directSFTPBackend) list(ctx context.Context, name, root string) ([]DirectoryEntry, error) {
	if err := backend.check(ctx); err != nil {
		return nil, err
	}
	info, err := backend.sftp.Stat(name)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fail(http.StatusBadRequest, "not-directory", "path is not a directory")
	}
	stream, err := openDirectSearchDirectoryStream(ctx, backend.ssh)
	if err != nil {
		return nil, err
	}
	defer stream.Close()
	handle, err := stream.open(name)
	if err != nil {
		return nil, err
	}
	defer func() { _ = stream.closeHandle(handle) }()
	entries := make([]DirectoryEntry, 0, 128)
	responseBytes := len(name) + 64
	for {
		batch, done, err := stream.next(handle)
		if err != nil {
			return nil, err
		}
		for _, entry := range batch {
			if err := backend.check(ctx); err != nil {
				return nil, err
			}
			if entry.name == "." || entry.name == ".." {
				continue
			}
			if entry.name == "" || strings.ContainsAny(entry.name, "/\x00") || !utf8.ValidString(entry.name) {
				return nil, fail(http.StatusUnprocessableEntity, "invalid-path", "SFTP returned an invalid directory entry")
			}
			if len(entries) >= maxDirectoryItems {
				return nil, fail(http.StatusRequestEntityTooLarge, "too-many-entries", "directory exceeds the item limit")
			}
			child := path.Join(name, entry.name)
			if len(child) > maxRemotePathBytes || root != "" && !directWithin(root, child) {
				return nil, fail(http.StatusForbidden, "outside-root", "path is outside the requested root")
			}
			// 符号链接不跟随；读取目标时另行解析并验证根范围。
			item, err := backend.sftp.Lstat(child)
			if err != nil {
				return nil, directRemoteError(err)
			}
			v, err := directSFTPMetadataVersion(child, item)
			if err != nil {
				return nil, err
			}
			row := DirectoryEntry{Name: entry.name, Path: child, Type: directType(item), Version: v}
			if item.Mode().IsRegular() {
				size := item.Size()
				row.Size = &size
			}
			encoded, err := json.Marshal(row)
			if err != nil {
				return nil, err
			}
			responseBytes += len(encoded) + 1
			if responseBytes > maxResponseBytes {
				return nil, fail(http.StatusRequestEntityTooLarge, "response-too-large", "directory response exceeds the byte limit")
			}
			entries = append(entries, row)
		}
		if done {
			break
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	if err := ensureResponseFits(ListResponse{Path: name, Entries: entries}); err != nil {
		return nil, err
	}
	return entries, nil
}

func (backend *directSFTPBackend) read(ctx context.Context, root, name string, limit int64) ([]byte, os.FileInfo, error) {
	if err := backend.check(ctx); err != nil {
		return nil, nil, err
	}
	file, err := backend.sftp.Open(name)
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
	// SFTP 没有 openat2 语义；读取前后都复核路径，若远端在检查期间换链则拒绝结果。
	if err := backend.recheck(ctx, root, name, info); err != nil {
		return nil, nil, err
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
	if int64(len(data)) != after.Size() {
		return nil, nil, fail(http.StatusConflict, "file-changed", "file changed during read")
	}
	if err := backend.recheck(ctx, root, name, after); err != nil {
		return nil, nil, err
	}
	return data, after, nil
}

func (backend *directSFTPBackend) recheck(ctx context.Context, root, name string, opened os.FileInfo) error {
	canonical, err := backend.canonical(ctx, name)
	if err != nil {
		return err
	}
	rootPath, err := backend.canonical(ctx, path.Clean(root))
	if err != nil {
		return err
	}
	if canonical != name || !directWithin(rootPath, canonical) {
		return fail(http.StatusForbidden, "outside-root", "file path changed outside the requested root")
	}
	current, err := backend.sftp.Stat(name)
	if err != nil {
		return err
	}
	if !current.Mode().IsRegular() || current.Size() != opened.Size() || !current.ModTime().Equal(opened.ModTime()) {
		return fail(http.StatusConflict, "file-changed", "file changed during read")
	}
	return nil
}

// update 保留 agent 的观察结果与版本冲突语义；SFTP 不提供原子的版本 CAS。
func (backend *directSFTPBackend) update(ctx context.Context, root, name string, request WriteRequest) (WriteResponse, error) {
	if int64(len(request.Content)) > maxFileBytes {
		return WriteResponse{}, fail(http.StatusRequestEntityTooLarge, "too-large", "content exceeds the writable byte limit")
	}
	if !utf8.ValidString(request.Content) || strings.IndexByte(request.Content, 0) >= 0 {
		return WriteResponse{}, fail(http.StatusUnprocessableEntity, "not-text", "content must be valid UTF-8 text")
	}
	if len(name) > maxRemotePathBytes || len(root) > maxRemotePathBytes {
		return WriteResponse{}, fail(http.StatusBadRequest, "invalid-path", "path exceeds the byte limit")
	}
	info, err := backend.sftp.Lstat(name)
	err = directRemoteError(err)
	exists := err == nil
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return WriteResponse{}, err
	}
	if exists && !info.Mode().IsRegular() {
		return WriteResponse{}, fail(http.StatusUnprocessableEntity, "not-regular-file", "target is not a regular file")
	}
	createIfAbsent := false
	if request.Expected != nil {
		switch request.Expected.Kind {
		case "createIfAbsent":
			createIfAbsent = true
			if exists {
				return WriteResponse{}, fail(http.StatusConflict, "not-observed", "file already exists")
			}
		case "replaceIfVersion":
			if !exists {
				return WriteResponse{}, fail(http.StatusConflict, "stale-version", "file no longer exists")
			}
			if err := directSFTPRequireStrongVersion(request.Expected.Version); err != nil {
				return WriteResponse{}, err
			}
			currentVersion, err := backend.strongVersion(ctx, root, name, info)
			if err != nil {
				return WriteResponse{}, err
			}
			if currentVersion != request.Expected.Version {
				return WriteResponse{}, fail(http.StatusConflict, "stale-version", "file changed since it was read")
			}
		default:
			return WriteResponse{}, fail(http.StatusBadRequest, "invalid-write-expectation", "unsupported write expectation")
		}
	}
	if createIfAbsent && !backend.hasHardlink {
		return WriteResponse{}, fail(http.StatusNotImplemented, "sftp-hardlink-unsupported", "atomic create is not supported by this SFTP server")
	}
	if !createIfAbsent && !backend.hasPosixRename {
		return WriteResponse{}, fail(http.StatusNotImplemented, "sftp-posix-rename-unsupported", "atomic replacement is not supported by this SFTP server")
	}
	var before *string
	if exists && info.Size() <= maxFileBytes {
		old, opened, readErr := backend.read(ctx, root, name, maxFileBytes)
		if readErr == nil {
			if opened.Size() != info.Size() || !opened.ModTime().Equal(info.ModTime()) || opened.Mode() != info.Mode() {
				return WriteResponse{}, fail(http.StatusConflict, "stale-version", "file changed since it was read")
			}
			if utf8.Valid(old) && bytes.IndexByte(old, 0) < 0 {
				value := normalizeLineEndings(string(old))
				before = &value
			}
		} else {
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
	after := normalizeLineEndings(request.Content)
	if err := ensureResponseFits(WriteResponse{Operation: operation, Version: "sftp-sha256:" + strings.Repeat("0", sha256.Size*2), Before: before, After: after}); err != nil {
		return WriteResponse{}, err
	}
	mode := os.FileMode(0o600)
	if exists {
		mode = info.Mode().Perm()
	}
	if err := backend.publish(ctx, root, name, []byte(request.Content), mode, request.Expected, createIfAbsent); err != nil {
		return WriteResponse{}, err
	}
	committed, err := backend.sftp.Stat(name)
	if err != nil {
		return WriteResponse{}, directCommitUnknown()
	}
	v, err := backend.strongVersion(ctx, root, name, committed)
	if err != nil {
		return WriteResponse{}, directCommitUnknown()
	}
	return WriteResponse{Operation: operation, Version: v, Before: before, After: after}, nil
}

func (backend *directSFTPBackend) edit(ctx context.Context, root, name string, request EditRequest) (EditResponse, error) {
	info, err := backend.sftp.Lstat(name)
	if err != nil {
		return EditResponse{}, directRemoteError(err)
	}
	if !info.Mode().IsRegular() {
		return EditResponse{}, fail(http.StatusUnprocessableEntity, "not-regular-file", "target is not a regular file")
	}
	data, opened, err := backend.read(ctx, root, name, maxFileBytes)
	if err != nil {
		return EditResponse{}, err
	}
	if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
		return EditResponse{}, fail(http.StatusUnprocessableEntity, "not-text", "file is not valid UTF-8 text")
	}
	if !utf8.ValidString(request.OldString) || !utf8.ValidString(request.NewString) || strings.IndexByte(request.OldString, 0) >= 0 || strings.IndexByte(request.NewString, 0) >= 0 {
		return EditResponse{}, fail(http.StatusUnprocessableEntity, "not-text", "edit must contain valid UTF-8 text")
	}
	v, err := directSFTPStrongVersion(name, opened, data)
	if err != nil {
		return EditResponse{}, err
	}
	if request.Expected != nil {
		if request.Expected.Kind != "replaceIfVersion" {
			return EditResponse{}, fail(http.StatusBadRequest, "invalid-write-expectation", "unsupported edit expectation")
		}
		if err := directSFTPRequireStrongVersion(request.Expected.Version); err != nil {
			return EditResponse{}, err
		}
		if request.Expected.Version != v {
			return EditResponse{}, fail(http.StatusConflict, "stale-version", "file changed since it was read")
		}
	}
	lineEndings := detectLineEndings(string(data))
	before := normalizeLineEndings(string(data))
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
	after := strings.Replace(before, oldString, newString, 1)
	if request.ReplaceAll {
		after = strings.ReplaceAll(before, oldString, newString)
	}
	storedAfter := restoreLineEndings(after, lineEndings)
	if int64(len(storedAfter)) > maxFileBytes {
		return EditResponse{}, fail(http.StatusRequestEntityTooLarge, "too-large", "edited file exceeds the byte limit")
	}
	if err := ensureResponseFits(EditResponse{Version: "sftp-sha256:" + strings.Repeat("0", sha256.Size*2), Before: before, After: after}); err != nil {
		return EditResponse{}, err
	}
	write, err := backend.update(ctx, root, name, WriteRequest{Root: root, Path: name, Content: storedAfter, Expected: &WriteExpectation{Kind: "replaceIfVersion", Version: v}})
	if err != nil {
		return EditResponse{}, err
	}
	return EditResponse{Version: write.Version, Before: before, After: after}, nil
}

func directCommitUnknown() error {
	return fail(http.StatusServiceUnavailable, "commit-unknown", "remote file may have changed; read its current version before retrying")
}

// publish 的提交请求同步执行；其结果不明时不推断提交失败。
func (backend *directSFTPBackend) publish(ctx context.Context, root, name string, content []byte, mode os.FileMode, expected *WriteExpectation, createIfAbsent bool) (result error) {
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	temporary := path.Join(path.Dir(name), ".coding-agent-write-"+hex.EncodeToString(random[:]))
	if err := backend.check(ctx); err != nil {
		return err
	}
	file, err := backend.sftp.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY)
	if err != nil {
		return directRemoteError(err)
	}
	defer func() {
		if cleanupErr := backend.sftp.Remove(temporary); cleanupErr != nil && !errors.Is(directRemoteError(cleanupErr), os.ErrNotExist) && result == nil {
			result = directCommitUnknown()
		}
	}()
	if err := file.Chmod(mode); err != nil {
		_ = file.Close()
		return directRemoteError(err)
	}
	written, writeErr := file.Write(content)
	closeErr := file.Close()
	if writeErr != nil {
		return directRemoteError(writeErr)
	}
	if written != len(content) {
		return io.ErrShortWrite
	}
	if closeErr != nil {
		return directRemoteError(closeErr)
	}
	if err := backend.check(ctx); err != nil {
		return err
	}
	// 临时文件及目标父目录必须仍在同一已验证根内；提交后不重试。
	resolved, err := backend.resolve(ctx, root, name, true)
	if err != nil {
		return err
	}
	if resolved != name {
		return fail(http.StatusConflict, "stale-version", "file path changed since it was read")
	}
	canonicalTemp, err := backend.canonical(ctx, temporary)
	if err != nil {
		return err
	}
	if canonicalTemp != temporary {
		return fail(http.StatusForbidden, "outside-root", "temporary file path changed")
	}
	current, err := backend.sftp.Lstat(name)
	err = directRemoteError(err)
	if createIfAbsent {
		if err == nil {
			return fail(http.StatusConflict, "not-observed", "file already exists")
		}
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	} else {
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err == nil && !current.Mode().IsRegular() {
			return fail(http.StatusUnprocessableEntity, "not-regular-file", "target is not a regular file")
		}
		if expected != nil && expected.Kind == "replaceIfVersion" {
			if errors.Is(err, os.ErrNotExist) {
				return fail(http.StatusConflict, "stale-version", "file no longer exists")
			}
			if err := directSFTPRequireStrongVersion(expected.Version); err != nil {
				return err
			}
			v, versionErr := backend.strongVersion(ctx, root, name, current)
			if versionErr != nil {
				return versionErr
			}
			if v != expected.Version {
				return fail(http.StatusConflict, "stale-version", "file changed since it was read")
			}
		}
	}
	if err := backend.check(ctx); err != nil {
		return err
	}
	if createIfAbsent {
		err = backend.sftp.Link(temporary, name)
	} else {
		err = backend.sftp.PosixRename(temporary, name)
	}
	if err != nil {
		return directCommitUnknown()
	}
	return nil
}
