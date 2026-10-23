package desktopremote

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
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

// RemoteSSHReconnectWorkspace 用已保存的凭据重连某个远端工作区，并把 marker
// 重新发布到新连接上。marker 路径必须与该档案记录的路径一致，否则拒绝，
// 避免把旧证书用到另一台主机。
func (s *Service) RemoteSSHReconnectWorkspace(markerPath string) (RemoteSSHConnectResult, error) {
	if s.profiles == nil {
		return RemoteSSHConnectResult{}, errors.New("SSH profile store is unavailable")
	}
	if strings.TrimSpace(markerPath) == "" || len(markerPath) > remoteSSHMaxPathBytes || strings.ContainsRune(markerPath, '\x00') {
		return RemoteSSHConnectResult{}, errors.New("remote workspace path is invalid")
	}
	ctx, cancel := context.WithTimeout(s.bindingContext(), remoteReconnectTimeout)
	defer cancel()
	profile, err := s.profiles.FindByMarker(ctx, markerPath)
	if err != nil {
		return RemoteSSHConnectResult{}, err
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
