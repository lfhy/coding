package sshprofile

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testProfile(id string) Profile {
	return Profile{
		ID:         id,
		Host:       "example.com",
		Port:       22,
		Username:   "coding",
		Mode:       "basic",
		AuthKind:   "password",
		RemoteRoot: "/opt/project",
		MarkerPath: "/Users/me/.coding/remote-workspaces/abc/project-def",
		UpdatedAt:  time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC),
	}
}

func TestSaveWritesEncryptedSecret(t *testing.T) {
	home := t.TempDir()
	store, err := Open(home)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	ctx := context.Background()
	if err := store.Save(ctx, testProfile("p1"), "super-secret-password"); err != nil {
		t.Fatalf("save profile: %v", err)
	}
	raw, err := os.ReadFile(store.ConfigPath())
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	if strings.Contains(string(raw), "super-secret-password") {
		t.Fatalf("config file leaks the plaintext secret: %s", raw)
	}
	info, err := os.Stat(store.ConfigPath())
	if err != nil {
		t.Fatalf("stat config: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("config mode = %o, want 600", info.Mode().Perm())
	}
	keyInfo, err := os.Stat(filepath.Join(home, filepath.FromSlash(masterKeyName)))
	if err != nil {
		t.Fatalf("stat master key: %v", err)
	}
	if keyInfo.Mode().Perm() != 0o600 {
		t.Fatalf("master key mode = %o, want 600", keyInfo.Mode().Perm())
	}
}

func TestSecretRoundTripAndDelete(t *testing.T) {
	home := t.TempDir()
	store, err := Open(home)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	ctx := context.Background()
	profile := testProfile("p1")
	if err := store.Save(ctx, profile, "key-material"); err != nil {
		t.Fatalf("save profile: %v", err)
	}
	kind, secret, err := store.Secret(ctx, "p1")
	if err != nil {
		t.Fatalf("read secret: %v", err)
	}
	if kind != "password" || secret != "key-material" {
		t.Fatalf("secret round trip = %q/%q", kind, secret)
	}
	found, err := store.FindByMarker(ctx, profile.MarkerPath)
	if err != nil {
		t.Fatalf("find by marker: %v", err)
	}
	if found.ID != "p1" {
		t.Fatalf("marker lookup returned %q", found.ID)
	}
	if err := store.Delete(ctx, "p1"); err != nil {
		t.Fatalf("delete profile: %v", err)
	}
	if _, err := store.Find(ctx, "p1"); !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("find after delete: %v", err)
	}
	if _, _, err := store.Secret(ctx, "p1"); !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("secret after delete: %v", err)
	}
	if err := store.Delete(ctx, "p1"); !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("repeat delete: %v", err)
	}
}

func TestSecretCannotBeRebound(t *testing.T) {
	home := t.TempDir()
	store, err := Open(home)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	ctx := context.Background()
	first := testProfile("p1")
	second := testProfile("p2")
	second.MarkerPath = "/Users/me/.coding/remote-workspaces/abc/other-ghi"
	second.UpdatedAt = first.UpdatedAt.Add(time.Minute)
	if err := store.Save(ctx, first, "first-secret"); err != nil {
		t.Fatalf("save first: %v", err)
	}
	if err := store.Save(ctx, second, "second-secret"); err != nil {
		t.Fatalf("save second: %v", err)
	}
	// 把 p2 的密文搬到 p1：AAD 绑定 id，必须解不开。
	raw, err := os.ReadFile(store.ConfigPath())
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	lines := strings.Split(string(raw), "\n")
	index := -1
	for position, line := range lines {
		if strings.Contains(line, "id: p2") {
			index = position
			break
		}
	}
	if index < 0 {
		t.Fatalf("second profile missing from config: %s", raw)
	}
	var secondSecret string
	for _, line := range lines[index:] {
		if trimmed := strings.TrimSpace(line); strings.HasPrefix(trimmed, "secret: ") {
			secondSecret = strings.TrimPrefix(trimmed, "secret: ")
			break
		}
	}
	if secondSecret == "" {
		t.Fatalf("second profile has no secret: %s", raw)
	}
	for position, line := range lines {
		if strings.Contains(line, "id: p1") {
			// 用 p2 的密文覆盖 p1 的密文行。
			for offset := position; offset < len(lines); offset++ {
				if strings.HasPrefix(strings.TrimSpace(lines[offset]), "secret: ") {
					lines[offset] = "    secret: " + secondSecret
					break
				}
			}
			break
		}
	}
	swapped := strings.Join(lines, "\n")
	if err := os.WriteFile(store.ConfigPath(), []byte(swapped), 0o600); err != nil {
		t.Fatalf("rewrite config: %v", err)
	}
	if _, _, err := store.Secret(ctx, "p1"); err == nil {
		t.Fatal("rebinding a secret to another profile must fail")
	}
}

func TestTamperedCiphertextIsRejected(t *testing.T) {
	home := t.TempDir()
	store, err := Open(home)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	ctx := context.Background()
	if err := store.Save(ctx, testProfile("p1"), "secret"); err != nil {
		t.Fatalf("save profile: %v", err)
	}
	raw, err := os.ReadFile(store.ConfigPath())
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	tampered := strings.Replace(string(raw), "secret: v1:", "secret: v1:A", 1)
	if tampered == string(raw) {
		t.Fatalf("unexpected config shape: %s", raw)
	}
	if err := os.WriteFile(store.ConfigPath(), []byte(tampered), 0o600); err != nil {
		t.Fatalf("rewrite config: %v", err)
	}
	if _, _, err := store.Secret(ctx, "p1"); err == nil {
		t.Fatal("tampered ciphertext must not decrypt")
	}
}

func TestMasterKeyPermissionsAreEnforced(t *testing.T) {
	home := t.TempDir()
	store, err := Open(home)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	ctx := context.Background()
	if err := store.Save(ctx, testProfile("p1"), "secret"); err != nil {
		t.Fatalf("save profile: %v", err)
	}
	keyPath := filepath.Join(home, filepath.FromSlash(masterKeyName))
	if err := os.Chmod(keyPath, 0o644); err != nil {
		t.Fatalf("chmod master key: %v", err)
	}
	if _, _, err := store.Secret(ctx, "p1"); err == nil {
		t.Fatal("group readable master key must be rejected")
	}
}

func TestUnknownFieldIsRejected(t *testing.T) {
	home := t.TempDir()
	store, err := Open(home)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	body := "version: 1\nprofiles: []\nunexpected: true\n"
	if err := os.WriteFile(store.ConfigPath(), []byte(body), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if _, err := store.List(context.Background()); err == nil {
		t.Fatal("unknown fields must be rejected")
	}
}

func TestMissingFileIsEmptyStore(t *testing.T) {
	home := t.TempDir()
	store, err := Open(home)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	profiles, err := store.List(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(profiles) != 0 {
		t.Fatalf("empty store returned %d profiles", len(profiles))
	}
	if _, _, err := store.Secret(context.Background(), "missing"); !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("missing secret: %v", err)
	}
}
