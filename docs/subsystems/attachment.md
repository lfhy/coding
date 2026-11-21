# 持久图片附件与全局文件库

附件页面承载两个共享同一 subsystem 的能力：[coding-attachment](../../packages/attachment/attachment) 的不可变图片附件 seam，以及 [coding-file-library](../../packages/attachment/file-library) 的全局受管理文件服务。二者通过「持久字节先落地、引用后发布」的原则衔接：附件服务拥有会话图片与图库事件的准入，文件库为上传原件和已准入生成图片提供独立副本及跨会话元数据，生成图片由 [`ctx.imageGeneration`](../../packages/image/image-gen/README.md) 在附件准入后复制进文件库。上传原件则经 [open-in-app](../../packages/host/open-in-app/README.md) 的同源拖放路由进入文件库，供本地会话引用。

来源：[`packages/attachment/attachment/src/types.ts`](../../packages/attachment/attachment/src/types.ts) · [`packages/attachment/file-library/src/types.ts`](../../packages/attachment/file-library/src/types.ts)

## 标识与经过校验的元数据

附件 seam 将二进制图片的所有权与会话日志分离。生产方把经过校验的编码字节交给 [`ctx.attachments`](#ctxattachments--attachmentstore-abstract-seam)；只有对象完成持久化后，该服务才会发布不可变的内容寻址引用。会话事件和模型可见的 `ImageBlock` 包含该引用及其元数据，绝不包含浏览器对象 URL、宿主临时路径、提供方 URL 或 base64 数据。未发送的浏览器草稿可以保留在内存中，原生客户端也可以将其暂存于操作系统临时存储；宿主接受用户消息后，会先把消息中的图片移到 `<DSH_HOME>/attachments/v1` 下，再追加用户事件。结构化模型图片输出遵循同样的先持久化、后追加事件规则。

`AttachmentId` 是带类型标记的不透明字符串。本地后端目前生成 `sha256:<digest>`，但消费方既不能解析这种表示，也不能据此派生文件系统路径。

```ts type-equiv
/** Raster image formats accepted by the version-one attachment path. */
type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
```

```ts type-equiv
/** Durable, serializable metadata for one immutable image object. */
interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Media type verified from the stored bytes. */
  mediaType: ImageMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic encoded width in pixels. */
  width: number
  /** Intrinsic encoded height in pixels. */
  height: number
  /** Optional display name stripped of local path information. */
  name?: string
}
```

```ts type-equiv
/** Deployment-resolved limits used by upload admission and request buffering. */
interface ImageAttachmentLimits {
  maxImageBytes: number
  /** 单张输入在解码和归一化前允许的编码字节数；省略时沿用 maxImageBytes。 */
  maxSourceImageBytes?: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  /** 单条消息的原始编码字节总额；省略时沿用 maxMessageImageBytes。 */
  maxSourceMessageImageBytes?: number
  maxImagePixels: number
  /** 单张输入所有帧的解码像素总额。 */
  maxSourceImagePixels?: number
  /** 单张输入允许的最大动画帧数。 */
  maxSourceImageFrames?: number
  /** Maximum intrinsic width and maximum intrinsic height in pixels for one image. */
  maxImageDimension: number
  mediaTypes: readonly ImageMediaType[]
}
```

引用记录固有尺寸和编码长度，使客户端无需先解码即可排布历史记录；每次权威读取仍会根据对象重新校验摘要、媒体签名、尺寸和元数据。

## 提交与经校验读取的数据

```ts type-equiv
/** Base64-encoded image upload accompanying one wire request. */
interface EncodedImageAttachment {
  /** Declared media type, verified against the decoded bytes during admission. */
  mediaType: ImageMediaType
  /** Canonical base64 encoding of the image bytes. */
  data: string
  /** Optional display name; it is never interpreted as a path. */
  name?: string
}
```

```ts type-equiv
/** Request to validate and durably commit one image. */
interface SaveImageAttachment {
  data: Uint8Array
  /** Caller-declared media type, checked against fully decoded bytes. */
  mediaType: ImageMediaType
  /** Optional browser/provider display name; it is never interpreted as a path. */
  name?: string
}
```

```ts type-equiv
/** Stored image bytes returned after reference and digest verification. */
interface StoredImageAttachment {
  ref: ImageAttachmentRef
  data: Uint8Array
}
```

`saveImage()` 完整校验并按提供方策略归一化图片，再原子提交对象并返回引用；`validateImage()` 执行相同的准入，但不持久化。`saveImages()` 先检查输入批次张数与源字节总额、准备全部成员并对归一化后的最终总额作判断，必要时在提交前按批次预算重新处理。`admitEncodedImages()` 是浏览器 RPC、ACP 和 MCP 共用的内联 base64 入口，在解码前检查源字节上限和规范 base64，再委托 `saveImages()`。输入不合规不写入；存储失败不返回部分引用，但此前发布的不可变对象可能等待后续垃圾回收。具体源与最终限额、动图保留规则归[本地提供方](../../packages/attachment/attachment-local/README.md)所有。

`readImage()` 接受来自已授权会话路径的引用，只在完整性校验通过后返回字节。历史对象不会因后续写入限额收紧而被重写或拒读。该服务刻意不规定保留策略：恢复和 fork 后的会话可能共享对象，因此基于引用的垃圾回收会延期实现，而不是与任何一个会话的删除绑定。

<a id="managed-files"></a>

## 全局文件库

[`ctx.fileLibrary`](#ctxfilelibrary--filelibrary) 把两类持久字节收进独立于会话工作区的受管理目录：`open-in-app` 拖放上传的原件，以及 `ctx.imageGeneration` 在附件准入后复制的生成图片。元数据走 `ctx.storageDomain` 的 `files` v1 领域（装配层将其路由到独立 SQLite 后端），文件系统侧在 POSIX 上校验当前用户独占目录权限，Windows 依赖继承 ACL；文件仍独占创建并进行符号链接与身份复核；两个介质没有跨介质原子提交，失败只回滚当前操作仍拥有的磁盘条目。文件库不取代会话附件：原附件仍由附件服务拥有，图库事件仍由会话日志拥有。

```ts type-equiv
/** 上传原件与生成图片的受管理文件元数据。 */
interface ManagedFileRecord {
  id: FileId
  kind: 'upload' | 'generated-image'
  name: string
  relativePath: string
  mediaType: string
  bytes: number
  createdAt: string
  sessionId?: string | undefined
  galleryId?: string | undefined
  attachmentId?: string | undefined
}

/** 按创建时间倒序分页，不包含本机绝对路径。 */
interface ManagedFilePage {
  items: ManagedFileRecord[]
  total: number
  nextOffset?: number
}
```

`saveUpload` 在读流前和提交记录前调用消费方的会话校验；`saveGeneratedImage` 只接受附件服务已准入的 PNG/JPEG/WebP/GIF 字节，由 `ctx.imageGeneration` 在生成图片入库前复制；`getUpload` 对真实、已登记的上传文件返回安全保存名等记录，`isManagedUploadPath` 复用同一检查。浏览器读取面只有回环同源的 `GET /api/files/list` 分页路由，响应不含绝对路径或文件内容，[ui-files](../../packages/client/ui-files/README.md) 的设置分区是它的消费方。删除、重命名与配额策略未定义，见[包 README](../../packages/attachment/file-library/README.md)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog`; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxattachments--attachmentstore-abstract-seam"></a>

### `ctx.attachments` — `AttachmentStore` (abstract seam)

Immutable binary attachment service. Implementations validate bytes before publishing a reference.

```ts cordis-catalog
/**
 * Validate one image without persisting it.
 * Batch callers validate every member before saving any member.
 * @param input - encoded bytes, declared media type, and optional display name.
 * @returns completion after the encoded raster has been fully decoded.
 */
abstract validateImage(input: SaveImageAttachment): Promise<void>

/**
 * 按顺序提交批次前，先校验并归一化所有成员。最终总额超限时，
 * 保留已合规的小图，并对其余成员按确定的均分预算重新处理。
 * 准入失败不会写入；存储失败不返回部分引用，但已经发布的不可变对象可能保留到后续回收。
 * @param inputs - 按消息顺序排列的原始编码图片。
 * @returns 与输入顺序一致的持久引用。
 */
async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>

/**
 * Validate and durably commit one image before its owning session event is appended.
 * @param input - encoded bytes, declared media type, and optional display name.
 * @returns a durable content-addressed reference.
 */
abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>

/**
 * Read one image and verify that bytes still match the recorded reference.
 * @param ref - durable reference from the session log.
 * @param signal - optional cancellation for backend read and verification work.
 * @returns the verified bytes and canonical reference.
 * @throws the signal reason when aborted, or a storage error when verification fails.
 */
abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>
```

Source: [`packages/attachment/attachment/src/index.ts:33`](../../packages/attachment/attachment/src/index.ts)

<a id="ctxfilelibrary--filelibrary"></a>

### `ctx.fileLibrary` — `FileLibrary`

受管理文件与记录分属两个介质；提交失败只回滚当前操作仍拥有的磁盘条目。

```ts cordis-catalog
/**
 * 将上传流写入独占私有文件，校验发起会话后写入领域记录。
 * 拒绝空文件或超过 32 MiB 的流；失败仅删除本次仍持有的文件，不回滚其他介质已持久化的事实。
 * @param input - 原名、会话身份、数据流和提交前的会话有效性检查。
 * @returns 持久记录和只供 Host 内部使用的绝对路径。
 */
async saveUpload(input: { name: string sessionId: string workspaceId?: string stream: AsyncIterable<Uint8Array> verify: () => Promise<void> }): Promise<{ record: ManagedFileRecord; path: string }>

/**
 * 复制已由附件服务准入的不可变生成图片；原附件继续由附件服务拥有，字节限额仍由附件提供方控制。
 * @param input - 会话、图库、附件引用及已准入编码字节。
 * @returns 副本的持久元数据，以及模型侧需要引用的绝对路径。
 */
async saveGeneratedImage(input: { sessionId: string workspaceId?: string galleryId?: string attachmentId: string mediaType: GeneratedImageMediaType data: Uint8Array }): Promise<{ record: ManagedFileRecord; path: string }>

/**
 * 把已由附件服务准入的输入图片复制到文件库，供文件管理页集中查看。
 * @param input - 会话、附件身份、媒体类型、可选文件名与已准入字节。
 * @returns 文件库记录和仅供 Host 使用的绝对路径。
 */
async saveInputImage(input: { sessionId: string workspaceId?: string attachmentId: string mediaType: GeneratedImageMediaType name?: string data: Uint8Array }): Promise<{ record: ManagedFileRecord; path: string }>

/**
 * 把会话导出的成品登记到全局文件库。导出文件与工作区里的原始产物
 * 保持两份独立副本，便于无工作区会话在 Coding home 中集中管理。
 * @param input - 成品文件名、会话身份、媒体类型与已生成字节。
 * @returns 文件库记录和仅供 Host 使用的绝对路径。
 */
async saveExport(input: { name: string sessionId: string workspaceId?: string mediaType: string data: Uint8Array }): Promise<{ record: ManagedFileRecord; path: string }>

/**
 * 从领域快照按创建时间倒序分页；不返回本机路径。
 * @param offset - 从零开始的偏移，默认零。
 * @param limit - 每页最多 100 条，默认 50。
 * @param filter - 可选的会话、工作区、范围、类型和分类过滤条件。
 * @returns 当前快照的一页、总数和可选后续偏移。
 */
list(offset: number = 0, limit: number = 50, filter: { sessionId?: string workspaceId?: string unscoped?: boolean kind?: ManagedFileKind category?: ManagedFileCategory } = {}): ManagedFilePage

/**
 * 文件列表并入无目录笔记：领域快照的过滤结果与笔记根目录的实时记录合并后分页。
 * 笔记只出现在未分组视图或 `kind: 'note'` 过滤下；已登记记录与实时记录相对路径重复时只取登记记录。
 * @param offset - 从零开始的偏移，默认零。
 * @param limit - 每页最多 100 条，默认 50。
 * @param filter - 与 {@link FileLibrary.list} 相同的过滤条件。
 * @returns 合并视图的一页、总数和可选后续偏移。
 */
async listWithNotes(offset: number = 0, limit: number = 50, filter: { sessionId?: string workspaceId?: string unscoped?: boolean kind?: ManagedFileKind category?: ManagedFileCategory } = {}): Promise<ManagedFilePage>

/**
 * 按文件库 ID 读取已登记的本地字节；绝对路径永远不离开 Host。未登记 id 落到无目录笔记的实时记录。
 * @param id - 文件库或实时笔记的标识。
 * @returns 记录与字节；标识不存在或文件不再安全时为 undefined。
 */
async read(id: string): Promise<{ record: ManagedFileRecord; data: Uint8Array } | undefined>

/**
 * 笔记根目录的绝对路径；只供 Host 侧会话工作目录使用，不进入浏览器响应。
 * @returns 笔记根目录绝对路径。
 */
notesRootPath(): string

/**
 * 扫描笔记根目录返回目录树：Markdown 文件、幻灯片工程目录与普通目录，符号链接条目不进入树。
 * 幻灯片工程目录只出现为一行 `deck` 条目，其内部的工程文件不参与扫描与节点预算。
 * 深度与节点总数超限视为结构异常，整棵树拒绝。
 * @returns 根级条目数组；子节点按名称排序。
 */
async notesTree(): Promise<NotesTreeNode[]>

/**
 * 读取笔记原文与其修改时间；保存冲突检测的基准时间由此取得。
 * @param relativePath - 相对笔记根目录的路径。
 * @returns 规范化路径、全文与毫秒修改时间。
 */
async readNote(relativePath: string): Promise<{ path: string; content: string; mtimeMs: number }>

/**
 * 写入笔记；没有修改时间基准时按需创建中间目录，写入经临时文件原子改名并同步目录。
 * 传入 `baseMtimeMs` 时目标文件与父目录必须仍存在，外部修改或删除都拒绝覆盖。
 * @param relativePath - 相对笔记根目录的路径，必须使用 Markdown 扩展名。
 * @param content - 笔记全文。
 * @param baseMtimeMs - 读取时的修改时间（可选）。
 * @returns 规范化路径与写入后的修改时间。
 */
async saveNote(relativePath: string, content: string, baseMtimeMs?: number): Promise<{ path: string; mtimeMs: number }>

/**
 * 在指定笔记目录创建空笔记；名称按文件库规则净化，缺省扩展名补 `.md`，同名已存在时拒绝。
 * @param name - 用户提交的文件名。
 * @param directory - 相对笔记根目录的父目录，空字符串表示根目录。
 * @returns 相对笔记根目录的路径。
 */
async createNote(name: string, directory: string = ''): Promise<{ path: string }>

/**
 * 在笔记树中独占创建一份幻灯片工程目录（`{name}.codingppt`）；这是只供 Host 调用的 PPT 服务 seam。
 * 目录由本方法以 `0o700` 独占创建并同步父目录，工程内容由调用方在自己的目录句柄里写入。
 * @param name - 用户提交的名称；缺省补 `.codingppt` 后缀。
 * @param directory - 相对笔记根目录的真实私有父目录，空字符串表示根目录。
 * @returns 相对笔记根目录的目录路径，以及只在仍拥有本次创建的目录时递归清理的句柄。
 * @throws TypeError 名称或父目录不安全，或同名条目已存在时。
 */
async createNoteDeck(name: string, directory: string = ''): Promise<{ path: string; remove: () => Promise<void> }>

/**
 * 在指定笔记目录创建子目录；只接受单个目录名，拒绝覆盖现有条目。
 * @param name - 用户提交的目录名。
 * @param parent - 相对笔记根目录的父目录，空字符串表示根目录。
 * @returns 相对笔记根目录的新目录路径。
 */
async createNoteDirectory(name: string, parent: string = ''): Promise<{ path: string }>

/**
 * 在原文件或目录的同一父目录内安全改名；Markdown 与幻灯片工程目录保留自己的后缀，不覆盖已有条目。
 * @param relativePath - 要改名的 Markdown 文件、幻灯片工程目录或普通目录路径。
 * @param name - 新的单段名称；Markdown 与幻灯片工程目录可省略后缀，但不能指定其他扩展名。
 * @returns 改名后的相对路径。
 */
async renameNote(relativePath: string, name: string): Promise<{ path: string }>

/**
 * 删除单个 Markdown 文件或整个目录（含幻灯片工程目录）；拒绝将符号链接作为目标，目录中的链接只移除链接本身。
 * @param relativePath - 要删除的文件或目录路径。
 * @returns 删除完成后兑现；目标不存在或路径越界时拒绝。
 */
async deleteNote(relativePath: string): Promise<void>

/**
 * 无目录笔记的实时记录：笔记根目录直属的 Markdown 文件（不含子目录条目），
 * 已被领域表登记的同名相对路径不重复出现。
 * @returns 按修改时间表达创建时间的记录数组。
 */
async noteRecords(): Promise<ManagedFileRecord[]>

/**
 * 读取真实且仍归本库登记的上传记录；目录和文件均需通过当前身份检查。
 * @param path - Host 提供的绝对路径。
 * @returns 已登记的上传记录；路径失效或不属于本库时为 `undefined`。
 */
async getUpload(path: string): Promise<ManagedFileRecord | undefined>

/**
 * 仅确认真实、仍归本库登记的上传文件，拒绝符号链接及库外路径。
 * @param path - Host 提供的绝对路径。
 * @returns 是否属于已登记的上传对象。
 */
async isManagedUploadPath(path: string): Promise<boolean>
```

Source: [`packages/attachment/file-library/src/index.ts:156`](../../packages/attachment/file-library/src/index.ts)

<a id="ctximagegeneration--imagegeneration"></a>

### `ctx.imageGeneration` — `ImageGeneration`

会话身份来自 Host 的活会话或持久会话检查，而不是浏览器提供的附件 ID。

```ts cordis-catalog
/**
 * 配置来源挂载、卸载或提交，以及当前凭据引用变化后通知消费方重新读取 `status()`。
 * 注册不主动通知，调用方应先订阅再做首次读取；监听器抛错不会回滚设置或凭据提交。
 * @param listener - 可用性需重新判定时调用的同步回调。
 * @returns 撤销该回调的函数。
 */
watchAvailability(listener: () => void): () => void

/**
 * 不包含端点、引用与密钥的配置可见性摘要；无凭据的本地端点可用。
 * @returns 启用状态、可用性与当前模型名。
 */
async status(): Promise<{ enabled: boolean; available: boolean; model: string }>

/**
 * 返回比例与像素尺寸的非机密配置，供手动生图选择器使用。
 * @returns 比例到尺寸代号的像素尺寸映射。
 */
outputSizes(): Record<string, Record<string, string>>

/**
 * 把模型给的比例与档位解析成当前尺寸表里的像素尺寸。
 * @param aspectRatio - 形如 `16:9` 的比例；省略时由上游选择默认尺寸。
 * @param resolution - `1K`／`2K`／`4K`；给出时必须同时给出比例。
 * @returns 像素尺寸，或 `undefined` 表示不向上游指定尺寸。
 */
sizeFor(aspectRatio?: string, resolution?: string): string | undefined

/**
 * 工作台的参考图上限与服务端本次编辑上限保持一致。
 * @returns 单次编辑可引用的参考图数量。
 */
maxEditReferences(): number

/**
 * 返回此会话的不可变图库事件投影；重启后可从持久日志重建。
 * @param events - 会话持久日志中的事件。
 * @returns 按事件顺序排列的图库项。
 */
gallery(events: readonly SessionEvent[]): GalleryItem[]

/**
 * 返回持久日志中的当前画布快照。
 * @param events - 会话持久日志中的事件。
 * @returns 带修订号的画布快照。
 */
canvas(events: readonly SessionEvent[]): CanvasSnapshot

/**
 * 只在同一会话的图库投影内查找附件引用，跨会话 ID 永不直接读附件。
 * @param events - 会话持久日志中的事件。
 * @param id - 请求读取的图库项 id。
 * @returns 校验通过的图片字节与引用；找不到时为 `undefined`。
 */
async readImage(events: readonly SessionEvent[], id: string): Promise<{ data: Uint8Array; ref: ImageAttachmentRef } | undefined>

/**
 * 从最近一次会话图像事件选择参考图；选取仅由同会话日志确定。
 * @param events - 会话持久日志中的事件。
 * @param count - 需要的参考图数量。
 * @returns 最近指定数量的图库项。
 */
latestImages(events: readonly SessionEvent[], count: number): GalleryItem[]

/**
 * 把用户上传的参考图按附件策略准入并写入当前会话图库，供编辑接口引用。
 * 此操作不发送模型请求，也不要求生图服务已启用；准入失败不追加图片事件。
 * 返回前等待会话持久化；持久化失败会拒绝，但不回滚已追加的图库事实。
 * @param session - 当前仍在 Host 中的会话。
 * @param image - 原始编码字节与声明媒体类型。
 * @returns 此会话可用于 `edit_image` 的持久图库项。
 */
async importReference(session: Session, image: SaveImageAttachment): Promise<GalleryItem>

/**
 * 图片经附件准入后复制到全局文件库，才追加图库事实并等待会话持久化。
 * 副本登记失败不发布图库项；会话持久化失败不回滚已追加事实或已登记副本。
 * @param session - 发起生图的会话。
 * @param prompt - 图片描述文本。
 * @param sourceIds - 编辑来源的图库项 id；文生图为空。
 * @param signal - 取消上游请求的中断信号。
 * @param output - 可选尺寸与质量覆盖。
 * @returns 已持久化到会话图库的生成项。
 */
async create( session: Session, prompt: string, sourceIds: readonly string[] = [], signal: AbortSignal = new AbortController().signal, output: { size?: string; quality?: string } = {}, ): Promise<GalleryItem & { path: string }>

/**
 * 画布写入只由当前活会话拥有；持久读取无需启动 Agent。
 * @param session - 拥有画布事件的会话。
 * @param revision - 调用方持有的画布修订号。
 * @param state - 新画布状态。
 * @returns 写入后的新画布快照。
 */
saveCanvas(session: Session, revision: number, state: CanvasState): CanvasSnapshot

/**
 * 路由只接受 live session 或已持久存在的 session id；不创建或 resume Agent。
 * @param id - 请求读取的会话 id。
 * @returns 会话事件；会话不存在时为 `undefined`。
 */
async sessionEvents(id: SessionId): Promise<readonly SessionEvent[] | undefined>
```

Types: [Session](session.md) · [SessionEvent](session.md) · [SessionId](core.md)

Source: [`packages/image/image-gen/src/index.ts:60`](../../packages/image/image-gen/src/index.ts)
<!-- END GENERATED cordis-surface -->
