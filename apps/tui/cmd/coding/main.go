// coding is the Linux interactive client for the local Coding Host.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/deepseek-ai/coding/apps/internal/hostlaunch"
	"github.com/deepseek-ai/coding/apps/tui/internal/tui"
)

func main() {
	var cwd string
	flag.StringVar(&cwd, "cwd", "", "default workspace directory")
	flag.Parse()
	if cwd != "" {
		absolute, err := filepath.Abs(cwd)
		if err != nil {
			fatal(err)
		}
		cwd = absolute
	}
	launcher, err := hostlaunch.New(hostlaunch.Options{CWD: cwd})
	if err != nil {
		fatal(err)
	}
	endpoint, err := launcher.Ensure(context.Background())
	if err != nil {
		fatal(err)
	}
	program := tea.NewProgram(tui.NewModel(tui.NewClient(endpoint.BaseURL)), tea.WithAltScreen())
	if _, err := program.Run(); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, "coding:", err)
	os.Exit(1)
}
