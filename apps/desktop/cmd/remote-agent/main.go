// coding-remote-agent 是经 SSH 部署到远端的最小执行与文件代理。
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/deepseek-ai/coding/apps/desktop/internal/remoteagent"
)

func main() {
	// isolate child 的 stdout 是父 agent 的私有 NDJSON wire；必须在 flag
	// 解析和 Server 创建前短路，避免 token/readiness 文本污染协议流。
	if len(os.Args) == 2 && os.Args[1] == "--code-isolate" {
		if err := remoteagent.RunCodeIsolateStdio(os.Stdin, os.Stdout, os.Stderr); err != nil {
			fmt.Fprintln(os.Stderr, "coding-remote-agent isolate:", err)
			os.Exit(2)
		}
		return
	}
	var tokenFromStdin bool
	var showVersion bool
	flag.BoolVar(&tokenFromStdin, "token-stdin", false, "read the bearer token from standard input")
	flag.BoolVar(&showVersion, "version", false, "print the remote agent version")
	flag.Parse()
	if showVersion {
		fmt.Println(remoteagent.AgentVersion)
		return
	}
	if !tokenFromStdin {
		fmt.Fprintln(os.Stderr, "coding-remote-agent: --token-stdin is required")
		os.Exit(2)
	}
	token, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && len(token) == 0 {
		fmt.Fprintln(os.Stderr, "coding-remote-agent: read token:", err)
		os.Exit(2)
	}
	server, err := remoteagent.NewServer(strings.TrimSpace(token))
	if err != nil {
		fmt.Fprintln(os.Stderr, "coding-remote-agent:", err)
		os.Exit(2)
	}
	ready, err := server.ListenAndServe()
	if err != nil {
		fmt.Fprintln(os.Stderr, "coding-remote-agent:", err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(ready); err != nil {
		fmt.Fprintln(os.Stderr, "coding-remote-agent: write readiness:", err)
		os.Exit(1)
	}
	<-server.Done()
}
