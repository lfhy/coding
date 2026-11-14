# coding-client-ui-renderer

负责 React 渲染层的浏览器 Cordis 插件。[`dsh-client-web`](../web/README.md) 渲染不依赖框架的启动页并加载完整的客户端插件名册；所有 entry 激活后，它调用 `ctx.uiRenderer.mount(container)`。本包提供该服务、安装 slot 渲染器、hydrate 现有启动 DOM、在下一次绘制前切换到组装完成的应用，并返回 React 根的卸载 disposer。

client entry 还持有 slot outlet、会话 provider 以及 observable 到 uSES 绑定的 React 实现。业务插件通过带类型的 slot `hooks` 传递裸 observable source；渲染器在 outlet 处完成绑定。插件在 `slots`、`sessions` 和 `layout` 就绪后激活，投影当前会话标题，并执行全程序唯一一次上下文级 `renderSlot('root')` 调用。React、React DOM、Cordis、ui-slots 和 ui-primitives 通过 web 外壳的静态模块表保持同一浏览器身份；本包则以动态客户端 bundle 到达。

`session-maybe` 默认保留无会话到首个会话的组件身份，之后切换或清空会话时重挂。显式 `sessionIdentity: 'entry'` 的常驻壳保留 React 身份，但标准 hook、注入和 store 继续使用当前会话；新对话根壳与输入栏用此选项保留编辑器，并由页面管理开始方式与临时选择的归属。

## 模型体验

无，因为 UI 渲染器只组装浏览器 UI，不贡献模型可见输入。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **应用首帧会等待全部客户端 entry**——启动内核只在 loader 名册稳定后交出挂载点。按区域就绪仍属暂缓事项。
- **slot 渲染没有 Suspense 集成或逐 entry 惰性加载**——完整插件名册稳定后，渲染器才挂载根节点。
