/**
 * Instruction-file discovery and bounded, abort-aware provider reads.
 *
 * @module coding-agent-instructions/files
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { FileSystem, FsInfo, FsTarget, FsVersion } from 'coding-fs'
import { assertNever } from 'coding-llm'
import { dshHomeDisplay } from 'coding-home-paths'
import { resolveConfig, resolveDiscoveryConfig, type ResolvedConfig } from './config.ts'
import { trimmedInstructionDigest } from './digest.ts'
import {
  decodeScopeKey,
  instructionKindFor,
  PROJECT_ROOT_DIRECTORY,
  renderWorkspaceInstructionSet,
  type RenderedWorkspaceContext,
  USER_GLOBAL_DIRECTORY,
  USER_GLOBAL_FILE,
} from './render.ts'

/**
 * 已加载文件渲染为工作区指令还是项目背景。项目简介候选只从项目根目录加载，
 * 因此子目录永远不会继承项目自身的 README。
 */
export type InstructionKind = 'instructions' | 'overview'

/** An instruction candidate identified by absolute and model-facing paths. */
export interface InstructionFile {
  absolutePath: string
  displayPath: string
  kind: InstructionKind
}

/** An instruction file whose UTF-8 content was read successfully. */
export interface LoadedInstructionFile extends InstructionFile {
  content: string
  /** Provider freshness token when the file was loaded through `ctx.fs`. */
  version?: FsVersion
}

interface DiscoveredInstructionFile extends InstructionFile {
  target?: FsTarget
  size?: number
  version?: FsVersion
}

/** Provider metadata for a probed scope candidate before its content is read. */
export interface ProbedInstructionFile extends InstructionFile {
  target: FsTarget
  version: FsVersion
  size?: number
}

interface DiscoverOptions {
  cwd: string
  dshHome?: string
  projectRootMarkers?: string[]
  instructionFileCandidates?: string[]
  localInstructionFileCandidates?: string[]
  overviewFileCandidates?: string[]
  projectRoot?: string
  signal?: AbortSignal
}

interface LoadOptions extends DiscoverOptions {
  maxBytes: number
  maxSourceBytes?: number
  overviewMaxBytes?: number
  replacePreviousBaseline?: boolean
}

/** Rendered baseline plus the successfully read and byte-budget-retained files. */
export interface RenderedInstructionSet {
  rendered: RenderedWorkspaceContext
  /** Successfully read candidates before content deduplication and byte budgeting. */
  observed: LoadedInstructionFile[]
  /** Candidates retained by content deduplication and byte budgeting. */
  included: LoadedInstructionFile[]
}
/** Tri-state scope probe that distinguishes confirmed absence from provider failure. */
export type ScopeInstructionProbe =
  | { kind: 'present'; file: ProbedInstructionFile }
  | { kind: 'absent' }
  | { kind: 'unavailable' }

interface StatFileInfo {
  target?: FsTarget
  size?: number
  version?: FsVersion
}

type StatFileProbe =
  | { kind: 'present'; info: StatFileInfo }
  | { kind: 'absent' }
  | { kind: 'unavailable' }

function signalOptions(signal?: AbortSignal): { signal: AbortSignal } | undefined {
  return signal === undefined ? undefined : { signal }
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

async function nodeStatFile(path: string, signal?: AbortSignal): Promise<StatFileProbe> {
  try {
    signal?.throwIfAborted()
    // stat (not lstat) follows a final-component symlink so a link to a regular
    // file loads; a broken link surfaces as ENOENT and is treated as absent below.
    const info = await stat(path)
    signal?.throwIfAborted()
    if (!info.isFile()) return { kind: 'absent' }
    return { kind: 'present', info: { size: info.size } }
  } catch (error: unknown) {
    signal?.throwIfAborted()
    return isMissingPathError(error) ? { kind: 'absent' } : { kind: 'unavailable' }
  }
}

async function fsStatFile(
  path: string,
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<StatFileProbe> {
  // resolve() follows a final-component symlink to its target's stable identity;
  // stat then classifies that target. A link to a regular file loads, while a
  // missing path or non-file target (including a link to a directory) is absent.
  try {
    const target = await fileSystem.resolve(path, signalOptions(signal))
    signal?.throwIfAborted()
    const info = await fileSystem.stat(target, signal)
    signal?.throwIfAborted()
    if (info?.type !== 'file') return { kind: 'absent' }
    return {
      kind: 'present',
      info: { target, version: info.version, ...info.size === undefined ? {} : { size: info.size } },
    }
  } catch {
    signal?.throwIfAborted()
    return { kind: 'unavailable' }
  }
}

async function statFile(
  path: string,
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<StatFileProbe> {
  return fileSystem === undefined ? nodeStatFile(path, signal) : fsStatFile(path, fileSystem, signal)
}

async function existsAsMarker(path: string, fileSystem?: FileSystem, signal?: AbortSignal): Promise<boolean> {
  if (fileSystem !== undefined) {
    try {
      const target = await fileSystem.resolve(path, signalOptions(signal))
      return await fileSystem.stat(target, signal) !== undefined
    } catch {
      signal?.throwIfAborted()
      // TODO(root-marker-unavailable): preserve provider failure separately from
      // absence and stop discovery; continuing upward can cross into an ancestor project.
      return false
    }
  }
  try {
    signal?.throwIfAborted()
    await stat(path)
    signal?.throwIfAborted()
    return true
  } catch {
    signal?.throwIfAborted()
    return false
  }
}

/**
 * Walk upward to the first directory containing a configured root marker.
 * @param cwd - absolute session working directory where the walk begins.
 * @param markers - child names that identify a project root.
 * @param fileSystem - optional provider used instead of host filesystem probes.
 * @param signal - cancellation for provider and host probes.
 * @returns the discovered project root, or `cwd` when no marker exists.
 */
export async function findProjectRoot(
  cwd: string,
  markers: readonly string[],
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<string> {
  let current = resolve(cwd)
  for (;;) {
    for (const marker of markers) {
      if (await existsAsMarker(join(current, marker), fileSystem, signal)) return current
    }
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/**
 * Build the inclusive root-to-cwd directory chain.
 * @param root - root directory expected to contain or equal `cwd`.
 * @param cwd - most-specific directory in the chain.
 * @returns directories ordered from broadest to most specific.
 */
export function ancestorChain(root: string, cwd: string): string[] {
  const chain: string[] = []
  let current = resolve(cwd)
  const resolvedRoot = resolve(root)
  while (current !== resolvedRoot) {
    chain.push(current)
    const parent = dirname(current)
    /* v8 ignore next -- discovery always supplies cwd or an ancestor root. */
    if (parent === current) break
    current = parent
  }
  chain.push(resolvedRoot)
  return chain.reverse()
}

/**
 * Find descendant directories crossed between a cwd and a touched file.
 * @param root - session cwd that bounds nested discovery.
 * @param touchedPath - absolute path or path relative to `root`.
 * @returns descendant directories from shallowest through the touched file's parent.
 */
export function descendantDirsBetween(root: string, touchedPath: string): string[] {
  const resolvedRoot = resolve(root)
  const targetPath = isAbsolute(touchedPath) ? resolve(touchedPath) : resolve(resolvedRoot, touchedPath)
  const targetDir = dirname(targetPath)
  const rel = relative(resolvedRoot, targetDir)
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return []
  return ancestorChain(resolvedRoot, targetDir).slice(1)
}

/**
 * Convert an absolute instruction path to its project-root-relative display form.
 * @param root - project root used as the display base.
 * @param path - absolute path to display.
 * @returns the root-relative path.
 */
export function relativeDisplay(root: string, path: string): string {
  return relative(root, path)
}

async function existingInstructionFiles(
  dir: string,
  root: string,
  candidateNames: readonly string[],
  kind: InstructionKind,
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<DiscoveredInstructionFile[]> {
  const found: DiscoveredInstructionFile[] = []
  for (const candidate of candidateNames) {
    const path = join(dir, candidate)
    const probe = await statFile(path, fileSystem, signal)
    switch (probe.kind) {
      case 'present':
        found.push({ absolutePath: path, displayPath: relativeDisplay(root, path), kind, ...probe.info })
        continue
      // 缺失的候选文件直接跳过；提供方暂时失败也只跳过该候选文件，其余彼此
      // 独立的候选仍会加载。
      case 'absent':
      case 'unavailable':
        continue
      /* v8 ignore next 2 -- StatFileProbe is closed; this arm only makes adding a kind a compile error. */
      default:
        assertNever(probe, 'StatFileProbe')
    }
  }
  return found
}

async function discoverInstructionFiles(
  options: DiscoverOptions,
  fileSystem?: FileSystem,
): Promise<DiscoveredInstructionFile[]> {
  const config = resolveDiscoveryConfig(options)
  const files: DiscoveredInstructionFile[] = []
  const seen = new Set<string>()
  const addFile = (file: DiscoveredInstructionFile): void => {
    if (seen.has(file.absolutePath)) return
    seen.add(file.absolutePath)
    files.push(file)
  }

  const userGlobal = join(config.dshHome, USER_GLOBAL_FILE)
  const userGlobalProbe = await statFile(userGlobal, fileSystem, options.signal)
  switch (userGlobalProbe.kind) {
    case 'present':
      addFile({
        absolutePath: userGlobal,
        displayPath: userGlobalDisplayPath(config.dshHome),
        kind: 'instructions',
        ...userGlobalProbe.info,
      })
      break
    case 'absent':
    case 'unavailable':
      break
    /* v8 ignore next 2 -- StatFileProbe is closed; this arm only makes adding a kind a compile error. */
    default:
      assertNever(userGlobalProbe, 'StatFileProbe')
  }

  const cwd = resolve(options.cwd)
  const projectRoot = options.projectRoot
    ?? await findProjectRoot(cwd, config.projectRootMarkers, fileSystem, options.signal)
  for (const dir of ancestorChain(projectRoot, cwd)) {
    // 项目简介只在项目根目录发现，并渲染在该目录指令之前：它是背景，基线溢出时
    // 共享预算最先丢弃最宽泛的一节。
    const groups: { candidateNames: readonly string[]; kind: InstructionKind }[] = [
      ...dir === projectRoot
        ? [{ candidateNames: config.overviewFileCandidates, kind: 'overview' as const }]
        : [],
      { candidateNames: config.instructionFileCandidates, kind: 'instructions' },
      { candidateNames: config.localInstructionFileCandidates, kind: 'instructions' },
    ]
    for (const group of groups) {
      for (const file of await existingInstructionFiles(
        dir,
        projectRoot,
        group.candidateNames,
        group.kind,
        fileSystem,
        options.signal,
      )) {
        addFile(file)
      }
    }
  }
  return files
}

/**
 * 发现宿主可见的用户全局、项目简介与项目根到 cwd 的指令候选。
 * 每个目录中所有存在的候选都会返回；去除空白后内容重复的文件在读取后折叠。
 * @param options - cwd、home、项目根标记与候选配置。
 * @returns 按模型优先级去重的候选，每项带自己的渲染类型。
 */
export async function discoverBaselineInstructionFiles(options: DiscoverOptions): Promise<InstructionFile[]> {
  return (await discoverInstructionFiles(options))
    .map(({ absolutePath, displayPath, kind }) => ({ absolutePath, displayPath, kind }))
}

async function* nodeTextChunks(path: string, signal?: AbortSignal): AsyncIterable<string> {
  const stream = createReadStream(path, { encoding: 'utf8', signal })
  for await (const chunk of stream) yield String(chunk)
}

async function readBounded(
  file: { absolutePath: string; target?: FsTarget; size?: number },
  maxSourceBytes: number,
  fileSystem?: FileSystem,
  signal?: AbortSignal,
): Promise<string | undefined> {
  // TODO(total-instruction-read-bound): enforce an aggregate source budget
  // across a complete baseline or reconciliation batch; the render budget is
  // applied only after every accepted file has been read under this per-file cap.
  signal?.throwIfAborted()
  if (file.size !== undefined && file.size > maxSourceBytes) return undefined
  try {
    const chunks = fileSystem === undefined || file.target === undefined
      ? nodeTextChunks(file.absolutePath, signal)
      : await fileSystem.streamText(file.target, signal)
    const parts: string[] = []
    let bytes = 0
    for await (const chunk of chunks) {
      signal?.throwIfAborted()
      bytes += Buffer.byteLength(chunk, 'utf8')
      if (bytes > maxSourceBytes) return undefined
      parts.push(chunk)
    }
    signal?.throwIfAborted()
    return parts.join('')
  } catch {
    signal?.throwIfAborted()
    // A file may disappear or become unreadable after its metadata probe.
    return undefined
  }
}

/**
 * 丢弃同一目录中与更早同级候选内容（去除首尾空白后）重复的候选。不同目录即使内容
 * 完全一致也不折叠；同一目录内保留发现顺序最早的候选并渲染其原始字节。symlink 到
 * 同级文件的候选会解析出相同内容，因此和任何字节一致的真实文件一样在此折叠。
 * @param files - 按发现顺序排列的已加载文件。
 * @returns 按发现顺序保留的文件。
 */
export function dedupInstructionFilesByDirectory(files: LoadedInstructionFile[]): LoadedInstructionFile[] {
  const keptDigestsByDir = new Map<string, Set<string>>()
  const kept: { index: number; file: LoadedInstructionFile }[] = []
  const entries = files.map((file, index) => ({ index, file }))
  // 指令先于项目简介认领同一目录的重复身份，尽管简介渲染在前：复制或 symlink 到
  // 同级 AGENTS.md 的 README 不能让真正的指令降级成背景文字。
  const claimOrder = [...entries].sort((left, right) => {
    const byKind = Number(left.file.kind === 'overview') - Number(right.file.kind === 'overview')
    return byKind === 0 ? left.index - right.index : byKind
  })
  for (const entry of claimOrder) {
    const dir = dirname(entry.file.displayPath)
    let digests = keptDigestsByDir.get(dir)
    if (digests === undefined) {
      digests = new Set()
      keptDigestsByDir.set(dir, digests)
    }
    const digest = trimmedInstructionDigest(entry.file.content)
    if (digests.has(digest)) continue
    digests.add(digest)
    kept.push(entry)
  }
  return kept.sort((left, right) => left.index - right.index).map(entry => entry.file)
}

/**
 * Discover, read, and render the baseline instruction chain.
 * @param options - discovery, source-size, byte-budget, and cancellation configuration.
 * @param fileSystem - optional provider used instead of host filesystem reads.
 * @returns rendered baseline context, or undefined when nothing can be loaded.
 */
export async function loadBaselineInstructions(
  options: LoadOptions,
  fileSystem?: FileSystem,
): Promise<RenderedWorkspaceContext | undefined> {
  return (await loadBaselineInstructionSet(options, fileSystem))?.rendered
}

/**
 * Load a baseline together with the files retained after rendering.
 * @param options - discovery, source-size, byte-budget, and cancellation configuration.
 * @param fileSystem - optional provider used instead of host filesystem reads.
 * @returns rendered context and retained files, an explicit empty replacement set, or undefined when empty or disabled.
 */
export async function loadBaselineInstructionSet(
  options: LoadOptions,
  fileSystem?: FileSystem,
): Promise<RenderedInstructionSet | undefined> {
  const config = resolveConfig(options)
  if (config.maxBytes <= 0 || !Number.isFinite(config.maxBytes)) return undefined
  if (config.maxSourceBytes <= 0 || !Number.isFinite(config.maxSourceBytes)) return undefined
  const discovered = await discoverInstructionFiles(options, fileSystem)
  const loaded: LoadedInstructionFile[] = []
  for (const file of discovered) {
    const content = await readBounded(file, config.maxSourceBytes, fileSystem, options.signal)
    if (content !== undefined) {
      loaded.push({
        absolutePath: file.absolutePath,
        displayPath: file.displayPath,
        kind: file.kind,
        content,
        ...file.version === undefined ? {} : { version: file.version },
      })
    }
  }
  const deduped = dedupInstructionFilesByDirectory(loaded)
  const renderOptions = {
    maxBytes: config.maxBytes,
    overviewMaxBytes: config.overviewMaxBytes,
  }
  if (deduped.length === 0) {
    if (options.replacePreviousBaseline !== true) return undefined
    const { rendered, included } = renderWorkspaceInstructionSet([], {
      ...renderOptions,
      replacePreviousBaseline: true,
    })
    return {
      rendered,
      observed: [],
      included,
    }
  }
  const { rendered, included } = renderWorkspaceInstructionSet(deduped, {
    ...renderOptions,
    ...options.replacePreviousBaseline === undefined
      ? {}
      : { replacePreviousBaseline: options.replacePreviousBaseline },
  })
  return {
    rendered,
    observed: loaded,
    included,
  }
}

/**
 * Probe the current provider metadata for one per-candidate instruction scope.
 * @param scope - a {@link candidateScopeKey} identifying a directory and candidate file.
 * @param projectRoot - project root used to resolve and display project scopes.
 * @param resolved - normalized plugin configuration.
 * @param fileSystem - provider used to resolve and stat scope candidates.
 * @param signal - cancellation for provider probes.
 * @returns present metadata, confirmed absence, or temporary unavailability.
 */
export async function probeScopeInstruction(
  scope: string,
  projectRoot: string,
  resolved: ResolvedConfig,
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<ScopeInstructionProbe> {
  const { directory, candidateName } = decodeScopeKey(scope)
  const dir = directory === USER_GLOBAL_DIRECTORY
    ? resolved.dshHome
    : directory === PROJECT_ROOT_DIRECTORY ? projectRoot : join(projectRoot, directory)
  const absolutePath = join(dir, candidateName)
  // resolve() 会跟随最后一段 symlink，stat 随后判定目标类型：非文件目标（缺失或
  // 指向目录的链接）是已确认不存在，只有提供方异常才报告为不可用。
  let target: FsTarget
  let info: FsInfo | undefined
  try {
    target = await fileSystem.resolve(absolutePath, signalOptions(signal))
    info = await fileSystem.stat(target, signal)
  } catch {
    signal?.throwIfAborted()
    return { kind: 'unavailable' }
  }
  if (info?.type !== 'file') return { kind: 'absent' }
  const file: ProbedInstructionFile = {
    absolutePath,
    displayPath: directory === USER_GLOBAL_DIRECTORY ? userGlobalDisplayPath(resolved.dshHome) : relativeDisplay(projectRoot, absolutePath),
    kind: instructionKindFor(directory, candidateName, resolved.overviewFileCandidates),
    target,
    version: info.version,
    ...info.size === undefined ? {} : { size: info.size },
  }
  return { kind: 'present', file }
}

/**
 * Read one already-probed scope candidate under the configured source cap.
 * @param file - winning provider candidate and its metadata snapshot.
 * @param maxSourceBytes - maximum UTF-8 bytes accepted from the source.
 * @param fileSystem - provider used for the streaming read.
 * @param signal - cancellation for provider streaming.
 * @returns loaded content with the probed version, or undefined when unavailable.
 */
export async function readScopeInstruction(
  file: ProbedInstructionFile,
  maxSourceBytes: number,
  fileSystem: FileSystem,
  signal?: AbortSignal,
): Promise<LoadedInstructionFile | undefined> {
  const content = await readBounded(file, maxSourceBytes, fileSystem, signal)
  if (content === undefined) return undefined
  return {
    absolutePath: file.absolutePath,
    displayPath: file.displayPath,
    kind: file.kind,
    content,
    version: file.version,
  }
}

function userGlobalDisplayPath(dshHome: string): string {
  return `${dshHomeDisplay(dshHome)}/AGENTS.md`
}
