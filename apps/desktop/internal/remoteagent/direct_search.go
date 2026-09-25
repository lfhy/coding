package remoteagent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

const (
	maxDirectSearchPacket     = 1 << 20
	maxDirectSearchPathMemory = 32 << 20
)

// Search 只通过 SFTP 搜索已绑定的远端根目录，不在远端或本机执行搜索命令。
func (backend *directSFTPBackend) Search(ctx context.Context, body []byte) (ProxyResponse, error) {
	if len(body) > maxRequestBytes {
		return directError(fail(http.StatusRequestEntityTooLarge, "request-too-large", "request exceeds the byte limit")), nil
	}
	var request SearchRequest
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return directError(fail(http.StatusBadRequest, "invalid-json", "invalid search request JSON")), nil
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return directError(fail(http.StatusBadRequest, "invalid-json", "request must contain exactly one JSON value")), nil
	}
	result, err := backend.search(ctx, request)
	if err != nil {
		return directError(err), nil
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return directError(err), nil
	}
	return ProxyResponse{Status: http.StatusOK, ContentType: "application/json", Body: append(encoded, '\n')}, nil
}

func (backend *directSFTPBackend) search(ctx context.Context, request SearchRequest) (SearchResponse, error) {
	return backend.searchWithFiles(ctx, request, backend.searchFiles)
}

func (backend *directSFTPBackend) searchWithFiles(ctx context.Context, request SearchRequest, discover func(context.Context, string, string, int) ([]discoveredFile, bool, error)) (SearchResponse, error) {
	if strings.TrimSpace(request.Root) == "" {
		return SearchResponse{}, fail(http.StatusBadRequest, "invalid-root", "search root must be non-empty")
	}
	if request.Kind != "glob" && request.Kind != "grep" {
		return SearchResponse{}, fail(http.StatusBadRequest, "invalid-search-kind", "search kind must be glob or grep")
	}
	if request.Pattern == "" || len(request.Pattern) > maxSearchPatternBytes || strings.ContainsRune(request.Pattern, 0) ||
		(request.Kind == "glob" && strings.TrimSpace(request.Pattern) == "") {
		return SearchResponse{}, fail(http.StatusBadRequest, "invalid-pattern", "search pattern must be non-empty and within the byte limit")
	}
	if request.Kind == "glob" && request.Include != "" {
		return SearchResponse{}, fail(http.StatusBadRequest, "invalid-include", "glob search does not accept include")
	}
	if len(request.Include) > maxSearchPatternBytes || strings.ContainsRune(request.Include, 0) {
		return SearchResponse{}, fail(http.StatusBadRequest, "invalid-include", "include is invalid or exceeds the byte limit")
	}
	if request.Include != "" {
		if err := validateSearchInclude(request.Include); err != nil {
			return SearchResponse{}, err
		}
	}
	caps, err := resolveSearchCaps(request)
	if err != nil {
		return SearchResponse{}, err
	}
	if !path.IsAbs(request.Root) || len(request.Root) > maxRemotePathBytes || strings.ContainsRune(request.Root, 0) {
		return SearchResponse{}, fail(http.StatusBadRequest, "invalid-root", "search root must be an absolute remote path")
	}
	root, err := backend.resolve(ctx, "", request.Root, false)
	if err != nil {
		return SearchResponse{}, err
	}
	rootInfo, err := backend.sftp.Stat(root)
	if err != nil {
		return SearchResponse{}, directRemoteError(err)
	}
	if !rootInfo.IsDir() {
		return SearchResponse{}, fail(http.StatusBadRequest, "not-directory", "search root is not a directory")
	}
	raw := request.Path
	if strings.TrimSpace(raw) == "" {
		raw = root
	} else if err := backend.rejectSearchSymlink(ctx, request.Root, raw); err != nil {
		return SearchResponse{}, err
	}
	if len(raw) > maxRemotePathBytes {
		return SearchResponse{}, fail(http.StatusBadRequest, "invalid-path", "search path exceeds the byte limit")
	}
	target, err := backend.resolve(ctx, request.Root, raw, false)
	if err != nil {
		return SearchResponse{}, err
	}
	var pattern, include *regexp.Regexp
	if request.Kind == "glob" {
		pattern, err = compileSearchGlob(request.Pattern)
	} else {
		pattern, err = regexp.Compile(request.Pattern)
		if err != nil {
			err = fail(http.StatusBadRequest, "invalid-pattern", "grep pattern is not a valid regular expression")
		}
		if err == nil && request.Include != "" {
			include, err = compileSearchGlob(request.Include)
		}
	}
	if err != nil {
		return SearchResponse{}, err
	}
	files, fileLimit, err := discover(ctx, root, target, caps.files)
	if err != nil {
		return SearchResponse{}, err
	}
	reasons := newSearchTruncation(fileLimit)
	response := SearchResponse{Root: root}
	if request.Kind == "glob" {
		sort.Slice(files, func(i, j int) bool {
			if files[i].modTime.Equal(files[j].modTime) {
				return files[i].display < files[j].display
			}
			return files[i].modTime.After(files[j].modTime)
		})
		response.Paths = make([]string, 0, min(len(files), caps.results))
		used := estimatedSearchResponseBytes(response)
		for _, file := range files {
			if err := activeRequest(ctx); err != nil {
				return SearchResponse{}, err
			}
			if !pattern.MatchString(file.display) {
				continue
			}
			if len(response.Paths) >= caps.results {
				reasons.add("results")
				break
			}
			itemBytes := encodedSearchItemBytes(file.display)
			if used+itemBytes > caps.response {
				reasons.add("bytes")
				break
			}
			response.Paths = append(response.Paths, file.display)
			used += itemBytes
		}
	} else {
		sort.Slice(files, func(i, j int) bool { return files[i].display < files[j].display })
		response.Matches = make([]SearchMatch, 0, min(caps.results, 256))
		used := estimatedSearchResponseBytes(response)
		var readBytes int64
		for _, file := range files {
			if err := activeRequest(ctx); err != nil {
				return SearchResponse{}, err
			}
			if include != nil && !include.MatchString(file.display) {
				continue
			}
			stop, consumed, err := backend.grepSearchFile(ctx, root, file, pattern, caps, readBytes, &response, &used, reasons)
			readBytes += consumed
			if err != nil {
				return SearchResponse{}, err
			}
			if stop {
				break
			}
		}
	}
	reasons.finish(&response)
	return boundSearchResponse(response, caps.response)
}

// rejectSearchSymlink 在规范化前检查显式目标的每一层，避免服务端 RealPath
// 在软链接逃逸时只返回笼统的 SFTP failure，亦避免遍历链接目录。
func (backend *directSFTPBackend) rejectSearchSymlink(ctx context.Context, root, raw string) error {
	if strings.HasPrefix(raw, "~") {
		return nil // 后续 resolve 仍执行规范化和根范围检查。
	}
	if !path.IsAbs(raw) {
		raw = path.Join(root, raw)
	}
	cleanRoot, target := path.Clean(root), path.Clean(raw)
	if !directWithin(cleanRoot, target) {
		return fail(http.StatusForbidden, "outside-root", "path is outside the requested root")
	}
	if target == cleanRoot {
		return nil
	}
	relative := strings.TrimPrefix(target, strings.TrimSuffix(cleanRoot, "/")+"/")
	current := cleanRoot
	for _, component := range strings.Split(relative, "/") {
		if err := activeRequest(ctx); err != nil {
			return err
		}
		current = path.Join(current, component)
		if _, err := backend.sftp.ReadLink(current); err == nil {
			return fail(http.StatusForbidden, "outside-root", "search target must not traverse a symlink")
		}
		info, err := backend.sftp.Lstat(current)
		if err != nil {
			return directRemoteError(err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fail(http.StatusForbidden, "outside-root", "search target must not traverse a symlink")
		}
	}
	return nil
}

// searchFiles 每批只保留一个受 packet 上限约束的目录响应，累计扫描项亦受限。
func (backend *directSFTPBackend) searchFiles(ctx context.Context, root, target string, limit int) ([]discoveredFile, bool, error) {
	if err := activeRequest(ctx); err != nil {
		return nil, false, err
	}
	info, err := backend.sftp.Stat(target)
	if err != nil {
		return nil, false, directRemoteError(err)
	}
	if info.Mode().IsRegular() {
		return []discoveredFile{{path: target, display: directSearchDisplay(root, target), modTime: info.ModTime()}}, false, nil
	}
	if !info.IsDir() {
		return nil, false, fail(http.StatusUnprocessableEntity, "not-searchable", "search target is not a regular file or directory")
	}
	stream, err := openDirectSearchDirectoryStream(ctx, backend.ssh)
	if err != nil {
		return nil, false, err
	}
	defer stream.Close()
	return backend.searchFilesWithStream(ctx, root, target, limit, stream)
}

func (backend *directSFTPBackend) searchFilesWithStream(ctx context.Context, root, target string, limit int, stream *directSearchDirectoryStream) ([]discoveredFile, bool, error) {
	files := make([]discoveredFile, 0, min(limit, 256))
	queue := []string{target}
	visited := 0
	retainedPathBytes := len(target)
	for len(queue) > 0 {
		if err := activeRequest(ctx); err != nil {
			return nil, false, err
		}
		directory := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		retainedPathBytes -= len(directory)
		resolved, err := backend.resolve(ctx, root, directory, false)
		if err != nil {
			return nil, false, err
		}
		entryInfo, err := backend.sftp.Lstat(directory)
		if err != nil {
			return nil, false, directRemoteError(err)
		}
		if !entryInfo.IsDir() || resolved != directory {
			continue
		}
		handle, err := stream.open(directory)
		if err != nil {
			return nil, false, err
		}
		for {
			batch, done, err := stream.next(handle)
			if err != nil {
				_ = stream.closeHandle(handle)
				return nil, false, err
			}
			for _, item := range batch {
				if err := activeRequest(ctx); err != nil {
					_ = stream.closeHandle(handle)
					return nil, false, err
				}
				if item.name == "." || item.name == ".." {
					continue
				}
				if item.name == "" || strings.ContainsAny(item.name, "/\x00") || !utf8.ValidString(item.name) || len(item.name) > maxRemotePathBytes {
					_ = stream.closeHandle(handle)
					return nil, false, fail(http.StatusUnprocessableEntity, "invalid-path", "SFTP returned an invalid directory entry")
				}
				visited++
				if visited > maxSearchFiles {
					_ = stream.closeHandle(handle)
					return files, true, nil
				}
				child := path.Join(directory, item.name)
				if len(child) > maxRemotePathBytes || !directWithin(root, child) {
					continue
				}
				if item.kind == 0 {
					// SFTP v3 允许 READDIR 省略 permissions；只检查当前路径，不跟随软链接。
					info, err := backend.sftp.Lstat(child)
					if err != nil {
						_ = stream.closeHandle(handle)
						return nil, false, directRemoteError(err)
					}
					if err := activeRequest(ctx); err != nil {
						_ = stream.closeHandle(handle)
						return nil, false, err
					}
					stat, ok := info.Sys().(*sftp.FileStat)
					if !ok || stat.Mode&0o170000 == 0 {
						_ = stream.closeHandle(handle)
						return nil, false, fail(http.StatusUnprocessableEntity, "missing-file-type", "SFTP LSTAT omitted the file type")
					}
					switch {
					case info.IsDir():
						item.kind = 4
					case info.Mode().IsRegular():
						item.kind = 8
						item.modified = info.ModTime()
					}
				}
				if len(files) >= limit && item.kind == 8 {
					_ = stream.closeHandle(handle)
					return files, true, nil
				}
				switch item.kind {
				case 4: // POSIX S_IFDIR
					if _, skip := searchVCSDirectories[item.name]; !skip {
						if retainedPathBytes+len(child) > maxDirectSearchPathMemory {
							_ = stream.closeHandle(handle)
							return files, true, nil
						}
						queue = append(queue, child)
						retainedPathBytes += len(child)
					}
				case 8: // POSIX S_IFREG
					if retainedPathBytes+2*len(child) > maxDirectSearchPathMemory {
						_ = stream.closeHandle(handle)
						return files, true, nil
					}
					files = append(files, discoveredFile{path: child, display: directSearchDisplay(root, child), modTime: item.modified})
					retainedPathBytes += 2 * len(child)
				}
			}
			if done {
				break
			}
		}
		if err := stream.closeHandle(handle); err != nil {
			return nil, false, err
		}
	}
	return files, false, nil
}

func directSearchDisplay(root, target string) string {
	if root == target {
		return "."
	}
	return strings.TrimPrefix(target, strings.TrimSuffix(root, "/")+"/")
}

type directSearchFile interface {
	io.Reader
	Stat() (os.FileInfo, error)
	Close() error
}

func (backend *directSFTPBackend) grepSearchFile(
	ctx context.Context, root string, file discoveredFile, pattern *regexp.Regexp, caps searchCaps,
	alreadyRead int64, response *SearchResponse, responseBytes *int64, reasons searchTruncation,
) (bool, int64, error) {
	return backend.grepSearchFileWithOpen(ctx, root, file, pattern, caps, alreadyRead, response, responseBytes, reasons,
		func() (directSearchFile, error) { return backend.sftp.Open(file.path) })
}

func (backend *directSFTPBackend) grepSearchFileWithOpen(
	ctx context.Context, root string, file discoveredFile, pattern *regexp.Regexp, caps searchCaps,
	alreadyRead int64, response *SearchResponse, responseBytes *int64, reasons searchTruncation,
	openFile func() (directSearchFile, error),
) (stop bool, consumed int64, err error) {
	if alreadyRead >= caps.readBytes {
		reasons.add("read-bytes")
		return true, 0, nil
	}
	resolved, err := backend.resolve(ctx, root, file.path, false)
	if err != nil {
		return false, 0, err
	}
	info, err := backend.sftp.Lstat(file.path)
	if err != nil {
		if errors.Is(directRemoteError(err), os.ErrNotExist) {
			return false, 0, nil
		}
		return false, 0, directRemoteError(err)
	}
	if !info.Mode().IsRegular() || resolved != file.path {
		return false, 0, nil
	}
	handle, err := openFile()
	if err != nil {
		if errors.Is(directRemoteError(err), os.ErrNotExist) {
			return false, 0, nil
		}
		return false, 0, directRemoteError(err)
	}
	defer handle.Close()
	opened, err := handle.Stat()
	if err != nil {
		return false, 0, directRemoteError(err)
	}
	if !opened.Mode().IsRegular() {
		return false, 0, fail(http.StatusUnprocessableEntity, "not-regular-file", "search target is not a regular file")
	}
	// SFTP 不提供原子根约束；打开句柄后及读完后都复核，拒绝换链期间的结果。
	if err := backend.recheck(ctx, root, file.path, opened); err != nil {
		return false, 0, err
	}
	defer func() {
		if err != nil {
			return
		}
		after, statErr := handle.Stat()
		if statErr != nil {
			err = directRemoteError(statErr)
			return
		}
		if !after.Mode().IsRegular() {
			err = fail(http.StatusConflict, "file-changed", "file changed during search")
			return
		}
		err = backend.recheck(ctx, root, file.path, after)
	}()
	remaining := caps.readBytes - alreadyRead
	reader := &io.LimitedReader{R: handle, N: remaining}
	buffered := bufio.NewReaderSize(reader, maxSearchLine+1)
	lineNumber := 0
	for {
		if err := activeRequest(ctx); err != nil {
			return false, remaining - reader.N, err
		}
		line, readErr := buffered.ReadSlice('\n')
		if len(line) > 0 {
			lineNumber++
		}
		if errors.Is(readErr, bufio.ErrBufferFull) {
			reasons.add("line-bytes")
			return false, remaining - reader.N, nil
		}
		if len(line) > 0 {
			lineText := strings.TrimSuffix(strings.TrimSuffix(string(line), "\n"), "\r")
			if !utf8.ValidString(lineText) || strings.IndexByte(lineText, 0) >= 0 {
				return false, remaining - reader.N, nil
			}
			if pattern.MatchString(lineText) {
				if len(response.Matches) >= caps.results {
					reasons.add("results")
					return true, remaining - reader.N, nil
				}
				match := SearchMatch{Path: file.display, LineNumber: lineNumber, Line: lineText}
				itemBytes := encodedSearchItemBytes(match)
				if *responseBytes+itemBytes > caps.response {
					reasons.add("bytes")
					return true, remaining - reader.N, nil
				}
				response.Matches = append(response.Matches, match)
				*responseBytes += itemBytes
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return false, remaining - reader.N, directRemoteError(readErr)
		}
	}
	if reader.N == 0 && info.Size() > remaining {
		reasons.add("read-bytes")
		return true, remaining, nil
	}
	return false, remaining - reader.N, nil
}

// directSearchDirectoryStream 只使用已认证 SSH 连接的 SFTP subsystem，逐包读取目录。
// pkg/sftp.ReadDirContext 会在返回前缓存完整目录，无法对恶意大目录施加内存上限。
type directSearchDirectoryStream struct {
	session *ssh.Session
	input   io.WriteCloser
	output  io.Reader
	stop    func() bool
	id      uint32
}

func openDirectSearchDirectoryStream(ctx context.Context, client *ssh.Client) (*directSearchDirectoryStream, error) {
	if err := activeRequest(ctx); err != nil {
		return nil, err
	}
	session, err := client.NewSession()
	if err != nil {
		return nil, err
	}
	output, err := session.StdoutPipe()
	if err != nil {
		_ = session.Close()
		return nil, err
	}
	input, err := session.StdinPipe()
	if err != nil {
		_ = session.Close()
		return nil, err
	}
	stream := &directSearchDirectoryStream{session: session, input: input, output: output}
	stream.stop = context.AfterFunc(ctx, func() { _ = session.Close() })
	if err := session.RequestSubsystem("sftp"); err != nil {
		stream.Close()
		return nil, err
	}
	if err := stream.write(1, []byte{0, 0, 0, 3}); err != nil {
		stream.Close()
		return nil, err
	}
	kind, payload, err := stream.read()
	if err != nil || kind != 2 || len(payload) < 4 || binary.BigEndian.Uint32(payload[:4]) != 3 {
		stream.Close()
		return nil, errors.New("remote SFTP server did not negotiate protocol v3")
	}
	return stream, nil
}

func (stream *directSearchDirectoryStream) Close() {
	if stream.stop != nil {
		stream.stop()
	}
	_ = stream.input.Close()
	_ = stream.session.Close()
}

func (stream *directSearchDirectoryStream) write(kind byte, payload []byte) error {
	header := [5]byte{}
	binary.BigEndian.PutUint32(header[:4], uint32(len(payload)+1))
	header[4] = kind
	if _, err := stream.input.Write(header[:]); err != nil {
		return err
	}
	_, err := stream.input.Write(payload)
	return err
}

func (stream *directSearchDirectoryStream) read() (byte, []byte, error) {
	var header [5]byte
	if _, err := io.ReadFull(stream.output, header[:]); err != nil {
		return 0, nil, err
	}
	size := binary.BigEndian.Uint32(header[:4])
	if size < 1 || size > maxDirectSearchPacket {
		return 0, nil, errors.New("SFTP directory response exceeds packet limit")
	}
	data := make([]byte, size-1)
	_, err := io.ReadFull(stream.output, data)
	return header[4], data, err
}

func (stream *directSearchDirectoryStream) call(kind byte, payload []byte) (byte, []byte, error) {
	stream.id++
	var id [4]byte
	binary.BigEndian.PutUint32(id[:], stream.id)
	if err := stream.write(kind, append(id[:], payload...)); err != nil {
		return 0, nil, err
	}
	typeID, result, err := stream.read()
	if err != nil {
		return 0, nil, err
	}
	if len(result) < 4 || binary.BigEndian.Uint32(result[:4]) != stream.id {
		return 0, nil, errors.New("SFTP directory response has unexpected request id")
	}
	return typeID, result[4:], nil
}

func directSearchString(value string) []byte {
	data := make([]byte, 4+len(value))
	binary.BigEndian.PutUint32(data[:4], uint32(len(value)))
	copy(data[4:], value)
	return data
}

func directSearchTake(data *[]byte) ([]byte, error) {
	if len(*data) < 4 {
		return nil, errors.New("SFTP directory response is malformed")
	}
	size := binary.BigEndian.Uint32((*data)[:4])
	*data = (*data)[4:]
	if uint64(size) > uint64(len(*data)) {
		return nil, errors.New("SFTP directory response is malformed")
	}
	value := (*data)[:size]
	*data = (*data)[size:]
	return value, nil
}

func directSearchStatus(data []byte) error {
	if len(data) < 4 {
		return errors.New("SFTP directory status is malformed")
	}
	switch binary.BigEndian.Uint32(data[:4]) {
	case 1:
		return io.EOF
	case 2:
		return os.ErrNotExist
	case 3:
		return os.ErrPermission
	default:
		return fmt.Errorf("SFTP directory operation failed with status %d", binary.BigEndian.Uint32(data[:4]))
	}
}

func (stream *directSearchDirectoryStream) open(directory string) (string, error) {
	kind, data, err := stream.call(11, directSearchString(directory))
	if err != nil {
		return "", err
	}
	if kind == 101 {
		return "", directSearchStatus(data)
	}
	if kind != 102 {
		return "", errors.New("SFTP open-directory response is malformed")
	}
	handle, err := directSearchTake(&data)
	return string(handle), err
}

func (stream *directSearchDirectoryStream) closeHandle(handle string) error {
	kind, data, err := stream.call(4, directSearchString(handle))
	if err != nil {
		return err
	}
	if kind != 101 || len(data) < 4 || binary.BigEndian.Uint32(data[:4]) != 0 {
		return errors.New("SFTP close-directory failed")
	}
	return nil
}

type directSearchEntry struct {
	name     string
	kind     uint32
	modified time.Time
}

func (stream *directSearchDirectoryStream) next(handle string) ([]directSearchEntry, bool, error) {
	kind, data, err := stream.call(12, directSearchString(handle))
	if err != nil {
		return nil, false, err
	}
	if kind == 101 {
		if errors.Is(directSearchStatus(data), io.EOF) {
			return nil, true, nil
		}
		return nil, false, directSearchStatus(data)
	}
	if kind != 104 || len(data) < 4 {
		return nil, false, errors.New("SFTP directory batch is malformed")
	}
	count := binary.BigEndian.Uint32(data[:4])
	data = data[4:]
	if count > uint32(len(data)/12) || count > maxSearchFiles {
		return nil, false, errors.New("SFTP directory batch exceeds item limit")
	}
	entries := make([]directSearchEntry, 0, count)
	for range count {
		name, err := directSearchTake(&data)
		if err != nil {
			return nil, false, err
		}
		if _, err := directSearchTake(&data); err != nil { // longname
			return nil, false, err
		}
		entry, err := directSearchAttributes(&data)
		if err != nil {
			return nil, false, err
		}
		entry.name = string(name)
		entries = append(entries, entry)
	}
	if len(data) != 0 {
		return nil, false, errors.New("SFTP directory batch has trailing bytes")
	}
	return entries, false, nil
}

func directSearchAttributes(data *[]byte) (directSearchEntry, error) {
	if len(*data) < 4 {
		return directSearchEntry{}, errors.New("SFTP directory attributes are malformed")
	}
	flags := binary.BigEndian.Uint32((*data)[:4])
	*data = (*data)[4:]
	if flags & ^uint32(0x8000000f) != 0 {
		return directSearchEntry{}, errors.New("SFTP directory attributes have unknown flags")
	}
	entry := directSearchEntry{}
	for _, field := range []struct {
		mask uint32
		size int
	}{{1, 8}, {2, 8}, {4, 4}, {8, 8}} {
		if flags&field.mask == 0 {
			continue
		}
		if len(*data) < field.size {
			return directSearchEntry{}, errors.New("SFTP directory attributes are malformed")
		}
		if field.mask == 4 {
			entry.kind = (binary.BigEndian.Uint32((*data)[:4]) & 0o170000) >> 12
		}
		if field.mask == 8 {
			entry.modified = time.Unix(int64(binary.BigEndian.Uint32((*data)[4:8])), 0)
		}
		*data = (*data)[field.size:]
	}
	if flags&0x80000000 != 0 {
		if len(*data) < 4 {
			return directSearchEntry{}, errors.New("SFTP directory attributes are malformed")
		}
		count := binary.BigEndian.Uint32((*data)[:4])
		*data = (*data)[4:]
		if count > uint32(len(*data)/8) {
			return directSearchEntry{}, errors.New("SFTP directory attributes are malformed")
		}
		for range count {
			if _, err := directSearchTake(data); err != nil {
				return directSearchEntry{}, err
			}
			if _, err := directSearchTake(data); err != nil {
				return directSearchEntry{}, err
			}
		}
	}
	return entry, nil
}
