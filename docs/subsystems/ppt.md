# 演示文稿工程

`ctx.pptProjects` 是会话级演示文稿工程服务：模型工具与右侧工作台通过它读写同一工程，并共享版本、撤销／重做与导出结果。服务由 [`coding-ppt-workbench`](../../packages/ppt/ppt-workbench/README.md) 提供；模型工具与面板的具体交互分别见 [`coding-tool-ppt`](../../packages/ppt/tool-ppt/README.md) 和 [`coding-client-ui-ppt-workbench`](../../packages/client/ui-ppt-workbench/README.md)。

## 数据类型

| 类型 | 归属 | 调用方需知道的字段 |
| --- | --- | --- |
| `SlideSizeId`、`ThemeId` | [数据模型](../../packages/ppt/model/src/index.ts) | 画布比例为 `16:9` 或 `4:3`；主题为 `ink`、`paper`、`ocean`、`forest` 或 `inference`（白底蓝橘）。画布坐标以基准像素表示。 |
| `PptSnapshot` | [工程存储](../../packages/ppt/ppt-workbench/src/store.ts) | 完整工程 `deck`、绝对目录 `dir`、`revision` 与可撤销／重做状态；`revision` 是编辑冲突的比较值。 |
| `PptWorkbenchState` | [服务定义](../../packages/ppt/ppt-workbench/src/index.ts) | 当前会话的工作区目录、工程列表、当前工程与等待面板确认的打开请求。 |
| `PptCheckResult` | [质检](../../packages/ppt/ppt-workbench/src/check.ts) | `ok` 表示没有阻断导出的 error 级问题；`issues` 包含页面、元素与规则标识。 |
| `RenderedPage` | [页面渲染](../../packages/ppt/ppt-workbench/src/render.ts) | 每页的 id、名称与 PNG 绝对路径。 |
| `PptExportResult` | [服务定义](../../packages/ppt/ppt-workbench/src/index.ts) | `.pptx` 的绝对路径、字节数、修订号、已嵌入字体与跳过字体的原因。 |

## 会话与版本

`rootOf(sessionId)` 取会话的工作目录；工程目录由 `resolveDir` 限制在该工作区内，未打开工程又未指定目录时拒绝。创建、打开和导入工程会记录会话当前工程并通知面板；面板通过 `ackOpenRequest` 确认消费。编辑可携带 `baseRevision`，不匹配时拒绝覆盖；同一目录的写入在进程内串行。导出先执行质检，除非调用方显式设置 `skipCheck`。持久文件布局、错误映射和渲染限制由[工作台包 README](../../packages/ppt/ppt-workbench/README.md) 持有。

## 创建与模板语义

`create(sessionId, { title, dir? })` 用内置白底蓝橘 16:9 六页整稿发布独立工程；显式传入 `size` 或 `theme` 任一项则创建单页标题稿。整稿抽象参考稿的视觉结构，不保存源稿文件、正文或备注。只读默认预览不创建工程；内置单页版式和用户模板库分别由[工作台包 README](../../packages/ppt/ppt-workbench/README.md#默认整稿与内置单页版式)说明。

`importTemplateFromFile` 读取本机工作区的无宏 `.pptx`，提取可表达的几何、颜色与文字样式，将原稿正文泛化为占位内容后存入用户模板库，不创建或切换工程，也不保存源文件；返回摘要的 `sourceName` 是源文件名，`dropped` 列出已知设计／结构损失。复杂图形、母版与主题色可能不保真，套用前须检查预览。`import` 创建保留可解析源正文的工作区工程，`saveTemplate` 则将已有工程连同当前正文和媒体原样保存为模板，这两条路径都不负责去原文化。模板导入、普通导入与手工精修的使用边界见[工具包 README](../../packages/ppt/tool-ppt/README.md#行为)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog`; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpptprojects--pptprojects"></a>

### `ctx.pptProjects` — `PptProjects`

会话级工程服务；写入由存储层按工程串行化，路由层负责转换错误码。

```ts cordis-catalog
/**
 * 会话的工作区目录。
 * @param sessionId - 会话身份。
 * @returns 绝对工作目录。
 * @throws PptModelError - 会话不存在或没有工作目录时。
 */
rootOf(sessionId: string): string

/**
 * 把工程目录解析到工作区内。
 * @param sessionId - 会话身份。
 * @param dir - 相对工作区的目录；缺省用会话当前打开的工程。
 * @returns 绝对目录。
 * @throws PptModelError - 目录越界或没有可用的当前工程时。
 */
resolveDir(sessionId: string, dir?: string): string

/**
 * 会话当前打开的工程目录（相对工作区）。
 * @param sessionId - 会话身份。
 * @returns 相对目录；没有打开时为 undefined。
 */
activeDir(sessionId: string): string | undefined

/**
 * 记住会话要显示的工程，并让面板下一次轮询时切换过去。
 * @param sessionId - 会话身份。
 * @param dir - 绝对工程目录。
 * @returns 相对工作区的目录。
 */
focus(sessionId: string, dir: string): string

/**
 * 面板视角的整体状态。
 * @param sessionId - 会话身份。
 * @returns 工程列表、当前工程与待处理的打开请求。
 */
async state(sessionId: string): Promise<PptWorkbenchState>

/**
 * 面板确认已处理某次打开请求。
 * @param sessionId - 会话身份。
 * @param at - 请求时间戳；与当前请求不一致时忽略，避免重复消费新请求。
 */
ackOpenRequest(sessionId: string, at: number): void

/**
 * 新建工程并设为当前工程；未指定尺寸或主题时使用内置整稿模板。
 * @param sessionId - 会话身份。
 * @param options - 标题、目录、尺寸与主题；显式尺寸或主题保留单页新建。
 * @returns 新工程快照。
 */
create(sessionId: string, options: { title: string dir?: string size?: SlideSizeId theme?: ThemeId }): Promise<PptSnapshot>

/**
 * 打开既有工程（模型 `ppt_open` 与面板点击共用）。
 * @param sessionId - 会话身份。
 * @param dir - 相对或绝对目录。
 * @returns 工程快照。
 */
async open(sessionId: string, dir: string): Promise<PptSnapshot>

/**
 * 读取工程。
 * @param sessionId - 会话身份。
 * @param dir - 相对或绝对目录；缺省为当前工程。
 * @returns 工程快照。
 */
read(sessionId: string, dir?: string): Promise<PptSnapshot>

/**
 * 应用一次编辑。
 * @param sessionId - 会话身份。
 * @param dir - 工程目录；缺省为当前工程。
 * @param ops - 未校验的编辑步骤。
 * @param baseRevision - 乐观锁基准版本。
 * @returns 写入后的快照。
 */
edit(sessionId: string, dir: string | undefined, ops: unknown, baseRevision?: number): Promise<PptSnapshot>

/**
 * 撤销。
 * @param sessionId - 会话身份。
 * @param dir - 工程目录；缺省为当前工程。
 * @param steps - 步数。
 * @returns 撤销后的快照。
 */
undo(sessionId: string, dir: string | undefined, steps: number): Promise<PptSnapshot>

/**
 * 重做。
 * @param sessionId - 会话身份。
 * @param dir - 工程目录；缺省为当前工程。
 * @param steps - 步数。
 * @returns 重做后的快照。
 */
redo(sessionId: string, dir: string | undefined, steps: number): Promise<PptSnapshot>

/**
 * 把工程导出成 PDF：先渲染每页 PNG（会同时在 Agent 浏览器里打开），再拼成 PDF。
 * @param sessionId - 会话身份。
 * @param dir - 工程目录；缺省为当前工程。
 * @returns 导出文件路径与大小。
 */
async exportPdf(sessionId: string, dir?: string): Promise<{ path: string; bytes: number; revision: number }>

/**
 * 把页面渲染成 PNG（工作台与导出一致的那一版）。
 * @param sessionId - 会话身份。
 * @param dir - 工程目录；缺省为当前工程。
 * @param pages - 要渲染的页下标（0 起）；缺省全部。
 * @returns 每页的 PNG 路径。
 */
async render(sessionId: string, dir?: string, pages?: readonly number[]): Promise<RenderedPage[]>

/**
 * 读取工程内的一张图片，供面板显示。
 * @param sessionId - 会话身份。
 * @param dir - 工程目录；缺省为当前工程。
 * @param source - 工程的 `media/<file>` 相对路径。
 * @returns 图片字节；越界或不存在时为 undefined。
 */
media(sessionId: string, dir: string | undefined, source: string): Promise<Uint8Array | undefined>

/**
 * 把上传的图片写进工程并返回可写进元素的相对路径。
 * @param sessionId - 会话身份。
 * @param dir - 工程目录；缺省为当前工程。
 * @param name - 上传时的文件名（取扩展名）。
 * @param bytes - 图片字节。
 * @returns `media/<file>` 相对路径。
 */
upload(sessionId: string, dir: string | undefined, name: string, bytes: Uint8Array): Promise<string>

/**
 * 规则质检。
 * @param sessionId - 会话身份。
 * @param dir - 工程目录；缺省为当前工程。
 * @returns 质检结果。
 */
async check(sessionId: string, dir?: string): Promise<PptCheckResult>

/**
 * 把工作区或本机已登记上传的 .pptx 导入成工程。
 * @param sessionId - 会话身份。
 * @param source - 工作区中的 .pptx 路径，或已登记上传文件的绝对路径。
 * @param options - 目标目录与标题（都缺省时按源文件名生成）。
 * @returns 新工程快照、逐页保留报告与源文件 SHA-256；导入只创建工程，不保存模板。
 * @throws PptStoreError 远程工作区、越界、文件超限或目标已有内容时；失败不切换当前工程。
 */
async import(sessionId: string, source: string, options: { dir?: string; title?: string }): Promise<{ snapshot: PptSnapshot dropped: readonly string[] report: PptImportReport sourceSha256: string }>

/** 分片读取已导入 PPTX 的源页证据，源文件变化后必须重新导入。
 * @param sessionId - 本机会话身份。
 * @param source - 工作区中的 .pptx 路径，或已登记上传文件的绝对路径。
 * @param options - 源页序号、导入时的 SHA-256 与可选分片窗口。
 * @returns 经同一安全解包器提取的有界证据片段及其源哈希。
 * @throws PptStoreError 路径不安全、源文件缺失或内容已变化时。
 */
async importEvidence(sessionId: string, source: string, options: { sourceIndex: number sourceSha256: string offset?: number limit?: number }): Promise<PptPageEvidenceChunk & { sourceSha256: string }>

/** 列出本机用户模板；不切换任何会话的当前工程。
 * @returns 按创建时间排列的模板摘要。
 * @throws PptStoreError 模板仓库损坏或无法访问时。
 */
listTemplates(): Promise<readonly PptTemplateSummary[]>

/** 读取模板的完整 deck；不切换当前工程。
 * @param id - 模板 UUID。
 * @returns 模板详情。
 * @throws PptStoreError 模板不存在或仓库内容不合法时。
 */
readTemplate(id: string): Promise<PptTemplateDetail>

/** 读取模板 deck 引用的媒体原字节，不需要会话且不改变模板或当前工程。
 * @param id - 模板 UUID。
 * @param source - `media/<文件名>` 相对路径。
 * @returns 模板媒体原始字节。
 * @throws PptStoreError 模板不存在、路径不合法、媒体未被引用或仓库损坏时。
 */
templateMedia(id: string, source: string): Promise<Uint8Array>

/** 将无宏 PPTX 的可编辑几何和设计提取为无源正文的用户模板；丢失的复杂结构在返回值中列出。
 * @param fileName - 安全的单层 .pptx 文件名。
 * @param bytes - 压缩源文件字节，上限 8 MiB；不会保存源文件本身。
 * @param options - 模板名称；缺省取去掉扩展名的文件名。
 * @returns 持久化的模板详情。
 * @throws PptStoreError 文件名、大小、内容或仓库不合法时。
 */
async importTemplate(fileName: string, bytes: Uint8Array, options: { name?: string } = {}): Promise<PptTemplateDetail>

/** 将工作区或本机已登记上传的 PPTX 保存为用户模板，不创建工程或切换当前工程。
 * @param sessionId - 本机会话身份。
 * @param source - 工作区中的 .pptx 路径，或已登记上传文件的绝对路径。
 * @param options - 可选模板名称；缺省取源文件名去掉扩展名。
 * @returns 包含来源文件名与导入限制的持久模板详情。
 * @throws PptStoreError 远程工作区、路径越界、符号链接、文件超限或文件名不安全时。
 */
async importTemplateFromFile(sessionId: string, source: string, options: { name?: string } = {}): Promise<PptTemplateDetail>

/** 保存工程整稿和全部引用媒体的原字节；不改变当前工程。
 * @param sessionId - 本机会话身份。
 * @param options - 名称和可选工程目录；缺省取会话当前工程。
 * @returns 持久化的模板详情。
 * @throws PptStoreError 远程工作区、缺图、符号链接、越界或仓库错误时。
 */
async saveTemplate(sessionId: string, options: { name: string; dir?: string }): Promise<PptTemplateDetail>

/** 重命名模板但不修改 deck 或已由模板创建的工程。
 * @param id - 模板 UUID。
 * @param name - 新名称。
 * @returns 新摘要。
 * @throws PptStoreError 模板不存在或名称无效时。
 */
renameTemplate(id: string, name: string): Promise<PptTemplateSummary>

/** 删除模板库条目，不影响已创建的工程；模型应传当前名称以防重命名后误删。
 * @param id - 模板 UUID。
 * @param expectedName - 模型确认时看到的名称，由仓库在删除锁内核对。
 * @returns 删除完成时兑现。
 * @throws PptStoreError 模板不存在、名称已变化或仓库内容不合法时。
 */
deleteTemplate(id: string, expectedName?: string): Promise<void>

/** 从模板创建可独立编辑的工程副本；成功发布后才切换会话焦点。
 * @param sessionId - 本机会话身份。
 * @param id - 模板 UUID。
 * @param options - 新标题和目标目录；缺省用模板名生成目录。
 * @returns 初始版本号为 1 的工程快照。
 * @throws PptStoreError 远程工作区、目标已存在、目录越界或模板损坏时。
 */
async createFromTemplate(sessionId: string, id: string, options: { title?: string; dir?: string } = {}): Promise<PptSnapshot>

/**
 * 导出当前版本为 .pptx。
 * @param sessionId - 会话身份。
 * @param dir - 工程目录；缺省为当前工程。
 * @param options - `skipCheck` 为 true 时跳过 error 级质检。
 * @returns 导出文件路径与大小。
 */
async export(sessionId: string, dir?: string, options: { skipCheck?: boolean } = {}): Promise<PptExportResult>
```

Source: [`packages/ppt/ppt-workbench/src/index.ts:88`](../../packages/ppt/ppt-workbench/src/index.ts)
<!-- END GENERATED cordis-surface -->
