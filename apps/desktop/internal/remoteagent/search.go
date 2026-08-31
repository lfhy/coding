package remoteagent

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const maxSearchPatternBytes = 4 << 10

var searchVCSDirectories = map[string]struct{}{
	".git": {}, ".svn": {}, ".hg": {}, ".bzr": {}, ".jj": {}, ".sl": {},
}

type searchCaps struct {
	results   int
	response  int64
	files     int
	readBytes int64
}

type discoveredFile struct {
	path    string
	display string
	modTime time.Time
}

// searchWorkspace 在受根目录保护的文件树内执行一项无 shell 搜索。
func searchWorkspace(ctx context.Context, request SearchRequest) (SearchResponse, error) {
	if strings.TrimSpace(request.Root) == "" {
		return SearchResponse{}, fail(http.StatusBadRequest, "invalid-root", "search root must be non-empty")
	}
	if request.Kind != "glob" && request.Kind != "grep" {
		return SearchResponse{}, fail(http.StatusBadRequest, "invalid-search-kind", "search kind must be glob or grep")
	}
	if len(request.Pattern) > maxSearchPatternBytes || request.Pattern == "" ||
		(request.Kind == "glob" && strings.TrimSpace(request.Pattern) == "") {
		return SearchResponse{}, fail(http.StatusBadRequest, "invalid-pattern", "search pattern must be non-empty and within the byte limit")
	}
	if strings.ContainsRune(request.Pattern, '\x00') {
		return SearchResponse{}, fail(http.StatusBadRequest, "invalid-pattern", "search pattern must not contain NUL")
	}
	if request.Kind == "glob" && request.Include != "" {
		return SearchResponse{}, fail(http.StatusBadRequest, "invalid-include", "glob search does not accept include")
	}
	if len(request.Include) > maxSearchPatternBytes || strings.ContainsRune(request.Include, '\x00') {
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
	root, err := resolveScopedPath("", request.Root, false)
	if err != nil {
		return SearchResponse{}, err
	}
	rootInfo, err := os.Stat(root)
	if err != nil {
		return SearchResponse{}, err
	}
	if !rootInfo.IsDir() {
		return SearchResponse{}, fail(http.StatusBadRequest, "not-directory", "search root is not a directory")
	}
	rawPath := request.Path
	if strings.TrimSpace(rawPath) == "" {
		rawPath = root
	}
	target, err := resolveScopedPath(root, rawPath, false)
	if err != nil {
		return SearchResponse{}, err
	}
	if err := activeRequest(ctx); err != nil {
		return SearchResponse{}, err
	}

	var include *regexp.Regexp
	if request.Include != "" {
		include, err = compileSearchGlob(request.Include)
		if err != nil {
			return SearchResponse{}, err
		}
	}
	if request.Kind == "grep" {
		pattern, compileErr := regexp.Compile(request.Pattern)
		if compileErr != nil {
			return SearchResponse{}, fail(http.StatusBadRequest, "invalid-pattern", "grep pattern is not a valid regular expression")
		}
		return grepWorkspace(ctx, root, target, pattern, include, caps)
	}
	pattern, err := compileSearchGlob(request.Pattern)
	if err != nil {
		return SearchResponse{}, err
	}
	return globWorkspace(ctx, root, target, pattern, caps)
}

func resolveSearchCaps(request SearchRequest) (searchCaps, error) {
	if request.MaxResults < 0 || request.MaxBytes < 0 || request.MaxFiles < 0 {
		return searchCaps{}, fail(http.StatusBadRequest, "invalid-search-limit", "search limits must not be negative")
	}
	caps := searchCaps{
		results: maxSearchResults, response: maxSearchBytes, files: maxSearchFiles, readBytes: maxSearchReadBytes,
	}
	if request.MaxResults > 0 && request.MaxResults < caps.results {
		caps.results = request.MaxResults
	}
	if request.MaxBytes > 0 && request.MaxBytes < caps.response {
		caps.response = request.MaxBytes
	}
	if request.MaxFiles > 0 && request.MaxFiles < caps.files {
		caps.files = request.MaxFiles
	}
	return caps, nil
}

func validateSearchInclude(include string) error {
	if strings.TrimSpace(include) == "" || strings.HasPrefix(include, "!") {
		return fail(http.StatusBadRequest, "invalid-include", "include must be one positive non-empty glob")
	}
	depth := 0
	for _, character := range include {
		switch character {
		case '{':
			depth++
		case '}':
			if depth > 0 {
				depth--
			}
		case ',':
			if depth == 0 {
				return fail(http.StatusBadRequest, "invalid-include", "include must be one glob, not a comma-separated list")
			}
		}
	}
	return nil
}

// compileSearchGlob 支持双星、星号、问号、字符类和花括号 alternation。不含路径
// 分隔符的模式匹配任意深度 basename，其余模式匹配远端根目录相对路径。
func compileSearchGlob(pattern string) (*regexp.Regexp, error) {
	pattern = strings.ReplaceAll(pattern, "\\", "/")
	if pattern == "" || strings.HasPrefix(pattern, "/") {
		return nil, fail(http.StatusBadRequest, "invalid-pattern", "glob pattern is invalid")
	}
	translated, index, err := translateSearchGlob(pattern, 0, 0)
	if err != nil || index != len(pattern) {
		return nil, fail(http.StatusBadRequest, "invalid-pattern", "glob pattern is invalid")
	}
	if !strings.Contains(pattern, "/") {
		translated = "(?:.*/)?" + translated
	}
	compiled, err := regexp.Compile("^" + translated + "$")
	if err != nil {
		return nil, fail(http.StatusBadRequest, "invalid-pattern", "glob pattern is invalid")
	}
	return compiled, nil
}

func translateSearchGlob(pattern string, start, braceDepth int) (string, int, error) {
	var builder strings.Builder
	for index := start; index < len(pattern); {
		switch pattern[index] {
		case '*':
			if index+1 < len(pattern) && pattern[index+1] == '*' {
				index += 2
				if index < len(pattern) && pattern[index] == '/' {
					builder.WriteString("(?:.*/)?")
					index++
				} else {
					builder.WriteString(".*")
				}
			} else {
				builder.WriteString("[^/]*")
				index++
			}
		case '?':
			builder.WriteString("[^/]")
			index++
		case '[':
			end := index + 1
			if end < len(pattern) && (pattern[end] == '!' || pattern[end] == '^') {
				end++
			}
			if end < len(pattern) && pattern[end] == ']' {
				end++
			}
			for end < len(pattern) && pattern[end] != ']' {
				end++
			}
			if end >= len(pattern) {
				return "", 0, errors.New("unterminated character class")
			}
			class := pattern[index+1 : end]
			if strings.HasPrefix(class, "!") {
				class = "^" + class[1:]
			}
			builder.WriteByte('[')
			builder.WriteString(class)
			builder.WriteByte(']')
			index = end + 1
		case '{':
			if braceDepth >= 8 {
				return "", 0, errors.New("glob alternation is too deeply nested")
			}
			index++
			alternatives := make([]string, 0, 2)
			for {
				translated, next, err := translateSearchGlob(pattern, index, braceDepth+1)
				if err != nil {
					return "", 0, err
				}
				alternatives = append(alternatives, translated)
				if next >= len(pattern) {
					return "", 0, errors.New("unterminated alternation")
				}
				if pattern[next] == '}' {
					index = next + 1
					break
				}
				index = next + 1
			}
			builder.WriteString("(?:")
			builder.WriteString(strings.Join(alternatives, "|"))
			builder.WriteByte(')')
		case ',':
			if braceDepth > 0 {
				return builder.String(), index, nil
			}
			builder.WriteString(regexp.QuoteMeta(","))
			index++
		case '}':
			if braceDepth > 0 {
				return builder.String(), index, nil
			}
			return "", 0, errors.New("unmatched closing brace")
		default:
			_, size := utf8.DecodeRuneInString(pattern[index:])
			builder.WriteString(regexp.QuoteMeta(pattern[index : index+size]))
			index += size
		}
	}
	return builder.String(), len(pattern), nil
}

func globWorkspace(ctx context.Context, root, target string, pattern *regexp.Regexp, caps searchCaps) (SearchResponse, error) {
	files, fileLimitReached, err := discoverSearchFiles(ctx, root, target, caps.files)
	if err != nil {
		return SearchResponse{}, err
	}
	sort.SliceStable(files, func(left, right int) bool {
		if files[left].modTime.Equal(files[right].modTime) {
			return files[left].display < files[right].display
		}
		return files[left].modTime.After(files[right].modTime)
	})
	response := SearchResponse{Root: root, Paths: make([]string, 0, min(len(files), caps.results))}
	reasons := newSearchTruncation(fileLimitReached)
	responseBytes := estimatedSearchResponseBytes(response)
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
		if responseBytes+itemBytes > caps.response {
			reasons.add("bytes")
			break
		}
		response.Paths = append(response.Paths, file.display)
		responseBytes += itemBytes
	}
	reasons.finish(&response)
	return boundSearchResponse(response, caps.response)
}

func grepWorkspace(
	ctx context.Context,
	root, target string,
	pattern, include *regexp.Regexp,
	caps searchCaps,
) (SearchResponse, error) {
	files, fileLimitReached, err := discoverSearchFiles(ctx, root, target, caps.files)
	if err != nil {
		return SearchResponse{}, err
	}
	sort.SliceStable(files, func(left, right int) bool { return files[left].display < files[right].display })
	response := SearchResponse{Root: root, Matches: make([]SearchMatch, 0, min(caps.results, 256))}
	reasons := newSearchTruncation(fileLimitReached)
	var readBytes int64
	responseBytes := estimatedSearchResponseBytes(response)
	for _, file := range files {
		if err := activeRequest(ctx); err != nil {
			return SearchResponse{}, err
		}
		if include != nil && !include.MatchString(file.display) {
			continue
		}
		stop, consumed, err := grepSearchFile(ctx, root, file, pattern, caps, readBytes, &response, &responseBytes, reasons)
		readBytes += consumed
		if err != nil {
			return SearchResponse{}, err
		}
		if stop {
			break
		}
	}
	reasons.finish(&response)
	return boundSearchResponse(response, caps.response)
}

func discoverSearchFiles(ctx context.Context, root, target string, limit int) ([]discoveredFile, bool, error) {
	info, err := os.Stat(target)
	if err != nil {
		return nil, false, err
	}
	if info.Mode().IsRegular() {
		display, err := searchDisplayPath(root, target)
		if err != nil {
			return nil, false, err
		}
		return []discoveredFile{{path: target, display: display, modTime: info.ModTime()}}, false, nil
	}
	if !info.IsDir() {
		return nil, false, fail(http.StatusUnprocessableEntity, "not-searchable", "search target is not a regular file or directory")
	}
	files := make([]discoveredFile, 0, min(limit, 256))
	truncated := false
	err = filepath.WalkDir(target, func(path string, entry os.DirEntry, walkErr error) error {
		if err := activeRequest(ctx); err != nil {
			return err
		}
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if _, excluded := searchVCSDirectories[entry.Name()]; excluded {
				return filepath.SkipDir
			}
		}
		if entry.Type()&os.ModeSymlink != 0 || entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			return err
		}
		if len(files) >= limit {
			truncated = true
			return filepath.SkipAll
		}
		display, err := searchDisplayPath(root, path)
		if err != nil {
			return err
		}
		files = append(files, discoveredFile{path: path, display: display, modTime: info.ModTime()})
		return nil
	})
	if err != nil {
		return nil, false, err
	}
	return files, truncated, nil
}

func searchDisplayPath(root, path string) (string, error) {
	relative, err := filepath.Rel(root, path)
	if err != nil || filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", fail(http.StatusForbidden, "outside-root", "search result is outside the requested root")
	}
	if relative == "." {
		return ".", nil
	}
	return filepath.ToSlash(relative), nil
}

// grepSearchFile 在一个已发现的普通文件中按行匹配，所有读入都计入总字节预算。
func grepSearchFile(
	ctx context.Context,
	root string,
	file discoveredFile,
	pattern *regexp.Regexp,
	caps searchCaps,
	alreadyRead int64,
	response *SearchResponse,
	responseBytes *int64,
	reasons searchTruncation,
) (stop bool, consumed int64, err error) {
	if alreadyRead >= caps.readBytes {
		reasons.add("read-bytes")
		return true, 0, nil
	}
	resolved, err := resolveScopedPath(root, file.path, false)
	if err != nil {
		return false, 0, err
	}
	handle, err := os.Open(resolved)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, 0, nil
		}
		return false, 0, err
	}
	defer handle.Close()
	info, err := handle.Stat()
	if err != nil {
		return false, 0, err
	}
	if !info.Mode().IsRegular() {
		return false, 0, nil
	}
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
		if readErr == bufio.ErrBufferFull {
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
				match := SearchMatch{
					Path: file.display, LineNumber: lineNumber, Line: lineText,
				}
				itemBytes := encodedSearchItemBytes(match)
				if *responseBytes+itemBytes > caps.response {
					reasons.add("bytes")
					return true, remaining - reader.N, nil
				}
				response.Matches = append(response.Matches, match)
				*responseBytes += itemBytes
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return false, remaining - reader.N, readErr
		}
	}
	if reader.N == 0 && info.Size() > remaining {
		reasons.add("read-bytes")
		return true, remaining, nil
	}
	return false, remaining - reader.N, nil
}

// estimatedSearchResponseBytes 预留固定 JSON 字段和截断说明的空间；每个项目再用
// json.Marshal 的精确长度计入，避免在宽泛 grep 时累积无法交付的大量行文本。
func estimatedSearchResponseBytes(response SearchResponse) int64 {
	data, err := json.Marshal(response)
	if err != nil {
		return maxSearchBytes + 1
	}
	return int64(len(data) + 1 + 512)
}

func encodedSearchItemBytes(value any) int64 {
	data, err := json.Marshal(value)
	if err != nil {
		return maxSearchBytes + 1
	}
	return int64(len(data) + 1)
}

type searchTruncation map[string]struct{}

func newSearchTruncation(files bool) searchTruncation {
	reasons := searchTruncation{}
	if files {
		reasons.add("files")
	}
	return reasons
}

func (reasons searchTruncation) add(reason string) { reasons[reason] = struct{}{} }

func (reasons searchTruncation) finish(response *SearchResponse) {
	if len(reasons) == 0 {
		return
	}
	response.Truncated = true
	for _, reason := range []string{"results", "bytes", "files", "read-bytes", "line-bytes"} {
		if _, exists := reasons[reason]; exists {
			response.TruncatedBy = append(response.TruncatedBy, reason)
		}
	}
}

// boundSearchResponse 在序列化之后复核字节预算，确保 bridge 不会拿到部分 JSON。
func boundSearchResponse(response SearchResponse, budget int64) (SearchResponse, error) {
	for {
		data, err := json.Marshal(response)
		if err != nil {
			return SearchResponse{}, err
		}
		if int64(len(data)+1) <= budget {
			return response, nil
		}
		if len(response.Paths) > 0 {
			response.Paths = response.Paths[:len(response.Paths)-1]
		} else if len(response.Matches) > 0 {
			response.Matches = response.Matches[:len(response.Matches)-1]
		} else {
			return SearchResponse{}, fail(http.StatusRequestEntityTooLarge, "response-too-large", "search response minimum exceeds the requested byte limit")
		}
		response.Truncated = true
		if !containsSearchTruncation(response.TruncatedBy, "bytes") {
			response.TruncatedBy = append(response.TruncatedBy, "bytes")
			sort.Strings(response.TruncatedBy)
		}
	}
}

func containsSearchTruncation(reasons []string, wanted string) bool {
	for _, reason := range reasons {
		if reason == wanted {
			return true
		}
	}
	return false
}
