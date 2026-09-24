// Coding Wails 桌面壳：窗口、菜单、单实例与 Host 启动编排。
package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/deepseek-ai/coding/apps/desktop/internal/instance"
	"github.com/deepseek-ai/coding/apps/desktop/internal/remoteagent"
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
	ctx                 context.Context
	launcher            *hostlaunch.Launcher
	stateMu             sync.RWMutex
	endpoint            *url.URL
	bridgeToken         string
	remoteManager       remoteSSHManager
	remoteBridge        *remoteBridge
	remoteConnectMu     sync.Mutex
	remoteConnectCancel context.CancelFunc
	remoteConnectSeq    uint64
	remoteConnectID     string
	remoteCancelled     map[string]time.Time
	remoteConnectWG     sync.WaitGroup
	remoteMarkerMu      sync.Mutex
	remoteMarkers       map[string]string
	remoteStopping      bool
	remoteShutdownOnce  sync.Once
	ready               chan struct{}
	readyOnce           sync.Once
	windowReady         chan struct{}
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
	lock, primary, err := instance.Acquire(os.Args[1:], isDevelopmentBuild)
	if err != nil {
		fatal(err)
	}
	if !primary {
		// 第二个实例的激活请求已转发给持锁进程，本进程直接退出。
		return
	}
	defer lock.Close()

	bindingToken, err := newBridgeToken()
	if err != nil {
		fatal(err)
	}
	hostBridgeToken, err := newBridgeToken()
	if err != nil {
		fatal(err)
	}
	home, err := desktopHome()
	if err != nil {
		fatal(err)
	}
	runtimeRoot := packagedRuntimeRoot()
	hostCommand, err := desktopHostCommand()
	if err != nil {
		fatal(err)
	}
	manager, err := remoteagent.NewManager(remoteagent.ManagerOptions{
		KnownHostsPath: filepath.Join(home, "remote-ssh", "known_hosts"),
		AgentPathFor:   remoteAgentPathFor(runtimeRoot),
	})
	if err != nil {
		fatal(err)
	}
	bridge, err := newRemoteBridge(hostBridgeToken, func(ctx context.Context, connectionID, method, requestPath string, body []byte) (int, []byte, error) {
		response, err := manager.Proxy(ctx, connectionID, method, requestPath, body)
		return response.Status, response.Body, err
	})
	if err != nil {
		fatal(err)
	}
	app := &App{
		bridgeToken: bindingToken, remoteManager: manager, remoteBridge: bridge,
		remoteMarkers: make(map[string]string), ready: make(chan struct{}), windowReady: make(chan struct{}),
	}
	go lock.Serve(func() {
		// 可能在 Wails 启动前收到第二次启动请求，待原生窗口可用后再恢复。
		<-app.windowReady
		app.focusPrimary()
	})
	launcher, err := hostlaunch.New(hostlaunch.Options{
		Home:        home,
		CWD:         cwd,
		Command:     hostCommand,
		RuntimeRoot: runtimeRoot,
		Version:     packagedHostVersion(),
		Environment: map[string]string{
			"DSH_REMOTE_BRIDGE_URL":   bridge.URL(),
			"DSH_REMOTE_BRIDGE_TOKEN": hostBridgeToken,
		},
		ReplaceCompatibleHost: true,
		OnProgress: func(done, total int) {
			if app.ctx == nil {
				return
			}
			wailsruntime.EventsEmit(app.ctx, "coding:host-progress", map[string]int{"done": done, "total": total})
		},
	})
	if err != nil {
		_ = bridge.Close()
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
	fileMenu.AddText(closeWindowMenuLabel(), keys.CmdOrCtrl("w"), func(*wmenu.CallbackData) {
		app.closePrimary()
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
		Title:             desktopWindowTitle(),
		Width:             1280,
		Height:            860,
		WindowStartState:  options.Maximised,
		MinWidth:          720,
		MinHeight:         480,
		HideWindowOnClose: hideWindowOnClose(),
		BackgroundColour:  &options.RGBA{R: 245, G: 245, B: 247, A: 1},
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId: desktopInstanceID(),
			OnSecondInstanceLaunch: func(_ options.SecondInstanceData) {
				app.focusPrimary()
			},
		},
		AssetServer: &assetserver.Options{
			// 纯静态壳：只服务内嵌启动页；Host 就绪后整窗导航到回环 URL，
			// 不经壳层转发任何 /api 流量。
			Assets: assets,
		},
		// Host 页面使用每次启动随机的 127.0.0.1 端口。允许其调用原生
		// binding 后，每个敏感方法仍需验证本窗口随机 token，不能把
		// loopback origin 当作授权凭据。
		BindingsAllowedOrigins: "http://127.0.0.1:*",
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
			close(app.windowReady)
			localizeNativeMenus()
			installNativeWindowChrome()
			installNativeTray()
			go app.startHost(ctx)
		},
		OnShutdown: func(context.Context) {
			app.shutdownRemote()
			removeNativeTray()
		},
		OnDomReady: func(ctx context.Context) {
			// Windows 会在每次导航完成后调用此回调；macOS/Linux 的远端 Host
			// 页面不会加载 Wails runtime，改由 startHost 的有界重试覆盖。
			app.injectHostBindings()
			// FullSizeContent 窗口没有原生标题栏可拖。宿主页不是 Wails 资源页，
			// runtime 脚本与 CSS 拖拽标记都可能缺席，因此由壳层直接接管：
			// 顶部 40px 内按下鼠标且目标非交互元素时先等待移动；移动后才向
			// external 消息通道发送 drag。双击最大化由 macOS 原生事件监听处理，
			// 不经随机端口 Host 页面会被拒绝的 Wails binding 消息通道。
			topInset, rightInset := desktopWindowInsets(runtime.GOOS)
			wailsruntime.WindowExecJS(ctx, fmt.Sprintf(`(() => {
				const setInsets = () => {
					document.documentElement.style.setProperty('--app-safe-area-inset-top', %q)
					document.documentElement.style.setProperty('--app-safe-area-inset-right', %q)
				}
				setInsets()
				if (window.__codingWindowDrag) {
					return
				}
				window.__codingWindowDrag = true
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
			})()`, topInset, rightInset))
		},
		Bind: []interface{}{app},
	})
	app.shutdownRemote()
	if err != nil {
		fatal(err)
	}
}

// desktopWindowInsets 为原生窗口控件分别预留垂直与水平空间。
func desktopWindowInsets(platform string) (top, right string) {
	switch platform {
	case "darwin":
		return "38px", "0px"
	case "windows":
		return "0px", "138px"
	default:
		return "0px", "0px"
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
	a.stateMu.Lock()
	a.endpoint = parsed
	a.stateMu.Unlock()
	a.injectHostBindings()
	a.readyOnce.Do(func() { close(a.ready) })
	wailsruntime.EventsEmit(a.ctx, "coding:host-ready", parsed.String()+"/")
}

// injectHostBindings 在 Host 导航后把受限调用面装进当前 WebView。Host 页面不含
// Wails runtime，且不同平台对 OnDomReady 的导航回调不一致，因此短暂重试直到
// location.replace 完成；脚本先精确校验随机 Host origin，不能向另一回环页面泄露
// 窗口 token。
func (a *App) injectHostBindings() {
	if a.ctx == nil {
		return
	}
	a.stateMu.RLock()
	endpoint := a.endpoint
	a.stateMu.RUnlock()
	if endpoint == nil {
		return
	}
	hostOrigin := endpoint.Scheme + "://" + endpoint.Host
	topInset, rightInset := desktopWindowInsets(runtime.GOOS)
	script := desktopBindingsScript(a.bridgeToken, hostOrigin, topInset, rightInset)
	go func(ctx context.Context) {
		for _, delay := range []time.Duration{0, 80 * time.Millisecond, 250 * time.Millisecond, 750 * time.Millisecond, 2 * time.Second} {
			if delay > 0 {
				timer := time.NewTimer(delay)
				select {
				case <-ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			}
			wailsruntime.WindowExecJS(ctx, script)
		}
	}(a.ctx)
}

// Endpoint 暴露给启动页轮询：就绪后由前端主动跳转，与后台导航互为兜底。
func (a *App) Endpoint() string {
	select {
	case <-a.ready:
		a.stateMu.RLock()
		endpoint := a.endpoint
		a.stateMu.RUnlock()
		if endpoint != nil {
			return endpoint.String() + "/"
		}
		return ""
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
	showPrimaryWindow(a.ctx)
}

func (a *App) closePrimary() {
	closePrimaryWindow(a.ctx)
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

// shutdownRemote 先取消未发布的连接尝试并等待其归还 SSH 资源，再停止所有
// 已发布连接和 Host 使用的回环 bridge。该顺序避免退出期间留下远端 agent。
func (a *App) shutdownRemote() {
	a.remoteShutdownOnce.Do(func() {
		a.remoteConnectMu.Lock()
		a.remoteStopping = true
		a.remoteConnectSeq++
		if a.remoteConnectCancel != nil {
			a.remoteConnectCancel()
		}
		a.remoteConnectMu.Unlock()

		attemptsDone := make(chan struct{})
		go func() {
			a.remoteConnectWG.Wait()
			close(attemptsDone)
		}()
		select {
		case <-attemptsDone:
		case <-time.After(3 * time.Second):
		}
		if a.remoteManager != nil {
			ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
			_ = a.remoteManager.CloseAll(ctx)
			cancel()
		}
		if a.remoteBridge != nil {
			_ = a.remoteBridge.Close()
		}
	})
}

func desktopHome() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("coding: resolve user home: %w", err)
	}
	if isDevelopmentBuild {
		return filepath.Join(home, ".dsh-dev"), nil
	}
	return filepath.Join(home, ".dsh"), nil
}

func desktopInstanceID() string {
	if isDevelopmentBuild {
		return "com.coding.desktop.dev"
	}
	return "com.coding.desktop"
}

func desktopWindowTitle() string {
	if isDevelopmentBuild {
		return "Coding Dev"
	}
	return applicationName
}

// desktopHostCommand 让开发壳强制使用仓库 Host，不从 PATH 或打包目录回退。
func desktopHostCommand() ([]string, error) {
	if !isDevelopmentBuild {
		return nil, nil
	}
	root, err := findProjectRoot()
	if err != nil {
		return nil, err
	}
	return []string{
		"node", "--import", "tsx/esm", filepath.Join(root, "apps", "cli", "src", "bin.ts"), "web", "--coding-host",
	}, nil
}

// remoteAgentPathFor 在发行包中只读取 Resources/remote-agent；开发运行则从
// 当前仓库的 dist/remote-agent 读取，不回退到 PATH 或下载网络产物。
func remoteAgentPathFor(runtimeRoot string) func(remoteagent.RemotePlatform) (string, error) {
	return func(platform remoteagent.RemotePlatform) (string, error) {
		if !supportedRemoteAgentPlatform(platform) {
			return "", fmt.Errorf("coding: unsupported remote agent target %s/%s", platform.OS, platform.Arch)
		}
		suffix := ""
		if platform.OS == "windows" {
			suffix = ".exe"
		}
		filename := fmt.Sprintf("coding-remote-agent-%s-%s%s", platform.OS, platform.Arch, suffix)
		root := filepath.Join(runtimeRoot, "remote-agent")
		if runtimeRoot == "" {
			projectRoot, err := findProjectRoot()
			if err != nil {
				return "", err
			}
			root = filepath.Join(projectRoot, "dist", "remote-agent")
		}
		artifact := filepath.Join(root, filename)
		info, err := os.Stat(artifact)
		if err != nil || !info.Mode().IsRegular() {
			return "", fmt.Errorf("coding: remote agent artifact is missing at %s; run 'make remote-agent'", artifact)
		}
		return artifact, nil
	}
}

func supportedRemoteAgentPlatform(platform remoteagent.RemotePlatform) bool {
	if platform.Arch != "amd64" && platform.Arch != "arm64" {
		return false
	}
	return platform.OS == "darwin" || platform.OS == "linux" || platform.OS == "windows"
}

func findProjectRoot() (string, error) {
	directory, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("coding: resolve development directory: %w", err)
	}
	for {
		if info, statErr := os.Stat(filepath.Join(directory, "apps", "desktop", "go.mod")); statErr == nil && info.Mode().IsRegular() {
			return directory, nil
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			return "", errors.New("coding: cannot locate project root for remote agent artifacts")
		}
		directory = parent
	}
}

// packagedRuntimeRoot 定位 .app Resources 目录下的 Node 与预展开 Host 闭包；开发运行（无打包）返回空。
func packagedRuntimeRoot() string {
	if isDevelopmentBuild {
		return ""
	}
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
