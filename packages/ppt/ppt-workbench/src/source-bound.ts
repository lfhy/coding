/** 将工作区内的 PPTX 原件绑定到工程，并在同一工程队列内核对及提交来源版本。 */
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { withFileLock } from 'coding-atomic-write'
import { buildPptx } from './export/pptx.ts'
import { PPT_IMPORT_MAX_BYTES } from './import.ts'
import { PptStoreError, loadProject, resolveProjectDir, withLock, writeProjectVersion, type PptCommit, type PptHistory, type PptSnapshot } from './store.ts'
import { readWorkspaceFile, readWorkspaceMedia } from './template-project.ts'

const BINDING_FILE = 'source.json'
const BINDING_MAX_BYTES = 4096
const TXN_FILE = '.source-transaction.json'

/** 原件路径和版本必须保存在工程目录内，重挂服务和切换会话也不能丢失。 */
export interface PptSourceBinding {
  readonly version: 1
  readonly path: string
  readonly sha256: string
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 原件只可取工作区内的相对 .pptx，不能借绝对路径指向文件库或目录外。 */
export function sourcePath(root: string, path: string): string {
  if (typeof path !== 'string' || path === '' || isAbsolute(path) || !/\.pptx$/iu.test(path)
    || path.split(/[\\/]/u).some(segment => segment === '..' || segment === '.') || path.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new PptStoreError('bad-request', '来源必须是工作区内的相对 .pptx 文件路径')
  }
  const absolute = resolveProjectDir(root, path)
  if (absolute === resolve(root)) throw new PptStoreError('forbidden', '不能将工作区根目录作为来源文件')
  return absolute
}

function fingerprint(path: string, info: Awaited<ReturnType<typeof lstat>>, bytes: Uint8Array): PptSourceBinding {
  return { version: 1, path, sha256: hash(bytes), dev: Number(info.dev), ino: Number(info.ino),
    size: Number(info.size), mtimeMs: Number(info.mtimeMs) }
}

function sameVersion(left: PptSourceBinding, right: PptSourceBinding): boolean {
  return left.path === right.path && left.sha256 === right.sha256 && left.dev === right.dev
    && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
}

/** 拒绝真实目录中的符号链接，包括绑定文件的上级工程目录。 */
async function assertDirectory(root: string, path: string): Promise<void> {
  const base = resolve(root)
  const inside = relative(base, path)
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new PptStoreError('forbidden', '文件越出工作区')
  }
  let current = base
  const rootInfo = await lstat(current)
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new PptStoreError('forbidden', '工作区路径不安全')
  for (const segment of inside.split(sep).filter(Boolean)) {
    current = join(current, segment)
    const info = await lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new PptStoreError('forbidden', '目录不允许符号链接')
  }
}

/** 通过现有工作区准入读取源，并在读前后核对路径身份，避免将两次替换混成一个版本。 */
export async function readSourceVersion(root: string, path: string): Promise<{
  binding: PptSourceBinding
  bytes: Uint8Array
}> {
  const absolute = isAbsolute(path) ? path : sourcePath(root, path)
  const canonical = sourcePath(root, relative(resolve(root), absolute))
  if (absolute !== canonical) throw new PptStoreError('forbidden', 'PPTX 原文件必须位于工作区内')
  const before = await lstat(absolute).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PptStoreError('not-found', 'PPTX 原文件不存在')
    }
    throw error
  })
  const bytes = await readWorkspaceFile(root, absolute, PPT_IMPORT_MAX_BYTES)
  const after = await lstat(absolute)
  if (!before.isFile() || !after.isFile() || before.isSymbolicLink() || after.isSymbolicLink()) {
    throw new PptStoreError('forbidden', 'PPTX 原文件必须是普通文件')
  }
  const first = fingerprint(absolute, before, bytes)
  const last = fingerprint(absolute, after, bytes)
  if (!sameVersion(first, last)) throw new PptStoreError('conflict', 'PPTX 原文件在读取时发生变化，请重新打开')
  return { binding: last, bytes }
}

function parseBinding(value: unknown, root: string): PptSourceBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PptStoreError('bad-request', 'PPTX 来源关联不合法')
  }
  const item = value as Record<string, unknown>
  if (item.version !== 1 || typeof item.path !== 'string' || !isAbsolute(item.path)
    || typeof item.sha256 !== 'string' || !/^[a-f\d]{64}$/u.test(item.sha256)
    || !['dev', 'ino', 'size', 'mtimeMs'].every(key => typeof item[key] === 'number'
      && Number.isFinite(item[key]) && item[key] >= 0)) {
    throw new PptStoreError('bad-request', 'PPTX 来源关联不合法')
  }
  let safePath: string
  try { safePath = sourcePath(root, relative(resolve(root), item.path)) } catch {
    throw new PptStoreError('forbidden', 'PPTX 来源路径已越出工作区')
  }
  if (safePath !== item.path) {
    throw new PptStoreError('forbidden', 'PPTX 来源路径已越出工作区')
  }
  return value as PptSourceBinding
}

/** 读取可选的来源关联，坏记录不得退化为普通工程以绕过原位写回。 */
export async function readSourceBinding(root: string, dir: string): Promise<PptSourceBinding | undefined> {
  const path = join(dir, BINDING_FILE)
  const bytes = await readWorkspaceFile(root, path, BINDING_MAX_BYTES).catch((error: unknown) => {
    if (error instanceof PptStoreError && error.code === 'not-found') return undefined
    throw error
  })
  if (bytes === undefined) return undefined
  try {
    return parseBinding(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), root)
  } catch (error) {
    if (error instanceof PptStoreError) throw error
    throw new PptStoreError('bad-request', 'PPTX 来源关联不合法')
  }
}

interface SourceTransaction {
  readonly version: 1
  readonly before: PptSourceBinding
  readonly baseRevision: number
  readonly baseDeckSha256: string
  readonly baseHistorySha256: string
  readonly nextSha256: string
  readonly snapshot: PptSnapshot
  readonly history: PptHistory
}

async function transactionOf(root: string, dir: string): Promise<SourceTransaction | undefined> {
  const bytes = await readWorkspaceFile(root, join(dir, TXN_FILE), PPT_IMPORT_MAX_BYTES).catch((error: unknown) => {
    if (error instanceof PptStoreError && error.code === 'not-found') return undefined
    throw error
  })
  if (bytes === undefined) return undefined
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1
      || !('before' in value) || !('nextSha256' in value) || typeof value.nextSha256 !== 'string'
      || !('baseRevision' in value) || !Number.isSafeInteger(value.baseRevision)
      || !('baseDeckSha256' in value) || typeof value.baseDeckSha256 !== 'string'
      || !/^[a-f\d]{64}$/u.test(value.baseDeckSha256)
      || !('baseHistorySha256' in value) || typeof value.baseHistorySha256 !== 'string'
      || !/^[a-f\d]{64}$/u.test(value.baseHistorySha256)
      || !/^[a-f\d]{64}$/u.test(value.nextSha256) || !('snapshot' in value) || !('history' in value)) {
      throw new Error('交易数据不合法')
    }
    parseBinding(value.before, root)
    const txn = value as SourceTransaction
    if (txn.snapshot.dir !== dir || !Array.isArray(txn.history.entries)
      || typeof txn.snapshot.revision !== 'number' || txn.history.entries.length === 0
      || !Number.isSafeInteger(txn.history.cursor) || txn.history.cursor < 0
      || txn.history.cursor >= txn.history.entries.length) {
      throw new Error('交易工程不匹配')
    }
    const entry: unknown = txn.history.entries[txn.history.cursor]
    if (typeof entry !== 'object' || entry === null || !('revision' in entry)
      || entry.revision !== txn.snapshot.revision) throw new Error('交易历史不匹配')
    return txn
  } catch {
    throw new PptStoreError('bad-request', 'PPTX 原位保存记录损坏，请先修复工程')
  }
}

/** 持锁期间恢复未完成的事务，避免另一个进程把暂存版本当作外部修改。 */
async function reconcileLocked(root: string, dir: string,
  binding: PptSourceBinding | undefined): Promise<PptSourceBinding | undefined> {
  const txn = await transactionOf(root, dir)
  if (txn === undefined) return binding
  if (binding === undefined) {
    throw new PptStoreError('conflict', 'PPTX 原位保存记录缺少来源关联，请先检查工程')
  }
  const current = await readSourceVersion(root, binding.path).catch((error: unknown) => {
    if (error instanceof PptStoreError && (error.code === 'not-found' || error.code === 'forbidden')) {
      throw new PptStoreError('conflict', 'PPTX 原文件已被移动或替换，请重新打开')
    }
    throw error
  })
  const published = !sameVersion(binding, txn.before) && binding.path === txn.before.path
    && binding.sha256 === txn.nextSha256 && sameVersion(binding, current.binding)
  if (!sameVersion(binding, txn.before) && !published) {
    throw new PptStoreError('conflict', 'PPTX 原位保存记录与工程不符，请先检查原文件')
  }
  if (sameVersion(binding, current.binding)) {
    if (!published) {
      await rm(join(dir, TXN_FILE))
      return binding
    }
  }
  if (current.binding.sha256 !== txn.nextSha256) {
    throw new PptStoreError('conflict', 'PPTX 原文件已在别处修改，请重新打开文件')
  }
  const project = await loadProject(dir)
  const history = await readWorkspaceFile(root, join(dir, 'history.json'), PPT_IMPORT_MAX_BYTES)
  let historyMatchesBase = false
  let historyMatchesNext = false
  try {
    const saved: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(history))
    historyMatchesBase = hash(new TextEncoder().encode(JSON.stringify(saved))) === txn.baseHistorySha256
    historyMatchesNext = JSON.stringify(saved) === JSON.stringify(txn.history)
  } catch {
    throw new PptStoreError('conflict', '工程历史已与原件保存记录分叉，请先检查文件')
  }
  const matchesBase = project.revision === txn.baseRevision
    && hash(new TextEncoder().encode(JSON.stringify(project.deck))) === txn.baseDeckSha256
  const matchesNext = project.revision === txn.snapshot.revision
    && JSON.stringify(project.deck) === JSON.stringify(txn.snapshot.deck)
  if ((!matchesBase && !matchesNext) || (!historyMatchesBase && !historyMatchesNext)) {
    throw new PptStoreError('conflict', '工程已与原件保存记录分叉，请先检查文件')
  }
  if (published && matchesNext && historyMatchesNext) {
    await rm(join(dir, TXN_FILE))
    return binding
  }
  await publishVersion(root, dir, txn.snapshot, txn.history, current.binding)
  await rm(join(dir, TXN_FILE))
  return current.binding
}

/** 只在源文件锁内检查版本并恢复事务；非本服务修改仍按版本冲突处理。 */
async function withLockedSource<T>(root: string, dir: string,
  run: (binding: PptSourceBinding | undefined) => Promise<T>): Promise<T> {
  await assertDirectory(root, dir)
  const initial = await readSourceBinding(root, dir)
  if (initial === undefined) return run(await reconcileLocked(root, dir, undefined))
  await assertDirectory(root, dirname(initial.path))
  return withFileLock(initial.path, async () => {
    const binding = await readSourceBinding(root, dir)
    if (binding === undefined || binding.path !== initial.path) {
      throw new PptStoreError('conflict', 'PPTX 来源关联已改变，请重新打开工程')
    }
    return run(await reconcileLocked(root, dir, binding))
  })
}

/** 断电后由下一次读取或编辑完成原件已写入的工程版本。 */
export function reconcileSource(root: string, dir: string): Promise<PptSourceBinding | undefined> {
  return withLockedSource(root, dir, binding => Promise.resolve(binding))
}

/** 普通读取和工程打开也经过工程队列，避免与编辑提交时的多个文件替换交错。 */
export function withSourceRead<T>(root: string, dir: string,
  read: (binding: PptSourceBinding | undefined) => Promise<T>): Promise<T> {
  return withLock(dir, () => withLockedSource(root, dir, async (binding) => {
    if (binding !== undefined) await assertSourceVersion(root, binding)
    return read(binding)
  }))
}

/** 初次发布工程时由模板发布器在临时目录写入，随工程整体可见。 */
export function serializeSourceBinding(binding: PptSourceBinding): string {
  return `${JSON.stringify(binding, null, 2)}\n`
}

/** 读或写前明确报告外部改动，不允许轮询误把旧工程当成最新原件。 */
export async function assertSourceVersion(root: string, binding: PptSourceBinding): Promise<void> {
  let actual
  try { actual = (await readSourceVersion(root, binding.path)).binding } catch (error) {
    if (error instanceof PptStoreError && error.code === 'not-found') {
      throw new PptStoreError('conflict', 'PPTX 原文件已被移动或删除，请重新打开')
    }
    if (error instanceof PptStoreError && error.code === 'forbidden') {
      throw new PptStoreError('conflict', 'PPTX 原文件路径已改变，请重新打开')
    }
    throw error
  }
  if (!sameVersion(binding, actual)) {
    throw new PptStoreError('conflict', 'PPTX 原文件已在别处修改，工程没有覆盖它；请重新打开文件')
  }
}

/** 在真实源文件旁独占创建临时原件，失败时不更改工程或原件。 */
async function replaceSource(root: string, binding: PptSourceBinding, bytes: Uint8Array): Promise<PptSourceBinding> {
  if (bytes.byteLength === 0 || bytes.byteLength > PPT_IMPORT_MAX_BYTES) {
    throw new PptStoreError('bad-request', '编辑后的 PPTX 超过 8 MiB，未保存到原文件')
  }
  const path = binding.path
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`)
  try {
    const sourceInfo = await lstat(path)
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
      throw new PptStoreError('forbidden', 'PPTX 原文件必须是普通文件')
    }
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW
    const handle = await open(temp, flags, sourceInfo.mode & 0o777)
    try { await handle.writeFile(bytes) } finally { await handle.close() }
    await assertSourceVersion(root, binding)
    await assertDirectory(root, dirname(path))
    await rename(temp, path)
    const replaced = await lstat(path)
    return fingerprint(path, replaced, bytes)
  } finally {
    await rm(temp, { force: true })
  }
}

/** 模型和面板的 edit/undo/redo 都在 store.withLock 内经此回调提交。 */
export function linkedCommit(root: string, dir: string): PptCommit {
  let prepared: PptSourceBinding | undefined
  const commit = async (current: PptSnapshot, previous: PptHistory, next: PptSnapshot, history: PptHistory) => {
    const binding = await readSourceBinding(root, dir)
    if (binding === undefined) { await writeProjectVersion(dir, next, history); return }
    await withFileLock(binding.path, async () => {
      if (prepared === undefined || !sameVersion(prepared, binding)) {
        throw new PptStoreError('conflict', 'PPTX 来源关联已被修改，请重新打开工程')
      }
      const latest = await loadProject(dir)
      if (latest.revision !== current.revision || JSON.stringify(latest.deck) !== JSON.stringify(current.deck)) {
        throw new PptStoreError('conflict', '工程已被其他操作修改，请重新打开工程')
      }
      const saved = await readWorkspaceFile(root, join(dir, 'history.json'), PPT_IMPORT_MAX_BYTES)
      let diskHistory: unknown
      try { diskHistory = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(saved)) }
      catch { throw new PptStoreError('conflict', '工程历史已改变，请重新打开工程') }
      if (JSON.stringify(diskHistory) !== JSON.stringify(previous)) {
        throw new PptStoreError('conflict', '工程历史已被其他操作修改，请重新打开工程')
      }
      await assertSourceVersion(root, binding)
      // 普通导出允许缺图降级成色块；原件回写必须读齐媒体，不能丢图片。
      const images = await readWorkspaceMedia(root, dir, next.deck)
      const media = new Map(images.map(image => [image.part, image.bytes]))
      const bytes = buildPptx(next.deck, { media: source => media.get(source) })
      if (bytes.byteLength > PPT_IMPORT_MAX_BYTES) {
        throw new PptStoreError('bad-request', '编辑后的 PPTX 超过 8 MiB，未保存到原文件')
      }
      const txn: SourceTransaction = {
        version: 1, before: binding, baseRevision: current.revision,
        baseDeckSha256: hash(new TextEncoder().encode(JSON.stringify(current.deck))),
        baseHistorySha256: hash(new TextEncoder().encode(JSON.stringify(previous))),
        nextSha256: hash(bytes), snapshot: next, history,
      }
      const transactionPath = join(dir, TXN_FILE)
      await writeFile(transactionPath, `${JSON.stringify(txn)}\n`, { flag: 'wx', mode: 0o600 })
      try {
        const updated = await replaceSource(root, binding, bytes)
        // 单文件 rename 之间靠交易记录恢复；不能承诺跨文件系统的多文件原子性。
        await publishVersion(root, dir, next, history, updated)
        await rm(transactionPath)
      } catch (error) {
        const actual = await readSourceVersion(root, binding.path).catch(() => undefined)
        if (actual !== undefined && sameVersion(actual.binding, binding)) {
          await rm(transactionPath)
          throw error
        }
        if (actual?.binding.sha256 === txn.nextSha256) {
          try {
            await reconcileLocked(root, dir, await readSourceBinding(root, dir))
          } catch {
            throw new PptStoreError('conflict', 'PPTX 已写入，但工程版本待恢复；请重新打开工程再操作')
          }
          throw new PptStoreError('conflict', 'PPTX 已写入并恢复工程，请读取最新版本后重试')
        }
        throw error
      }
    })
  }
  return Object.assign(commit, { prepare: async () => { prepared = await reconcileSource(root, dir) } })
}

async function publishVersion(root: string, dir: string, snapshot: PptSnapshot, history: PptHistory,
  binding?: PptSourceBinding): Promise<void> {
  await assertDirectory(root, dir)
  const files: readonly [string, string][] = [
    ['history.json', `${JSON.stringify(history, null, 2)}\n`],
    ['deck.json', `${JSON.stringify({ revision: snapshot.revision, deck: snapshot.deck }, null, 2)}\n`],
    ...binding === undefined ? [] : [['source.json', serializeSourceBinding(binding)] as [string, string]],
  ]
  const temp = join(dir, `.source-version-${randomBytes(8).toString('hex')}`)
  await mkdir(temp, { mode: 0o700 })
  try {
    for (const [file, text] of files) await writeFile(join(temp, file), text, { flag: 'wx', mode: 0o600 })
    for (const [file] of files) {
      const target = join(dir, file)
      const info = await lstat(target)
      if (info.isSymbolicLink() || !info.isFile()) throw new PptStoreError('forbidden', '工程文件不允许符号链接')
    }
    for (const [file] of files) await rename(join(temp, file), join(dir, file))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}
