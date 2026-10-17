# 记忆

记忆能力由 [`coding-memory`](../../packages/memory/memory/README.md) 定义 `ctx.memory`，由 [`memory-local`](../../packages/memory/memory-local/README.md) 在宿主文件系统上实现，并由 [`memory-context`](../../packages/memory/memory-context/README.md) 与 [`tool-memory`](../../packages/memory/tool-memory/README.md) 消费。
它把会话 cwd 解析成一个稳定的项目键，为每个项目维护若干 Markdown 记忆文件，让「同一个项目、不同会话之间不要忘事」，同时不把记忆写进仓库、不随提交共享。
服务拥有键计算、文件名与限额策略、Markdown 条目格式和注入摘要渲染；Provider 只实现列表、读、写、删四个存储原语，不决定语义。

## 键与存储

`projectFor(cwd)` 从会话目录向上找第一个带项目根标记（默认 `.git`）的目录，解析 symlink 后取路径的 `md5` 作为目录键；同一项目在任何子目录开会话都命中同一份记忆，没有标记时用 cwd 本身。
记忆落在数据主目录下的 `<home>/memory/<md5(项目根真实路径)>/`，每个项目一个目录，目录里的 `project.json` 记录真实路径便于人工辨认。
键是路径的函数：项目改名或移动后旧记忆不再命中，也不自动重键。
文件名只接受 `[a-z0-9._-]` 组成、以 `.md` 结尾且不含路径分隔符，消费方无法用文件名离开项目目录。

## 写入与限额

`save` 把小节内容作为 Markdown 列表项追加进目标文件，多行内容缩进续行；未指定时写入 `notes.md` 的 `要点` 小节，小节不存在时在文件末尾新建。
写入前依次检查单条、单文件、每项目总量与文件数四项限额，任何一项越界都抛错并在诊断里带实际数值。
`remove` 删除整个文件或一个小节，删掉最后一个小节后只剩标题的文件同样按清空处理并删除；`read` 在超过单文件上限时只返回头部并置 `truncated`。
`save` 是「读—改—写」，两个会话同时写同一文件时后者覆盖前者：记忆是笔记，不是事务存储，也不是安全边界——同机同用户的进程都读得到，凭据与隐私不写进记忆。

## 注入与消费

`excerpt` 按最近修改排序渲染有界摘要（默认 4096 字节），每个文件给标题与开头内容，被截断或省略的文件列在返回值里，由消费方提示模型去读全文。
`memory-context` 把这份摘要注入会话基线；`tool-memory` 提供 `memory_save`、`memory_read`、`memory_list`、`memory_delete` 四个工具，参数里没有任何路径，目标目录由会话项目根决定。

以下跨包类型声明来自 [`packages/memory/memory/src/index.ts`](../../packages/memory/memory/src/index.ts)。服务方法的完整签名与 JSDoc 由下方 Cordis API 区域生成。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog`; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmemory--memory-abstract-seam"></a>

### `ctx.memory` — `Memory` (abstract seam)

项目记忆服务。Provider 实现四个存储原语，本类负责校验、限额与渲染，因此工具与 提示词两个消费方共享同一套语义。

```ts cordis-catalog
/**
 * 把会话 cwd 解析成项目身份。
 * @param cwd - 会话工作目录。
 * @returns 项目真实路径、目录键与记忆目录。
 */
projectFor(cwd: string): MemoryProject

/**
 * 列出项目的记忆文件，最近修改的在前。
 * @param project - {@link projectFor} 返回的项目身份。
 * @returns 文件元数据。
 */
async list(project: MemoryProject): Promise<MemoryFileSummary[]>

/**
 * 读取一个记忆文件，超出单文件上限时只返回头部。
 * @param project - 项目身份。
 * @param name - 记忆文件名。
 * @returns 读取结果；文件不存在时返回 undefined。
 */
async read(project: MemoryProject, name: string): Promise<MemoryReadResult | undefined>

/**
 * 追加一条记忆，并在此处执行单条、单文件、总量与文件数限额。
 * @param project - 项目身份。
 * @param request - 条目内容与目标文件／小节。
 * @returns 写入后的文件元数据。
 * @throws 条目为空、或越过任一限额时抛出，诊断里带上实际数值。
 */
async save(project: MemoryProject, request: MemorySaveRequest): Promise<MemoryFileSummary>

/**
 * 删除整个记忆文件，或只删除其中一个小节。
 * @param project - 项目身份。
 * @param name - 记忆文件名。
 * @param section - 省略时删除整个文件。
 * @returns 是否确实删除了内容。
 */
async remove(project: MemoryProject, name: string, section?: string): Promise<boolean>

/**
 * 渲染注入提示词的有界摘要：按最近修改排序，逐个文件给出标题与开头，直到用完
 * `injectBytes`；被截断或省略的文件列在结果里，让消费方提示模型去读全文。
 * @param project - 项目身份。
 * @returns 摘要文本与文件清单；没有记忆时返回 {@link EMPTY_EXCERPT}。
 */
async excerpt(project: MemoryProject): Promise<MemoryExcerpt>
```

Source: [`packages/memory/memory/src/index.ts:256`](../../packages/memory/memory/src/index.ts)
<!-- END GENERATED cordis-surface -->
