# coding-skill-project-init

随包分发 [`project-init`](../../../README.md) 技能：在改动业务代码之前先定地基与可回滚的版本基线。插件依赖 `ctx.skills`，无配置；正文是 [`assets/project-init.md`](assets/project-init.md)，资源目录同时交给消费方定位。卸载即撤销登记。

技能面向三类时机：在空目录开始新项目、用户要求某次改动「可回滚」、以及在一个还不是 Git 工作区的项目里动手实现。正文要求先用 `git rev-parse --show-toplevel` 判断现状（父级仓库与 worktree 都算已在工作区），不在工作区时才 `git init -b main`；随后写 `.gitignore`，逐条确认要纳入版本的文件并用具体路径 `git add`，最后建一条基线提交作为回退锚点。之后每一步改动按「改一处 → 跑覆盖该处的验证 → 一个本地提交」推进，不推送、不改写历史、不切分支。

新项目在有联网能力、且用户没有要求完全从 0 开发时，正文要求先搜 GitHub 找现成地基而不是从空文件手搭：优先挑同栈的 template／脚手架仓库作为项目模板，对话／Agent 类项目先看 `vercel/ai-chatbot` 与 HeroUI 的 chat 模板；没有合适的模板再找同类产品仓库做参考（后台管理系统点名 `vue-vben-admin`、`shadcn-admin`，对话页面点名 `assistant-ui/assistant-ui`、`CherryHQ/cherry-studio`、`deepseek-ai/deepseek-harness`），要借的是实现本身而不是照着它的布局另写一份；两者都没有才从零搭并说明搜索结论。正文另有一条针对对话与 Agent 页面的规则：流式增量、消息列表与虚拟滚动、markdown 与代码块渲染、工具调用与推理展示、停止与重试、附件与多模态都有成熟实现，直接接 `assistant-ui` 这类库或沿用所选模板的组件，不自己重写；`CherryHQ/cherry-studio` 是 AGPL-3.0，只读做法不复制代码。模板通过 `npx degit` 或浅克隆到临时目录再拷入落地，不保留模板自己的 `.git`，先跑通模板自带的安装与启动命令，再把模板原状作为基线提交，并在 `README.md` 写明来源、版本、许可证与本地改动范围。落地后就在这份真实代码上改——改配置、删示例页面、把它的组件接到自己的数据与接口，而不是读完目录布局再另建一套「差不多」的实现：只凭观感重写会丢掉模板已处理好的边界、状态与时序。参考仓库同理，要借的是实现本身，能装包就装包，许可证允许就移植那段代码并保留声明。GitHub 直连不通或很慢时正文要求改用镜像前缀（`https://gh-proxy.com/https://github.com/<owner>/<repo>.git`，raw 同样加前缀）而不是干等；`npx degit` 只认直连主机，加前缀会报 `UNSUPPORTED_HOST`，此时改用前缀 `git clone` 再删 `.git`，试过两三个镜像仍失败就请用户给可用代理或镜像。镜像只作下载通道，`README.md` 的来源仍写 `github.com` 上的 `owner/repo` 与 commit。前端与后端都不由模板定型：Go 项目的前端工程放在模块的 `web/` 下、产物进 `web/dist` 并经 `go:embed` 嵌进二进制由服务端提供，交付前必须真的构建得出来；后端按已加载的分层技能搭，例如 Go 用 `go-backend` 的根 `main.go` 加 `cmd/`、`conf/`、`core/` 分层，新项目不建 `internal/`。

正文另有一节配置约定：追求 0 配置启动（每项都有可用默认值），配置文件一律 TOML，Go 项目用 `github.com/lfhy/flag` 统一解析参数、配置文件与默认值并复用它的子命令框架；覆盖顺序按该库为命令行 > 环境变量 > 配置文件 > 默认值，所以环境变量只绑运维型配置，用户会改的业务配置只落 TOML 与设置页。有页面就必须提供系统设置页面，让用户在界面里改配置并写回文件，而不是手动编辑配置文件，设置页与命令行、环境变量共用同一份解析与校验。

遇到陌生领域时正文要求先去 GitHub 搜该领域的 skill／AGENTS 规范，把能用的迁成项目级 skill（`.agents/skills/<kebab-name>/SKILL.md`，记录来源与许可证），而不是凭印象现编。文档结构按层拆分：根 `AGENTS.md` 只放每次会话都要用的内容，每个服务层／子系统各有一份自己的 `AGENTS.md`，改到那层才加载；代码地图 `docs/codemap/README.md` 必须保留并随模块同步，由根 `AGENTS.md` 链接，用了模板也要补上。

正文同时给出新项目的最小文件集（`README.md` 说明做什么与怎么运行，`AGENTS.md` 说明结构、命令、约定与安全边界并按层拆分，`docs/codemap/README.md` 作代码地图入口），并明确三条禁止：不在工作目录之外初始化仓库、不在已有仓库里建嵌套仓库、不提交凭据与构建产物。用户明确不要 Git 时正文要求照办并说明代价。

它不做别的事：不删除或覆盖用户已有文件，不改 `.gitignore` 之外的配置，不代替用户决定推送与分支策略，也不替用户挑选与需求不符的技术栈；这些判断留给会话里的用户指令与项目约定。

## Model Experience

### 技能目录与正文

#### What the model sees

目录贡献的名称为 `project-init`，描述为：

> 在新建项目（含 AI 对话／Agent 页面）、空目录或需要让改动可回滚时使用：已在 Git 工作区就不重复初始化；新项目且有联网时先在 GitHub 按优先级找 template 或同类开源仓库（如 vben、shadcn-admin、assistant-ui、Cherry Studio）当地基，对话页面直接接成熟实现不重写；前端进 Go 工程的 web 目录并由 go:embed 提供、后端按分层技能自己搭；未初始化就 git init、写 .gitignore、逐条确认后建基线提交，并给出新项目最小的 README／AGENTS；之后每一步改动都小步验证并本地提交。

被选择时加载的固定正文见 [`assets/project-init.md`](assets/project-init.md)。技能允许模型从目录加载，也允许用户显式调用。

#### Token effect

启用后目录增加一项固定描述；仅在模型或用户加载该技能时加入正文。正文不含随仓库变化的内容，加载后的大小固定。

#### KV Cache effect

固定目录条目改变目录所在请求前缀；加载正文后，该轮请求增加固定指引。技能启用状态或目录成员变化可能改变前缀。

## Known Limitations and Deferred Work

- 技能只给操作顺序与判断标准，不能代替执行：初始化、模板落地、忽略规则与提交仍由模型用 Shell、Git 与联网工具完成，权限与审批沿用会话设置。
- 模板挑选依赖模型当场搜索与判断，正文不给仓库清单快照；推荐的具体模版（`vue-vben-admin`、`shadcn-admin`）会随上游生态变化，失效时以当场搜索结果为准。
- 不覆盖非 Git 的版本控制方案；使用其他 VCS 的项目只能在正文之外按其约定处理。
- 第三方模板的许可证合规由会话内的用户指令决定；正文只要求记录来源与遵循模板的声明要求，不代替许可证审核。
