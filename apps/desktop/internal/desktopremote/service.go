// Package desktopremote 拥有桌面端 Remote-SSH 生命周期、marker 事务和回环 bridge。
package desktopremote

import (
	"context"
	"crypto/sha256"
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
)

// MarkerPublisher 串行发布 marker 文件和同代路由，失败时保持旧路由。
type MarkerPublisher interface {
	PublishMarker(context.Context, string, string, string, uint64, func(uint64) error) (uint64, error)
	RevokeMarker(context.Context, MarkerIdentity, func() (bool, error)) (bool, error)
	CurrentMarker(context.Context, MarkerIdentity, func() bool) bool
	Close() error
}

// ProgressEvent 仅携带无凭据的向导进度。
type ProgressEvent struct {
	AttemptID string `json:"attemptId"`
	Phase     string `json:"phase"`
	Message   string `json:"message"`
}

// Options 注入 SSH manager、bridge 和会话回调。
type Options struct {
	Home           string
	Context        context.Context
	Manager        Manager
	Bridge         MarkerPublisher
	OnProgress     func(ProgressEvent)
	OnCleanupError func(error)
}

// Service 管理连接尝试、marker 引用和关闭顺序；由桌面壳拥有。
type Service struct {
	home                string
	ctx                 context.Context
	cancel              context.CancelFunc
	remoteManager       Manager
	remoteBridge        MarkerPublisher
	onProgress          func(ProgressEvent)
	onCleanupError      func(error)
	remoteConnectMu     sync.Mutex
	remoteConnectCancel context.CancelFunc
	remoteConnectSeq    uint64
	remoteConnectID     string
	remoteCancelled     map[string]time.Time
	remoteConnectWG     sync.WaitGroup
	remoteMarkerMu      sync.Mutex
	remoteMarkers       map[string]string
	unclaimed           map[string]*unclaimedOperation
	// 测试钩子固定选择事务解锁到外层收尾之间的竞态窗口。
	afterUnclaimedSelect func()
	remoteStopping       bool
	remoteShutdownOnce   sync.Once
}

// NewService 构造独立于 UI 运行时的 Remote-SSH 服务。
func NewService(options Options) (*Service, error) {
	if options.Manager == nil || options.Bridge == nil || options.Home == "" {
		return nil, errors.New("Remote-SSH service requires home, manager and bridge")
	}
	ctx := options.Context
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithCancel(ctx)
	return &Service{home: options.Home, ctx: ctx, cancel: cancel, remoteManager: options.Manager, remoteBridge: options.Bridge,
		onProgress: options.OnProgress, onCleanupError: options.OnCleanupError, remoteMarkers: make(map[string]string)}, nil
}

// CloseAll 撤销握手，归还 SSH 连接，再停止回环 bridge；重复调用无副作用。
func (s *Service) CloseAll(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	var result error
	s.remoteShutdownOnce.Do(func() {
		s.cancel()
		s.remoteConnectMu.Lock()
		s.remoteStopping = true
		s.remoteConnectSeq++
		if s.remoteConnectCancel != nil {
			s.remoteConnectCancel()
		}
		s.remoteConnectMu.Unlock()
		attemptsDone := make(chan struct{})
		go func() { s.remoteConnectWG.Wait(); close(attemptsDone) }()
		select {
		case <-attemptsDone:
		case <-time.After(3 * time.Second):
		case <-ctx.Done():
		}
		closeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), remoteCloseTimeout)
		managerErr := s.remoteManager.CloseAll(closeCtx)
		cancel()
		result = errors.Join(managerErr, s.remoteBridge.Close())
	})
	return result
}

const (
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

// RemoteSSHConnectInput 是桌面 IPC 边界接收的一次性 SSH 连接输入。
type RemoteSSHConnectInput struct {
	AttemptID                string             `json:"attemptId"`
	Host                     string             `json:"host"`
	Port                     int                `json:"port"`
	Username                 string             `json:"username"`
	Auth                     RemoteSSHAuthInput `json:"auth"`
	ConfirmationID           string             `json:"confirmationId,omitempty"`
	AcceptHostKeyFingerprint string             `json:"acceptHostKeyFingerprint,omitempty"`
}

// RemoteSSHAuthInput 只在一次调用期间持有密码或私钥。
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
	Code           string `json:"code,omitempty"`
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

// Manager 是服务所需的最小 SSH 生命周期接口。
type Manager interface {
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

// RemoteSSHConnect 建立或确认一次 SSH 连接。每个新调用会取消仍在运行的旧
// 调用，且旧回调不能再向重新打开的向导发送进度。
func (s *Service) RemoteSSHConnect(input RemoteSSHConnectInput) (RemoteSSHConnectResult, error) {
	if !validOpaqueID(input.AttemptID) {
		return remoteSSHFailure(errors.New("Remote-SSH attempt id is invalid")), nil
	}
	request, err := remoteSSHConnectRequest(input)
	if err != nil {
		return remoteSSHFailure(err), nil
	}
	ctx, sequence, finish, err := s.beginRemoteConnect(input.AttemptID)
	if err != nil {
		return remoteSSHFailure(err), nil
	}
	defer finish()
	request.OnProgress = func(progress remoteagent.Progress) {
		phase, ok := remoteSSHProgressPhase(progress.Stage)
		if ok && s.isCurrentRemoteConnect(sequence) && s.onProgress != nil {
			s.onProgress(ProgressEvent{AttemptID: input.AttemptID, Phase: phase})
		}
	}

	var info remoteagent.ConnectionInfo
	if input.ConfirmationID != "" || input.AcceptHostKeyFingerprint != "" {
		if !validOpaqueID(input.ConfirmationID) || len(input.AcceptHostKeyFingerprint) > 256 || input.AcceptHostKeyFingerprint == "" {
			return remoteSSHFailure(errors.New("SSH host-key confirmation is invalid")), nil
		}
		info, err = s.remoteManager.ConfirmHostKey(ctx, input.ConfirmationID, request, input.AcceptHostKeyFingerprint)
	} else {
		info, err = s.remoteManager.Connect(ctx, request)
	}
	if err != nil {
		var unknown *remoteagent.ErrUnknownHostKey
		if errors.As(err, &unknown) {
			if !s.isCurrentRemoteConnect(sequence) {
				s.remoteManager.RejectHostKey(unknown.ConfirmationID)
				return remoteSSHFailure(errors.New("Remote-SSH connection attempt was replaced")), nil
			}
			return RemoteSSHConnectResult{
				Kind: "host-key-confirmation", ConfirmationID: unknown.ConfirmationID,
				Fingerprint: unknown.Fingerprint, Algorithm: unknown.Algorithm,
			}, nil
		}
		if s.isCurrentRemoteConnect(sequence) && s.onProgress != nil {
			s.onProgress(ProgressEvent{AttemptID: input.AttemptID, Phase: "failed"})
		}
		return remoteSSHFailure(err), nil
	}
	if !s.isCurrentRemoteConnect(sequence) {
		closeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = s.remoteManager.Close(closeCtx, info.ID)
		cancel()
		return remoteSSHFailure(errors.New("Remote-SSH connection attempt was replaced")), nil
	}
	return RemoteSSHConnectResult{Kind: "ready", ConnectionID: info.ID, HomePath: info.RemoteHome}, nil
}

// RemoteSSHListDirectories 返回一个规范化目录的一层子目录。
func (s *Service) RemoteSSHListDirectories(connectionID, remotePath string) (RemoteSSHDirectoryListing, error) {
	if err := validateRemoteBindingPath(connectionID, remotePath); err != nil {
		return RemoteSSHDirectoryListing{}, err
	}
	ctx, cancel := context.WithTimeout(s.bindingContext(), remoteDirectoryTimeout)
	defer cancel()
	listing, err := s.remoteManager.ListDirectories(ctx, connectionID, remotePath)
	if err != nil {
		return RemoteSSHDirectoryListing{}, err
	}
	return normalizeRemoteSSHDirectoryListing(listing, maxRemoteDirectoryListingBytes)
}

// normalizeRemoteSSHDirectoryListing 在复制远端响应前校验最终 JSON 的完整
// 大小。预留的封包空间让外层回调仍保持在 bridge 的 40 MiB 传输上限内。
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
func (s *Service) RemoteSSHSelectDirectory(connectionID, remotePath string) (RemoteSSHDirectorySelection, error) {
	return s.selectDirectory(connectionID, remotePath, nil)
}

func (s *Service) selectDirectory(connectionID, remotePath string, operation *unclaimedOperation) (RemoteSSHDirectorySelection, error) {
	if err := validateRemoteBindingPath(connectionID, remotePath); err != nil {
		return RemoteSSHDirectorySelection{}, err
	}
	ctx, cancel := context.WithTimeout(s.bindingContext(), remoteSelectionTimeout)
	defer cancel()
	// 选择事务与 Close 共用这把锁。Close 不能在 marker 尚未登记前关闭已经
	// 通过 ResolvePath 确认的连接，否则后续 marker 会指向失效连接。
	if operation == nil {
		s.remoteMarkerMu.Lock()
		defer s.remoteMarkerMu.Unlock()
	}
	if err := ctx.Err(); err != nil {
		return RemoteSSHDirectorySelection{}, err
	}
	resolved, err := s.remoteManager.ResolvePath(ctx, connectionID, remotePath)
	if err != nil {
		return RemoteSSHDirectorySelection{}, err
	}
	if !validCanonicalRemotePath(resolved.Path) || resolved.Info == nil || resolved.Info.Type != "directory" || resolved.Info.Path != resolved.Path {
		return RemoteSSHDirectorySelection{}, errors.New("remote workspace path must be an existing directory")
	}
	info, err := s.remoteManager.Connection(connectionID)
	if err != nil {
		return RemoteSSHDirectorySelection{}, err
	}
	marker, err := s.remoteManager.Marker(connectionID, resolved.Path)
	if err != nil {
		return RemoteSSHDirectorySelection{}, err
	}
	markerRoot, err := remoteMarkerRoot(s.home, info, resolved.Path)
	if err != nil {
		return RemoteSSHDirectorySelection{}, err
	}
	var markerRootInfo os.FileInfo
	if operation != nil {
		markerRootInfo, err = os.Lstat(markerRoot)
		if err != nil || !markerRootInfo.IsDir() || markerRootInfo.Mode()&os.ModeSymlink != 0 {
			return RemoteSSHDirectorySelection{}, errors.New("remote marker root changed before selection")
		}
	}
	if operation != nil {
		// 远端解析不能阻塞另一请求记录撤销；回锁后再进入原有 marker 事务。
		s.remoteMarkerMu.Lock()
		defer s.remoteMarkerMu.Unlock()
		operation.marker.MarkerRoot = markerRoot
		operation.marker.RemoteRoot = resolved.Path
		operation.markerRootInfo = markerRootInfo
		if operation.state == unclaimedRevoked {
			return RemoteSSHDirectorySelection{}, errUnclaimedRevoked
		}
	}
	// 旧 marker 核验与直接发布在 marker 锁下串行；Electron 重绑已有 marker
	// 仅暂存候选，待 Claim 持同锁发布后才清理旧连接。发布后的清理失败
	// 不撤销已提交的选择，不能让调用方再释放新连接。
	if err := ctx.Err(); err != nil {
		return RemoteSSHDirectorySelection{}, err
	}
	previous, err := readRemoteWorkspaceMarker(markerRoot, resolved.Path)
	if err != nil {
		return RemoteSSHDirectorySelection{}, err
	}
	var previousFile os.FileInfo
	if previous != nil && operation != nil {
		previousFile, err = os.Lstat(filepath.Join(markerRoot, remoteWorkspaceMarkerName))
		if err != nil {
			return RemoteSSHDirectorySelection{}, err
		}
	}
	previousConnectionID := ""
	if previous != nil && previous.ConnectionID != connectionID {
		previousInfo, lookupErr := s.remoteManager.Connection(previous.ConnectionID)
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
	if previous != nil && operation != nil {
		// 已有 Workspace 仍依赖旧连接。Electron 在 claim 前只登记候选，
		// 不发布 generation，也不关闭旧连接；撤销时只需释放候选连接。
		operation.state = unclaimedStaged
		operation.marker = MarkerIdentity{MarkerRoot: markerRoot, RemoteRoot: marker.RemoteRoot, ConnectionID: connectionID}
		operation.markerRootInfo = markerRootInfo
		operation.previous, operation.previousFile = *previous, previousFile
		if !previousMarkerMatches(operation) {
			operation.state = unclaimedFailed
			return RemoteSSHDirectorySelection{}, errors.New("remote workspace marker changed before selection")
		}
		return RemoteSSHDirectorySelection{MarkerPath: markerRoot, RemotePath: resolved.Path}, nil
	}
	previousGeneration := remoteWorkspaceMarkerGeneration(previous)
	if s.remoteBridge == nil {
		return RemoteSSHDirectorySelection{}, errors.New("Remote-SSH bridge is unavailable")
	}
	// bridge 的写锁覆盖文件替换和路由发布。Node 即使在文件读取后才到达
	// bridge，也必须带上这一轮 generation；旧快照不会被转发到旧连接。
	var publishedFile os.FileInfo
	generation, err := s.remoteBridge.PublishMarker(ctx, markerRoot, marker.RemoteRoot, marker.ConnectionID, previousGeneration, func(generation uint64) error {
		marker.Version = 2
		marker.Generation = generation
		if operation != nil {
			return writeRemoteWorkspaceMarkerWithFile(markerRoot, marker, &publishedFile)
		}
		return writeRemoteWorkspaceMarker(markerRoot, marker)
	})
	if err != nil {
		return RemoteSSHDirectorySelection{}, err
	}
	if s.remoteMarkers == nil {
		s.remoteMarkers = make(map[string]string)
	}
	s.remoteMarkers[markerRoot] = connectionID
	if operation != nil {
		operation.state = unclaimedPublished
		operation.marker = MarkerIdentity{MarkerRoot: markerRoot, RemoteRoot: marker.RemoteRoot, ConnectionID: connectionID, Generation: generation}
		operation.markerRootInfo = markerRootInfo
		operation.publishedFile = publishedFile
		operation.hadPrevious = previous != nil
	}
	if previousConnectionID != "" && !s.remoteConnectionReferencedLocked(previousConnectionID) {
		closeCtx, cancel := context.WithTimeout(ctx, 6*time.Second)
		err = s.remoteManager.Close(closeCtx, previousConnectionID)
		cancel()
		if err != nil && !errors.Is(err, remoteagent.ErrConnectionNotFound) {
			if s.onCleanupError != nil {
				s.onCleanupError(err)
			}
		}
	}
	return RemoteSSHDirectorySelection{MarkerPath: markerRoot, RemotePath: resolved.Path}, nil
}

// remoteConnectionReferencedLocked 报告 marker 或未 settle 的选择是否仍持有连接；调用方必须持有 remoteMarkerMu。
func (s *Service) remoteConnectionReferencedLocked(connectionID string) bool {
	for _, markerConnectionID := range s.remoteMarkers {
		if markerConnectionID == connectionID {
			return true
		}
	}
	// 可撤销选择在远端 Resolve 期间不持有 marker 锁；阻止 Close 在它
	// 回锁发布前关闭连接，避免产生指向失效连接的新 marker。
	for _, operation := range s.unclaimed {
		if operation.connectionID == connectionID && (operation.state == unclaimedPending || operation.state == unclaimedStaged || operation.state == unclaimedRevoked && operation.settling) {
			return true
		}
	}
	return false
}

// RemoteSSHClose 停止一个未被 marker 引用的已发布连接；marker 持有的连接只能
// 在 marker 重绑定或桌面端关闭时释放，避免让已有 Workspace 指向失效 connectionId。
func (s *Service) RemoteSSHClose(connectionID string) error {
	if !validOpaqueID(connectionID) {
		return errors.New("remote SSH connection id is invalid")
	}
	s.remoteMarkerMu.Lock()
	defer s.remoteMarkerMu.Unlock()
	if s.remoteConnectionReferencedLocked(connectionID) {
		return errors.New("remote SSH connection is used by a workspace")
	}
	ctx, cancel := context.WithTimeout(s.bindingContext(), remoteCloseTimeout)
	defer cancel()
	return s.remoteManager.Close(ctx, connectionID)
}

// RemoteSSHCancelConnect 取消当前尚未完成的握手或部署，并推进 sequence，使已经
// 排队的旧 progress 与成功结果不能污染下一次向导。
func (s *Service) RemoteSSHCancelConnect(attemptID string) error {
	if !validOpaqueID(attemptID) {
		return errors.New("Remote-SSH attempt id is invalid")
	}
	s.remoteConnectMu.Lock()
	s.cleanupCancelledRemoteAttemptsLocked(time.Now())
	if s.remoteConnectID == attemptID {
		s.remoteConnectSeq++
		s.remoteConnectID = ""
	}
	if s.remoteConnectID == "" && s.remoteConnectCancel != nil {
		s.remoteConnectCancel()
		s.remoteConnectCancel = nil
	}
	if s.remoteCancelled == nil {
		s.remoteCancelled = make(map[string]time.Time)
	}
	if len(s.remoteCancelled) >= maxRemoteCancelledAttempts {
		var oldestID string
		var oldest time.Time
		for id, cancelledAt := range s.remoteCancelled {
			if oldestID == "" || cancelledAt.Before(oldest) {
				oldestID, oldest = id, cancelledAt
			}
		}
		delete(s.remoteCancelled, oldestID)
	}
	s.remoteCancelled[attemptID] = time.Now()
	s.remoteConnectMu.Unlock()
	return nil
}

// RemoteSSHRejectHostKey 删除尚未确认且不含认证材料的 host-key 状态。
func (s *Service) RemoteSSHRejectHostKey(confirmationID string) error {
	if !validOpaqueID(confirmationID) {
		return errors.New("SSH host-key confirmation id is invalid")
	}
	s.remoteManager.RejectHostKey(confirmationID)
	return nil
}

func (s *Service) bindingContext() context.Context {
	return s.ctx
}

func (s *Service) beginRemoteConnect(attemptID string) (context.Context, uint64, func(), error) {
	s.remoteConnectMu.Lock()
	defer s.remoteConnectMu.Unlock()
	if s.remoteStopping || s.remoteManager == nil {
		return nil, 0, nil, errors.New("Remote-SSH is shutting down")
	}
	s.cleanupCancelledRemoteAttemptsLocked(time.Now())
	if _, cancelled := s.remoteCancelled[attemptID]; cancelled {
		delete(s.remoteCancelled, attemptID)
		return nil, 0, nil, context.Canceled
	}
	if s.remoteConnectCancel != nil {
		s.remoteConnectCancel()
	}
	s.remoteConnectSeq++
	sequence := s.remoteConnectSeq
	s.remoteConnectID = attemptID
	ctx, cancel := context.WithCancel(s.bindingContext())
	s.remoteConnectCancel = cancel
	s.remoteConnectWG.Add(1)
	var once sync.Once
	return ctx, sequence, func() {
		once.Do(func() {
			cancel()
			s.remoteConnectMu.Lock()
			if s.remoteConnectSeq == sequence {
				s.remoteConnectCancel = nil
				s.remoteConnectID = ""
			}
			s.remoteConnectMu.Unlock()
			s.remoteConnectWG.Done()
		})
	}, nil
}

func (s *Service) cleanupCancelledRemoteAttemptsLocked(now time.Time) {
	for id, cancelledAt := range s.remoteCancelled {
		if now.Sub(cancelledAt) >= remoteCancelledAttemptTTL {
			delete(s.remoteCancelled, id)
		}
	}
}

func (s *Service) isCurrentRemoteConnect(sequence uint64) bool {
	s.remoteConnectMu.Lock()
	defer s.remoteConnectMu.Unlock()
	return !s.remoteStopping && s.remoteConnectSeq == sequence
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
	result := RemoteSSHConnectResult{Kind: "error", Message: message}
	if errors.Is(err, remoteagent.ErrPortForwardingDenied) {
		result.Code = "port-forwarding-denied"
	}
	return result
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
	return writeRemoteWorkspaceMarkerWithFile(markerRoot, marker, nil)
}

func writeRemoteWorkspaceMarkerWithFile(markerRoot string, marker remoteagent.RemoteWorkspaceMarker, published *os.FileInfo) error {
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
	info, err := temporary.Stat()
	if err != nil {
		_ = temporary.Close()
		return fmt.Errorf("inspect remote workspace marker before publication: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close remote workspace marker: %w", err)
	}
	if err := replaceMarkerFile(temporaryName, filepath.Join(markerRoot, remoteWorkspaceMarkerName)); err != nil {
		return fmt.Errorf("replace remote workspace marker: %w", err)
	}
	keepTemporary = false
	if published != nil {
		*published = info
	}
	return nil
}
