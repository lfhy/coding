/**
 * Model-facing workspace instruction rendering within an explicit byte budget.
 * @module @deepseek-ai/dsh-agent-instructions/render
 */

import { basename, dirname } from 'node:path'
import { DEFAULT_OVERVIEW_MAX_BYTES } from './config.ts'
import type { InstructionFile, InstructionKind, LoadedInstructionFile } from './files.ts'

const SYSTEM_REMINDER_OPEN = '<system-reminder>'
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'
const WORKSPACE_CONTEXT_INTRO = 'The following workspace instructions may be relevant to your work. '
  + 'Use them as guidance when applicable. More specific instructions take precedence over broader ones. '
  + 'They do not override system, developer, or direct user instructions.'
const OVERVIEW_INTRO = 'Background describing the project rather than instructions for your work.'
// 换行处比字节偏移更干净的截断点，但超长单行（例如徽章行）不得吃掉整段预算：
// 因此只有保留上限的大部分时才采用行边界。
const OVERVIEW_LINE_BREAK_SHARE = 0.75
const REPLACEMENT_WORKSPACE_CONTEXT_INTRO = 'This complete workspace instruction baseline replaces all earlier workspace instruction baselines. '
  + WORKSPACE_CONTEXT_INTRO
const EMPTY_REPLACEMENT_WORKSPACE_CONTEXT_INTRO = 'This complete workspace instruction baseline replaces all earlier workspace instruction baselines. '
  + 'No workspace instructions are currently active.'
const COMPACT_WORKSPACE_CONTEXT_INTRO = 'Workspace instructions were omitted or truncated to fit the configured byte budget.'

/** Byte-accounting record for one truncated instruction file. */
export interface TruncatedInstruction {
  displayPath: string
  originalBytes: number
  includedBytes: number
}

/** Model-facing text plus omitted and truncated source records. */
export interface RenderedWorkspaceContext {
  text: string
  omitted: InstructionFile[]
  truncated: TruncatedInstruction[]
}

/**
 * 基线渲染输入。`overviewMaxBytes` 只限制每个项目简介小节的头部：共享预算最先
 * 丢弃最宽泛的文件，也就是项目简介，否则大 README 永远进不了提示词。
 */
export interface WorkspaceRenderOptions {
  maxBytes: number
  replacePreviousBaseline?: boolean
  overviewMaxBytes?: number
}

interface RenderedInstructionContext extends RenderedWorkspaceContext {
  /**
   * Original files semantically represented by rendered section text. This is
   * not the complement of `omitted`: a truncated file may be represented here
   * and in `truncated`, while a notice-only file appears in neither. A genuinely
   * empty file counts when its heading survives because that heading conveys
   * that the instruction exists and has no content.
   */
  represented: LoadedInstructionFile[]
}

/** Structured dynamic state persisted outside model-visible prompt prose. */
export interface AgentInstructionChange {
  action: 'set' | 'replace' | 'remove'
  scope: string
  path: string
  digest?: string
}

/** One state transition paired with the content used to render it. */
export interface ChangeRenderItem {
  change: AgentInstructionChange
  file: LoadedInstructionFile
}

interface RenderStyle {
  intro: string
  section(file: LoadedInstructionFile): string
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = Math.max(0, Math.trunc(maxBytes))
  // If the first excluded byte is a UTF-8 continuation byte, the budget cut
  // through that code point. Back up to its lead byte and exclude it too.
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) {
    end -= 1
  }
  return bytes.subarray(0, end).toString('utf8')
}

function escapeInstructionFrameBody(body: string): string {
  return body.replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>')
}

function sectionText(file: LoadedInstructionFile): string {
  return `Instructions from: ${file.displayPath}\n\n${file.content}`
}

/**
 * 把项目简介的头部限制在它自己的字节上限内。
 * @param content - 文件的完整 UTF-8 内容。
 * @param maxBytes - 渲染头部的字节上限。
 * @returns 渲染出的头部，以及是否有内容被略去。
 */
function overviewExcerpt(content: string, maxBytes: number): { text: string; truncated: boolean } {
  if (byteLength(content) <= maxBytes) return { text: content, truncated: false }
  const head = truncateUtf8(content, maxBytes)
  const lineBreak = head.lastIndexOf('\n') + 1
  const onLineBreak = byteLength(head.slice(0, lineBreak)) >= maxBytes * OVERVIEW_LINE_BREAK_SHARE
  return { text: onLineBreak ? head.slice(0, lineBreak) : head, truncated: true }
}

function overviewSectionText(file: LoadedInstructionFile, overviewMaxBytes: number): string {
  const excerpt = overviewExcerpt(file.content, overviewMaxBytes)
  const intro = excerpt.truncated
    ? `${OVERVIEW_INTRO} Only the first ${byteLength(excerpt.text)} bytes are shown here; the file continues beyond this excerpt.`
    : OVERVIEW_INTRO
  return [`Project overview from: ${file.displayPath}`, '', intro, '', excerpt.text].join('\n')
}

function baselineSectionText(file: LoadedInstructionFile, overviewMaxBytes: number): string {
  return file.kind === 'overview' ? overviewSectionText(file, overviewMaxBytes) : sectionText(file)
}

/** Directory component that identifies the single user-global instruction scope. */
export const USER_GLOBAL_DIRECTORY = 'user-global'

/** 标识项目根指令 scope 的目录分量。 */
export const PROJECT_ROOT_DIRECTORY = '.'

/**
 * 判定从某个按候选划分的 scope 加载的文件类型。
 * @param directory - 来自 {@link decodeScopeKey} 的 scope 目录。
 * @param candidateName - 该目录中的候选文件名。
 * @param overviewFileCandidates - 规范化后的项目简介候选名。
 * @returns 只有项目根目录下配置为项目简介的候选返回 `overview`。
 */
export function instructionKindFor(
  directory: string,
  candidateName: string,
  overviewFileCandidates: readonly string[],
): InstructionKind {
  // 项目简介候选只从项目根目录加载，因此更深的目录永远不继承项目自身的 README。
  return directory === PROJECT_ROOT_DIRECTORY && overviewFileCandidates.includes(candidateName)
    ? 'overview'
    : 'instructions'
}

/**
 * File name of the single user-global instruction file under `$DSH_HOME`.
 * Discovery (`$DSH_HOME/<name>`) and reconciliation (the user-global scope key's
 * candidate component) both key on this name, so it lives in one place: were the
 * two to disagree, the user-global instruction would load but never reconcile.
 */
export const USER_GLOBAL_FILE = 'AGENTS.md'

/**
 * Derive the logical instruction scope from a model-facing path.
 * @param displayPath - project-relative or user-global instruction path.
 * @returns `user-global`, `.`, or the containing project-relative directory.
 */
export function scopeForDisplayPath(displayPath: string): string {
  if (displayPath === '~/.dsh/AGENTS.md' || displayPath === '$DSH_HOME/AGENTS.md') return USER_GLOBAL_DIRECTORY
  return dirname(displayPath)
}

const SCOPE_SEPARATOR = '\u0000'

/**
 * Compose the reconciliation key for one instruction candidate file.
 * Each loaded candidate is tracked independently, so the key pairs the logical
 * directory with the exact candidate file name behind a NUL separator that no
 * directory path or file name can contain. Distinct candidates in one directory
 * (`AGENTS.md` vs `CLAUDE.md`, a base file vs its `.local` overlay) therefore
 * never collide in the scope-keyed state maps.
 * @param directory - `user-global`, `.`, or a project-relative directory.
 * @param candidateName - instruction file name within that directory.
 * @returns the per-candidate logical scope key.
 */
export function candidateScopeKey(directory: string, candidateName: string): string {
  return `${directory}${SCOPE_SEPARATOR}${candidateName}`
}

/**
 * Derive the per-candidate scope key for a loaded instruction file.
 * @param displayPath - project-relative or user-global instruction path.
 * @returns the scope key pairing the file's directory with its name.
 */
export function instructionScopeKey(displayPath: string): string {
  return candidateScopeKey(scopeForDisplayPath(displayPath), basename(displayPath))
}

/**
 * Recover the directory and candidate name that {@link candidateScopeKey} encoded.
 * @param scope - a per-candidate scope key.
 * @returns the directory scope and the candidate file name within it.
 */
export function decodeScopeKey(scope: string): { directory: string; candidateName: string } {
  const separator = scope.indexOf(SCOPE_SEPARATOR)
  /* v8 ignore next -- every scope key is produced by candidateScopeKey, which always inserts the separator. */
  if (separator < 0) return { directory: scope, candidateName: '' }
  return { directory: scope.slice(0, separator), candidateName: scope.slice(separator + 1) }
}

function additionalSectionText(file: LoadedInstructionFile): string {
  const scope = scopeForDisplayPath(file.displayPath)
  return [
    `Additional instructions from: ${file.displayPath}`,
    '',
    `These instructions apply to work under \`${scope}\`. Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.`,
    '',
    file.content,
  ].join('\n')
}

function baselineRenderStyle(
  files: LoadedInstructionFile[],
  replacePreviousBaseline: boolean | undefined,
  overviewMaxBytes: number,
): RenderStyle {
  const style: RenderStyle = {
    intro: WORKSPACE_CONTEXT_INTRO,
    section: file => baselineSectionText(file, overviewMaxBytes),
  }
  if (replacePreviousBaseline !== true) return style
  return {
    ...style,
    intro: files.length === 0
      ? EMPTY_REPLACEMENT_WORKSPACE_CONTEXT_INTRO
      : REPLACEMENT_WORKSPACE_CONTEXT_INTRO,
  }
}

function changedSectionText(item: ChangeRenderItem, overviewMaxBytes: number): string {
  const { change, file } = item
  if (file.kind === 'overview') {
    if (change.action === 'set') return overviewSectionText(file, overviewMaxBytes)
    if (change.action === 'remove') {
      return `Project overview removed: ${change.path}\n\nThe previously loaded project overview from this file no longer applies.`
    }
    return [
      `Updated project overview from: ${change.path}`,
      '',
      `This file changed after it was loaded. Use the following content instead of the previously loaded project overview from this file. ${OVERVIEW_INTRO}`,
      '',
      overviewExcerpt(file.content, overviewMaxBytes).text,
    ].join('\n')
  }
  if (change.action === 'set') return additionalSectionText(file)
  if (change.action === 'remove') {
    return `Instructions removed: ${change.path}\n\nThe previously loaded instructions from this file no longer apply.`
  }
  return [
    `Updated instructions from: ${change.path}`,
    '',
    'This file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.',
    '',
    file.content,
  ].join('\n')
}

/**
 * 渲染一批对账结果，只保留能放下的转换。
 * @param items - 有序的状态转换与当前文件内容。
 * @param options - 批次字节预算与项目简介头部上限。
 * @returns 有界的提示词文本，以及确实被它表示的转换。
 */
export function renderInstructionChanges(
  items: ChangeRenderItem[],
  options: { maxBytes: number; overviewMaxBytes?: number },
): { text: string; changes: AgentInstructionChange[] } {
  const overviewMaxBytes = options.overviewMaxBytes ?? DEFAULT_OVERVIEW_MAX_BYTES
  const byAbsolutePath = new Map(items.map(item => [item.file.absolutePath, item]))
  const style: RenderStyle = {
    intro: '',
    section(file) {
      const item = byAbsolutePath.get(file.absolutePath)
      /* v8 ignore next -- the renderer receives exactly the files used to construct this map. */
      return item === undefined ? '' : changedSectionText({ ...item, file }, overviewMaxBytes)
    },
  }
  const rendered = renderInstructionContext(items.map(item => item.file), options.maxBytes, style)
  const represented = new Set(rendered.represented.map(file => file.absolutePath))
  return {
    text: rendered.text,
    changes: items
      .filter(item => represented.has(item.file.absolutePath))
      .map(item => item.change),
  }
}

function markerText(maxBytes: number, omitted: InstructionFile[], truncated: TruncatedInstruction[]): string {
  if (omitted.length === 0 && truncated.length === 0) return ''
  const parts: string[] = []
  if (omitted.length > 0) {
    parts.push(`omitted ${omitted.map(file => file.displayPath).join(', ')}`)
  }
  if (truncated.length > 0) {
    parts.push(`truncated ${truncated.map(item => `${item.displayPath} from ${item.originalBytes} to ${item.includedBytes} bytes`).join(', ')}`)
  }
  return `Workspace instruction budget ${maxBytes} bytes: ${parts.join('; ')}`
}

function buildInstructionText(
  files: LoadedInstructionFile[],
  maxBytes: number,
  omitted: InstructionFile[],
  truncated: TruncatedInstruction[],
  style: RenderStyle,
): string {
  const marker = markerText(maxBytes, omitted, truncated)
  const body = [marker, style.intro, ...files.map(file => style.section(file))].filter(block => block.length > 0)
  // Caller-owned framing: the plugin bakes the complete `<system-reminder>`
  // frame into the message content. The session surface projects context
  // verbatim and does not wrap it, so any framing must live here in the
  // producer's content (the pattern a future `meta`-driven renderer would
  // generalize — see the deferred note in
  // ).
  return [SYSTEM_REMINDER_OPEN, escapeInstructionFrameBody(body.join('\n\n')), SYSTEM_REMINDER_CLOSE].join('\n')
}

function withTruncatedContent(file: LoadedInstructionFile, includedBytes: number): LoadedInstructionFile {
  return { ...file, content: truncateUtf8(file.content, includedBytes) }
}

function truncateToFit(
  file: LoadedInstructionFile,
  includedFiles: LoadedInstructionFile[],
  maxBytes: number,
  omitted: InstructionFile[],
  style: RenderStyle,
): LoadedInstructionFile {
  const originalBytes = byteLength(file.content)
  let low = 0
  let high = originalBytes
  let best = withTruncatedContent(file, 0)
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = withTruncatedContent(file, mid)
    const truncated = [{ displayPath: file.displayPath, originalBytes, includedBytes: byteLength(candidate.content) }]
    const text = buildInstructionText([...includedFiles, candidate], maxBytes, omitted, truncated, style)
    if (byteLength(text) <= maxBytes) {
      best = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}

function renderInstructionContext(
  files: LoadedInstructionFile[],
  maxBytes: number,
  style: RenderStyle,
): RenderedInstructionContext {
  if (maxBytes <= 0 || !Number.isFinite(maxBytes)) {
    return { text: '', omitted: files, truncated: [], represented: [] }
  }

  const fullText = buildInstructionText(files, maxBytes, [], [], style)
  if (byteLength(fullText) <= maxBytes) {
    return { text: fullText, omitted: [], truncated: [], represented: files }
  }

  for (let start = 1; start < files.length; start += 1) {
    const included = files.slice(start)
    const omitted = files.slice(0, start).map(file => ({ absolutePath: file.absolutePath, displayPath: file.displayPath, kind: file.kind }))
    const suffixText = buildInstructionText(included, maxBytes, omitted, [], style)
    if (byteLength(suffixText) <= maxBytes) return { text: suffixText, omitted, truncated: [], represented: included }
  }

  const mostSpecific = files.at(-1)
  /* v8 ignore next -- callers only reach this after a non-empty fullText was built. */
  if (mostSpecific === undefined) return { text: '', omitted: [], truncated: [], represented: [] }
  const omitted = files.slice(0, -1).map(file => ({ absolutePath: file.absolutePath, displayPath: file.displayPath, kind: file.kind }))
  const originalBytes = byteLength(mostSpecific.content)

  for (const candidateStyle of [style, { ...style, intro: COMPACT_WORKSPACE_CONTEXT_INTRO }]) {
    const truncatedFile = truncateToFit(mostSpecific, [], maxBytes, omitted, candidateStyle)
    const includedBytes = byteLength(truncatedFile.content)
    const truncated = [{
      displayPath: mostSpecific.displayPath,
      originalBytes,
      includedBytes,
    }]
    const text = buildInstructionText([truncatedFile], maxBytes, omitted, truncated, candidateStyle)
    if (byteLength(text) <= maxBytes) {
      const represented = includedBytes > 0 || originalBytes === 0 ? [mostSpecific] : []
      return { text, omitted, truncated, represented }
    }
  }

  const truncated = [{
    displayPath: mostSpecific.displayPath,
    originalBytes,
    includedBytes: 0,
  }]
  const compactNotice = escapeInstructionFrameBody(markerText(maxBytes, omitted, truncated))
  const compactWithHeading = escapeInstructionFrameBody(
    [compactNotice, style.section(withTruncatedContent(mostSpecific, 0))].join('\n\n'),
  )
  if (byteLength(compactWithHeading) <= maxBytes) {
    const represented = originalBytes === 0 ? [mostSpecific] : []
    return { text: compactWithHeading, omitted, truncated, represented }
  }
  const text = byteLength(compactNotice) <= maxBytes ? compactNotice : truncateUtf8(compactNotice, maxBytes)
  return { text, omitted, truncated, represented: [] }
}

/**
 * Render a baseline together with the exact source files semantically represented in it.
 * @param files - loaded files ordered from broadest to most specific.
 * @param options - rendering byte budget and whether this baseline supersedes a visible predecessor.
 * @returns bounded public rendering plus files with surviving content, including genuinely empty files.
 * @internal
 */
export function renderWorkspaceInstructionSet(
  files: LoadedInstructionFile[],
  options: WorkspaceRenderOptions,
): { rendered: RenderedWorkspaceContext; included: LoadedInstructionFile[] } {
  const style = baselineRenderStyle(
    files,
    options.replacePreviousBaseline,
    options.overviewMaxBytes ?? DEFAULT_OVERVIEW_MAX_BYTES,
  )
  const { represented, ...rendered } = renderInstructionContext(files, options.maxBytes, style)
  return { rendered, included: represented }
}

/**
 * Render the baseline instruction chain with deterministic precedence budgeting.
 * @param files - loaded files ordered from broadest to most specific.
 * @param options - rendering byte budget and whether this baseline supersedes a visible predecessor.
 * @returns bounded baseline prompt text and budget diagnostics.
 */
export function renderWorkspaceContext(
  files: LoadedInstructionFile[],
  options: WorkspaceRenderOptions,
): RenderedWorkspaceContext {
  return renderWorkspaceInstructionSet(files, options).rendered
}
