// Coding opens the existing local Web application in a native WebView.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"

	"github.com/deepseek-ai/coding/apps/desktop/internal/chrome"
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

	window := webview.New(debug)
	defer window.Destroy()
	window.SetTitle(applicationName)
	window.SetSize(1280, 860, webview.HintNone)
	window.SetHtml(splashHTML("正在准备 Coding"))
	chrome.Decorate(window)
	// 无边框样式下交通灯浮在页面上方；注入统一安全区变量，真实页面与启动页共用。
	window.Init(chrome.PageSafeAreaScript())
	ready := make(chan hostlaunch.Endpoint, 1)
	failed := make(chan error, 1)
	go func() {
		endpoint, err := launcher.Ensure(context.Background())
		if err != nil {
			failed <- err
			return
		}
		ready <- endpoint
	}()
	readyThen := make(chan hostlaunch.Endpoint, 1)
	// 菜单"新建会话"→ 模拟点击侧边栏的新建按钮；选择器失败时无副作用。
	newSessionJS := `(() => {
		const button = document.querySelector('[aria-label="新建会话"], [aria-label="New session"], [aria-label="New Session"]');
		if (button instanceof HTMLElement) button.click();
	})()`
	chrome.OnNewSession(func() {
		window.Dispatch(func() { window.Eval(newSessionJS) })
	})
	go lock.Serve(func() {
		// webview_go 无导出的窗口句柄；激活时刷新导航即可把窗口带回前台界面。
		if endpoint := <-readyThen; endpoint.BaseURL != "" {
			window.Navigate(endpoint.BaseURL)
		}
	})
	select {
	case endpoint := <-ready:
		readyThen <- endpoint
		window.Navigate(endpoint.BaseURL)
	case err := <-failed:
		window.Dispatch(func() { window.Navigate(errorHTML(err)) })
	}
	window.Run()
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, applicationName+":", err)
	os.Exit(1)
}
