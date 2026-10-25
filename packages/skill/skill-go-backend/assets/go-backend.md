# Go 后端实现约定

用于写 Go 服务端：HTTP 接口、后台任务、数据库访问与测试。先看项目已有的做法——目录布局、路由库、日志、迁移工具——有就沿用；没有才按下面的默认。

## 布局

- `cmd/<binary>/main.go` 只做装配：读配置、建依赖、启动、处理退出信号。
- `internal/<domain>/` 放实现，外部模块无法 import；按能力分目录，不为「以后复用」建 `pkg/` 泛容器。
- 依赖用构造函数显式传入（`NewServer(deps)`）；不建全局单例，不靠 `init()` 启动副作用。

## HTTP

- 路由用 `http.ServeMux`（Go 1.22+ 的方法加路径模式）或项目已有库；handler 只做解析、校验、调用与写响应。
- 请求体设上限（`http.MaxBytesReader`），JSON 用 `json.NewDecoder` 解码并决定未知字段策略（`DisallowUnknownFields` 用于内部接口）。
- 服务端显式设 `ReadHeaderTimeout` 与 `IdleTimeout`；慢依赖用 `context.WithTimeout` 限制，不用 `http.ListenAndServe` 裸启动。
- 错误映射集中一处：内部错误写日志，返回给用户的只说发生了什么和下一步怎么做，不带堆栈、内部路径或 SQL。

## Context 与并发

- `context.Context` 是函数第一个参数并一路往下传；不存进结构体，不用 `context.Background()` 顶替调用方传入的 ctx。
- goroutine 的生命周期要显式：`errgroup.Group` 或 `sync.WaitGroup`，关闭时能等待；通道要有明确的关闭方与缓冲策略。
- 共享状态用锁或单写者模型；`go test -race` 必须干净。

## 错误

- 用 `fmt.Errorf("...: %w", err)` 包装，判定用 `errors.Is`／`errors.As`。
- 区分可重试与终态错误；对外状态码在映射层决定，不在深层业务逻辑里直接写 HTTP 状态。

## 数据

- `database/sql` 加版本化迁移文件，每个迁移可前滚；查询用参数占位，不拼字符串。
- 事务写成 `defer tx.Rollback()` 后显式 `Commit`，失败路径不留半写状态。
- 连接池参数（`MaxOpenConns`、`MaxIdleConns`、`ConnMaxLifetime`）按实际负载设定，不改默认值蒙混。

## 测试

- 表驱动加 `t.Run`；HTTP 用 `httptest` 直接跑 handler。
- 数据库测试用临时实例或内存实现，不依赖开发者本机状态。
- 默认跑 `go vet ./...` 与 `go test ./...`；并发改动加 `-race`。
- 断言对外行为（状态码、响应体、副作用），不断言私有实现细节。

## 交付

改完跑 `gofmt`（或 `goimports`）、`go build ./...`、`go vet ./...`、`go test ./...`，必要时加 `-race`；把实际执行的命令与结果写进回复，没跑的说明原因。

## 不要做的

- 没被要求就换框架、加 ORM、引入新依赖。
- 绕过 context 的超时或取消。
- 把凭据、令牌写进代码、日志或测试夹具。
