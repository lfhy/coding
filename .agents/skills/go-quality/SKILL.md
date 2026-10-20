---
name: go-quality
description: Use when implementing, reviewing, or finishing Go changes; covers idiomatic package design, errors, context and concurrency, dependency maintenance, formatting, tests, vetting, race checks, CGO-free verification, and evidence-based completion.
---

# Go 质量与验证

这是 Go 实现和审阅的指导，不是机械清单。先理解仓库现有布局、构造函数、错误约定、测试入口和支持的 Go 版本，再做最小改动；本项目的目录、配置、数据库和模块规则分别由 [go-project-conventions](../go-project-conventions/SKILL.md)、[go-cli-config](../go-cli-config/SKILL.md) 和 [go-database](../go-database/SKILL.md) 负责。

## 设计原则

优先清晰、直接和可读的控制流；错误和边界条件提前返回，避免为了“架构完整”增加空包、透传 wrapper 或单实现接口。先写具体类型，只有消费者确实需要替换多个实现、隔离外部边界或测试需要时才定义接口；通常由消费者定义最小接口，函数返回具体类型。

让零值尽量可用，但对必须校验的运行时配置提供明确的构造/校验函数。不要用全局可变状态、隐式 `init()` 注册或默认日志副作用隐藏依赖；`main.go`、`cmd` 和装配代码拥有生命周期，领域包返回结果和错误。

## 错误、上下文与并发

错误是调用契约：用 `%w` 包装需要上层匹配的根因，用 `errors.Is`/`errors.As` 分支；不要把预期输入错误 panic，也不要在每一层重复打印同一错误。panic 只保留在明确的进程边界或不可恢复的不变量失败处，并在边界转换为可诊断的退出结果。

需要取消、超时或请求范围时显式传递 `context.Context`，不要把 context 放进结构体或用 `context.Background()` 覆盖调用者取消。每个 goroutine 都必须有明确的所有者、退出条件、取消路径和资源释放顺序；关闭 channel 的责任属于发送方/所有者，避免向已关闭 channel 发送。并发改动运行 `go test -race`，不要用锁或 sleep 掩盖未定义的生命周期。

## 测试证据

测试行为、错误、边界和外部可观察结果，不只测试实现分支或覆盖率数字。输入复杂时使用表驱动测试，解析器和纯函数可增加 fuzz；涉及数据库、文件、网络、进程或真实入口时，优先走实际装配路径，并为资源清理、取消、重复调用和部分失败保留测试。基准测试只用于热点或明确的性能主张，使用 `b.ReportAllocs()` 并以基准结果支持结论。

常规验证从最窄范围开始：

```sh
test -z "$(gofmt -l .)"
go test ./path/to/changed/...
go vet ./path/to/changed/...
```

涉及并发、跨包或可执行入口时补充：

```sh
go test -race ./...
go test ./...
go build ./...
```

`-race` 是并发问题的额外证据，部分平台和 Go 工具链需要启用 CGO；它不是发布构建，也不能替代 `CGO_ENABLED=0` 验证。若项目必须保持 CGO-free，分别运行下方的纯 Go 检查并记录 race 检查的工具链条件。

面向可移植发布或用户要求的 CGO 约束时补充：

```sh
CGO_ENABLED=0 go test ./...
CGO_ENABLED=0 go build ./...
go list -deps -f '{{if .CgoFiles}}{{.ImportPath}}: {{.CgoFiles}}{{end}}' ./...
```

`go vet`、测试、构建和 CgoFiles 检查各自证明不同事实；通过其中一项不能代替其他项。没有凭据时不要把真实外部服务测试伪装成通过，使用项目提供的无凭据测试或明确报告未执行。

## 模块和依赖

新模块先执行 `go mod init <module-path>`，不要手写 `go.mod`/`go.sum`。代码和依赖变化后执行 `go mod tidy`、`go mod verify` 并审阅模块 diff；允许 tidy 根据当前工具链和依赖要求升级 `go`/`toolchain` 版本，不要为了旧 `go 1.18` 做无必要的降级兼容。标准库优先，第三方依赖必须删除实际重复实现或提供项目确需的能力；不要因为依赖已存在就扩大使用范围。

## 收尾报告

完成前检查格式、目标测试、`go vet`、构建、`go mod tidy`/`verify`、CGO 验证和 `git diff --check` 的实际结果，按是否执行分别报告。新增参数、配置、输出或公开行为时同步更新 README、测试和示例；技能或说明变更不需要运行 Go lint，但仍需检查 Markdown/空白和失效的本地链接。

## 外部参考

- [Effective Go](https://go.dev/doc/effective_go)
- [Go Code Review Comments](https://go.dev/wiki/CodeReviewComments)
- [spf13/go-skills：清晰优先与按需抽象](https://github.com/spf13/go-skills/blob/main/go/SKILL.md)
- [samber/cc-skills-golang：测试、错误、并发和依赖管理主题](https://github.com/samber/cc-skills-golang)
- [madflojo/go-style-agent-skill：布局、接口和测试参考](https://github.com/madflojo/go-style-agent-skill)
- [eduardo-sl/go-agent-skills：按需加载与 Go 审阅主题索引](https://github.com/eduardo-sl/go-agent-skills)
