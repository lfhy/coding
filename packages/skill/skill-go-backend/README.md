# coding-skill-go-backend

随包分发 `go-backend` 技能：写 Go 服务端时的默认约定。插件依赖 `ctx.skills`，无配置；正文是 [`assets/go-backend.md`](assets/go-backend.md)，资源目录同时交给消费方定位。卸载即撤销登记。

技能的第一条要求是沿用项目已有做法：目录布局、路由库、日志与迁移工具都以项目为准，本文只补项目没有约定的部分。默认约定覆盖五块——`cmd/<binary>` 只做装配、`internal/<domain>` 放实现的布局；HTTP 的请求体上限、超时与集中错误映射；`context.Context` 一路下传、goroutine 生命周期可等待、`go test -race` 干净；错误用 `%w` 包装并以 `errors.Is`／`errors.As` 判定；`database/sql` 的参数化查询、可前滚迁移与事务收尾。交付前要求实际跑 `gofmt`、`go build`、`go vet`、`go test`（必要时 `-race`）并把结果写进回复。

它不做的：不引入框架、ORM 或新依赖（除非用户要求或项目已在用），不规定具体框架与部署形态，不代替项目自己的 lint 与 CI 配置。

## Model Experience

### 技能目录与正文

#### What the model sees

目录贡献的名称为 `go-backend`，描述为：

> 在写或改 Go 后端代码时使用：按项目已有布局与依赖实现 HTTP、后台任务、数据库访问与测试，涵盖 cmd／internal 分层、context 与并发生命周期、错误包装、参数化查询与迁移，以及 go vet、go test -race 的交付验证。

被选择时加载的固定正文见 [`assets/go-backend.md`](assets/go-backend.md)。技能允许模型从目录加载，也允许用户显式调用。

#### Token effect

启用后目录增加一项固定描述；仅在模型或用户加载该技能时加入正文，正文大小固定。

#### KV Cache effect

固定目录条目改变目录所在请求前缀；加载正文后，该轮请求增加固定指引。技能启用状态或目录成员变化可能改变前缀。

## Known Limitations and Deferred Work

- 技能是约定而不是检查器：不能强制 `gofmt`、`vet` 或 `-race` 真的跑过，实际执行仍由模型的 Shell 调用与会话审批保证。
- 不覆盖 CGO、WASM 目标与嵌入式 Go 的特殊约束；这些场景需要项目自己的说明。
