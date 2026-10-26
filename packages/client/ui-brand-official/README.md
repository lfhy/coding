# coding-client-ui-brand-official

仅当 `DSH_CLIENT_BUILD_PROFILE` 为 `official` 时，本包才使用 Coding 图标填充 `conversation.hero.brand.mark`。其他构建仍会加载插件，但不注册 occupant，Hero 因此显示调用方自己的兜底呈现。

占位者通过 `slots.inject()` 作为声明感知注册安装。因此无论该包的条目先于还是后于会话声明方激活，它都能工作；声明折叠时会撤回占位者，HMR 期间不会留下半个品牌。它不保留运行时状态。node 半边是空的 Loader seat；浏览器标题仍属于本包之外的构建环境事项。

## 模型体验

无，因为本包只贡献浏览器呈现；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与暂缓事项

- **侧栏不再有品牌字标** —— 展开侧栏的顶部位置属于新对话入口，品牌只在 Hero 图标处出现。
- **浏览器标题相互独立** —— `DSH_CLIENT_TITLE` 在构建期选择标题文字，而不经过 UI slot。
