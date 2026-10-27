# coding-skill-frontend-development

前端开发技能提供方，向 `ctx.skills` 登记 `frontend-development`。它把前端实现、图标与信息层级、列表滚动与列宽行高、可复制的 CSS 动效参考、用户体验和浏览器验收的约束按需加载到模型上下文；不改变现有 UI 组件、样式或浏览器工具的运行时行为。

## Model Experience

### 技能目录与正文

#### What the model sees

目录贡献的名称为 `frontend-development`，描述为：

> 在创建或修改前端、网页、组件或用户界面时使用。遵循项目已有技术栈、组件、图标库和设计规范；没有既有图标库时按需读取内置参考并默认选用 Lucide，禁止手写或内联 SVG（除非确实缺少领域图标且已走项目图标抽象）；请求失败等短暂通知必须使用共享 Toast，长流程使用分步模态框，抽屉内使用子 Tab；列表页不整页滚动，搜索与筛选工具栏留在视口内，只让列表区域内部滚动，长列表使用虚拟滚动与无限滚动加载；列表不超出屏幕宽度，长名称截断成省略号且整行不换行，行高统一，列不够时按优先级隐藏；避免文字海报和页面／图标硬切；禁止把系统或开发者提示、技能、工具调用、Agent 计划、框架／库／包标识、内部路径、调试信息或内部状态写进用户界面；完成后加载 browser-use 检查真实渲染与交互。仅在用户明确要求具名视觉方向时配合 stylekit，不能覆盖产品规范。

加载后，模型会获得 [`assets/frontend-development.md`](assets/frontend-development.md) 中的完整工作约束，以及按需读取的 [`assets/list-scroll.md`](assets/list-scroll.md) 列表滚动、列宽与行高参考、[`assets/icon-library.md`](assets/icon-library.md) 图标库选择参考、[`assets/notification-and-structure.md`](assets/notification-and-structure.md) 通知与复用结构参考和 [`assets/motion-recipes/`](assets/motion-recipes/index.md) CSS 动效参考。

本技能负责现有技术栈与组件复用、图标库选择与信息层级、通知与分层交互、列表页的滚动归属、列宽与行高约束、虚拟滚动／无限滚动、可见文案边界、CSS 动效配方的按需选用以及真实页面验收的调度；它不绑定某个框架、组件库、图标包或虚拟化库，目标项目已有约定优先。`browser-use` 负责受控地观察和操作渲染页面，只有需要页面验收时才加载；`stylekit` 只在用户点名或明确要求具名视觉方向时加载，负责颜色、令牌与 do／don't 规则，不能覆盖产品行为、无障碍、现有组件或项目设计规范。
#### Token effect

未加载时只增加一条目录摘要；加载后增加前端实现、图标与信息层级、通知与分层交互、列表页的滚动归属、列宽与行高约束与虚拟滚动／无限滚动、CSS 动效配方、用户体验和浏览器验收规则。该技能不向页面注入文案，也不改变浏览器工具的权限。

#### KV Cache effect

固定目录条目会改变技能目录所在请求前缀；正文只在模型选择该技能时加入请求。技能目录变化可能使请求前缀变化，浏览器页面观测不会改变本技能正文。

## Known Limitations and Deferred Work

- 技能只能约束模型的实现选择，不能替代项目自身的依赖、样式、组件和无障碍检查。
- 浏览器验收由 `browser-use` 和浏览器工具提供；本技能不安装浏览器、不执行截图，也不改变审批策略。
