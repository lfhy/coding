# coding-client-ui-theme

主题插件：基于 `--dsw-*` token 基础样式表（静态尺度 + 别名语义层）的 ThemeRuntime，以及设置里的「主题外观」页面。该服务拥有实时的外观选择（`light`／`dark`／`system` 或任一已注册主题 id），把 `system` 与声明 `auto` 的主题通过 `prefers-color-scheme` 解析成具体明暗，并发布不可变的 `ThemeSnapshot`，通过 `theme/change` 事件通知变化；它绝不接触 DOM：ui-layout 的呈现器会应用解析后的快照（`html { color-scheme }`、`body[data-ds-dark-theme]`，以及主题的别名 token 内联变量）。

来自回环地址的浏览器会先以 `system` 立即提供该服务，随后在后台加载 `ui-theme` 分节，并把每次选择通过 Host settings API 写入；其本地提供方默认将设置存入 `$DSH_HOME/settings.yaml`。收到推送的 settings 变更时或重连后，浏览器都会重新拉取该设置；连续快速选择会按操作顺序携带 namespace revision 串行写入，最新写入被拒时则重新加载持久化值。选择值是字符串：内置三项之外，内置预设 id 与导入的主题包 id 同样持久化，因此重启后仍是同一套外观；远程浏览器无法访问特权 settings API，它的选择仅保留在进程内。持久化边界由 Host settings 支撑的偏好决策拥有。

## 内置主题目录

`src/themes/` 是三套上游主题的移植层，随包内置，不需要再装插件：

| 来源 | 套数 | 说明 |
| --- | --- | --- |
| [dsh-dream-skin](https://github.com/RevolutionLA/dsh-dream-skin)「幻梦」 | 8 | 固定明暗的原创皮肤，各带一段弥散光背景（默认壁纸）。 |
| [dsh-joi-channel-theme](https://github.com/tpmoonchefryan/dsh-joi-channel-theme)「轴伊」 | 2 | 双衣装配色，各自提供浅色/深色两套令牌与底纹。 |
| [dsh-opencode-palette](https://github.com/FeatherHunter/dsh-opencode-palette)「OpenCode 调色板」 | 37 | 上游 37 个语义色换算成本项目设计令牌；浅色变体可用时跟随外观，否则固定深色。 |

来源、移植范围与逐项差异见 [NOTICE.md](NOTICE.md)。

`src/themes/thumbnails/` 存压缩后的界面截图（640px 宽的 JPEG，每张 25–50 KB），`scripts/gen-thumbnails.mjs` 把它们内联成 `src/themes/thumbnails.generated.ts` 里的 data URL——客户端插件只对外提供 `client.js`，同目录的图片文件浏览器取不到，内联是唯一不动宿主静态资源约定的做法。换图后运行 `pnpm --filter coding-client-ui-theme gen:thumbnails`，不要手改生成物。

数据在 `src/themes/data/`，只描述上游给的东西（令牌、明暗归属、自带背景、缩略图键）；`themes/catalog.ts` 判断明暗归属、分组与卡片预览色，`themes/opencode.ts` 持有 OpenCode 语义槽到本项目令牌的唯一映射表，`themes/color.ts` 是共用的解析与混色。新增或改动主题只改这三处。目录在模块加载时构建一次，`auto` 缺一套令牌、id 重复这类问题会直接抛错——数据是我们自己的，静默降级只会让页面少一张卡片而无从排查。

## 主题外观页面

页面注册进 `settings.section`（id `appearance`），由主题特征自己拥有；General 分区里的「外观」行（浅色/深色/跟随系统）保留，选择主题预设时该行点亮解析后的明暗方块。页面内容：

- **配色墙**：内置三项外观 + 全部预设 + 导入的主题包，按来源与收藏筛选，可搜索；点卡片即切换，卡片下方是收藏开关。卡片优先展示该主题的界面缩略图（幻梦 8 套、轴伊 2 套各带截图；跟随明暗的轴伊另按当前方案换图），没有截图的主题（内置三项、OpenCode 调色板、导入的主题包）回落到底色 + 强调色 + 正文色的配色块。卡片墙自己滚动，最多占 52vh，高级外观不会被 47 套列表顶到几屏之外。
- **壁纸**：跟随主题自带的弥散光、关闭、渐变预设，或图片（图片地址或本地文件）。可见度、模糊、填充方式（裁剪填满／完整显示／平铺）可调。本地图片在浏览器里等比缩放到最长边 2400px 并按 0.82→0.4 的 JPEG 质量逐档压缩，仍超过上限就拒绝并提示换一张。
- **强调色**：12 个色块或自选颜色，覆盖 `--dsw-alias-brand-*`、按钮主色、业务状态色等令牌；选择「跟随主题」即撤销。
- **玻璃与不透明度**：标准／磨砂材质（磨砂给遮罩加 14px 背景模糊，并把壁纸再柔化 6px），面板不透明度稀释浮层表面。
- **主题包**：把当前主题与外观导出成 `*.theme.json`、导入别人的主题包、复制分享链接；导入的主题包落在设置文档里，关掉页面仍在。
- **随机换一个 / 还原默认**：还原会回到跟随系统并清空强调色、壁纸与材质，收藏和已导入主题包保留。

外观层（`src/client/appearance-runtime.ts`）把以上设置换算成一层 `ctx.theme.overrideTokens` 覆盖挂在生效主题之上，因此不改动任何已注册主题，关掉即恢复主题原样。它只读取注册表里的主题定义，不读合成后的快照——否则本层自己的输出会在下一次计算里被当成主题底色、逐次叠加透明度。

壁纸通过 `wallpaper.css` 的 `body::before` 铺在画布之下；外观层把 `--dsw-alias-bg-base` 与 `--dsw-specific-sidebar-fill` 按可见度稀释成半透明，壁纸才透得出来。`--dsh-wallpaper-*` 与其它令牌一样由呈现器写到 body 行内，伪元素继承读取；没有壁纸时 `--dsh-wallpaper-opacity` 缺失，取 0，这一层不绘制。

打开带 `#theme-pack=` 的分享链接时，插件在启动阶段导入主题包并清掉 hash，刷新不会重复导入。导入失败不打断启动。

## 引导与首帧

当主机组合包含 HTTP 服务器时，主机侧紧接 `<body>` 起始标签注入同步引导代码。每份 index 响应会嵌入当前持久化的选择；内置偏好照旧解析，主题预设按它声明的明暗（`auto` 交给系统配色），并额外把该方案的画布底色铺到 `body` 上，避免插件加载前闪一帧错的配色。不含 HTTP 服务器的组合不受影响，插件树激活后 ThemeRuntime 与 ui-layout 仍分别是客户端状态和后续 DOM 更新的权威来源。

## 样式表

`src/styles/` 下有六张样式表，由 ui-theme 的动态客户端 entry 依次导入：`base.css`、`design-platform.css`、`scrollbar.css`、`gradient-shadow-text.css`、`shiki.css` 与 `wallpaper.css`。客户端 bundle 将其编译并注入为插件持有的全局样式，因此卸载与 HMR 会随 ui-theme 一同移除这些样式，而不会把主题 CSS 留在静态 Web 外壳中。`scrollbar.css` 是 `--dsw-alias-scrollbar-*` token 的唯一消费方，必须排在声明这些 token 的 `design-platform.css` 之后。

输入栏推理强度控件所需的明暗表面、轨道、滑块、逐档文字与填充颜色、蓝紫渐变和星点由本包的 `--dsw-specific-reasoning-*` 与 `--dsw-linear-reasoning-*` token 持有；模型选择面板继续使用普通菜单 token。

滚动条重新绑定约定：`scrollbar.css` 在 `body` 上把 `--dsh-scrollbar-thumb` 与 `--dsh-scrollbar-thumb-hover` 绑定到 l1（基础表面）token，两条渲染路径都读取这一组变量。高层级表面（菜单、浮层、对话框）在自己的容器上设置 `--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2)` 与 `--dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2)`；一次重新绑定即可为引擎实际走的那条路径换色。这组变量的另一个合法目标是 `transparent`，即完全不绘制滑块——[ui-sidebar](../ui-sidebar/README.md) 在指针不在栏内时就这样重新绑定自己的列。绑回 l1 那组不算重新绑定，它只是重述基础表面的默认值。`--dsh-scrollbar-width` 镜像 WebKit 滚动条的布局宽度，供需要与占布局宽度的滚动条对齐的表面使用——[ui-conversation](../ui-conversation/README.md) 用它作为覆盖 composer 座位 `right` 偏移——scrollbar-styles 规格把它与镜像规则及消费者配对检查。

两条路径在构造上互斥。`scrollbar-width`／`scrollbar-color` 写在 `@supports not selector(::-webkit-scrollbar)` 之内，因为这两个属性中的任一个只要取非 `auto` 值，Chromium 与 Safari 就会丢弃该元素上的全部 `::-webkit-scrollbar*` 规则，`::-webkit-scrollbar-thumb:hover` 也在其中——若无条件地同时声明，`--dsh-scrollbar-thumb-hover` 在任何引擎上都不会被渲染。因此 Firefox 走标准属性，WebKit 系引擎走伪元素，hover token 只经由伪元素这条路径渲染。相关原理与实测计算值见滚动条 设计记录。

## 模型体验

无。主题服务管理浏览器外观；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **主题是表层，不是产品**：注册主题意味着覆盖同名别名变量；目前不会验证一组覆盖是否完整——导入的主题包只校验格式、令牌名与长度，不判断配色是否成对可读。
- **token 样式表是颜色值的唯一权威来源**：会有意不补入 cssdesign 中缺失的值（例如设计中的 #4176E6 标签页蓝色）；一律采用最接近的语义 token。设计负责人批准的新增值是例外：须在同一变更中以一个静态尺度层级与一个语义别名的形式进入（`--dsw-static-blue-900` / `--dsw-alias-label-primary-bluish`）。
- **壁纸只作用于画布**：半透明的是画布与侧栏列，卡片、输入框与气泡保持主题自己的不透明度；需要更透的面用「面板不透明度」统一放宽，暂不提供逐组件透明度。
- **上游能力有取舍**：dsh-dream-skin 的必应每日壁纸、本地文件夹轮换（需要宿主侧读盘）与轴伊的角色立绘装饰层未移植；OpenCode 调色板的 4 套 desktop-2.0 主题使用另一套 schema，也未收录。
- **远程浏览器不持久化**：设置 RPC 只对回环地址开放，远程会话里的主题与外观只在进程内有效。
