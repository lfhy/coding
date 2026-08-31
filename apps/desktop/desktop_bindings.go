package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/deepseek-ai/coding/apps/desktop/internal/remoteagent"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	bridgeTokenBytes               = 32
	remoteSSHMaxPathBytes          = 4096
	maxRemoteDirectoryEntries      = 10_000
	remoteDirectoryListingReserve  = 1 << 10
	maxRemoteDirectoryListingBytes = int(remoteBridgeMaxPayloadBytes) - remoteDirectoryListingReserve
	remoteWorkspaceMarkerName      = ".coding-remote-workspace.json"
	remoteWorkspaceMarkerMaxSize   = 16 << 10
	// marker generation 会经 JSON number 进入 Node，不能超过 IEEE-754 的安全整数。
	remoteWorkspaceMarkerMaxGeneration uint64 = 1<<53 - 1
	remoteDirectoryTimeout                    = 15 * time.Second
	remoteSelectionTimeout                    = 20 * time.Second
	remoteCloseTimeout                        = 8 * time.Second
	remoteCancelledAttemptTTL                 = 5 * time.Minute
	maxRemoteCancelledAttempts                = 64
)

// RemoteSSHConnectInput 是 Wails 边界接收的一次性 SSH 连接输入。
type RemoteSSHConnectInput struct {
	AttemptID                string             `json:"attemptId"`
	Host                     string             `json:"host"`
	Port                     int                `json:"port"`
	Username                 string             `json:"username"`
	Auth                     RemoteSSHAuthInput `json:"auth"`
	ConfirmationID           string             `json:"confirmationId,omitempty"`
	AcceptHostKeyFingerprint string             `json:"acceptHostKeyFingerprint,omitempty"`
}

// RemoteSSHAuthInput 只在一次 binding 调用期间持有密码或私钥。
type RemoteSSHAuthInput struct {
	Kind   string `json:"kind"`
	Secret string `json:"secret"`
}

// RemoteSSHConnectResult 是 Client 约定的封闭连接结果。
type RemoteSSHConnectResult struct {
	Kind           string `json:"kind"`
	ConnectionID   string `json:"connectionId,omitempty"`
	HomePath       string `json:"homePath,omitempty"`
	ConfirmationID string `json:"confirmationId,omitempty"`
	Fingerprint    string `json:"fingerprint,omitempty"`
	Algorithm      string `json:"algorithm,omitempty"`
	Message        string `json:"message,omitempty"`
}

// RemoteSSHDirectoryEntry 是目录选择器可进入的远端目录。
type RemoteSSHDirectoryEntry struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Directory bool   `json:"directory"`
}

// RemoteSSHDirectoryListing 是规范化目录及其一层子目录。
type RemoteSSHDirectoryListing struct {
	Path    string                    `json:"path"`
	Entries []RemoteSSHDirectoryEntry `json:"entries"`
}

// RemoteSSHDirectorySelection 返回供 Workspace create 复用的确定性 marker 根。
type RemoteSSHDirectorySelection struct {
	MarkerPath string `json:"markerPath"`
	RemotePath string `json:"remotePath"`
}

var errDesktopBridgeUnauthorized = errors.New("coding: desktop bridge is not authorized")

// remoteSSHManager 是桌面壳实际消费的最小 SSH 生命周期能力，也让 binding
// 测试无需打开真实端口或保存认证材料。
type remoteSSHManager interface {
	Connect(context.Context, remoteagent.ConnectRequest) (remoteagent.ConnectionInfo, error)
	ConfirmHostKey(context.Context, string, remoteagent.ConnectRequest, string) (remoteagent.ConnectionInfo, error)
	RejectHostKey(string)
	ListDirectories(context.Context, string, string) (remoteagent.RemoteDirectory, error)
	ResolvePath(context.Context, string, string) (remoteagent.ResolveResponse, error)
	Connection(string) (remoteagent.ConnectionInfo, error)
	Marker(string, string) (remoteagent.RemoteWorkspaceMarker, error)
	Close(context.Context, string) error
	CloseAll(context.Context) error
}

// newBridgeToken 为一个桌面窗口生成仅存于内存的 binding 授权 token。
func newBridgeToken() (string, error) {
	bytes := make([]byte, bridgeTokenBytes)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("coding: create desktop bridge token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

// validBridgeToken 在常数时间内校验从 Host WebView 传入的窗口 token。
func validBridgeToken(expected, received string) bool {
	return len(expected) > 0 && len(expected) == len(received) &&
		subtle.ConstantTimeCompare([]byte(expected), []byte(received)) == 1
}

// RemoteSSHConnect 建立或确认一次 SSH 连接。每个新调用会取消仍在运行的旧
// 调用，且旧回调不能再向重新打开的向导发送进度。
func (a *App) RemoteSSHConnect(receivedToken string, input RemoteSSHConnectInput) (RemoteSSHConnectResult, error) {
	if !validBridgeToken(a.bridgeToken, receivedToken) {
		return RemoteSSHConnectResult{}, errDesktopBridgeUnauthorized
	}
	if !validOpaqueID(input.AttemptID) {
		return remoteSSHFailure(errors.New("Remote-SSH attempt id is invalid")), nil
	}
	request, err := remoteSSHConnectRequest(input)
	if err != nil {
		return remoteSSHFailure(err), nil
	}
	ctx, sequence, finish, err := a.beginRemoteConnect(input.AttemptID)
	if err != nil {
		return remoteSSHFailure(err), nil
	}
	defer finish()
	request.OnProgress = func(progress remoteagent.Progress) {
		phase, ok := remoteSSHProgressPhase(progress.Stage)
		if ok && a.isCurrentRemoteConnect(sequence) && a.ctx != nil {
			wailsruntime.EventsEmit(a.ctx, "coding:remote-ssh-progress", map[string]string{"attemptId": input.AttemptID, "phase": phase, "message": ""})
		}
	}

	var info remoteagent.ConnectionInfo
	if input.ConfirmationID != "" || input.AcceptHostKeyFingerprint != "" {
		if !validOpaqueID(input.ConfirmationID) || len(input.AcceptHostKeyFingerprint) > 256 || input.AcceptHostKeyFingerprint == "" {
			return remoteSSHFailure(errors.New("SSH host-key confirmation is invalid")), nil
		}
		info, err = a.remoteManager.ConfirmHostKey(ctx, input.ConfirmationID, request, input.AcceptHostKeyFingerprint)
	} else {
		info, err = a.remoteManager.Connect(ctx, request)
	}
	if err != nil {
		var unknown *remoteagent.ErrUnknownHostKey
		if errors.As(err, &unknown) {
			if !a.isCurrentRemoteConnect(sequence) {
				a.remoteManager.RejectHostKey(unknown.ConfirmationID)
				return remoteSSHFailure(errors.New("Remote-SSH connection attempt was replaced")), nil
			}
			return RemoteSSHConnectResult{
				Kind: "host-key-confirmation", ConfirmationID: unknown.ConfirmationID,
				Fingerprint: unknown.Fingerprint, Algorithm: unknown.Algorithm,
			}, nil
		}
		if a.isCurrentRemoteConnect(sequence) && a.ctx != nil {
			wailsruntime.EventsEmit(a.ctx, "coding:remote-ssh-progress", map[string]string{"attemptId": input.AttemptID, "phase": "failed", "message": ""})
		}
		return remoteSSHFailure(err), nil
	}
	if !a.isCurrentRemoteConnect(sequence) {
		closeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = a.remoteManager.Close(closeCtx, info.ID)
		cancel()
		return remoteSSHFailure(errors.New("Remote-SSH connection attempt was replaced")), nil
	}
	return RemoteSSHConnectResult{Kind: "ready", ConnectionID: info.ID, HomePath: info.RemoteHome}, nil
}

// RemoteSSHListDirectories 返回一个规范化目录的一层子目录。
func (a *App) RemoteSSHListDirectories(receivedToken, connectionID, remotePath string) (RemoteSSHDirectoryListing, error) {
	if !validBridgeToken(a.bridgeToken, receivedToken) {
		return RemoteSSHDirectoryListing{}, errDesktopBridgeUnauthorized
	}
	if err := validateRemoteBindingPath(connectionID, remotePath); err != nil {
		return RemoteSSHDirectoryListing{}, err
	}
	ctx, cancel := context.WithTimeout(a.bindingContext(), remoteDirectoryTimeout)
	defer cancel()
	listing, err := a.remoteManager.ListDirectories(ctx, connectionID, remotePath)
	if err != nil {
		return RemoteSSHDirectoryListing{}, err
	}
	return normalizeRemoteSSHDirectoryListing(listing, maxRemoteDirectoryListingBytes)
}

// normalizeRemoteSSHDirectoryListing 在复制远端响应前校验最终 Wails JSON 的完整
// 大小。预留的封包空间让 Wails 外层回调仍保持在 bridge 的 40 MiB 传输上限内。
func normalizeRemoteSSHDirectoryListing(listing remoteagent.RemoteDirectory, maxBytes int) (RemoteSSHDirectoryListing, error) {
	if !validCanonicalRemotePath(listing.Path) {
		return RemoteSSHDirectoryListing{}, errors.New("remote agent returned an invalid directory path")
	}
	if len(listing.Entries) > maxRemoteDirectoryEntries {
		return RemoteSSHDirectoryListing{}, errors.New("remote agent returned too many directory entries")
	}
	entries := make([]RemoteSSHDirectoryEntry, 0, len(listing.Entries))
	empty, err := json.Marshal(RemoteSSHDirectoryListing{Path: listing.Path, Entries: []RemoteSSHDirectoryEntry{}})
	if err != nil {
		return RemoteSSHDirectoryListing{}, fmt.Errorf("encode remote directory listing: %w", err)
	}
	encodedBytes := len(empty)
	if encodedBytes > maxBytes {
		return RemoteSSHDirectoryListing{}, errors.New("remote agent returned a directory listing that is too large")
	}
	for _, entry := range listing.Entries {
		if entry.Type != "directory" {
			continue
		}
		if entry.Name == "" || len(entry.Name) > 255 || strings.ContainsRune(entry.Name, '\x00') || !validCanonicalRemotePath(entry.Path) {
			return RemoteSSHDirectoryListing{}, errors.New("remote agent returned an invalid directory entry")
		}
		normalized := RemoteSSHDirectoryEntry{Name: entry.Name, Path: entry.Path, Directory: true}
		encoded, err := json.Marshal(normalized)
		if err != nil {
			return RemoteSSHDirectoryListing{}, fmt.Errorf("encode remote directory entry: %w", err)
		}
		additionalBytes := len(encoded)
		if len(entries) > 0 {
			// 空数组本身已经包含方括号；第二项起只多一个 JSON 分隔逗号。
			additionalBytes++
		}
		if encodedBytes+additionalBytes > maxBytes {
			return RemoteSSHDirectoryListing{}, errors.New("remote agent returned a directory listing that is too large")
		}
		encodedBytes += additionalBytes
		entries = append(entries, normalized)
	}
	return RemoteSSHDirectoryListing{Path: listing.Path, Entries: entries}, nil
}

// RemoteSSHSelectDirectory 验证规范目录并原子更新其确定性本地 marker。
func (a *App) RemoteSSHSelectDirectory(receivedToken, connectionID, remotePath string) (RemoteSSHDirectorySelection, error) {
	if !validBridgeToken(a.bridgeToken, receivedToken) {
		return RemoteSSHDirectorySelection{}, errDesktopBridgeUnauthorized
	}
	if err := validateRemoteBindingPath(connectionID, remotePath); err != nil {
		return RemoteSSHDirectorySelection{}, err
	}
	ctx, cancel := context.WithTimeout(a.bindingContext(), remoteSelectionTimeout)
	defer cancel()
	// 选择事务与 Close 共用这把锁。Close 不能在 marker 尚未登记前关闭已经
	// 通过 ResolvePath 确认的连接，否则后续 marker 会指向失效连接。
	a.remoteMarkerMu.Lock()
	defer a.remoteMarkerMu.Unlock()
	if err := ctx.Err(); err != nil {
		return RemoteSSHDirectorySelection{}, err
	}
	resolved, err := a.remoteManager.ResolvePath(ctx, connectionID, remotePath)
	if err != nil {
		return RemoteSSHDirectorySelection{}, err
	}
	if !validCanonicalRemotePath(resolved.Path) || resolved.Info == nil || resolved.Info.Type != "directory" || resolved.Info.Path != resolved.Path {
		return RemoteSSHDirectorySelection{}, errors.New("remote workspace path must be an existing directory")
	}
	info, err := a.remoteManager.Connection(connectionID)
	if err != nil {
		return RemoteSSHDirectorySelection{}, err
	}
	marker, err := a.remoteManager.Marker(connectionID, resolved.Path)
	if err != nil {
		return RemoteSSHDirectorySelection{}, err
	}
	markerRoot, err := remoteMarkerRoot(a.launcher.Home(), info, resolved.Path)
	if err != nil {
		return RemoteSSHDirectorySelection{}, err
	}
	// 读取旧 marker、发布新 marker 和停止旧连接必须串行。否则两个并发选择
	// 都可能只关闭旧连接，并让其中一个新连接失去 marker 引用。marker 发布后
	// 的旧连接清理不影响已成功的选择，不能让调用方再释放新连接。
	if err := ctx.Err(); err != nil {
		return RemoteSSHDirectorySelection{}, err
	}
	previous, err := readRemoteWorkspaceMarker(markerRoot, resolved.Path)
	if err != nil {
		return RemoteSSHDirectorySelection{}, err
	}
	previousConnectionID := ""
	if previous != nil && previous.ConnectionID != connectionID {
		previousInfo, lookupErr := a.remoteManager.Connection(previous.ConnectionID)
		if lookupErr != nil && !errors.Is(lookupErr, remoteagent.ErrConnectionNotFound) {
			return RemoteSSHDirectorySelection{}, lookupErr
		}
		if lookupErr == nil && (previousInfo.TargetHost != info.TargetHost || previousInfo.TargetPort != info.TargetPort || previousInfo.TargetUser != info.TargetUser) {
			return RemoteSSHDirectorySelection{}, errors.New("existing remote workspace marker belongs to a different SSH target")
		}
		if lookupErr == nil {
			previousConnectionID = previous.ConnectionID
		}
	}
	if err := ctx.Err(); err != nil {
		return RemoteSSHDirectorySelection{}, err
	}
	previousGeneration := remoteWorkspaceMarkerGeneration(previous)
	if a.remoteBridge == nil {
		return RemoteSSHDirectorySelection{}, errors.New("Remote-SSH bridge is unavailable")
	}
	// bridge 的写锁覆盖文件替换和路由发布。Node 即使在文件读取后才到达
	// bridge，也必须带上这一轮 generation；旧快照不会被转发到旧连接。
	_, err = a.remoteBridge.publishMarker(ctx, markerRoot, marker.RemoteRoot, marker.ConnectionID, previousGeneration, func(generation uint64) error {
		marker.Version = 2
		marker.Generation = generation
		return writeRemoteWorkspaceMarker(markerRoot, marker)
	})
	if err != nil {
		return RemoteSSHDirectorySelection{}, err
	}
	if a.remoteMarkers == nil {
		a.remoteMarkers = make(map[string]string)
	}
	a.remoteMarkers[markerRoot] = connectionID
	if previousConnectionID != "" && !a.remoteConnectionReferencedLocked(previousConnectionID) {
		closeCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
		err = a.remoteManager.Close(closeCtx, previousConnectionID)
		cancel()
		if err != nil && !errors.Is(err, remoteagent.ErrConnectionNotFound) {
			fmt.Fprintln(os.Stderr, applicationName+": remote workspace marker updated; replaced SSH connection cleanup failed")
		}
	}
	return RemoteSSHDirectorySelection{MarkerPath: markerRoot, RemotePath: resolved.Path}, nil
}

// remoteConnectionReferencedLocked 报告已发布 marker 是否仍持有连接；调用方必须持有 remoteMarkerMu。
func (a *App) remoteConnectionReferencedLocked(connectionID string) bool {
	for _, markerConnectionID := range a.remoteMarkers {
		if markerConnectionID == connectionID {
			return true
		}
	}
	return false
}

// RemoteSSHClose 停止一个未被 marker 引用的已发布连接；marker 持有的连接只能
// 在 marker 重绑定或桌面端关闭时释放，避免让已有 Workspace 指向失效 connectionId。
func (a *App) RemoteSSHClose(receivedToken, connectionID string) error {
	if !validBridgeToken(a.bridgeToken, receivedToken) {
		return errDesktopBridgeUnauthorized
	}
	if !validOpaqueID(connectionID) {
		return errors.New("remote SSH connection id is invalid")
	}
	a.remoteMarkerMu.Lock()
	defer a.remoteMarkerMu.Unlock()
	if a.remoteConnectionReferencedLocked(connectionID) {
		return errors.New("remote SSH connection is used by a workspace")
	}
	ctx, cancel := context.WithTimeout(a.bindingContext(), remoteCloseTimeout)
	defer cancel()
	return a.remoteManager.Close(ctx, connectionID)
}

// RemoteSSHCancelConnect 取消当前尚未完成的握手或部署，并推进 sequence，使已经
// 排队的旧 progress 与成功结果不能污染下一次向导。
func (a *App) RemoteSSHCancelConnect(receivedToken, attemptID string) error {
	if !validBridgeToken(a.bridgeToken, receivedToken) {
		return errDesktopBridgeUnauthorized
	}
	if !validOpaqueID(attemptID) {
		return errors.New("Remote-SSH attempt id is invalid")
	}
	a.remoteConnectMu.Lock()
	a.cleanupCancelledRemoteAttemptsLocked(time.Now())
	if a.remoteConnectID == attemptID {
		a.remoteConnectSeq++
		a.remoteConnectID = ""
	}
	if a.remoteConnectID == "" && a.remoteConnectCancel != nil {
		a.remoteConnectCancel()
		a.remoteConnectCancel = nil
	}
	if a.remoteCancelled == nil {
		a.remoteCancelled = make(map[string]time.Time)
	}
	if len(a.remoteCancelled) >= maxRemoteCancelledAttempts {
		var oldestID string
		var oldest time.Time
		for id, cancelledAt := range a.remoteCancelled {
			if oldestID == "" || cancelledAt.Before(oldest) {
				oldestID, oldest = id, cancelledAt
			}
		}
		delete(a.remoteCancelled, oldestID)
	}
	a.remoteCancelled[attemptID] = time.Now()
	a.remoteConnectMu.Unlock()
	return nil
}

// RemoteSSHRejectHostKey 删除尚未确认且不含认证材料的 host-key 状态。
func (a *App) RemoteSSHRejectHostKey(receivedToken, confirmationID string) error {
	if !validBridgeToken(a.bridgeToken, receivedToken) {
		return errDesktopBridgeUnauthorized
	}
	if !validOpaqueID(confirmationID) {
		return errors.New("SSH host-key confirmation id is invalid")
	}
	a.remoteManager.RejectHostKey(confirmationID)
	return nil
}

func (a *App) bindingContext() context.Context {
	if a.ctx != nil {
		return a.ctx
	}
	return context.Background()
}

func (a *App) beginRemoteConnect(attemptID string) (context.Context, uint64, func(), error) {
	a.remoteConnectMu.Lock()
	defer a.remoteConnectMu.Unlock()
	if a.remoteStopping || a.remoteManager == nil {
		return nil, 0, nil, errors.New("Remote-SSH is shutting down")
	}
	a.cleanupCancelledRemoteAttemptsLocked(time.Now())
	if _, cancelled := a.remoteCancelled[attemptID]; cancelled {
		delete(a.remoteCancelled, attemptID)
		return nil, 0, nil, context.Canceled
	}
	if a.remoteConnectCancel != nil {
		a.remoteConnectCancel()
	}
	a.remoteConnectSeq++
	sequence := a.remoteConnectSeq
	a.remoteConnectID = attemptID
	ctx, cancel := context.WithCancel(a.bindingContext())
	a.remoteConnectCancel = cancel
	a.remoteConnectWG.Add(1)
	var once sync.Once
	return ctx, sequence, func() {
		once.Do(func() {
			cancel()
			a.remoteConnectMu.Lock()
			if a.remoteConnectSeq == sequence {
				a.remoteConnectCancel = nil
				a.remoteConnectID = ""
			}
			a.remoteConnectMu.Unlock()
			a.remoteConnectWG.Done()
		})
	}, nil
}

func (a *App) cleanupCancelledRemoteAttemptsLocked(now time.Time) {
	for id, cancelledAt := range a.remoteCancelled {
		if now.Sub(cancelledAt) >= remoteCancelledAttemptTTL {
			delete(a.remoteCancelled, id)
		}
	}
}

func (a *App) isCurrentRemoteConnect(sequence uint64) bool {
	a.remoteConnectMu.Lock()
	defer a.remoteConnectMu.Unlock()
	return !a.remoteStopping && a.remoteConnectSeq == sequence
}

func remoteSSHConnectRequest(input RemoteSSHConnectInput) (remoteagent.ConnectRequest, error) {
	if input.Port < 1 || input.Port > 65535 {
		return remoteagent.ConnectRequest{}, errors.New("SSH port is invalid")
	}
	request := remoteagent.ConnectRequest{Host: input.Host, Port: input.Port, User: input.Username}
	switch input.Auth.Kind {
	case "password":
		request.Auth.Password = input.Auth.Secret
	case "privateKey":
		request.Auth.PrivateKey = input.Auth.Secret
	default:
		return remoteagent.ConnectRequest{}, errors.New("SSH authentication kind is invalid")
	}
	return request, nil
}

func remoteSSHFailure(err error) RemoteSSHConnectResult {
	message := "Remote-SSH connection failed"
	if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		message = err.Error()
	}
	return RemoteSSHConnectResult{Kind: "error", Message: message}
}

func remoteSSHProgressPhase(stage string) (string, bool) {
	switch stage {
	case "connecting":
		return "authenticating", true
	case "detecting-platform":
		return "probing", true
	case "uploading-agent":
		return "uploading", true
	case "starting-agent", "checking-agent":
		return "starting", true
	case "ready":
		return "ready", true
	default:
		return "", false
	}
}

func validateRemoteBindingPath(connectionID, remotePath string) error {
	if !validOpaqueID(connectionID) {
		return errors.New("remote SSH connection id is invalid")
	}
	if len(remotePath) == 0 || len(remotePath) > remoteSSHMaxPathBytes || strings.ContainsRune(remotePath, '\x00') {
		return errors.New("remote SSH path is invalid")
	}
	return nil
}

func validCanonicalRemotePath(remotePath string) bool {
	if len(remotePath) == 0 || len(remotePath) > remoteSSHMaxPathBytes || strings.ContainsRune(remotePath, '\x00') {
		return false
	}
	normalized := strings.ReplaceAll(remotePath, "\\", "/")
	for _, segment := range strings.Split(normalized, "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	if strings.HasPrefix(remotePath, "/") || strings.HasPrefix(remotePath, `\\`) {
		return true
	}
	return len(remotePath) >= 3 && ((remotePath[0] >= 'A' && remotePath[0] <= 'Z') || (remotePath[0] >= 'a' && remotePath[0] <= 'z')) &&
		remotePath[1] == ':' && (remotePath[2] == '/' || remotePath[2] == '\\')
}

func validOpaqueID(value string) bool {
	return remoteConnectionIDPattern.MatchString(value)
}

func remoteMarkerRoot(home string, info remoteagent.ConnectionInfo, remoteRoot string) (string, error) {
	if home == "" || info.TargetHost == "" || info.TargetPort < 1 || info.TargetUser == "" || remoteRoot == "" {
		return "", errors.New("remote workspace identity is incomplete")
	}
	targetHash := stableRemoteHash(info.TargetHost, strconv.Itoa(info.TargetPort), info.TargetUser)
	rootHash := stableRemoteHash(remoteRoot)
	label := remoteWorkspaceLabel(remoteRoot)
	base := filepath.Join(home, "remote-workspaces")
	targetDirectory := filepath.Join(base, targetHash)
	markerRoot := filepath.Join(targetDirectory, label+"-"+rootHash)
	for _, directory := range []string{base, targetDirectory, markerRoot} {
		if err := ensurePrivateMarkerDirectory(directory); err != nil {
			return "", err
		}
	}
	// Node 通过 realpath 记住 markerRoot；桥接器必须注册同一规范本地身份，
	// 否则 Home 中的合法符号链接会让每次请求都被误认为未发布 marker。
	canonical, err := filepath.EvalSymlinks(markerRoot)
	if err != nil {
		return "", fmt.Errorf("canonicalize remote workspace marker directory: %w", err)
	}
	if !filepath.IsAbs(canonical) {
		return "", errors.New("remote workspace marker directory is not absolute")
	}
	return canonical, nil
}

func stableRemoteHash(parts ...string) string {
	digest := sha256.New()
	for index, part := range parts {
		if index > 0 {
			_, _ = digest.Write([]byte{0})
		}
		_, _ = digest.Write([]byte(part))
	}
	return hex.EncodeToString(digest.Sum(nil))[:20]
}

func remoteWorkspaceLabel(remoteRoot string) string {
	canonical := strings.TrimRight(strings.ReplaceAll(remoteRoot, "\\", "/"), "/")
	label := path.Base(canonical)
	if label == "." || label == "/" || label == "" {
		label = "workspace"
	}
	var result strings.Builder
	for _, character := range label {
		if (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') || character == '-' || character == '_' {
			result.WriteRune(character)
		} else if result.Len() == 0 || result.String()[result.Len()-1] != '-' {
			result.WriteByte('-')
		}
		if result.Len() >= 40 {
			break
		}
	}
	value := strings.Trim(result.String(), "-")
	if value == "" {
		return "workspace"
	}
	return value
}

func ensurePrivateMarkerDirectory(directory string) error {
	if err := os.Mkdir(directory, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return fmt.Errorf("create remote workspace marker directory: %w", err)
	}
	info, err := os.Lstat(directory)
	if err != nil {
		return fmt.Errorf("inspect remote workspace marker directory: %w", err)
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("remote workspace marker directory must be a real directory")
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(directory, 0o700); err != nil {
			return fmt.Errorf("secure remote workspace marker directory: %w", err)
		}
	}
	return nil
}

func readRemoteWorkspaceMarker(markerRoot, expectedRemoteRoot string) (*remoteagent.RemoteWorkspaceMarker, error) {
	filename := filepath.Join(markerRoot, remoteWorkspaceMarkerName)
	info, err := os.Lstat(filename)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("inspect existing remote workspace marker: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > remoteWorkspaceMarkerMaxSize {
		return nil, errors.New("existing remote workspace marker is invalid")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("existing remote workspace marker permissions are too broad")
	}
	file, err := os.Open(filename)
	if err != nil {
		return nil, fmt.Errorf("open existing remote workspace marker: %w", err)
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, errors.New("existing remote workspace marker changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(file, remoteWorkspaceMarkerMaxSize+1))
	if err != nil || len(data) > remoteWorkspaceMarkerMaxSize {
		return nil, errors.New("existing remote workspace marker cannot be read")
	}
	var marker remoteagent.RemoteWorkspaceMarker
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&marker) != nil || decoder.Decode(&struct{}{}) != io.EOF || !validRemoteWorkspaceMarker(marker) ||
		marker.RemoteRoot != expectedRemoteRoot || !validOpaqueID(marker.ConnectionID) {
		return nil, errors.New("existing remote workspace marker is invalid")
	}
	return &marker, nil
}

// validRemoteWorkspaceMarker 同时接受旧的 v1 文件，以便下一次官方目录选择可将
// 它迁移为带 generation 的 v2。v1 不能通过新 bridge 的身份头校验，因此不会
// 重新获得远端访问能力。
func validRemoteWorkspaceMarker(marker remoteagent.RemoteWorkspaceMarker) bool {
	return marker.Version == 1 && marker.Generation == 0 ||
		marker.Version == 2 && marker.Generation > 0 && marker.Generation <= remoteWorkspaceMarkerMaxGeneration
}

func remoteWorkspaceMarkerGeneration(marker *remoteagent.RemoteWorkspaceMarker) uint64 {
	if marker != nil && marker.Version == 2 {
		return marker.Generation
	}
	return 0
}

func writeRemoteWorkspaceMarker(markerRoot string, marker remoteagent.RemoteWorkspaceMarker) error {
	if !validRemoteWorkspaceMarker(marker) {
		return errors.New("remote workspace marker generation is invalid")
	}
	data, err := json.Marshal(marker)
	if err != nil {
		return fmt.Errorf("encode remote workspace marker: %w", err)
	}
	data = append(data, '\n')
	if len(data) > remoteWorkspaceMarkerMaxSize {
		return errors.New("remote workspace marker exceeds byte limit")
	}
	temporary, err := os.CreateTemp(markerRoot, ".remote-workspace-*")
	if err != nil {
		return fmt.Errorf("create remote workspace marker: %w", err)
	}
	temporaryName := temporary.Name()
	keepTemporary := true
	defer func() {
		if keepTemporary {
			_ = os.Remove(temporaryName)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("secure remote workspace marker: %w", err)
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write remote workspace marker: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("sync remote workspace marker: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close remote workspace marker: %w", err)
	}
	if err := replaceMarkerFile(temporaryName, filepath.Join(markerRoot, remoteWorkspaceMarkerName)); err != nil {
		return fmt.Errorf("replace remote workspace marker: %w", err)
	}
	keepTemporary = false
	return nil
}

// desktopBindingsScript 在指定的本地 Host origin 页面安装最小 Wails 调用面。
// Wails 只会把完整 runtime 注入自身的 wails:// 页面；Host 是另一个回环 origin，
// 因而这里不经网络把当前窗口 token 和所需 callback/event 协议注入 WebView。
// origin 断言防止允许的任意 loopback 页面得到窗口私有 token。
func desktopBindingsScript(token, hostOrigin string) string {
	quotedToken := strconv.Quote(token)
	quotedOrigin := strconv.Quote(hostOrigin)
	return `(() => {
  if (window.location.origin !== ` + quotedOrigin + `) return
  const token = ` + quotedToken + `
  if (!Object.prototype.hasOwnProperty.call(window, '__CODING_DESKTOP_BRIDGE_TOKEN')) {
    Object.defineProperty(window, '__CODING_DESKTOP_BRIDGE_TOKEN', {
      value: token, writable: false, configurable: false,
    })
  }
  // Wails 自己的启动页已经有完整 runtime；保留它的 callback 表以避免影响 Host 启动。
  if (window.go?.main?.App && window.wails?.Callback && window.runtime?.EventsOn) return
  const callbacks = Object.create(null)
  const listeners = Object.create(null)
  const send = (message) => {
    if (typeof window.WailsInvoke === 'function') return window.WailsInvoke(message)
    if (window.chrome?.webview?.postMessage) return window.chrome.webview.postMessage(message)
    if (window.webkit?.messageHandlers?.external?.postMessage) return window.webkit.messageHandlers.external.postMessage(message)
    throw new Error('Coding desktop bridge is unavailable')
  }
  const call = (name, args) => new Promise((resolve, reject) => {
    let callbackID
    do {
      callbackID = name + '-' + String(window.crypto?.getRandomValues
        ? window.crypto.getRandomValues(new Uint32Array(1))[0]
        : Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))
    } while (callbacks[callbackID])
    callbacks[callbackID] = { resolve, reject }
    try {
      send('C' + JSON.stringify({ name, args, callbackID }))
    } catch (error) {
      delete callbacks[callbackID]
      reject(error)
    }
  })
  const callback = (raw) => {
    let message
    try { message = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return }
    const pending = callbacks[message?.callbackid]
    if (!pending) return
    delete callbacks[message.callbackid]
    if (message.error) pending.reject(new Error(String(message.error)))
    else pending.resolve(message.result)
  }
  const notify = (raw) => {
    let event
    try { event = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return }
    if (typeof event?.name !== 'string' || !Array.isArray(event.data)) return
    for (const listener of [...(listeners[event.name] ?? [])]) {
      try { listener(...event.data) } catch {}
    }
  }
  const on = (name, listener) => {
    const entries = listeners[name] ?? (listeners[name] = [])
    entries.push(listener)
    return () => {
      const current = listeners[name]
      if (!current) return
      const index = current.indexOf(listener)
      if (index >= 0) current.splice(index, 1)
      if (current.length === 0) delete listeners[name]
    }
  }
  window.wails = window.wails || {}
  window.wails.Callback = callback
  window.wails.EventsNotify = notify
  window.runtime = window.runtime || {}
  window.runtime.EventsOn = on
  window.go = window.go || {}
  window.go.main = window.go.main || {}
  window.go.main.App = window.go.main.App || {}
  for (const method of [
    'RemoteSSHConnect', 'RemoteSSHListDirectories', 'RemoteSSHSelectDirectory',
    'RemoteSSHClose', 'RemoteSSHCancelConnect', 'RemoteSSHRejectHostKey',
  ]) {
    window.go.main.App[method] = (...args) => call('main.App.' + method, args)
  }
})()`
}
