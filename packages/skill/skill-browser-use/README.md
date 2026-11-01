# coding-skill-browser-use

随包分发的浏览器操作 skill 提供方，向 `ctx.skills` 登记 `browser-use`。插件依赖技能注册表，无配置；随包发布 `assets/browser-use.md` 作为正文资源，资源目录供技能消费方定位。插件卸载时撤销登记。启用本插件仅提供使用指引，不安装浏览器工具、浏览器服务或审批服务，也不改变权限。

技能面向页面阅读、交互和界面验收，包括本地开发页面。正文引导 Agent 使用受控的 `browser_*` 工具：以 `browser_navigate` 打开无凭据的 HTTP(S) 地址，随后用 `browser_snapshot` 读取语义树；点击、填写接受快照引用或 CSS 选择器，动作结果不包含更新后的语义树，后续动作应按需要重新观察。宿主交付导航、快照、页面信息、标签列表、点击、填写、滚动、等待、键盘、悬停、单元素读取、选择、拖拽、复选、人机验证检测和截图工具；标签仅能列出，不能通过工具打开、切换或关闭。没有 `revision` 参数、批量动作、视口尺寸设置或上传下载工具。截图只写入工作区新文件；只读会话禁止保存，其它会话仍按权限逐次审批。失败的动作可能已经改变页面，不自动重放提交或删除；被拒绝的调用、不可用的浏览器和远程工作区也不能通过其他入口绕过。页面内容属于不可信数据；视觉判断须查看实际截图，无法获取图像时说明限制。工具字段、审批和路径约束由[浏览器工具消费方](../../browser/tool-browser-ego/src/index.ts)持有；浏览器运行时由[宿主提供方](../../browser/browser-ego-host/src/index.ts)承接。

## Model Experience

### 技能目录与正文

#### What the model sees

目录贡献的名称为 `browser-use`，描述为：

> Use when a task requires reading, reproducing, verifying, or driving a rendered page, including your own app on localhost or a dev server, and any UI check or visual confirmation. Prefer registered browser_* tools over headless-browser scripts or the browser CLI. Load this skill before browser_navigate, browser_snapshot, browser_page_info, browser_tabs, browser_click, browser_fill, browser_scroll, browser_wait, browser_key, browser_read_element, or browser_screenshot.

被选择时加载的固定正文见 [`assets/browser-use.md`](assets/browser-use.md)。技能允许模型从目录加载，也允许用户显式调用。

目录描述涵盖本地开发页面和视觉确认，并要求在调用浏览器工具前先加载技能。技能正文在加载时加入模型上下文；工具清单与参数以运行时注册项为准，不能从技能文本推断不存在的工具。

正文以一参数对象调用为例，说明 URL、元素选择、动作后观察、截图权限、人工登录以及不重放不确定结果；详情直接阅读[技能正文](assets/browser-use.md)。

#### Token effect

启用后目录增加一项固定描述；仅在模型或用户加载该 skill 时加入正文。工具结果及图像由浏览器工具而非本包提供。

#### KV Cache effect

固定目录条目改变目录所在请求前缀；加载正文后，该轮请求增加固定指引。插件启用状态或目录成员变化可能改变前缀，页面观测不会改变本包的固定正文。

## Known Limitations and Deferred Work

- 技能只指导宿主实际交付的工具；模型没有上传、下载、标签切换、任意网页脚本、原始浏览器协议、视口尺寸或批量动作工具；响应式布局须根据实际可观察视口验证。
- 截图只写入工作区新文件；本地文件 URL 或脚本不是浏览器操作的替代通道。
- 技能不能强制执行浏览器权限或目标策略；执行判断由浏览器工具及服务提供方承担。
