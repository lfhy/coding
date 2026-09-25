//go:build remote_ssh_e2e

// ssh-fixture 是仅在显式测试 build tag 下可编译的一次性回环 SSH 进程。
package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"

	"github.com/deepseek-ai/coding/apps/desktop/internal/sshfixture"
)

func main() {
	withoutForwarding := len(os.Args) == 2 && os.Args[1] == "--no-forwarding"
	if len(os.Args) != 1 && !withoutForwarding {
		fmt.Fprintln(os.Stderr, "ssh-fixture: only --no-forwarding is accepted")
		os.Exit(2)
	}
	var server *sshfixture.Server
	var err error
	if withoutForwarding {
		server, err = sshfixture.StartWithoutForwarding()
	} else {
		server, err = sshfixture.Start()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "ssh-fixture: start failed:", err)
		os.Exit(1)
	}
	defer server.Close()
	if err := json.NewEncoder(os.Stdout).Encode(server.Ready); err != nil {
		fmt.Fprintln(os.Stderr, "ssh-fixture: readiness failed:", err)
		return
	}
	_, _ = io.Copy(io.Discard, os.Stdin)
}
