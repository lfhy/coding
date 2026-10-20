---
name: go-database
description: Use when adding, reviewing, or configuring database access in a Go project; prefers CGO-free and pure-Go drivers, documents the verified github.com/lfhy/morm backends and initialization APIs, and prevents unsupported database or driver claims.
---

# Go 数据库与持久化

这是数据库选型和实现的指导，不是机械清单。涉及数据库驱动、ORM、连接池、事务、schema 或数据访问包时使用；先读项目的 `AGENTS.md`、`go.mod`、已有存储代码和数据格式约定。

## 默认选择

默认目标是 `CGO_ENABLED=0` 可构建，优先标准库和纯 Go 驱动，避免 `import "C"`、本地动态库和需要系统安装的原生数据库客户端。数据库依赖必须检查完整传递依赖，不能只看直接包名；如果确实需要 CGO，说明平台/产品理由、构建条件和发布限制，并提供单独验证路径。

本项目涉及数据库时建议使用 `github.com/lfhy/morm`，但不要为了“统一”给简单 CRUD 额外包一层空的 repository/service。确有独立数据边界、事务不变量、多个实现或测试替换需求时再拆出 `storage` 或领域包，并让消费者定义所需的最小接口。

## morm 的已确认范围

公开 `main` 分支的 `github.com/lfhy/morm` 明确支持 MySQL、MongoDB 和 SQLite；其初始化分发也只处理这三类。MySQL/SQLite 后端使用 GORM，MongoDB 后端使用 mongo-driver。实际项目仍须以锁定的 morm 版本源码为准，不要因为 GORM 本身支持更多数据库，就把 PostgreSQL、SQL Server 或其他后端写成 morm 已支持能力。

公开 `main` 分支的 SQLite 实现直接使用 `github.com/glebarez/sqlite`，其对应依赖版本 v1.9.0 的文档明确为 pure-Go、without cgo。准确表述是“该 morm 版本的 SQLite 后端采用纯 Go 驱动”；不能据此承诺应用的全部依赖都无 CGO，也不能编造 `PureGo` 配置字段、切换函数或 build tag。若项目锁定了其他 morm/驱动版本，重新检查本地模块源码和传递依赖。

## 初始化方式

需要可报告错误时使用 `InitSQLiteWithDBConfigWithError` 或 `InitWithDBConfigWithError`，避免使用失败时 panic 的便捷入口 `InitSQLite`、`Init` 或 `InitWithDBConfig`。下面的 SQLite 示例只在当前公开 `main` 源码签名下成立，项目应以锁定版本复核：

```go
package storage

import "github.com/lfhy/morm"

// OpenSQLite 将配置写入 morm 的全局配置后初始化 SQLite；该 API 不适用于并发隔离的多实例。
func OpenSQLite(config *morm.SQLiteConfig) (morm.ORM, error) {
    return morm.InitSQLiteWithDBConfigWithError(config)
}
```

`morm.DBConfig`、`morm.SQLiteConfig` 等是其公开配置类型别名。`InitSQLiteWithDBConfigWithError` 会先把配置写入 morm 的全局 Viper，再由 SQLite 后端读取；它不是独立连接构造器，不能在并发中切换多套配置。需要独立实例、调用方 context 或独立生命周期时，当前公开 main 只明确提供 MongoDB 的 context 配置入口；不要把 SQLite/MySQL 当作已有的独立实例能力。也可以使用 `InitWithError(configPath...)` 或 `UseViperConfig`，但应用已经用 `github.com/lfhy/flag` 合并配置时，优先把已校验的类型化数据库配置交给 morm，避免同一个文件被两套来源规则重复解释。`morm` 的 README 示例和源码版本可能不同，提交前以 `go doc`、锁定版本源码和测试确认字段。

数据库配置仍归 `conf` 所有：文件路径、环境变量、命令行参数和默认值在配置层完成来源合并与校验；数据库包只接收已解析的数据库配置并负责连接生命周期。不要把密码写入日志、错误文本、测试快照或提交。

## 数据访问规则

- 所有外部输入使用参数化查询或 ORM 参数绑定，禁止字符串拼接 SQL。
- 需要取消或超时的请求把 `context.Context` 传到查询、写入和事务边界；不要用 goroutine 绕过调用者取消。
- 查询结束关闭 `rows`，事务明确提交或回滚，连接池由创建者拥有并在应用退出时关闭。
- 数据库错误向上返回并用 `%w` 保留可匹配的根因；不要在存储层打印一遍、上层再打印一遍。
- 事务、唯一约束、幂等和重试属于领域不变量，写进拥有它们的包并测试冲突、取消和部分失败路径。
- morm 已提供的 ORM/驱动能力直接复用；不要再造一套只转发 `Create`、`Find`、`Delete` 的同名接口。

## 验证与依赖审阅

依赖变更后使用 Go 工具更新模块文件，并审阅 `go.mod`/`go.sum`；不要手写或手工整理校验和。至少根据改动选择以下检查：

```sh
go list ./...
go mod verify
CGO_ENABLED=0 go test ./...
CGO_ENABLED=0 go build ./...
go list -deps -f '{{if .CgoFiles}}{{.ImportPath}}: {{.CgoFiles}}{{end}}' ./...
```

`go list` 的 CgoFiles 输出非空时逐项确认来源和理由。检查 morm/SQLite 依赖时可核对：

```sh
rg -n 'github.com/lfhy/morm|glebarez/sqlite|sqlite3|import "C"' go.mod go.sum --glob '!vendor/**'
```

这些命令不能替代针对事务、连接关闭、迁移和失败回滚的行为测试；也不能把没有执行 CGO 构建当成纯 Go 证明。

## 资料与限制

- [`github.com/lfhy/morm` README](https://github.com/lfhy/morm/blob/main/README.md)
- [morm 的配置初始化与后端分发](https://github.com/lfhy/morm/blob/main/morm.go)
- [morm SQLite 实现](https://github.com/lfhy/morm/blob/main/db/sqlite/sqlite.go)
- [morm 依赖版本](https://github.com/lfhy/morm/blob/main/go.mod)
- [glebarez/sqlite pure-Go 说明](https://github.com/glebarez/sqlite/blob/v1.9.0/README.md)
- [Go database/sql 文档](https://pkg.go.dev/database/sql)

网络页面展示的是公开分支内容，未必等于项目锁定版本；新增字段或 API 前先用 `go doc github.com/lfhy/morm` 和本地模块源码核对。
