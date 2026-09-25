package desktopremote

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/deepseek-ai/coding/apps/desktop/internal/remoteagent"
)

const maxUnclaimedOperations = 65_536

var errUnclaimedRevoked = errors.New("remote selection was revoked")

type unclaimedState uint8

const (
	unclaimedPending unclaimedState = iota
	unclaimedRevoked
	unclaimedPublished
	unclaimedClaimed
	unclaimedFailed
	unclaimedStaged
)

type unclaimedOperation struct {
	connectionID string
	state        unclaimedState
	// Resolve 尚未收尾时，撤销只阻止发布，不移交连接关闭权。
	settling       bool
	marker         MarkerIdentity
	markerRootInfo os.FileInfo
	publishedFile  os.FileInfo
	hadPrevious    bool
	previous       remoteagent.RemoteWorkspaceMarker
	previousFile   os.FileInfo
}

// UnclaimedSelectionResult 的 selected 表示路径已验证；已有 marker 时路径仅为
// 待认领候选，须 ClaimSelection 成功后才切换到新连接。
type UnclaimedSelectionResult struct {
	Kind       string `json:"kind"`
	MarkerPath string `json:"markerPath,omitempty"`
	RemotePath string `json:"remotePath,omitempty"`
}

// UnclaimedActionResult 明确区分安全撤销、不可撤销保留与已交付。
type UnclaimedActionResult struct {
	Kind string `json:"kind"`
}

// RemoteSSHSelectUnclaimed 为 Electron 主进程预留可撤销的 marker 选择；Wails 不使用此接口。
func (s *Service) RemoteSSHSelectUnclaimed(operationID, connectionID, remotePath string) (UnclaimedSelectionResult, error) {
	if !validOpaqueID(operationID) || !validOpaqueID(connectionID) {
		return UnclaimedSelectionResult{}, errors.New("invalid remote selection identity")
	}
	if err := validateRemoteBindingPath(connectionID, remotePath); err != nil {
		return UnclaimedSelectionResult{}, err
	}
	s.remoteMarkerMu.Lock()
	if s.unclaimed == nil {
		s.unclaimed = make(map[string]*unclaimedOperation)
	}
	if existing, ok := s.unclaimed[operationID]; ok {
		matches := existing.connectionID == connectionID && existing.state == unclaimedRevoked
		s.remoteMarkerMu.Unlock()
		if matches {
			return UnclaimedSelectionResult{Kind: "revoked"}, nil
		}
		return UnclaimedSelectionResult{}, errors.New("duplicate remote selection operation id")
	}
	if len(s.unclaimed) >= maxUnclaimedOperations {
		s.remoteMarkerMu.Unlock()
		return UnclaimedSelectionResult{}, errors.New("remote selection operation capacity exceeded")
	}
	operation := &unclaimedOperation{connectionID: connectionID, state: unclaimedPending, settling: true}
	s.unclaimed[operationID] = operation
	s.remoteMarkerMu.Unlock()

	selected, err := s.selectDirectory(connectionID, remotePath, operation)
	if s.afterUnclaimedSelect != nil {
		s.afterUnclaimedSelect()
	}
	s.remoteMarkerMu.Lock()
	operation.settling = false
	wasRevoked := operation.state == unclaimedRevoked
	if wasRevoked {
		s.releaseRevokedCandidateLocked(operation)
	} else if err != nil && operation.state == unclaimedPending {
		operation.state = unclaimedFailed
	}
	s.remoteMarkerMu.Unlock()
	if wasRevoked || errors.Is(err, errUnclaimedRevoked) {
		return UnclaimedSelectionResult{Kind: "revoked"}, nil
	}
	if err != nil {
		return UnclaimedSelectionResult{}, err
	}
	return UnclaimedSelectionResult{Kind: "selected", MarkerPath: selected.MarkerPath, RemotePath: selected.RemotePath}, nil
}

// releaseRevokedCandidateLocked 只关闭能排除磁盘 marker 和其他选择引用的候选；调用方持有 remoteMarkerMu。
func (s *Service) releaseRevokedCandidateLocked(operation *unclaimedOperation) {
	if operation.settling || s.remoteConnectionReferencedLocked(operation.connectionID) {
		return
	}
	// 已验证的旧 marker 属于另一连接且候选从未发布时，目录 inode 后续
	// 替换不代表候选被旧 Workspace 持有；仍需核对当前路径没有新引用。
	stagedOtherConnection := operation.previous.RemoteRoot != "" && operation.previous.ConnectionID != operation.connectionID &&
		operation.marker.Generation == 0 && operation.publishedFile == nil
	if operation.markerRootInfo == nil || operation.marker.MarkerRoot == "" || operation.marker.RemoteRoot == "" {
		return
	}
	rootInfo, err := os.Lstat(operation.marker.MarkerRoot)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 ||
		!stagedOtherConnection && !os.SameFile(rootInfo, operation.markerRootInfo) {
		return
	}
	previous, err := readRemoteWorkspaceMarker(operation.marker.MarkerRoot, operation.marker.RemoteRoot)
	if err != nil || previous != nil && previous.ConnectionID == operation.connectionID {
		return
	}
	closeCtx, stop := context.WithTimeout(context.WithoutCancel(s.bindingContext()), remoteCloseTimeout)
	closeErr := s.remoteManager.Close(closeCtx, operation.connectionID)
	stop()
	if closeErr != nil && !errors.Is(closeErr, remoteagent.ErrConnectionNotFound) && s.onCleanupError != nil {
		s.onCleanupError(closeErr)
	}
}

// RemoteSSHRevokeUnclaimed 可先于 Select 建立有界墓碑；仅安全的新 marker 会被删除。
func (s *Service) RemoteSSHRevokeUnclaimed(operationID, connectionID string) (UnclaimedActionResult, error) {
	if !validOpaqueID(operationID) || !validOpaqueID(connectionID) {
		return UnclaimedActionResult{}, errors.New("invalid remote selection identity")
	}
	s.remoteMarkerMu.Lock()
	defer s.remoteMarkerMu.Unlock()
	if s.unclaimed == nil {
		s.unclaimed = make(map[string]*unclaimedOperation)
	}
	operation, exists := s.unclaimed[operationID]
	if !exists {
		if len(s.unclaimed) >= maxUnclaimedOperations {
			return UnclaimedActionResult{}, errors.New("remote selection operation capacity exceeded")
		}
		s.unclaimed[operationID] = &unclaimedOperation{connectionID: connectionID, state: unclaimedRevoked}
		return UnclaimedActionResult{Kind: "revoked"}, nil
	}
	if operation.connectionID != connectionID {
		return UnclaimedActionResult{}, errors.New("remote selection connection does not match")
	}
	switch operation.state {
	case unclaimedClaimed:
		return UnclaimedActionResult{Kind: "claimed"}, nil
	case unclaimedPending, unclaimedFailed:
		operation.state = unclaimedRevoked
		s.releaseRevokedCandidateLocked(operation)
		return UnclaimedActionResult{Kind: "revoked"}, nil
	case unclaimedRevoked:
		return UnclaimedActionResult{Kind: "revoked"}, nil
	case unclaimedPublished:
		if operation.hadPrevious {
			return UnclaimedActionResult{Kind: "retained"}, nil
		}
		ctx, cancel := context.WithTimeout(s.bindingContext(), remoteSelectionTimeout)
		defer cancel()
		revoked, err := s.remoteBridge.RevokeMarker(ctx, operation.marker, func() (bool, error) {
			return removePublishedMarker(operation)
		})
		if err != nil || !revoked {
			return UnclaimedActionResult{Kind: "retained"}, nil
		}
		operation.state = unclaimedRevoked
		if s.remoteMarkers[operation.marker.MarkerRoot] == connectionID {
			delete(s.remoteMarkers, operation.marker.MarkerRoot)
		}
		s.releaseRevokedCandidateLocked(operation)
		return UnclaimedActionResult{Kind: "revoked"}, nil
	case unclaimedStaged:
		operation.state = unclaimedRevoked
		s.releaseRevokedCandidateLocked(operation)
		return UnclaimedActionResult{Kind: "revoked"}, nil
	default:
		return UnclaimedActionResult{Kind: "retained"}, nil
	}
}

// RemoteSSHClaimSelection 在线性化锁下确认已完成且仍为当前 marker 的选择。
func (s *Service) RemoteSSHClaimSelection(operationID string) (UnclaimedActionResult, error) {
	if !validOpaqueID(operationID) {
		return UnclaimedActionResult{}, errors.New("invalid remote selection operation id")
	}
	s.remoteMarkerMu.Lock()
	defer s.remoteMarkerMu.Unlock()
	operation, exists := s.unclaimed[operationID]
	if !exists {
		return UnclaimedActionResult{Kind: "missing"}, nil
	}
	switch operation.state {
	case unclaimedPending:
		return UnclaimedActionResult{Kind: "pending"}, nil
	case unclaimedRevoked:
		return UnclaimedActionResult{Kind: "revoked"}, nil
	case unclaimedClaimed:
		return UnclaimedActionResult{Kind: "claimed"}, nil
	case unclaimedStaged:
		if !previousMarkerMatches(operation) {
			return UnclaimedActionResult{Kind: "missing"}, nil
		}
		ctx, cancel := context.WithTimeout(s.bindingContext(), remoteSelectionTimeout)
		defer cancel()
		var publishedFile os.FileInfo
		marker := remoteagent.RemoteWorkspaceMarker{RemoteRoot: operation.marker.RemoteRoot, ConnectionID: operation.connectionID}
		generation, err := s.remoteBridge.PublishMarker(ctx, operation.marker.MarkerRoot, marker.RemoteRoot, marker.ConnectionID,
			remoteWorkspaceMarkerGeneration(&operation.previous), func(generation uint64) error {
				if !previousMarkerMatches(operation) {
					return errors.New("remote workspace marker changed before claim")
				}
				marker.Version, marker.Generation = 2, generation
				return writeStagedMarker(operation, marker, &publishedFile)
			})
		if err != nil {
			return UnclaimedActionResult{}, err
		}
		operation.marker.Generation = generation
		operation.publishedFile = publishedFile
		s.remoteMarkers[operation.marker.MarkerRoot] = operation.connectionID
		verifyCtx, verifyCancel := context.WithTimeout(context.WithoutCancel(s.bindingContext()), remoteSelectionTimeout)
		defer verifyCancel()
		if !s.remoteBridge.CurrentMarker(verifyCtx, operation.marker, func() bool { return publishedMarkerMatches(operation) }) {
			// 文件路径被外部替换时不能再安全撤回已发布的路由，
			// 更不能关闭可能仍被旧 Workspace 使用的连接。
			operation.state = unclaimedPublished
			operation.hadPrevious = true
			return UnclaimedActionResult{Kind: "missing"}, nil
		}
		operation.state = unclaimedClaimed
		if operation.previous.ConnectionID != operation.connectionID && !s.remoteConnectionReferencedLocked(operation.previous.ConnectionID) {
			closeCtx, stop := context.WithTimeout(context.WithoutCancel(ctx), remoteCloseTimeout)
			closeErr := s.remoteManager.Close(closeCtx, operation.previous.ConnectionID)
			stop()
			if closeErr != nil && !errors.Is(closeErr, remoteagent.ErrConnectionNotFound) && s.onCleanupError != nil {
				s.onCleanupError(closeErr)
			}
		}
		return UnclaimedActionResult{Kind: "claimed"}, nil
	case unclaimedPublished:
		ctx, cancel := context.WithTimeout(s.bindingContext(), remoteSelectionTimeout)
		defer cancel()
		if !s.remoteBridge.CurrentMarker(ctx, operation.marker, func() bool { return publishedMarkerMatches(operation) }) {
			return UnclaimedActionResult{Kind: "missing"}, nil
		}
		operation.state = unclaimedClaimed
		return UnclaimedActionResult{Kind: "claimed"}, nil
	default:
		return UnclaimedActionResult{Kind: "missing"}, nil
	}
}

// writeStagedMarker 将提交固定在选择时核对过的目录 inode；路径被替换时拒绝写入。
func writeStagedMarker(operation *unclaimedOperation, marker remoteagent.RemoteWorkspaceMarker, published *os.FileInfo) error {
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
	root, err := os.OpenRoot(operation.marker.MarkerRoot)
	if err != nil {
		return err
	}
	defer root.Close()
	opened, err := root.Stat(".")
	if err != nil || !os.SameFile(operation.markerRootInfo, opened) || !previousMarkerMatches(operation) {
		return errors.New("remote workspace marker changed before claim")
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return err
	}
	temporaryName := ".remote-workspace-" + hex.EncodeToString(random[:])
	temporary, err := root.OpenFile(temporaryName, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	keepTemporary := true
	defer func() {
		if keepTemporary {
			_ = root.Remove(temporaryName)
		}
	}()
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	info, err := temporary.Stat()
	if err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if !previousMarkerMatches(operation) {
		return errors.New("remote workspace marker changed before claim")
	}
	if err := root.Rename(temporaryName, remoteWorkspaceMarkerName); err != nil {
		return fmt.Errorf("replace remote workspace marker: %w", err)
	}
	keepTemporary = false
	*published = info
	return nil
}

func previousMarkerMatches(operation *unclaimedOperation) bool {
	if operation.previousFile == nil || operation.markerRootInfo == nil {
		return false
	}
	rootInfo, err := os.Lstat(operation.marker.MarkerRoot)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 || !os.SameFile(rootInfo, operation.markerRootInfo) {
		return false
	}
	filename := filepath.Join(operation.marker.MarkerRoot, remoteWorkspaceMarkerName)
	info, err := os.Lstat(filename)
	if err != nil || !os.SameFile(info, operation.previousFile) {
		return false
	}
	marker, err := readRemoteWorkspaceMarker(operation.marker.MarkerRoot, operation.previous.RemoteRoot)
	if err != nil || marker == nil || *marker != operation.previous {
		return false
	}
	latest, err := os.Lstat(filename)
	if err != nil || !os.SameFile(latest, operation.previousFile) {
		return false
	}
	rootLatest, err := os.Lstat(operation.marker.MarkerRoot)
	return err == nil && os.SameFile(rootLatest, operation.markerRootInfo)
}

func publishedMarkerMatches(operation *unclaimedOperation) bool {
	if operation.publishedFile == nil || operation.markerRootInfo == nil {
		return false
	}
	rootInfo, err := os.Lstat(operation.marker.MarkerRoot)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 ||
		!os.SameFile(operation.markerRootInfo, rootInfo) {
		return false
	}
	filename := filepath.Join(operation.marker.MarkerRoot, remoteWorkspaceMarkerName)
	info, err := os.Lstat(filename)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || !os.SameFile(operation.publishedFile, info) {
		return false
	}
	marker, err := readRemoteWorkspaceMarker(operation.marker.MarkerRoot, operation.marker.RemoteRoot)
	if err != nil || marker == nil || marker.Version != 2 || marker.Generation != operation.marker.Generation ||
		marker.ConnectionID != operation.marker.ConnectionID {
		return false
	}
	latest, err := os.Lstat(filename)
	if err != nil || !os.SameFile(operation.publishedFile, latest) {
		return false
	}
	rootLatest, err := os.Lstat(operation.marker.MarkerRoot)
	return err == nil && os.SameFile(operation.markerRootInfo, rootLatest)
}

func removePublishedMarker(operation *unclaimedOperation) (bool, error) {
	if !publishedMarkerMatches(operation) {
		return false, nil
	}
	root, err := os.OpenRoot(operation.marker.MarkerRoot)
	if err != nil {
		return false, err
	}
	defer root.Close()
	openedRoot, err := root.Stat(".")
	if err != nil || !os.SameFile(operation.markerRootInfo, openedRoot) {
		return false, nil
	}
	latest, err := root.Lstat(remoteWorkspaceMarkerName)
	if err != nil || !os.SameFile(operation.publishedFile, latest) {
		return false, nil
	}
	if err := root.Remove(remoteWorkspaceMarkerName); err != nil {
		return false, err
	}
	return true, nil
}
