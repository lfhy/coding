package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestDesktopDevelopmentIdentity(t *testing.T) {
	if isDevelopmentBuild {
		if got := desktopInstanceID(); got != "com.coding.desktop.dev" {
			t.Fatalf("desktopInstanceID() = %q, want development ID", got)
		}
		if got := desktopWindowTitle(); got != "Coding Dev" {
			t.Fatalf("desktopWindowTitle() = %q, want Coding Dev", got)
		}
		if got := packagedRuntimeRoot(); got != "" {
			t.Fatalf("packagedRuntimeRoot() = %q, want no packaged Host", got)
		}
		return
	}
	if got := desktopInstanceID(); got != "com.coding.desktop" {
		t.Fatalf("desktopInstanceID() = %q, want production ID", got)
	}
	if got := desktopWindowTitle(); got != applicationName {
		t.Fatalf("desktopWindowTitle() = %q, want %q", got, applicationName)
	}
}

func TestDesktopHomeUsesBuildSpecificDirectory(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	got, err := desktopHome()
	if err != nil {
		t.Fatal(err)
	}
	directory := ".dsh"
	if isDevelopmentBuild {
		directory = ".dsh-dev"
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(home, directory); got != want {
		t.Fatalf("desktopHome() = %q, want %q", got, want)
	}
}

func TestDesktopHostCommandUsesRepositorySource(t *testing.T) {
	got, err := desktopHostCommand()
	if err != nil {
		t.Fatal(err)
	}
	if !isDevelopmentBuild {
		if got != nil {
			t.Fatalf("desktopHostCommand() = %v, want default Host discovery", got)
		}
		return
	}
	root, err := findProjectRoot()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"node", "--import", "tsx/esm", filepath.Join(root, "apps", "cli", "src", "bin.ts"), "web", "--coding-host"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("desktopHostCommand() = %v, want %v", got, want)
	}
}

func TestDesktopWindowInsets(t *testing.T) {
	tests := []struct {
		name     string
		platform string
		top      string
		right    string
	}{
		{name: "macOS traffic lights", platform: "darwin", top: "38px", right: "0px"},
		{name: "Windows titlebar controls", platform: "windows", top: "0px", right: "138px"},
		{name: "Linux native titlebar", platform: "linux", top: "0px", right: "0px"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			top, right := desktopWindowInsets(test.platform)
			if top != test.top || right != test.right {
				t.Fatalf("desktopWindowInsets(%q) = (%q, %q), want (%q, %q)", test.platform, top, right, test.top, test.right)
			}
		})
	}
}
