# Agent Note: 页面内目录对话框成为随包交互

Status: implemented

[English](2026-09-22-in-page-directory-dialog.md) | 中文

## Problem

随包发布的 web bundle 此前挂载自适应 [`-auto`](2026-07-29-directory-picker-adaptive-default.md) 选择器，它在 darwin／win32 的回环绑定上判定为系统面板。宿主进程始终是后台子进程——桌面壳的或终端的——而由这种进程呈现的系统面板拿不到交互：macOS 上 AppleScript 面板从不上屏，取而代之的进程内 `NSOpenPanel` 虽然上屏却点不动（[macOS 面板 Note](../bug-fix/2026-09-22-macos-picker-in-process-panel.md)）。桌面 GUI 因此给出一个操作者用不了的文件夹对话框，带着面板自带的英文提示文本，而各载体的交互互不相同。

## Decision

`packages/bundle/web-app/cordis.patch.yml` 把 `@deepseek-ai/dsh-host-directory-picker-browse` 挂为 `directory-picker` 行，并新增 `@deepseek-ai/dsh-client-ui-directory-picker-browse` 的 browser 行，因此桌面壳、本地浏览器与远程浏览器拿到同一个页面内对话框：模态卡片，含面包屑、双栏层级浏览、手输路径、新建文件夹与隐藏文件开关，文案全部来自客户端的 `directory-browser` 字典（默认中文）。`-native` 与 `-auto` 保留为只由覆盖层组合的包。

三处测试侧固定 `-browse` 的补丁已移除——web e2e scaffold 的 disable+insert 对、真实宿主 smoke 的覆盖层（`pin-browse-picker.overlay.yml`，已删除）与 CLI preset e2e 的那一对。随包组合正是这些通道需要的形态，因此 smoke 现在不带覆盖层直接拉起真实的 `dsh web`。

## Alternatives considered

**保留自适应默认，改为修好系统面板的激活。** 拒绝：面板由并非该应用的进程呈现，激活不是选择器能授予的；macOS 层级已经改用进程内 `NSOpenPanel`，在桌面壳里依然点不动。

**新增一个选择交互的配置字段。** 拒绝：seam 文档化的切换点是组合而非配置（`-auto` 的 README 已写明），而且按部署设置的字段仍然只给桌面 GUI 一种交互。

**切换默认后保留测试侧的固定补丁。** 拒绝：重复随包行的固定补丁是重复配置，其注释只能解释它什么都没改变。

## Consequences

- 所有载体拿到同一套交互，而且正是浏览器 e2e 通道一直在驱动的那一套（`apps/web/tests/workspace-management.e2e.ts` 以及经 `connectFreshWorkspace` 的 30 多个规格）。
- 系统面板层级保留给确能证明操作者就在宿主 GUI 会话前的部署；其平台限制记录在 `packages/host/directory-picker-native/README.md`。
- 随包组合不再挂载 `-auto`；其 README 记录了这一可选状态，并继承既有的判定限制。
- 代价是页面内对话框的功能集：无多选、不记忆最近位置、单层上限 1000 行、无系统集成。
