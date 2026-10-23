// Package sshprofile 持久化 Remote-SSH 连接档案与加密后的认证材料。
//
// 档案写在 `$DSH_HOME/ssh_config.yaml`：主机、端口、用户名、模式、远端根和
// marker 路径是明文，密码或私钥只以 AES-256-GCM 密文落盘。主密钥是
// `$DSH_HOME/remote-ssh/master.key`（首次使用时生成，0600），因此密文不能
// 脱离本机本用户解读，也不会随配置目录同步泄漏。局限：主密钥与密文同机同
// 用户，能防误同步与误提交，不防已能以该用户身份读取文件的本地进程。
package sshprofile

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"
)

const (
	// ConfigName 是档案文件在 DSH home 下的固定文件名。
	ConfigName = "ssh_config.yaml"
	// masterKeyName 是主密钥相对 DSH home 的路径。
	masterKeyName        = "remote-ssh/master.key"
	documentVersion      = 1
	secretPrefix         = "v1:"
	masterKeyBytes       = 32
	maxConfigBytes       = 1 << 20
	maxSecretBytes       = 64 << 10
	maxHostBytes         = 255
	maxUsernameBytes     = 255
	maxRemoteRootBytes   = 4096
	maxMarkerPathBytes   = 4096
	maxProfiles          = 128
	defaultConfigMode    = 0o600
	privateDirectoryMode = 0o700
)

// ErrProfileNotFound 表示请求的连接档案不存在。
var ErrProfileNotFound = errors.New("ssh profile not found")

// Profile 是不含机密的连接档案快照。
type Profile struct {
	ID         string
	Host       string
	Port       int
	Username   string
	Mode       string
	AuthKind   string
	RemoteRoot string
	MarkerPath string
	UpdatedAt  time.Time
}

// Store 是 `$DSH_HOME/ssh_config.yaml` 的唯一读写入口；同一进程内串行发布。
type Store struct {
	path    string
	keyPath string
	mu      sync.Mutex
}

type document struct {
	Version  int     `yaml:"version"`
	Profiles []entry `yaml:"profiles"`
}

type entry struct {
	ID         string `yaml:"id"`
	Host       string `yaml:"host"`
	Port       int    `yaml:"port"`
	Username   string `yaml:"username"`
	Mode       string `yaml:"mode"`
	AuthKind   string `yaml:"authKind"`
	RemoteRoot string `yaml:"remoteRoot"`
	MarkerPath string `yaml:"markerPath"`
	Secret     string `yaml:"secret"`
	UpdatedAt  string `yaml:"updatedAt"`
}

// Open 绑定 DSH home 下的档案与主密钥路径，不做任何 I/O。
func Open(home string) (*Store, error) {
	if strings.TrimSpace(home) == "" {
		return nil, errors.New("ssh profile store requires a home directory")
	}
	absolute, err := filepath.Abs(home)
	if err != nil {
		return nil, fmt.Errorf("resolve DSH home: %w", err)
	}
	return &Store{
		path:    filepath.Join(absolute, ConfigName),
		keyPath: filepath.Join(absolute, filepath.FromSlash(masterKeyName)),
	}, nil
}

// ConfigPath 返回档案文件路径，供诊断与测试使用。
func (s *Store) ConfigPath() string { return s.path }

// List 返回按更新时间倒序排列的档案；文件缺失视为空集合。
func (s *Store) List(ctx context.Context) ([]Profile, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	doc, err := s.read()
	if err != nil {
		return nil, err
	}
	profiles := make([]Profile, 0, len(doc.Profiles))
	for _, item := range doc.Profiles {
		profile, err := profileOf(item)
		if err != nil {
			return nil, err
		}
		profiles = append(profiles, profile)
	}
	sort.SliceStable(profiles, func(left, right int) bool {
		return profiles[left].UpdatedAt.After(profiles[right].UpdatedAt)
	})
	return profiles, nil
}

// Find 返回一个档案；不存在时返回 ErrProfileNotFound。
func (s *Store) Find(ctx context.Context, id string) (Profile, error) {
	profiles, err := s.List(ctx)
	if err != nil {
		return Profile{}, err
	}
	for _, profile := range profiles {
		if profile.ID == id {
			return profile, nil
		}
	}
	return Profile{}, ErrProfileNotFound
}

// FindByMarker 按自身创建的 marker 目录反查档案，供打开已有远端工作区时重连。
func (s *Store) FindByMarker(ctx context.Context, markerPath string) (Profile, error) {
	if strings.TrimSpace(markerPath) == "" {
		return Profile{}, ErrProfileNotFound
	}
	profiles, err := s.List(ctx)
	if err != nil {
		return Profile{}, err
	}
	for _, profile := range profiles {
		if profile.MarkerPath != "" && profile.MarkerPath == markerPath {
			return profile, nil
		}
	}
	return Profile{}, ErrProfileNotFound
}

// Secret 解密指定档案的认证材料。返回的字节只在调用方内存中存在。
func (s *Store) Secret(ctx context.Context, id string) (string, string, error) {
	if err := ctx.Err(); err != nil {
		return "", "", err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	doc, err := s.read()
	if err != nil {
		return "", "", err
	}
	for _, item := range doc.Profiles {
		if item.ID != id {
			continue
		}
		if _, err := profileOf(item); err != nil {
			return "", "", err
		}
		key, err := s.masterKey()
		if err != nil {
			return "", "", err
		}
		secret, err := open(key, item.ID, item.Secret)
		if err != nil {
			return "", "", err
		}
		return item.AuthKind, secret, nil
	}
	return "", "", ErrProfileNotFound
}

// Save 以 id 为键新增或替换一条档案；secret 只以密文落盘。
func (s *Store) Save(ctx context.Context, profile Profile, secret string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateProfile(profile); err != nil {
		return err
	}
	if len(secret) == 0 || len(secret) > maxSecretBytes {
		return errors.New("ssh profile secret has an unsupported length")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	doc, err := s.read()
	if err != nil {
		return err
	}
	key, err := s.ensureMasterKey()
	if err != nil {
		return err
	}
	sealed, err := seal(key, profile.ID, secret)
	if err != nil {
		return err
	}
	replacement := entry{
		ID:         profile.ID,
		Host:       profile.Host,
		Port:       profile.Port,
		Username:   profile.Username,
		Mode:       profile.Mode,
		AuthKind:   profile.AuthKind,
		RemoteRoot: profile.RemoteRoot,
		MarkerPath: profile.MarkerPath,
		Secret:     sealed,
		UpdatedAt:  profile.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}
	replaced := false
	for index, item := range doc.Profiles {
		if item.ID == profile.ID {
			doc.Profiles[index] = replacement
			replaced = true
			break
		}
	}
	if !replaced {
		if len(doc.Profiles) >= maxProfiles {
			return errors.New("ssh profile store reached its profile limit")
		}
		doc.Profiles = append(doc.Profiles, replacement)
	}
	return s.write(doc)
}

// UpdateTarget 只改写工作区定位字段，保留既有密文；用于连接建立后补记远端根。
func (s *Store) UpdateTarget(ctx context.Context, id, remoteRoot, markerPath string, updatedAt time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	doc, err := s.read()
	if err != nil {
		return err
	}
	for index, item := range doc.Profiles {
		if item.ID != id {
			continue
		}
		profile, err := profileOf(item)
		if err != nil {
			return err
		}
		profile.RemoteRoot = remoteRoot
		profile.MarkerPath = markerPath
		if !updatedAt.IsZero() {
			profile.UpdatedAt = updatedAt
		}
		if err := validateProfile(profile); err != nil {
			return err
		}
		doc.Profiles[index].RemoteRoot = profile.RemoteRoot
		doc.Profiles[index].MarkerPath = profile.MarkerPath
		doc.Profiles[index].UpdatedAt = profile.UpdatedAt.UTC().Format(time.RFC3339Nano)
		return s.write(doc)
	}
	return ErrProfileNotFound
}

// Delete 移除一条档案；不存在时返回 ErrProfileNotFound。
func (s *Store) Delete(ctx context.Context, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	doc, err := s.read()
	if err != nil {
		return err
	}
	kept := doc.Profiles[:0]
	removed := false
	for _, item := range doc.Profiles {
		if item.ID == id {
			removed = true
			continue
		}
		kept = append(kept, item)
	}
	if !removed {
		return ErrProfileNotFound
	}
	doc.Profiles = kept
	return s.write(doc)
}

// read 解析档案文件；文件不存在时返回空文档。调用方必须持有 s.mu。
func (s *Store) read() (document, error) {
	info, err := os.Lstat(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return document{Version: documentVersion, Profiles: []entry{}}, nil
	}
	if err != nil {
		return document{}, fmt.Errorf("inspect ssh profile store: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return document{}, errors.New("ssh profile store must be a regular file")
	}
	if info.Size() > maxConfigBytes {
		return document{}, errors.New("ssh profile store is too large")
	}
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return document{}, fmt.Errorf("read ssh profile store: %w", err)
	}
	doc := document{}
	decoder := yaml.NewDecoder(strings.NewReader(string(raw)))
	decoder.KnownFields(true)
	if err := decoder.Decode(&doc); err != nil {
		return document{}, fmt.Errorf("parse ssh profile store: %w", err)
	}
	if doc.Version != documentVersion {
		return document{}, fmt.Errorf("ssh profile store version %d is unsupported", doc.Version)
	}
	if len(doc.Profiles) > maxProfiles {
		return document{}, errors.New("ssh profile store has too many profiles")
	}
	seen := make(map[string]struct{}, len(doc.Profiles))
	for _, item := range doc.Profiles {
		if _, err := profileOf(item); err != nil {
			return document{}, err
		}
		if _, exists := seen[item.ID]; exists {
			return document{}, errors.New("ssh profile store contains a duplicate id")
		}
		seen[item.ID] = struct{}{}
	}
	return doc, nil
}

// write 原子替换档案文件：临时文件以 0600 创建后 rename。
func (s *Store) write(doc document) error {
	if doc.Version == 0 {
		doc.Version = documentVersion
	}
	encoded, err := yaml.Marshal(doc)
	if err != nil {
		return fmt.Errorf("encode ssh profile store: %w", err)
	}
	if len(encoded) > maxConfigBytes {
		return errors.New("ssh profile store is too large")
	}
	return writeAtomic(s.path, encoded)
}

// masterKey 读取既有主密钥；缺失时失败，不隐式创建。
func (s *Store) masterKey() ([]byte, error) {
	info, err := os.Lstat(s.keyPath)
	if err != nil {
		return nil, fmt.Errorf("inspect ssh master key: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("ssh master key must be a regular file")
	}
	if err := requirePrivateMode(info.Mode()); err != nil {
		return nil, err
	}
	key, err := os.ReadFile(s.keyPath)
	if err != nil {
		return nil, fmt.Errorf("read ssh master key: %w", err)
	}
	if len(key) != masterKeyBytes {
		return nil, errors.New("ssh master key has an unsupported length")
	}
	return key, nil
}

// ensureMasterKey 读取或首次生成主密钥；调用方必须持有 s.mu。
func (s *Store) ensureMasterKey() ([]byte, error) {
	key, err := s.masterKey()
	if err == nil {
		return key, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	directory := filepath.Dir(s.keyPath)
	if err := os.MkdirAll(directory, privateDirectoryMode); err != nil {
		return nil, fmt.Errorf("create ssh master key directory: %w", err)
	}
	if err := os.Chmod(directory, privateDirectoryMode); err != nil {
		return nil, fmt.Errorf("secure ssh master key directory: %w", err)
	}
	fresh := make([]byte, masterKeyBytes)
	if _, err := rand.Read(fresh); err != nil {
		return nil, fmt.Errorf("generate ssh master key: %w", err)
	}
	if err := writeAtomic(s.keyPath, fresh); err != nil {
		return nil, err
	}
	return fresh, nil
}

// writeAtomic 在目标目录内写入临时文件后 rename，避免半写状态被读到。
func writeAtomic(path string, content []byte) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, privateDirectoryMode); err != nil {
		return fmt.Errorf("create ssh profile directory: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".coding-ssh-profile-")
	if err != nil {
		return fmt.Errorf("create ssh profile temporary file: %w", err)
	}
	name := temporary.Name()
	defer func() { _ = os.Remove(name) }()
	if err := temporary.Chmod(defaultConfigMode); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("secure ssh profile temporary file: %w", err)
	}
	if _, err := temporary.Write(content); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("write ssh profile store: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("flush ssh profile store: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close ssh profile store: %w", err)
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("publish ssh profile store: %w", err)
	}
	return nil
}

// requirePrivateMode 拒绝把主密钥暴露给同机其他用户的状态。
func requirePrivateMode(mode os.FileMode) error {
	if mode.Perm()&0o077 != 0 {
		return errors.New("ssh master key permissions must not allow group or other access")
	}
	return nil
}

// profileOf 把存储记录转换为已校验的档案。
func profileOf(item entry) (Profile, error) {
	updatedAt, err := time.Parse(time.RFC3339Nano, item.UpdatedAt)
	if err != nil {
		return Profile{}, errors.New("ssh profile timestamp is invalid")
	}
	profile := Profile{
		ID:         item.ID,
		Host:       item.Host,
		Port:       item.Port,
		Username:   item.Username,
		Mode:       item.Mode,
		AuthKind:   item.AuthKind,
		RemoteRoot: item.RemoteRoot,
		MarkerPath: item.MarkerPath,
		UpdatedAt:  updatedAt,
	}
	if err := validateProfile(profile); err != nil {
		return Profile{}, err
	}
	if !strings.HasPrefix(item.Secret, secretPrefix) || len(item.Secret) > maxSecretBytes*2 {
		return Profile{}, errors.New("ssh profile secret is invalid")
	}
	return profile, nil
}

// validateProfile 在一个地方约束档案字段，读写两侧共用。
func validateProfile(profile Profile) error {
	if profile.ID == "" || len(profile.ID) > 128 || !isOpaqueID(profile.ID) {
		return errors.New("ssh profile id is invalid")
	}
	if profile.Host == "" || len(profile.Host) > maxHostBytes || strings.ContainsAny(profile.Host, "\x00\t\n") {
		return errors.New("ssh profile host is invalid")
	}
	if profile.Port < 1 || profile.Port > 65535 {
		return errors.New("ssh profile port is invalid")
	}
	if profile.Username == "" || len(profile.Username) > maxUsernameBytes || strings.ContainsAny(profile.Username, "\x00\t\n") {
		return errors.New("ssh profile username is invalid")
	}
	if profile.Mode != "basic" && profile.Mode != "agent" {
		return errors.New("ssh profile mode is invalid")
	}
	if profile.AuthKind != "password" && profile.AuthKind != "privateKey" {
		return errors.New("ssh profile authentication kind is invalid")
	}
	if len(profile.RemoteRoot) > maxRemoteRootBytes || strings.ContainsRune(profile.RemoteRoot, '\x00') {
		return errors.New("ssh profile remote root is invalid")
	}
	if len(profile.MarkerPath) > maxMarkerPathBytes || strings.ContainsRune(profile.MarkerPath, '\x00') {
		return errors.New("ssh profile marker path is invalid")
	}
	if profile.UpdatedAt.IsZero() {
		return errors.New("ssh profile timestamp is required")
	}
	return nil
}

// isOpaqueID 只接受连接与档案 id 使用的可打印标识字符集。
func isOpaqueID(value string) bool {
	for _, character := range value {
		switch {
		case character >= 'a' && character <= 'z':
		case character >= 'A' && character <= 'Z':
		case character >= '0' && character <= '9':
		case character == '-', character == '_', character == '.':
		default:
			return false
		}
	}
	return true
}

// seal 用 AES-256-GCM 加密认证材料，档案 id 作为 AAD 阻止条目互换。
func seal(key []byte, id, secret string) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("initialize ssh secret cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("initialize ssh secret aead: %w", err)
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", fmt.Errorf("generate ssh secret nonce: %w", err)
	}
	sealed := aead.Seal(nonce, nonce, []byte(secret), []byte(id))
	return secretPrefix + base64.RawStdEncoding.EncodeToString(sealed), nil
}

// open 解密认证材料；密文被改动、换绑或主密钥不匹配时失败。
func open(key []byte, id, encoded string) (string, error) {
	if !strings.HasPrefix(encoded, secretPrefix) {
		return "", errors.New("ssh profile secret is invalid")
	}
	raw, err := base64.RawStdEncoding.DecodeString(strings.TrimPrefix(encoded, secretPrefix))
	if err != nil {
		return "", errors.New("ssh profile secret is invalid")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("initialize ssh secret cipher: %w", err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("initialize ssh secret aead: %w", err)
	}
	if len(raw) < aead.NonceSize()+aead.Overhead() {
		return "", errors.New("ssh profile secret is invalid")
	}
	plain, err := aead.Open(nil, raw[:aead.NonceSize()], raw[aead.NonceSize():], []byte(id))
	if err != nil {
		return "", errors.New("ssh profile secret cannot be decrypted")
	}
	return string(plain), nil
}
