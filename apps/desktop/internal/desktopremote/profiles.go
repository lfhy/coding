package desktopremote

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/deepseek-ai/coding/apps/desktop/internal/remoteagent"
	"github.com/deepseek-ai/coding/apps/desktop/internal/sshprofile"
)

// RemoteSSHProfileView 是渲染层可见的连接档案；不含密码、私钥或密文。
type RemoteSSHProfileView struct {
	ID         string `json:"id"`
	Host       string `json:"host"`
	Port       int    `json:"port"`
	Username   string `json:"username"`
	Mode       string `json:"mode"`
	RemoteRoot string `json:"remoteRoot,omitempty"`
	MarkerPath string `json:"markerPath,omitempty"`
	UpdatedAt  string `json:"updatedAt"`
}

// profileView 把存储档案投影为公开视图。
func profileView(profile sshprofile.Profile) RemoteSSHProfileView {
	return RemoteSSHProfileView{
		ID:         profile.ID,
		Host:       profile.Host,
		Port:       profile.Port,
		Username:   profile.Username,
		Mode:       profile.Mode,
		RemoteRoot: profile.RemoteRoot,
		MarkerPath: profile.MarkerPath,
		UpdatedAt:  profile.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
}

// remoteSSHProfileID 用连接身份派生稳定档案 id，同一目标重复连接只更新一条记录。
func remoteSSHProfileID(host string, port int, user, mode string) string {
	digest := sha256.Sum256([]byte(host + "\x00" + strconv.Itoa(port) + "\x00" + user + "\x00" + mode))
	return hex.EncodeToString(digest[:10])
}

// rememberRemoteProfile 在连接成功后记录可复用凭据，并把连接映射到档案 id。
// 此时还不知道远端根，等 marker 发布后由 rememberRemoteTarget 补齐。
func (s *Service) rememberRemoteProfile(info remoteagent.ConnectionInfo, authKind, secret string) error {
	if s.profiles == nil {
		return errors.New("SSH profile store is unavailable")
	}
	id := remoteSSHProfileID(info.TargetHost, info.TargetPort, info.TargetUser, string(info.Mode))
	profile := sshprofile.Profile{
		ID:        id,
		Host:      info.TargetHost,
		Port:      info.TargetPort,
		Username:  info.TargetUser,
		Mode:      string(info.Mode),
		AuthKind:  authKind,
		UpdatedAt: time.Now(),
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.profiles.Save(ctx, profile, secret); err != nil {
		return err
	}
	s.remoteMarkerMu.Lock()
	defer s.remoteMarkerMu.Unlock()
	if s.remoteProfiles == nil {
		s.remoteProfiles = make(map[string]string)
	}
	s.remoteProfiles[info.ID] = id
	return nil
}

// rememberRemoteTargetLocked 在 marker 发布成功后补记远端根与 marker 路径，
// 使重新打开这个工作区能找到档案。调用方必须持有 remoteMarkerMu；失败不撤销
// 已经提交的 marker。
func (s *Service) rememberRemoteTargetLocked(connectionID, markerRoot, remoteRoot string) {
	if s.profiles == nil {
		return
	}
	id, known := s.remoteProfiles[connectionID]
	if !known {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.profiles.UpdateTarget(ctx, id, remoteRoot, markerRoot, time.Now()); err != nil && s.onCleanupError != nil {
		s.onCleanupError(err)
	}
}

// RemoteSSHProfiles 列出已保存的连接档案，供工作区自动重连与设置界面使用。
func (s *Service) RemoteSSHProfiles() ([]RemoteSSHProfileView, error) {
	if s.profiles == nil {
		return nil, errors.New("SSH profile store is unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	profiles, err := s.profiles.List(ctx)
	if err != nil {
		return nil, err
	}
	views := make([]RemoteSSHProfileView, 0, len(profiles))
	for _, profile := range profiles {
		views = append(views, profileView(profile))
	}
	return views, nil
}

// RemoteSSHForgetProfile 删除一条连接档案及其密文；不影响已经建立的工作区 marker。
func (s *Service) RemoteSSHForgetProfile(id string) error {
	if s.profiles == nil {
		return errors.New("SSH profile store is unavailable")
	}
	if !validOpaqueID(id) {
		return errors.New("SSH profile id is invalid")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := s.profiles.Delete(ctx, id)
	if errors.Is(err, sshprofile.ErrProfileNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	s.remoteMarkerMu.Lock()
	defer s.remoteMarkerMu.Unlock()
	for connectionID, profileID := range s.remoteProfiles {
		if profileID == id {
			delete(s.remoteProfiles, connectionID)
		}
	}
	return nil
}

// liveProfileConnection 找出该档案当前登记过的一条仍然可用的连接，供重连快路径
// 复用。marker 只能绑定仍然活着的连接，因此先用 manager 的摘要核验一次身份；
// 连接已关闭或已被清理时返回 false，调用方继续完整重连。
func (s *Service) liveProfileConnection(profileID string) (remoteagent.ConnectionInfo, bool) {
	s.remoteMarkerMu.Lock()
	candidates := make([]string, 0, len(s.remoteProfiles))
	for connectionID, id := range s.remoteProfiles {
		if id == profileID {
			candidates = append(candidates, connectionID)
		}
	}
	s.remoteMarkerMu.Unlock()
	for _, connectionID := range candidates {
		if info, err := s.remoteManager.Connection(connectionID); err == nil {
			return info, true
		}
	}
	return remoteagent.ConnectionInfo{}, false
}

// RemoteSSHReconnectWorkspace 复用工作区已发布的活连接；不可用时只允许用该工作区的保存档案重连。
func (s *Service) RemoteSSHReconnectWorkspace(markerPath string) (RemoteSSHConnectResult, error) {
	if strings.TrimSpace(markerPath) == "" || len(markerPath) > remoteSSHMaxPathBytes || strings.ContainsRune(markerPath, '\x00') {
		return RemoteSSHConnectResult{}, errors.New("remote workspace path is invalid")
	}
	ctx, cancel := context.WithTimeout(s.bindingContext(), remoteReconnectTimeout)
	defer cancel()
	if info, ok := s.liveWorkspaceConnection(ctx, markerPath); ok {
		return RemoteSSHConnectResult{Kind: "ready", ConnectionID: info.ID, Mode: info.Mode, HomePath: info.RemoteHome}, nil
	}
	if err := ctx.Err(); err != nil {
		return RemoteSSHConnectResult{}, err
	}
	if s.profiles == nil {
		return RemoteSSHConnectResult{}, errors.New("SSH profile store is unavailable")
	}
	profile, err := s.profiles.FindByMarker(ctx, markerPath)
	if err != nil {
		return RemoteSSHConnectResult{}, err
	}
	// marker 不可复用时，先尝试在档案的现有连接上恢复路由，再尝试重新握手。
	if info, ok := s.liveProfileConnection(profile.ID); ok && info.Mode == remoteagent.ConnectionMode(profile.Mode) {
		if selection, err := s.selectDirectory(info.ID, profile.RemoteRoot, nil); err == nil && selection.MarkerPath == markerPath {
			s.remoteMarkerMu.Lock()
			if s.remoteProfiles == nil {
				s.remoteProfiles = make(map[string]string)
			}
			s.remoteProfiles[info.ID] = profile.ID
			s.remoteMarkerMu.Unlock()
			return RemoteSSHConnectResult{Kind: "ready", ConnectionID: info.ID, Mode: info.Mode, HomePath: info.RemoteHome}, nil
		}
	}
	authKind, secret, err := s.profiles.Secret(ctx, profile.ID)
	if err != nil {
		return RemoteSSHConnectResult{}, err
	}
	request := remoteagent.ConnectRequest{
		Mode: remoteagent.ConnectionMode(profile.Mode),
		Host: profile.Host,
		Port: profile.Port,
		User: profile.Username,
	}
	switch authKind {
	case "password":
		request.Auth.Password = secret
	case "privateKey":
		request.Auth.PrivateKey = secret
	default:
		return RemoteSSHConnectResult{}, errors.New("SSH profile authentication kind is invalid")
	}
	info, err := s.remoteManager.Connect(ctx, request)
	if err != nil {
		return remoteSSHFailure(err), nil
	}
	s.remoteMarkerMu.Lock()
	if s.remoteProfiles == nil {
		s.remoteProfiles = make(map[string]string)
	}
	s.remoteProfiles[info.ID] = profile.ID
	s.remoteMarkerMu.Unlock()
	selection, err := s.selectDirectory(info.ID, profile.RemoteRoot, nil)
	if err != nil || selection.MarkerPath != markerPath {
		closeCtx, closeCancel := context.WithTimeout(context.WithoutCancel(ctx), remoteCloseTimeout)
		_ = s.remoteManager.Close(closeCtx, info.ID)
		closeCancel()
		if err == nil {
			err = fmt.Errorf("remote workspace %q no longer matches its saved root", markerPath)
		}
		return remoteSSHFailure(err), nil
	}
	return RemoteSSHConnectResult{Kind: "ready", ConnectionID: info.ID, Mode: info.Mode, HomePath: info.RemoteHome}, nil
}

// liveWorkspaceConnection 在选择事务锁下核对当前路由。仅复用同一世代，避免等待旧对话的远端请求。
func (s *Service) liveWorkspaceConnection(ctx context.Context, markerPath string) (remoteagent.ConnectionInfo, bool) {
	s.remoteMarkerMu.Lock()
	defer s.remoteMarkerMu.Unlock()
	connectionID, published := s.remoteMarkers[markerPath]
	if !published {
		return remoteagent.ConnectionInfo{}, false
	}
	if canonical, err := filepath.EvalSymlinks(markerPath); err != nil || canonical != markerPath {
		return remoteagent.ConnectionInfo{}, false
	}
	marker, err := readRemoteWorkspaceMarker(markerPath, "")
	if err != nil || marker == nil || marker.Version != 3 || marker.ConnectionID != connectionID {
		return remoteagent.ConnectionInfo{}, false
	}
	identity := MarkerIdentity{MarkerRoot: markerPath, RemoteRoot: marker.RemoteRoot, ConnectionID: connectionID, Generation: marker.Generation}
	var info remoteagent.ConnectionInfo
	current := s.remoteBridge.CurrentMarker(ctx, identity, func() bool {
		var lookupErr error
		info, lookupErr = s.remoteManager.Connection(connectionID)
		return ctx.Err() == nil && lookupErr == nil && info.ID == connectionID && info.Mode == marker.Mode
	})
	return info, current
}
