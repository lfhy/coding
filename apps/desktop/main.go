// Coding Wails 桌面壳：窗口、菜单、单实例与 Host 启动编排。
package main

import (
	"context"
	"embed"
	"encoding/json"
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

	app := &App{ready: make(chan struct{})}
	launcher, err := hostlaunch.New(hostlaunch.Options{
		CWD:         cwd,
		RuntimeRoot: packagedRuntimeRoot(),
		Version:     packagedHostVersion(),
		OnProgress: func(done, total int) {
			if app.ctx == nil {
				return
			}
			wailsruntime.EventsEmit(app.ctx, "coding:host-progress", map[string]int{"done": done, "total": total})
		},
	})
	if err != nil {
		fatal(err)
	}
	app.launcher = launcher

	menu := wmenu.NewMenu()
	menu.Append(wmenu.AppMenu())
	fileMenu := menu.AddSubmenu("文件")
	fileMenu.AddText("新建会话", keys.CmdOrCtrl("n"), func(*wmenu.CallbackData) {
		app.dispatchNewSession()
	})
	fileMenu.AddSeparator()
	fileMenu.AddText("关闭窗口", keys.CmdOrCtrl("w"), func(*wmenu.CallbackData) {
		// 单窗口应用：关闭窗口即结束本次桌面会话，同时释放 Host。
		wailsruntime.Quit(app.ctx)
	})
	menu.Append(wmenu.EditMenu())
	viewMenu := menu.AddSubmenu("视图")
	viewMenu.AddText("重新加载", keys.CmdOrCtrl("r"), func(*wmenu.CallbackData) {
		wailsruntime.WindowReload(app.ctx)
	})
	viewMenu.AddText("切换全屏", keys.CmdOrCtrl("f"), func(*wmenu.CallbackData) {
		app.toggleFullscreen()
	})
	menu.Append(wmenu.WindowMenu())
	helpMenu := menu.AddSubmenu("帮助")
	helpMenu.AddText("关于 Coding", nil, func(*wmenu.CallbackData) {
		wailsruntime.MessageDialog(app.ctx, wailsruntime.MessageDialogOptions{
			Type:          wailsruntime.InfoDialog,
			Title:         applicationName,
			Message:       "Coding 桌面客户端",
			Buttons:       []string{"好"},
			DefaultButton: "好",
		})
	})

	err = wails.Run(&options.App{
		Title:            applicationName,
		Width:            1280,
		Height:           860,
		WindowStartState: options.Maximised,
		MinWidth:         720,
		MinHeight:        480,
		BackgroundColour: &options.RGBA{R: 245, G: 245, B: 247, A: 1},
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: "com.coding.desktop",
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
			installNativeWindowChrome()
			go app.startHost(ctx)
		},
		OnDomReady: func(ctx context.Context) {
			// FullSizeContent 窗口没有原生标题栏可拖。宿主页不是 Wails 资源页，
			// runtime 脚本与 CSS 拖拽标记都可能缺席，因此由壳层直接接管：
			// 顶部 40px 内按下鼠标且目标非交互元素时先等待移动；移动后才向
			// external 消息通道发送 drag。双击最大化由 macOS 原生事件监听处理，
			// 不经随机端口 Host 页面会被拒绝的 Wails binding 消息通道。
			wailsruntime.WindowExecJS(ctx, `(() => {
				if (window.__codingWindowDrag) {
					document.documentElement.style.setProperty('--app-safe-area-inset-top','38px')
					return
				}
				window.__codingWindowDrag = true
				document.documentElement.style.setProperty('--app-safe-area-inset-top','38px')
				const interactive = 'button,a,input,textarea,select,label,[role="button"],[role="tab"],[role="menuitem"]'
				const post = (message) => {
					if (typeof window.WailsInvoke === 'function') window.WailsInvoke(message)
					else window.webkit?.messageHandlers?.external?.postMessage(message)
				}
				const isTopDragTarget = (event) => {
					if (event.clientY > 40) return false
					const element = event.target instanceof Element ? event.target : null
					return element !== null && !element.closest(interactive)
				}
				let pendingDrag = false
				let dragStartX = 0
				let dragStartY = 0
				// 先记录按下位置，移动后才启动原生窗口拖拽。
				document.addEventListener('mousedown', (event) => {
					if (event.button !== 0) return
					if (event.detail !== 1 || !isTopDragTarget(event)) {
						pendingDrag = false
						return
					}
					pendingDrag = true
					dragStartX = event.clientX
					dragStartY = event.clientY
				}, true)
				document.addEventListener('mousemove', (event) => {
					if (!pendingDrag || event.buttons !== 1) return
					if (Math.abs(event.clientX - dragStartX) < 4 && Math.abs(event.clientY - dragStartY) < 4) return
					pendingDrag = false
					event.preventDefault()
					post('drag')
				}, true)
				document.addEventListener('mouseup', (event) => {
					if (event.button === 0) pendingDrag = false
				}, true)
				document.addEventListener('blur', () => { pendingDrag = false }, true)
			})()`)
		},
		Bind: []interface{}{app},
	})
	if err != nil {
		fatal(err)
	}
}

// startHost 在窗口就绪后启动或连接共享 Host，解析 endpoint 后通知启动页跳转。
func (a *App) startHost(ctx context.Context) {
	endpoint, err := a.launcher.Ensure(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, applicationName+":", err)
		wailsruntime.EventsEmit(a.ctx, "coding:host-error", err.Error())
		return
	}
	parsed, perr := url.Parse(endpoint.BaseURL)
	if perr != nil {
		fmt.Fprintln(os.Stderr, applicationName+":", perr)
		return
	}
	a.endpoint = parsed
	close(a.ready)
	wailsruntime.EventsEmit(a.ctx, "coding:host-ready", parsed.String()+"/")
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

// toggleFullscreen 在全屏与普通窗口之间切换。
func (a *App) toggleFullscreen() {
	if wailsruntime.WindowIsFullscreen(a.ctx) {
		wailsruntime.WindowUnfullscreen(a.ctx)
	} else {
		wailsruntime.WindowFullscreen(a.ctx)
	}
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, applicationName+":", err)
	os.Exit(1)
}

// packagedRuntimeRoot 定位 .app Resources 目录下的 SEA Host；开发运行（无打包）返回空。
func packagedRuntimeRoot() string {
	if _, err := os.Stat(filepath.Join("apps", "cli", "src", "bin.ts")); err == nil {
		return ""
	}
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	return filepath.Join(filepath.Dir(executable), "..", "Resources")
}

// packagedHostVersion 读取打包 Runtime 旁 metadata.json 中的产品版本；
// Host 就绪记录按该版本校验。读不到时回退编译期默认值（开发模式）。
func packagedHostVersion() string {
	if root := packagedRuntimeRoot(); root != "" {
		if data, err := os.ReadFile(filepath.Join(root, "metadata.json")); err == nil {
			var metadata struct {
				Version string `json:"version"`
			}
			if json.Unmarshal(data, &metadata) == nil && metadata.Version != "" {
				return metadata.Version
			}
		}
	}
	return hostlaunch.AppVersion
}
