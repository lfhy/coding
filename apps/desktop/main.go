// Coding Wails 桌面壳：窗口、菜单、单实例与 Host 启动编排。
package main

import (
	"context"
	"embed"
	"flag"
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	"github.com/deepseek-ai/coding/apps/desktop/internal/instance"
	"github.com/deepseek-ai/coding/apps/internal/hostlaunch"
	"github.com/wailsapp/wails/v2"
	wmenu "github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

/*
#cgo darwin LDFLAGS: -framework UniformTypeIdentifiers
*/
import "C"

//go:embed all:frontend
var assets embed.FS

const applicationName = "Coding"

// App 承载 Wails 绑定与窗口/运行时引用。
type App struct {
	ctx      context.Context
	launcher *hostlaunch.Launcher
	endpoint *url.URL
	ready    chan struct{}
}

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
	lock, primary, err := instance.Acquire(os.Args[1:])
	if err != nil {
		fatal(err)
	}
	if !primary {
		// 第二个实例的激活请求已转发给持锁进程，本进程直接退出。
		return
	}
	defer lock.Close()

	launcher, err := hostlaunch.New(hostlaunch.Options{CWD: cwd})
	if err != nil {
		fatal(err)
	}
	app := &App{launcher: launcher, ready: make(chan struct{})}

	menu := wmenu.NewMenu()
	fileMenu := menu.AddSubmenu("文件")
	fileMenu.AddText("新建会话", keys.CmdOrCtrl("n"), func(*wmenu.CallbackData) {
		app.dispatchNewSession()
	})
	fileMenu.AddSeparator()
	fileMenu.AddText("关闭窗口", keys.CmdOrCtrl("w"), nil)

	err = wails.Run(&options.App{
		Title:            applicationName,
		Width:            1280,
		Height:           860,
		MinWidth:         720,
		MinHeight:        480,
		BackgroundColour: &options.RGBA{R: 245, G: 245, B: 247, A: 1},
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "ai.deepseek.coding.desktop",
			OnSecondInstanceLaunch: func(_ options.SecondInstanceData) {
				app.focusPrimary()
			},
		},
		AssetServer: &assetserver.Options{
			// 纯静态壳：只服务内嵌启动页；Host 就绪后整窗导航到回环 URL，
			// 不经壳层转发任何 /api 流量。
			Assets: assets,
		},
		Mac: &mac.Options{
			TitleBar: &mac.TitleBar{
				TitlebarAppearsTransparent: true,
				HideTitle:                  true,
				FullSizeContent:            true,
			},
			About:                &mac.AboutInfo{Title: applicationName, Message: "Coding"},
			WebviewIsTransparent: false,
			Appearance:           mac.DefaultAppearance,
		},
		Menu: menu,
		OnStartup: func(ctx context.Context) {
			app.ctx = ctx
			go app.startHost(ctx)
		},
		Bind: []interface{}{app},
	})
	if err != nil {
		fatal(err)
	}
}

// startHost 在窗口就绪后启动或连接共享 Host，解析 endpoint 后整窗导航。
func (a *App) startHost(ctx context.Context) {
	endpoint, err := a.launcher.Ensure(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, applicationName+":", err)
		return
	}
	parsed, perr := url.Parse(endpoint.BaseURL)
	if perr != nil {
		fmt.Fprintln(os.Stderr, applicationName+":", perr)
		return
	}
	a.endpoint = parsed
	close(a.ready)
}

// Endpoint 暴露给启动页轮询：就绪后由前端主动跳转，与后台导航互为兜底。
func (a *App) Endpoint() string {
	select {
	case <-a.ready:
		return a.endpoint.String() + "/"
	default:
		return ""
	}
}

func (a *App) dispatchNewSession() {
	// 与 Web 端同一动作：模拟点击侧边栏"新建会话"按钮；选择器失败无副作用。
	wailsruntime.WindowExecJS(a.ctx, `(() => {
		const button = document.querySelector('[aria-label="新建会话"], [aria-label="New session"], [aria-label="New Session"]');
		if (button instanceof HTMLElement) button.click();
	})()`)
}

func (a *App) focusPrimary() {
	wailsruntime.WindowUnminimise(a.ctx)
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, applicationName+":", err)
	os.Exit(1)
}
