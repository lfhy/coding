// Coding opens the existing local Web application in a native WebView.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/deepseek-ai/coding/apps/desktop/internal/instance"
	"github.com/deepseek-ai/coding/apps/desktop/internal/webview2"
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
	lock, primary, err := instance.Acquire(os.Args[1:])
	if err != nil {
		fatal(err)
	}
	if !primary {
		// 第二个实例的激活请求已转发给持锁进程，本进程直接退出。
		return
	}
	defer lock.Close()
	if runtime.GOOS == "windows" {
		if err := webview2.Check(); err != nil {
			fmt.Fprintln(os.Stderr, "Coding: 需要 WebView2 运行时。请安装:", "https://developer.microsoft.com/microsoft-edge/webview2/")
			os.Exit(1)
		}
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
	go lock.Serve(func() {
		// webview_go 无导出的窗口句柄；激活时刷新导航即可把窗口带回前台界面。
		window.Navigate(endpoint.BaseURL)
	})
	window.Run()
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, applicationName+":", err)
	os.Exit(1)
}
