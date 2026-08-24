package main

import "testing"

func TestHostCompatibilityVersion(t *testing.T) {
	if got, want := hostCompatibilityVersion("0.1.0", "abc123"), "0.1.0+abc123"; got != want {
		t.Errorf("hostCompatibilityVersion() = %q, want %q", got, want)
	}
	if got, want := hostCompatibilityVersion("0.1.0", ""), "0.1.0"; got != want {
		t.Errorf("hostCompatibilityVersion() = %q, want %q", got, want)
	}
}
