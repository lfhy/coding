//go:build !darwin

package hostlaunch

// resolveGuiLoginShellPath 在非 macOS 平台返回空字符串：终端与桌面启动都继承用户
// 会话环境里的 PATH，不需要启动器补全。
func resolveGuiLoginShellPath() string {
	return ""
}
