# Agent Note: 侧边栏常驻的工作台面板开关

Status: implemented

## 问题

文件工作台的文件侧栏与终端底栏开关随工作台顶栏渲染。工作台关闭、页面还原成普通会话页之后，这两个入口随之消失：想再打开终端底栏或文件侧栏，必须先在会话页头打开工作台。把入口挂回会话页头也不行，那个页头在最大化与窄屏全屏呈现下整列不可见。

## 决策

「显示/隐藏文件侧栏」与「显示/隐藏终端底栏」两个开关常驻在侧边栏品牌行（`sidebar.brand.action`，root scope 的 list 槽位），由 `dsh-client-ui-open-in-app` 的 `WorkbenchPanelToggles` 注册；宽侧栏横向排列，收起 rail 中纵向排列，因此工作台未打开、工作台最大化或会话页头被隐藏时都能操作。工作台顶栏只保留最大化与关闭。

点击开关时若工作台未打开，布局服务先打开工作台（并关闭详情栏）再显示对应面板：文件侧栏默认呈现内置文件管理，终端底栏默认呈现终端。没有当前会话或当前会话仍是空白会话时开关不渲染。

「文件侧栏是否可见」从 ui-open-in-app 的 Session viewing store 移到布局 store 的按 Session 工作台状态（`WorkbenchState.filesOpen`，默认 true），并随 `WorkbenchLayoutSnapshot` 与 `workbench` slot 的 owner props 发布；新增 `ctx.layout.toggleWorkbenchFiles(sessionId)`，`toggleWorkbenchBottom(sessionId)` 改为同一语义——已打开时翻转，未打开时先打开工作台再让该面板可见。开关的按下态只表达面板此刻实际可见（`open && filesOpen` / `open && bottomOpen`），不表达用户偏好。

## 曾考虑的替代方案

**把两个开关挂回会话页头。** 拒绝。页头随会话列在最大化与窄屏全屏呈现中不可见，开关会一起消失。

**两个开关同时留在工作台顶栏与侧边栏。** 拒绝。同一显隐状态出现两个常驻入口，界面无法回答哪个是权威，按下态也要在两处保持同步。

**为常驻开关新增一个面板服务。** 不采用。文件侧栏与底栏的显隐本来就是布局域事实，布局 store 已按 Session 持有工作台开关与几何；再加一层服务只会重复这份所有权。

## 后果

「打开文件管理 / 打开终端」不再依赖会话页头或工作台顶栏，工作台关闭后也能一步打开对应面板。代价是文件侧栏显隐从 viewing store 迁入布局 store，工作台组件改为从 owner props 读取它，且 `ctx.layout` 的底栏与侧栏切换在关闭态带有「打开工作台」的副作用。

覆盖验证：`ui-layout` 的 store／service／AppFrame 测试覆盖新字段、关闭态先打开工作台的语义与投影发布；`ui-sidebar` 的壳层测试覆盖 `sidebar.brand.action` 的声明、渲染位置与 rail 形态；`ui-open-in-app` 的品牌行开关测试覆盖无会话不渲染、按下态与动作接线。槽位目录由 `pnpm run gen-client-catalog` 重新生成。
