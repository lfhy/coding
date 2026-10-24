# coding-skill-frontend-development

前端开发技能提供方，向 `ctx.skills` 登记 `frontend-development`。它把前端实现、图标与信息层级、可复制的 CSS 动效参考、用户体验和浏览器验收的约束按需加载到模型上下文；不改变现有 UI 组件、样式或浏览器工具的运行时行为。

## Model Experience

### 技能目录与正文

#### What the model sees

目录贡献的名称为 `frontend-development`，描述为：

> 在创建或修改前端、网页、组件或用户界面时使用。遵循项目已有技术栈、组件、图标库和设计规范，避免文字海报；按需读取内置 CSS 动效配方，避免页面和图标硬切；禁止把系统或开发者提示、技能、工具调用、Agent 计划、框架／库／包标识、内部路径、调试信息或内部状态写进用户界面；保证主要流程在 `100vh` 内可用，善用子 Tab、抽屉和模态框；完成后加载 browser-use 检查真实渲染与交互。仅在用户明确要求具名视觉方向时配合 stylekit，不能覆盖产品规范。

加载后，模型会获得 [`assets/frontend-development.md`](assets/frontend-development.md) 中的完整工作约束和按需读取的 [`assets/motion-recipes/`](assets/motion-recipes/index.md) CSS 动效参考。

本技能负责现有技术栈与组件复用、图标与信息层级、可见文案边界、CSS 动效配方的按需选用以及真实页面验收的调度；Coding 客户端示例以 [`packages/client/UI_DESIGN.md`](../../client/UI_DESIGN.md) 为产品规范。`browser-use` 负责受控地观察和操作渲染页面，只有需要页面验收时才加载；`stylekit` 只在用户点名或明确要求具名视觉方向时加载，负责颜色、令牌与 do／don't 规则，不能覆盖产品行为、无障碍、现有组件或项目设计规范。
#### Token effect

未加载时只增加一条目录摘要；加载后增加前端实现、图标与信息层级、CSS 动效配方、用户体验和浏览器验收规则。该技能不向页面注入文案，也不改变浏览器工具的权限。

#### KV Cache effect

固定目录条目会改变技能目录所在请求前缀；正文只在模型选择该技能时加入请求。技能目录变化可能使请求前缀变化，浏览器页面观测不会改变本技能正文。

## Known Limitations and Deferred Work

- 技能只能约束模型的实现选择，不能替代项目自身的依赖、样式、组件和无障碍检查。
- 浏览器验收由 `browser-use` 和浏览器工具提供；本技能不安装浏览器、不执行截图，也不改变审批策略。
