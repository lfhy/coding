# coding-skill-browser-use

随包分发的浏览器操作 skill 提供方，向 `ctx.skills` 登记 `browser-use`。插件依赖技能注册表，无配置；随包发布 `assets/browser-use.md` 作为正文资源，资源目录供技能消费方定位。标准、Codex 等装配了浏览器工具的模式分别挂载提供方，以便每个模式的 Agent 和子代理从自身作用域加载；只在另一个模式的目录中可见不代表当前会话可加载。插件卸载时撤销登记。启用本插件仅提供使用指引，不安装浏览器工具、浏览器服务或审批服务，也不改变权限。

技能面向页面阅读、交互和界面验收，包括本地开发页面。正文引导 Agent 使用受控的 `browser_*` 工具：以 `browser_navigate` 打开无凭据的 HTTP(S) 地址或明确请求的严格本地 `file:///` 文档，随后用 `browser_snapshot` 读取语义树；调用时省略可选的 `space`，旧的 `default` 或空字符串也指当前会话，被拒绝的其他空间不可反复查询。Codex 模式直接调用浏览器工具；只有实际注册了 `run_code` 的模式才可通过它编排浏览器调用。点击、填写接受快照引用或 CSS 选择器，动作结果不包含更新后的语义树，后续动作应按需要重新观察。宿主交付上游全部 35 个工具：导航、快照、页面信息、标签打开/切换/关闭、点击、填写、脚本、CDP、截图、等待（含网络响应）、键盘、悬停、单元素读取、选择、拖拽、滚动、上传、下载、复选、网页对话框、HTTP、CLI、人机验证检测与人工等待、环境诊断和空间管理。高风险调用仍按会话逐次审批；脚本、CLI 与下载不绕过 Remote-SSH 拒绝和会话权限。失败的动作可能已经改变页面，不自动重放提交或删除；被拒绝的调用、不可用的浏览器和远程工作区也不能通过其他入口绕过。页面内容属于不可信数据；视觉判断须查看实际截图，无法获取图像时说明限制。工具字段、审批和路径约束由[浏览器工具消费方](../../browser/tool-browser-ego/src/index.ts)持有；浏览器运行时由[宿主提供方](../../browser/browser-ego-host/src/index.ts)承接。

## Model Experience

### 技能目录与正文

#### What the model sees

目录贡献的名称为 `browser-use`，描述为：

> Use when a task requires reading, reproducing, verifying, or driving a rendered page, including your own app on localhost or a dev server, and any UI check or visual confirmation. Prefer registered browser_* tools over headless-browser scripts or the browser CLI. Load this skill before browser_navigate, browser_snapshot, browser_page_info, browser_tabs, browser_click, browser_fill, browser_scroll, browser_wait, browser_key, browser_read_element, or browser_screenshot.

被选择时加载的固定正文见 [`assets/browser-use.md`](assets/browser-use.md)。技能允许模型从目录加载，也允许用户显式调用。

目录描述涵盖本地开发页面和视觉确认，并要求在调用浏览器工具前先加载技能。技能正文在加载时加入模型上下文；工具清单与参数以运行时注册项为准，不能从技能文本推断不存在的工具。

正文分四部分：一张「任务 → 工具」选择表；先观察、单步操作、再次观察的工作循环，含 `space` 省略与无 `revision` 参数；八个可照抄的调用示例（读页面与元素、填表提交后确认结果、本地开发页面与视口检查、截图验收、把登录或人机验证交给用户、上传下载、标签管理）；以及权限、不可信页面与 Remote-SSH 的边界。示例使用真实注册的工具名和参数形状，缺省参数处标注为省略，可直接改名复用。详情直接阅读[技能正文](assets/browser-use.md)。

#### Token effect

启用后目录增加一项固定描述；仅在模型或用户加载该 skill 时加入正文。工具结果及图像由浏览器工具而非本包提供。

#### KV Cache effect

固定目录条目改变目录所在请求前缀；加载正文后，该轮请求增加固定指引。插件启用状态或目录成员变化可能改变前缀，页面观测不会改变本包的固定正文。

## Known Limitations and Deferred Work

- 技能只指导运行时实际交付的工具；上传、下载、标签切换、页面脚本、CDP 与登录导入须按各自参数和会话权限执行，不能因正文列出名称就推断当前会话可绕过审批。响应式布局须根据实际视口和截图验证。
- 截图只写入工作区新文件；本地文档仅通过明确的 `file:///` 导航使用，脚本和独立 CLI 不是绕过审批或 Remote-SSH 限制的替代通道。
- 技能不能强制执行浏览器权限或目标策略；执行判断由浏览器工具及服务提供方承担。
