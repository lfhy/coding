# Go 后端实现约定

用于写 Go 服务端：HTTP 接口、后台任务、数据库访问与测试。先看项目已有的做法——目录布局、路由库、日志、迁移工具——有就沿用；没有才按下面的默认。

## 布局

- 根 `main.go` 只做装配：读配置、建依赖、分发 `cmd/<name>/` 子命令、处理退出信号；不往里堆业务流程。
- `cmd/<name>/` 是一个子命令的执行目录：输入适配加调用核心能力，不重复配置加载与数据库初始化。
- `conf/` 放类型化配置、默认值与校验；解析完成后把类型化配置交给装配边界。
- `core/<domain>/` 放项目自己的领域能力，按 `core/user`、`core/job` 这类真实领域分包。新项目不建 `internal/`；已有模块的 `internal/` 不为对齐本约定强行迁移，也不为「以后复用」建 `pkg/` 泛容器。
- 只在确有独立外部存储边界时才建 `storage/`。
- 带前端的项目把前端工程放在 `web/`，产物由 `go:embed` 嵌进二进制，见下一节。
- 依赖用构造函数显式传入（`NewServer(deps)`）；不建全局单例，不靠 `init()` 启动副作用。

## 前端与静态资源

- 前端工程就放在 Go 模块的 `web/` 下（`web/package.json` 与 Web 构建配置），不另立平级的前端仓库目录；构建产物固定在 `web/dist`。
- 产物用 `go:embed` 交给 Go 提供访问：`web/embed.go` 里 `//go:embed all:dist` 导出 `embed.FS`，再由 `http.ServeMux` 提供静态文件，未命中的路径回退到 `index.html` 让前端路由接管。
- 前端必须真的构建得出来：跑通项目自己的前端构建命令（例如 `npm --prefix web install && npm --prefix web run build`）产出 `web/dist`，之后 `go build ./...` 才能过——`go:embed` 匹配不到文件是编译错误。
- 产物不入库时，在 README 与构建步骤里写清先构建前端再 `go build`；需要干净检出就能编译时，先提交一个 `web/dist/index.html` 占位，别让首次 `go build ./...` 直接失败。
- 交付前跑通一次真实链路：前端构建成功、`go build ./...` 成功、启动二进制后用浏览器打开首页并走一条 API 请求。

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

改完跑 `gofmt`（或 `goimports`）、`go build ./...`、`go vet ./...`、`go test ./...`，必要时加 `-race`；带前端时先构建出 `web/dist` 再 `go build`。把实际执行的命令与结果写进回复，没跑的说明原因。

## 不要做的

- 没被要求就换框架、加 ORM、引入新依赖。
- 绕过 context 的超时或取消。
- 把凭据、令牌写进代码、日志或测试夹具。
