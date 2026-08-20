// Package hostlaunch discovers and starts the local Coding Node Host.
package hostlaunch

import "time"

const (
	// Protocol is the version of host.json and the readiness record.
	Protocol = 1
	// DefaultStartupTimeout bounds a launch that never publishes readiness.
	DefaultStartupTimeout = 45 * time.Second
)

// Record is the JSON contract written by a managed Host.
type Record struct {
	Type     string `json:"type"`
	Port     int    `json:"port"`
	PID      int    `json:"pid"`
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
	Token    string `json:"token"`
}

// Endpoint identifies a live local Host and records whether this launcher
// started its process. The process is intentionally not killed when a client
// closes; the Host owns idle shutdown.
type Endpoint struct {
	Record  Record
	BaseURL string
	Started bool
}

// Options configures discovery and a fallback Host launch.
type Options struct {
	Home           string
	Version        string
	CWD            string
	Command        []string
	StartupTimeout time.Duration
	LockTimeout    time.Duration
	PollInterval   time.Duration
	// RuntimeRoot is the materialized SEA runtime directory. When set, its
	// coding-host executable is preferred over development fallbacks.
	RuntimeRoot string
}
