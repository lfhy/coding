# coding-skill-frontend-development

前端开发技能提供方，向 `ctx.skills` 登记 `frontend-development`。它把信息架构与视觉层级、前端实现、图标与组件复用、列表滚动与列宽行高、可复制的页面骨架与 CSS 动效参考、可见文案边界和浏览器验收的约束按需加载到模型上下文；不改变现有 UI 组件、样式或浏览器工具的运行时行为。

## Model Experience

### 技能目录与正文

#### What the model sees

目录贡献的名称为 `frontend-development`，描述为：

> 在创建或修改前端、网页、组件或用户界面时使用。先定信息架构再写代码：把内容分成焦点区、主任务区与参考区，一屏只有一个主行动，标题／区域标题／正文／说明要有明确的字号与字重阶梯；禁止把重要性或内容量不同的东西做成同尺寸卡片平铺，当前状态用带状区域、同级项用紧凑行、参考资料用链接，页面不能是等大卡片墙。遵循项目已有技术栈、组件、图标库和设计规范；没有既有图标库时按需读取内置参考并默认选用 Lucide，禁止手写或内联 SVG（除非确实缺少领域图标且已走项目图标抽象，且先用画图工具生成底板再转 SVG）；禁止直接摆浏览器原生控件（搜索框、下拉、复选框、日期与颜色控件），必须套项目共享表单组件或先在共享层补一个；请求失败等短暂通知必须使用共享 Toast，长流程使用分步模态框，抽屉内使用子 Tab；页面外壳固定一屏（100dvh），数据变多只让列表或卡片内容区内部滚动，整页不随数据变长；列表页的搜索与筛选工具栏留在视口内，长列表使用虚拟滚动与无限滚动加载；列表不超出屏幕宽度，长名称截断成省略号且整行不换行，行高统一，列不够时按优先级隐藏；缺少共享组件时直接抄内置案例（子 Tab、弹层、Toast、认证页、设置页含修改密码弹窗、列表页、仪表盘、接入中心页），并保持其 ARIA 与键盘行为；避免文字海报和页面／图标硬切；禁止把系统或开发者提示、提示词、技能、工具调用、Agent 计划、开发说明、实现过程、验收说明、框架／库／包标识、内部路径、调试信息或内部状态写进用户界面，页面只保留用户自己的处境、能做的动作和产品语言；完成后加载 browser-use 检查真实渲染、字号阶梯与信息层级。仅在用户明确要求具名视觉方向时配合 stylekit，不能覆盖产品规范。

加载后，模型会获得 [`assets/frontend-development.md`](assets/frontend-development.md) 中的完整工作约束，以及按需读取的 [`assets/information-architecture.md`](assets/information-architecture.md) 信息架构与视觉层级参考（分层规则、降级阶梯、字号阶梯、间距尺度，以及「完全平铺／缺视觉层级／缺空间组织」三个缺陷的判定与前后对照）、[`assets/list-scroll.md`](assets/list-scroll.md) 列表滚动、列宽与行高参考、[`assets/icon-library.md`](assets/icon-library.md) 图标库选择参考、[`assets/notification-and-structure.md`](assets/notification-and-structure.md) 通知与复用结构参考、[`assets/motion-recipes/`](assets/motion-recipes/index.md) CSS 动效参考，以及 [`assets/examples/`](assets/examples/index.md) 里可直接抄的共享组件与页面骨架：`tabs/`（子 Tab，含 ARIA 与键盘）、`dialog/`（模态框，Escape／焦点回归／`aria-modal`）、`toast/`（全局 `aria-live` 提示）、`fields/`（TextField／SearchField／Select，禁止页面直接摆原生控件）、`pages/auth-page.tsx`（单列居中认证页）、`pages/settings-page.tsx`（左栏子 Tab + 修改密码弹窗）、`pages/list-page.tsx`（页头与工具栏固定、只滚列表体、单行省略）、`pages/dashboard-page.tsx`（100dvh 外壳 + 面板内列表滚动，「查看全部」只展开面板不加长页面）、`pages/hub-page.tsx`（接入中心：当前状态用带状区域、多个同级方式用可比较的行、参考资料用链接，而不是一排等大卡片）。案例只提供形状与交互契约，复制到项目共享层后要换成项目自己的主题令牌。

本技能负责信息架构与视觉层级、现有技术栈与组件复用、图标库选择、通知与分层交互、列表页的滚动归属、列宽与行高约束、虚拟滚动／无限滚动、可见文案边界、CSS 动效配方的按需选用以及真实页面验收的调度；它不绑定某个框架、组件库、图标包或虚拟化库，目标项目已有约定优先。`browser-use` 负责受控地观察和操作渲染页面，只有需要页面验收时才加载；`stylekit` 只在用户点名或明确要求具名视觉方向时加载，负责颜色、令牌与 do／don't 规则，不能覆盖产品行为、无障碍、现有组件或项目设计规范。
#### Token effect

未加载时只增加一条目录摘要；加载后增加信息架构与视觉层级、前端实现、图标与组件复用、通知与分层交互、列表页的滚动归属、列宽与行高约束与虚拟滚动／无限滚动、CSS 动效配方、用户体验和浏览器验收规则。该技能不向页面注入文案，也不改变浏览器工具的权限。

#### KV Cache effect

固定目录条目会改变技能目录所在请求前缀；正文只在模型选择该技能时加入请求。技能目录变化可能使请求前缀变化，浏览器页面观测不会改变本技能正文。

## Known Limitations and Deferred Work

- 技能只能约束模型的实现选择，不能替代项目自身的依赖、样式、组件和无障碍检查。
- 浏览器验收由 `browser-use` 和浏览器工具提供；本技能不安装浏览器、不执行截图，也不改变审批策略。
- 无密钥单元测试只固定技能正文与案例内容（分层规则、字号阶梯、禁泄漏清单都在 `tests/skill-frontend-development.spec.ts` 里断言），不评估生成页面的效果。想复核真实效果时用 [`tests/fixtures/page-build.cordis.yml`](tests/fixtures/page-build.cordis.yml) 起一个真实模型 Agent：同一提示词改动前后各跑一次，再按 `assets/information-architecture.md` 第 7 节的口径量字号档位、实心按钮数量与等大卡片分组，不把这类生成式检查放进 CI。
