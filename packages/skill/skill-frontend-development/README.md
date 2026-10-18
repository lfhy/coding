# coding-skill-frontend-development

前端开发技能提供方，向 `ctx.skills` 登记 `frontend-development`。它把前端实现、项目初始化和用户体验检查的约束按需加载到模型上下文；不改变现有 UI 组件、样式或浏览器工具的运行时行为。

## Model Experience

### 技能目录与正文

#### What the model sees

目录贡献的名称为 `frontend-development`，描述为：

> 在创建或修改前端、网页、组件或用户界面时使用。先遵循项目已有技术栈、UI 模块和设计规范；不要从空白重写，不要使用浏览器默认控件；完成后加载 `browser-use` 检查渲染效果和交互。新项目先用现代化脚手架或参考模板，不把实现提示词、系统指令或过度防御文案展示在用户页面。

加载后，模型会获得 [`assets/frontend-development.md`](assets/frontend-development.md) 中的完整工作约束。

#### Token effect

未加载时只增加一条目录摘要；加载后增加前端实现、初始化、用户体验和浏览器验收规则。该技能不向页面注入文案，也不改变浏览器工具的权限。

#### KV Cache effect

固定目录条目会改变技能目录所在请求前缀；正文只在模型选择该技能时加入请求。技能目录变化可能使请求前缀变化，浏览器页面观测不会改变本技能正文。

## Known Limitations and Deferred Work

- 技能只能约束模型的实现选择，不能替代项目自身的依赖、样式、组件和无障碍检查。
- 浏览器验收由 `browser-use` 和浏览器工具提供；本技能不安装浏览器、不执行截图，也不改变审批策略。
