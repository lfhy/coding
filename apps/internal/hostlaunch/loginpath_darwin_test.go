//go:build darwin

package hostlaunch

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// probeTestTimeout 是内容断言用例的探测上限。用例里的脚本立即返回，这个上限只用于
// 吸收机器繁忙时执行新脚本的额外延迟；超时行为由专门的时间用例覆盖。
const probeTestTimeout = 10 * time.Second

// writeProbeShell 写入一个代替登录 shell 的脚本。探测只读取它的输出，因此脚本忽略
// 传入的 `-ilc` 标志，用自己的输出模拟启动配置的噪声。
func writeProbeShell(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "probe-shell")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestProbeLoginShellPathReadsLastMarkerLine(t *testing.T) {
	shell := writeProbeShell(t, fmt.Sprintf(
		"printf 'plugin banner\\n%s/first/bin\\n%s/second/bin:/usr/bin\\n'\n",
		loginShellPathMarker, loginShellPathMarker))
	if got := probeLoginShellPath(shell, probeTestTimeout); got != "/second/bin:/usr/bin" {
		t.Fatalf("probeLoginShellPath() = %q, want the last marker line", got)
	}
}

func TestProbeLoginShellPathRejectsUnusableOutput(t *testing.T) {
	cases := []struct {
		name   string
		shell  string
		body   string
		reason string
	}{
		{name: "missing shell", shell: filepath.Join(t.TempDir(), "absent-shell"), reason: "不存在的 shell 必须失败"},
		{name: "non-zero exit", body: fmt.Sprintf("printf '\\n%s/fake/bin\\n'\nexit 3\n", loginShellPathMarker), reason: "退出非零不能当作结果"},
		{name: "missing marker", body: "printf 'no marker here\\n'\n", reason: "启动配置噪声不能被解析成 PATH"},
		{name: "empty value", body: fmt.Sprintf("printf '\\n%s\\n'\n", loginShellPathMarker), reason: "空 PATH 必须回退"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			shell := testCase.shell
			if shell == "" {
				shell = writeProbeShell(t, testCase.body)
			}
			if got := probeLoginShellPath(shell, probeTestTimeout); got != "" {
				t.Fatalf("probeLoginShellPath() = %q, want empty: %s", got, testCase.reason)
			}
		})
	}
}

func TestProbeLoginShellPathTimesOut(t *testing.T) {
	shell := writeProbeShell(t, "sleep 30\n")
	if got := probeLoginShellPath(shell, 200*time.Millisecond); got != "" {
		t.Fatalf("probeLoginShellPath() = %q, want empty after the timeout", got)
	}
}

func TestProbeLoginShellPathUsesInteractiveLoginShell(t *testing.T) {
	shell := writeProbeShell(t, fmt.Sprintf("printf '\\n%s%%s\\n' \"$*\"\n", loginShellPathMarker))
	got := probeLoginShellPath(shell, probeTestTimeout)
	if !strings.HasPrefix(got, "-ilc ") {
		t.Fatalf("shell arguments = %q, want interactive login invocation", got)
	}
}

func TestProbeEnvironmentOmitsSecretsAndDshNames(t *testing.T) {
	t.Setenv("DSH_PROBE_FACT", "host-fact")
	t.Setenv("PROBE_API_TOKEN", "secret-token")
	t.Setenv("PATH", "/probe/bin")
	shell := writeProbeShell(t, fmt.Sprintf(
		"printf '\\n%s%%s:%%s:%%s\\n' \"${DSH_PROBE_FACT:-missing}\" \"${PROBE_API_TOKEN:-missing}\" \"$PATH\"\n",
		loginShellPathMarker))
	got := probeLoginShellPath(shell, probeTestTimeout)
	if got != "missing:missing:/probe/bin" {
		t.Fatalf("probeLoginShellPath() = %q, want scrubbed environment with PATH kept", got)
	}
}
