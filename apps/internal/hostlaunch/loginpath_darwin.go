//go:build darwin

package hostlaunch

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"time"
)

const (
	// loginShellPathTimeout 限制登录 shell 探测；任何一份启动配置卡住时都会保留
	// 继承的 PATH，GUI 启动不会因为用户 shell 配置而无限等待。上限比交互式启动配置的
	// 常规耗时宽裕，机器繁忙时也不会误判成失败。
	loginShellPathTimeout = 6 * time.Second
	// loginShellPathMarker 标记探测输出里的 PATH 行。交互式启动配置可能打印横幅、
	// 版本提示或插件消息，只有带标记的最后一行才是结果。
	loginShellPathMarker = "__DSH_LOGIN_SHELL_PATH__"
)

// resolveGuiLoginShellPath 返回交互式登录 shell 的 PATH，供调用方在 GUI 启动时替换继承
// 环境。判据不由本函数推断：launchd 的子进程是桌面壳主进程，启动器是它的子进程，在启动器
// 里观察父进程永远得不出结论，因此由桌面壳显式声明（Options.GuiLaunch）。展开出的 PATH 与
// 用户终端一致：交互模式让 .zshrc 一类用户配置生效，登录模式让 /etc/zprofile 与 path_helper
// 目录生效。SHELL 缺失、探测失败或超时返回空字符串，调用方保留继承的 PATH。
func resolveGuiLoginShellPath() string {
	shell := strings.TrimSpace(os.Getenv("SHELL"))
	if shell == "" {
		return ""
	}
	return probeLoginShellPath(shell, loginShellPathTimeout)
}

// probeLoginShellPath 用交互式登录 shell 展开 PATH，使派生命令与用户终端看到同一组
// 可执行文件目录：交互模式让 .zshrc 一类用户配置生效，登录模式让 /etc/zprofile 与
// PATH 的 path_helper 目录生效（Go 与 Homebrew 通常由这两处加入）。成功时返回输出里
// 最后一个标记行携带的 PATH；shell 不存在、超时、退出非零或输出不含标记行时返回空
// 字符串，由调用方决定回退。
func probeLoginShellPath(shell string, timeout time.Duration) string {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	command := exec.CommandContext(ctx, shell, "-ilc",
		fmt.Sprintf(`printf '\n%s%%s\n' "$PATH"`, loginShellPathMarker))
	command.WaitDelay = time.Second
	command.Env = probeEnvironment()
	output, err := command.Output()
	if err != nil {
		return ""
	}
	for _, line := range slices.Backward(strings.Split(string(output), "\n")) {
		if !strings.HasPrefix(line, loginShellPathMarker) {
			continue
		}
		path := strings.TrimSpace(strings.TrimPrefix(line, loginShellPathMarker))
		if path != "" && !strings.ContainsRune(path, 0) {
			return path
		}
	}
	return ""
}

// probeEnvironment 返回探测登录 shell 时使用的环境：沿用继承环境，但剔除凭据形状的
// 名字与 DSH_* 值。探测会执行用户自己的启动配置，不得把窗口私有的凭据或 Host 事实
// 交给它；这与派生模型命令的清洗规则保持一致。
func probeEnvironment() []string {
	environment := os.Environ()
	result := make([]string, 0, len(environment))
	for _, entry := range environment {
		key, _, found := strings.Cut(entry, "=")
		if !found || strings.HasPrefix(strings.ToUpper(key), "DSH_") || sensitiveEnvironmentName(key) {
			continue
		}
		result = append(result, entry)
	}
	return result
}

// sensitiveEnvironmentName 报告变量名是否形如凭据。规则与 subprocess seam 的清洗
// 模式一致：名字包含 KEY、PASSWORD、SECRET 或 TOKEN（不区分大小写）即视为凭据。
func sensitiveEnvironmentName(key string) bool {
	upper := strings.ToUpper(key)
	return strings.Contains(upper, "KEY") || strings.Contains(upper, "PASSWORD") ||
		strings.Contains(upper, "SECRET") || strings.Contains(upper, "TOKEN")
}
