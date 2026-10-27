# 内置主题来源说明

`src/themes/data/` 下的主题数据移植自三个 MIT 许可的开源主题插件。本文件记录来源、版本、许可与逐项差异，方便日后同步上游。

## dsh-dream-skin（幻梦）

- 仓库：<https://github.com/RevolutionLA/dsh-dream-skin>
- 版本：10.26.1（提交 `a1dc11e2f06ebefe2a06a771503a57b51e12c3ee`）
- 许可：MIT，版权所有 dsh-dream-skin contributors
- 移植内容：`lib/client.js` 的 `SKINS` 数组——8 套皮肤的 id、明暗归属、别名层 token 与 glow 弥散光背景。
- 改造：
  - 只保留本项目 `--dsw-*` 样式表里存在或被消费的 token；每家产品独有的变量（`--dsw-menu-surface-fill`、`--dsw-alias-file-diff-*`、`--dsw-focus-ring-color` 等本项目没有消费方的 10 个）已剔除，见数据文件头注释。
  - 主题 id 加 `dream-` 前缀，避免与其它来源重名；中文名取 README 里的皮肤描述。
  - 皮肤自带的滑杆默认值（壁纸透明度、磨砂权重等）没有逐套移植，改为产品统一的默认值 + 用户自调。
- 未移植：必应每日壁纸、本地文件夹轮换（需要宿主侧读盘与定时器）、主题包本地库、低功耗模式、每皮肤出厂参数。

## dsh-joi-channel-theme（轴伊）

- 仓库：<https://github.com/tpmoonchefryan/dsh-joi-channel-theme>
- 版本：0.1.14（提交 `5879e04fbc75`，2026-10-11）
- 许可：MIT，版权所有 tpmoonchefryan。角色素材另有 [LICENSE-ASSETS.md](https://github.com/tpmoonchefryan/dsh-joi-channel-theme/blob/main/LICENSE-ASSETS.md)，本仓库未收录任何角色图片。
- 移植内容：`design/baseline-4q.json` 里的 19 级中性色阶、44 条语义别名映射、shiki 语法色与底纹（点阵／方格纸）定义。
- 改造：
  - 衣装从「覆盖层」变成「跟随明暗的主题」：注册时给出浅色与深色两套令牌。
  - 底纹生成成该主题的默认壁纸（`radial-gradient` / `linear-gradient` 复合）。
  - 插件私有的角色变量（`--joi-*`：logo 图、气泡文字色、描边、立绘边缘光等）未移植——它们依赖角色立绘与自定义装饰层。

## dsh-opencode-palette（OpenCode 调色板）

- 仓库：<https://github.com/FeatherHunter/dsh-opencode-palette>
- 版本：2.1.10（提交 `6fda3eb45844`，2026-10-26）
- 主题数据来源：anomalyco/opencode `v1.18.12` / 提交 `0dd6950d1b06958fbcdcadf0ad56258257ab7fdb`（上游 `src/themes/MANIFEST.json` 记录）
- 许可：MIT，版权所有 FeatherHunter
- 移植内容：`src/themes/*.json` 37 套主题的 37 个语义色（浅色/深色两套已按各主题的 `defs` 与变体解析成具体色值）。
- 改造：
  - 在 `src/themes/opencode.ts` 中重写语义槽到本项目令牌的映射与派生规则（参考上游 `engine/map-dsh.ts` 与 `engine/resolve.ts`，按本项目的 token 集与明暗口径重写）。
  - 主题 id 加 `oc-` 前缀；中文名取自上游 `engine/zh-names.ts`。
  - 上游浅色变体缺失或本身偏暗的主题收敛为固定深色主题。
  - 未收录 4 套 desktop-2.0 主题（`palette` + `overrides` 另一套 schema）、25 个 IP 主题胶囊、字体与字号设置、自定义主题编辑器。

## 主题缩略图

`src/themes/thumbnails/` 下的界面截图同样来自上述仓库，已缩放到 640px 宽并转成 JPEG：

- `dream-*.jpg`：dsh-dream-skin `docs/previews/<skin>.png`（8 张，MIT）。
- `joi-flowers.jpg` / `joi-flowers-dark.jpg` / `joi-library.jpg` / `joi-library-dark.jpg`：dsh-joi-channel-theme `docs/new-chat-flowers.png`、`docs/new-chat-flowers-dark.png`、`docs/new-chat-library.png`、`docs/new-chat-library-dark.png`（MIT；截图中的角色形象按该仓库 `LICENSE-ASSETS.md` 仅作主题预览，不随包再分发任何原始角色素材）。

OpenCode 调色板只提供整体截图，没有逐套主题的界面图，因此这 37 套在页面上回落成配色块，未收录其截图。

## 许可文本

三份上游许可均为 MIT，允许在保留版权与许可声明的前提下使用、修改与再分发。若需完整许可原文，请访问上述仓库的 `LICENSE` 文件。
