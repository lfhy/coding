---
name: go-project-conventions
description: Use when creating, initializing, structuring, reviewing, or refactoring a Go module in this repository; covers go mod init, the root main.go, cmd/, conf/, core/, layered design without speculative abstractions, CGO-free defaults, pure-Go dependencies, and Go toolchain/go.mod maintenance.
---

# Go 项目约定

这是本项目的 Go 结构与依赖约定，属于指导而不是机械清单。凡是创建、初始化、审阅或重构 `.go`、`go.mod`、CLI、服务端程序时使用；仓库或更深目录的 `AGENTS.md` 优先于本技能。

## 开始前确认

先读取目标目录的 `AGENTS.md`、README、现有 `go.mod`、入口和测试。先确认这是新模块还是已有模块、模块导入路径、当前 Go 工具链和已有目录约定；不要用模板覆盖现有项目。

## 初始化模块

新模块必须通过 Go 工具初始化：

```sh
go mod init <module-path>
```

`<module-path>` 应从仓库归属、发布导入路径或用户明确的模块路径确定。不要手写、拼接或用脚本伪造 `go.mod`、`go.sum`；`go mod init` 创建模块文件，`go get`、编译解析依赖和 `go mod tidy` 由 Go 工具维护依赖与校验和。已有 `go.mod` 时不要重复初始化或为了格式偏好重写它。

完成代码和依赖变更后运行 `go mod tidy`，审阅它对 `go.mod`、`go.sum` 以及 `go`/`toolchain` 行的修改。依赖要求提高时允许 Go 工具升级这些版本；不要为了保留旧项目的 `go 1.18` 而手工降级、添加旧 API 兼容层、构建标签或 `go mod tidy -compat=1.18`。只有用户明确要求旧工具链兼容时，才把兼容范围作为单独的设计约束验证。

## 目录与依赖方向

本项目的应用入口固定放在仓库根目录：

```text
.
├── main.go                 # 进程入口，只做装配、分发和退出码处理
├── cmd/
│   ├── serve/              # serve 子命令的执行逻辑
│   └── migrate/            # migrate 子命令的执行逻辑
├── conf/                   # 类型化配置、来源合并、默认值和校验
├── core/                   # 项目核心领域能力；按真实领域继续分包
├── storage/                # 仅在确有独立外部存储边界时创建
└── go.mod
```

- 根 `main.go` 是默认进程入口，负责装配、注册/分发 `cmd` 子命令和把错误转换为退出结果；不要把业务流程堆在这里。
- `cmd/<name>/` 是子命令的执行目录，负责该命令的输入适配和调用核心能力；不要在每个命令里复制配置加载、数据库初始化或业务规则。
- `conf/` 放配置结构、默认值、配置文件样例及来源合并/校验代码；命令行与环境变量的绑定使用 [go-cli-config](../go-cli-config/SKILL.md) 约定，真实凭据和机器本地配置不入库。配置解析完成后把类型化配置交给装配边界。
- `core/` 承载项目自身可复用的领域能力，替代本项目新建 `internal/` 包。按 `core/user`、`core/job` 等真实领域命名，不按 `service`、`manager`、`helper` 等空泛层名堆目录。
- 典型依赖方向是 `main.go -> cmd -> conf/core`；`core` 不依赖 `cmd`，`conf` 不依赖 `cmd`，外部适配器只在真正的边界被引入。出现循环依赖时重新检查职责归属，不用再加一层透传包。

本项目新建 Go 应用默认采用上述根入口、`cmd`、`conf` 和 `core` 结构；已有模块先保持其可理解的布局，除非用户明确要求迁移。项目代码默认不新建 `internal/`，但现有 `internal/` 目录、第三方模块自身的 `internal` 目录和确有编译可见性理由的特殊边界不应为遵守本技能而强行迁移。

## 分层但不堆抽象

分层必须对应至少一个真实边界：独立领域不变量、外部系统适配、生命周期协调、可验证的权限/输入边界，或确实存在的多个实现。只有一个调用者的接口、只转发参数的 `service`/`repository`/`controller`、重复 DTO 映射和 `utils`/`common`/`helpers` 垃圾桶都不构成合理分层。

先写具体类型和函数，再在消费者需要替换多个实现、隔离外部边界或测试确实需要时定义接口。接口通常由消费者所在包定义；不要为了“依赖倒置”预先给每个结构体配一个同名接口。相关操作若总是一起变化，应留在同一领域包内。

## 默认依赖与版本策略

标准库能清楚解决的问题优先使用标准库。新增第三方依赖前确认它删除了实际实现、提供了项目需要的能力或形成稳定外部边界，而不是只换一种包装。数据库场景遵循 [go-database](../go-database/SKILL.md)，命令行和配置场景遵循 [go-cli-config](../go-cli-config/SKILL.md)，通用质量检查遵循 [go-quality](../go-quality/SKILL.md)。

默认以 `CGO_ENABLED=0` 为可移植性目标，避免 `import "C"` 和依赖本地原生库；需要数据库时优先选用纯 Go 驱动，并按 [go-database](../go-database/SKILL.md) 验证传递依赖。必须使用 CGO 时要有明确的平台/产品理由、单独的构建路径和用户可见限制，不能把它作为默认实现。

## 参考资料

- [Go Modules Reference](https://go.dev/ref/mod)
- [spf13/go-skills：Go 项目布局与简洁设计](https://github.com/spf13/go-skills/blob/main/go/SKILL.md)
- [samber/cc-skills-golang：项目布局与依赖管理技能集合](https://github.com/samber/cc-skills-golang)
- [madflojo/go-style-agent-skill：布局与接口设计参考](https://github.com/madflojo/go-style-agent-skill/blob/main/skills/go-style-guide/references/LAYOUT.md)
