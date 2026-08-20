// Coding opens the existing local Web application in a native WebView.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/deepseek-ai/coding/apps/internal/hostlaunch"
	webview "github.com/webview/webview_go"
)

const applicationName = "Coding"

func main() {
	var cwd string
	var debug bool
	flag.StringVar(&cwd, "cwd", "", "default workspace directory")
	flag.BoolVar(&debug, "debug", false, "enable WebView developer tools")
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

	window := webview.New(debug)
	defer window.Destroy()
	window.SetTitle(applicationName)
	window.SetSize(1280, 860, webview.HintNone)
	window.Navigate(endpoint.BaseURL)
	window.Run()
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, applicationName+":", err)
	os.Exit(1)
}
