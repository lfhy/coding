# StyleKit 视觉风格

用这个技能给界面建立**具名的视觉方向**：先看项目现状，再按所选风格的配色、令牌与规则落地。风格规格是指导，不替产品决策。

## 一、先在随包目录里定位风格

`<skill-assets>` 指资源提示中 `Base directory for this skill` 给出的目录，其中有公开目录的随包快照 `styles.jsonl`：**一行一条风格**，字段为 `slug`、`name`（中文名）、`nameEn`、`category`、`styleType`、`tags`、`colors`（`primary`／`secondary`／`accent`）、`keywords`、`description`（中文一句话说明）。

- 用户点名了风格时用精确 `slug`，例如 `glassmorphism`、`neo-brutalist`、`cyberpunk-neon`、`bauhaus`、`swiss-style`、`apple-style`、`stripe-style`、`notion-style`、`linear-style`、`bento-grid`、`wabi-sabi`、`y2k`。名字对不上没关系：先按关键词检索，再做一次 slug 精确确认。
- 只描述感觉时用关键词检索，不要整读文件：

```bash
grep -inE "赛博朋克|机器人|neon" "<skill-assets>/styles.jsonl" | head -5
grep -inE "极简|留白|minimal" "<skill-assets>/styles.jsonl" | head -5
```

- `styles.jsonl` 命中行就是完整条目，可直接读出配色与说明；挑 1–3 个候选后再决定，只有在候选之间的取舍会实质改变结果时才向用户提问。
- 目录里没有匹配项、或用户要的是新风格时，如实说明并回到项目既有视觉语言，不要凭空编一个 slug。

## 二、取得完整规格

目录只固化到「配色 + 一句话方向」。完整规格（设计哲学、do/don't 规则、令牌、组件配方、全局 CSS）需要在线获取：

```bash
curl -sS "https://www.stylekit.top/api/styles/<slug>" -o "<work-dir>/spec.json"
```

按需读取其中的字段：`philosophy`（设计哲学）、`doList`／`dontList`（必须做／禁止做）、`colors`、`tokens`（设计令牌）、`recipes`（组件配方）、`globalCss`。只取用得到的部分，不要把整份规格贴进回答或写进代码注释。

Tailwind／shadcn 项目可以直接把风格装成主题（会改动 `globals.css` 的亮暗 `cssVars`）：

```bash
npx shadcn add "https://www.stylekit.top/r/<slug>.json"
```

目标项目需要 `tsconfig.json`；安装后复查 diff，只保留与本次视觉改造相关的改动。

**抓取失败时**（离线、超时、404）：用目录里的 `colors`／`keywords`／`description` 建立方向，并明确告诉用户没有取得上游完整规则；不要编造规则，也不要声称抓取成功。

## 三、在项目里落地

- 复用项目已有的技术栈、组件、设计令牌和样式约定。风格是约束，不是换栈的理由：不要为一个页面另起组件库或第二套视觉体系。
- 风格只改视觉决策，保留行为、路由、数据与无障碍；与用户明确选择或无障碍要求冲突时，以它们为准，规则是起点。
- 令牌落到项目主题层（CSS 变量、主题 token、Tailwind theme），不要在组件里散落新的字面色值、一次性断点或任意阴影。
- Tailwind v4：`globalCss` 里应当让位于工具类的 reset 放进 `@layer base`，或用注释说明作用范围，避免未分层选择器压过 utility。
- 新界面补齐 loading、empty、error、success 状态；窄屏布局、长内容滚动区域和键盘焦点单独检查。
- 风格名称、slug、上游文档地址都不是用户可见文案；页面里只出现产品自己的语言。

## 四、验证

1. 跑改动所属包的类型、lint、测试和构建。
2. 加载 `browser-use` 技能，在真实运行的应用里检查：计算后的颜色、字体、间距、圆角、边框与阴影是否符合所选风格；hover／active／focus 与键盘焦点行为；主要流程在单屏内可用。
3. 把「已实现」和「实际验证过」分开报告；在线规格取不到或运行时无法启动时，说明哪一项没验证。

## 五、边界

- `styles.jsonl` 是随包快照，上游目录可能已经更新；需要最新目录时重新拉取 `https://www.stylekit.top/api/styles`，不要凭记忆补 slug。
- 不安装 MCP 服务、不改客户端配置、不替用户迁移框架。
- 上游来源与许可见本技能所在包的 `NOTICE.md`；目录与规格的版权归 StyleKit 作者。
