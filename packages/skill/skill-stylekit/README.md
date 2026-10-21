# coding-skill-stylekit

随包分发的视觉风格技能提供方，向 `ctx.skills` 登记 `stylekit`。它把「给界面一个具名视觉方向」从口头要求变成可执行的配色、设计令牌与 do／don't 规则。目录索引与每风格完整规格都随包分发，技能在离线状态下即可完成选型与落地；正文与规格按需加载，不改变现有 UI 组件、样式或浏览器工具的运行时行为。

技能数据改编自 MIT 许可的 [StyleKit](https://github.com/AnxForever/stylekit)，来源与改造范围见 [NOTICE](NOTICE.md)。

## 资产

| 路径 | 作用 |
| --- | --- |
| `assets/stylekit.md` | 技能正文：检索随包目录、读取随包规格、在项目现有技术栈内落地、用 `browser-use` 验收。 |
| `assets/styles.jsonl` | 上游公开目录 `https://www.stylekit.top/api/styles` 的随包快照，一行一条风格，便于 `grep` 命中完整条目。 |
| `assets/styles/<slug>.json` | 每个风格的完整规格：`philosophy`、`doList`／`dontList`、`aiRules`、`colors`、`tokens`、`recipes`、`components`、`examplePrompts`、`globalCss`。 |

两份资产都由 [`scripts/gen-stylekit-catalog.ts`](../../../scripts/gen-stylekit-catalog.ts) 生成：`pnpm run gen-stylekit-catalog` 在线拉取上游目录与每个风格的规格并重写资产（`--input`／`--input-dir` 可用已保存响应离线重建），`pnpm run verify-stylekit-catalog` 离线校验索引结构、slug 唯一性与排序、规格与索引的一一对应以及紧凑格式。站点自用的质量看板（`readiness`、`accessibility`、`changelog`）和封面地址不随包，规格总计约 3.4 MB。

## Model Experience

### 技能目录与正文

#### What the model sees

目录贡献的名称为 `stylekit`，描述为：

> 在需要给网页或界面一个具名视觉风格时使用：玻璃拟态、新野兽派、赛博朋克、包豪斯、瑞士网格、便当盒布局、Apple／Stripe／Notion／Linear 风格、日式极简、复古 Y2K 等 StyleKit 风格目录。用来把“做得好看点”落成可执行的配色、设计令牌与 do／don't 规则，并在项目现有技术栈内实现；风格指南不覆盖产品行为、无障碍与项目已有组件。

加载后，模型会获得 [`assets/stylekit.md`](assets/stylekit.md) 的完整工作约束，以及资源提示中的资产目录路径；目录索引与单个风格规格都只在模型显式检索、读取时进入请求。

#### Token effect

未加载时只增加一条目录摘要；加载后增加检索、读取规格、落地与验收规则。整份约 75 KB 的目录索引和约 3.4 MB 的规格目录都不会自动加入请求：模型用 `grep` 取命中行，再按需读取单个约 20 KB 的规格文件。

#### KV Cache effect

固定目录条目会改变技能目录所在请求前缀；正文只在模型或用户加载该技能时加入请求。随包快照更新不改变请求内容，只有在模型实际读取时影响该轮请求。

## 已知限制与暂缓事项

- 目录与规格都是发布时的上游事实，不是实时目录；上游变更后需要维护者重新运行生成器。技能要求模型在规格缺失时如实降级，而不是编造 slug 或规则。
- 规格随包体积约 3.4 MB，随 npm 包与仓库一起分发；需要更小的安装体积时应改成按需下载，而不是删掉索引与规格的对应关系。
- 技能只提供设计方向与落地约束，不替代项目自身的依赖、组件、令牌和无障碍检查，也不安装 MCP 服务或迁移框架。
- 上游站点、CLI 与 MCP 服务未随包移植；需要它们时按上游文档单独安装。
