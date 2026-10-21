# coding-skill-stylekit

随包分发的视觉风格技能提供方，向 `ctx.skills` 登记 `stylekit`。它把「给界面一个具名视觉方向」从口头要求变成可执行的配色、设计令牌与 do／don't 规则；正文与随包目录按需加载，不改变现有 UI 组件、样式或浏览器工具的运行时行为。

技能数据改编自 MIT 许可的 [StyleKit](https://github.com/AnxForever/stylekit)，来源与改造范围见 [NOTICE](NOTICE.md)。

## 资产

| 路径 | 作用 |
| --- | --- |
| `assets/stylekit.md` | 技能正文：检索随包目录、取上游完整规格、在项目现有技术栈内落地、用 `browser-use` 验收。 |
| `assets/styles.jsonl` | 上游公开目录 `https://www.stylekit.top/api/styles` 的随包快照，一行一条风格，便于 `grep` 命中完整条目。 |

`styles.jsonl` 由 [`scripts/gen-stylekit-catalog.ts`](../../../scripts/gen-stylekit-catalog.ts) 生成：`pnpm run gen-stylekit-catalog` 重新拉取上游目录并重写资产，`pnpm run verify-stylekit-catalog` 离线校验已提交资产的结构、slug 唯一性与排序。完整的设计令牌与规则仍从上游在线取用，不随包分发。

## Model Experience

### 技能目录与正文

#### What the model sees

目录贡献的名称为 `stylekit`，描述为：

> 在需要给网页或界面一个具名视觉风格时使用：玻璃拟态、新野兽派、赛博朋克、包豪斯、瑞士网格、便当盒布局、Apple／Stripe／Notion／Linear 风格、日式极简、复古 Y2K 等 StyleKit 风格目录。用来把“做得好看点”落成可执行的配色、设计令牌与 do／don't 规则，并在项目现有技术栈内实现；风格指南不覆盖产品行为、无障碍与项目已有组件。

加载后，模型会获得 [`assets/stylekit.md`](assets/stylekit.md) 的完整工作约束，以及资源提示中的资产目录路径；目录快照只在该模型显式检索时被读取。

#### Token effect

未加载时只增加一条目录摘要；加载后增加检索、取规格、落地与验收规则。整份约 75 KB 的目录快照不会被自动加入请求，模型用 `grep` 只取命中行。

#### KV Cache effect

固定目录条目会改变技能目录所在请求前缀；正文只在模型或用户加载该技能时加入请求。随包快照更新不改变请求内容，只有在模型实际读取时影响该轮请求。

## 已知限制与暂缓事项

- 目录快照是发布时的上游事实，不是实时目录；风格规格、在线接口和 URL 由第三方维护，离线或上游变更时技能要求模型如实降级，而不是编造 slug、规则或抓取成功。
- 技能只提供设计方向与落地约束，不替代项目自身的依赖、组件、令牌和无障碍检查，也不安装 MCP 服务或迁移框架。
- 上游站点、CLI 与 MCP 服务未随包移植；需要它们时按上游文档单独安装。
