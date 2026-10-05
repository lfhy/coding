# @deepseek-ai/dsh-skill-browser-use

随包分发的浏览器操作 skill 提供方，向 `ctx.skills` 登记 `browser-use`。插件依赖技能注册表，无配置；随包发布 `assets/browser-use.md` 作为正文资源，资源目录供技能消费方定位。插件卸载时撤销登记。启用本插件仅提供使用指引，不安装浏览器工具、浏览器服务或审批服务，也不改变权限。

技能面向需要打开和检查网页、操作已观察到的控件、滚动或检查截图的任务。它要求在每次动作后检查返回观测，仅使用最新观测的元素 ref 与 revision，动态加载或引用失效时重新获取快照；除非用户要求关闭，否则保留页面供工作台查看。网页内容是非可信数据。七项工具的字段、执行审批、远程工作区限制及浏览器提供方行为分别由[工具消费方](../../browser/tool-browser/README.md)和[Playwright 提供方](../../browser/browser-playwright/README.md)拥有；此包不承诺自动等待或限制导航目的地。

## Model Experience

### 技能目录与正文

#### What the model sees

目录贡献的名称为 `browser-use`，描述为：

> Use for tasks that require browsing a web page: open a URL, inspect page text and elements, click or fill observed controls, scroll, or inspect a screenshot. Load before using the browser_navigate, browser_snapshot, browser_click, browser_fill, browser_scroll, browser_screenshot, or browser_close tools.

被选择时加载的固定正文见 [`assets/browser-use.md`](assets/browser-use.md)。技能允许模型从目录加载，也允许用户显式调用。

#### Token effect

启用后目录增加一项固定描述；仅在模型或用户加载该 skill 时加入正文。工具结果及图像由浏览器工具而非本包提供。

#### KV Cache effect

固定目录条目改变目录所在请求前缀；加载正文后，该轮请求增加固定指引。插件启用状态或目录成员变化可能改变前缀，页面观测不会改变本包的固定正文。

## Known Limitations and Deferred Work

- 技能只描述当前七项结构化操作，不增加键盘、历史、标签页或任意脚本操作；需要这些能力的任务须由其他受控界面处理。
- 技能不能强制执行浏览器权限或目标策略；执行判断由浏览器工具及服务提供方承担。
