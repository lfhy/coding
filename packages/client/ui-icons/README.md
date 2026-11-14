# coding-client-ui-icons

本包是浏览器客户端图标的独立组件边界。`Icon` 按产品语义名称选取图形，调用方只提供 `name`、可选的 `size`（默认 16px）与 `className`，一般图标颜色继承 `currentColor`，按钮的可访问名称仍由按钮自身提供。`sidebar` 映射到 Semi 的侧边栏图形，`files-panel` 使用该图形的右侧变体，`bottom-panel` 映射到终端图形。具体的 Semi 组件、旋转和尺寸适配仅在本包；业务组件不直接引用 `@douyinfe/semi-icons`。

原有具名的 `ic_ds_*` 图形完整迁入本包并保持各自默认尺寸；`ui-primitives` 继续转发这些导出，使旧组件无需一次性迁移。新图标先扩展 `IconName` 的语义映射，再让调用方使用统一的 `<Icon name="…" />`。`terminal-menu` 映射到本包导出的 `IconTerminalOutline16`，与工作台功能菜单的其他图标同族；模型能力开关分别使用 `model-vision` 的图片图形与 `model-reasoning` 的推理图形，图标本身不承载按钮名称；底栏开关的 `bottom-panel` 仍使用原有语义图形；`open-window` 使用设计系统的线性外开图形，供「在浏览器窗口中打开」这类把内容交给独立窗口的动作使用，不再由本包自绘。
`favorite` 使用统一的线性心形图形，选中状态由业务按钮的颜色和 `aria-pressed` 表达。
`undo` 与 `redo` 分别使用 Semi 的左右回转箭头，继承 `currentColor`，尺寸与布局类名通过统一的 `Icon` 属性传入。
`drag-handle` 使用 Semi 的六点抓手，用于标示悬浮面板等区域的拖拽位置；图标只负责呈现，拖拽交互由调用方实现。
`home` 使用 Semi 的线性房屋图形，供外层导航的「回到对话」入口使用；它继承文字颜色，不使用品牌 Logo。
`ppt-workbench` 使用上游 PPT 品牌标的 36×36 画布、橙色后片、蓝色前片和白色横线。它保留品牌固定颜色与渐变，不继承 `currentColor`；多个实例各有独立渐变 id。来源、改动与完整 MIT 许可见包内 [NOTICE](NOTICE) 和 [LICENSE.PptMark](LICENSE.PptMark)。

## 模型体验

无。图标只参与客户端呈现，不进入会话日志或模型请求。

#### KV 缓存影响

无；本包不发送提供方请求。

## 已知限制与延后工作

- 旧具名图标保留原来的默认尺寸；语义图标默认 16px，调用处可覆盖，不承诺与某个第三方图标名称一一对应。
- `ui-conversation` 的闪光图标是重新绘制的近似版本；本地设计数据尚不能导出对应的字体字形。
