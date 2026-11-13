/**
 * Pure row-model derivation for tool summary rows: variant classification,
 * one-line summary, expanded-body text, and flattened result output from the
 * frozen call slice. Input material comes from the call ARGUMENTS; output and
 * error material from the settled result node. A call whose render intent is
 * a terminal card gets its expanded body from the views instead, through
 * `terminalCardModel` in terminal-card-model.ts.
 */
// The block union's defining home is runtime (fold-product types); this
// contract only forwards it (type-definition authority stays with the layer
// that produces the values).
import type { ImageAttachmentRef } from 'coding-attachment'
import { abbreviateHomePath } from 'coding-client-runtime/client'
import type { ToolCallBlock, ToolResultNode } from 'coding-client-runtime/client'
import { imageAttachmentsIn } from './tool-result-images.ts'
import { toolDisplayDescription } from 'coding-tools/display-description'

export type { ToolCallBlock } from 'coding-client-runtime/client'

/** Tool-call row variants selected by the generic atomic renderer. */
export type ToolRowVariant = 'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'others'

/** Row state semantic; colors self-supplied via StateDot (design gives none). */
export type ToolRowState = 'running' | 'ok' | 'error' | 'stopped'

/** Figma row titles per variant (design literals, not translatable copy). */
export const VARIANT_TITLES: Record<ToolRowVariant, string> = {
  search: 'Search', read: 'Read', bash: 'Bash',
  write: 'Write', edit: 'Edit', code: 'Code', others: 'Tool call',
}

/**
 * Known tool name -> variant.
 *
 * `cordis_define` is deliberately absent: ui-cordis registers a keyed
 * `tool.call.toolview` entry for it, and a keyed hit REPLACES the generic row
 * (this table is only reached through GenericToolCard, the dispatch fallback in
 * ToolCallTree). An entry here would be unreachable, and a second title for the
 * same call would be a second answer to a question the card already owns.
 */
const TOOL_VARIANTS: Record<string, ToolRowVariant> = {
  bash: 'bash',
  exec_command: 'bash',
  // PowerShell 与 Bash 共用命令行视觉类别，保留各自标题。
  pwsh: 'bash',
  read: 'read',
  web_fetch: 'read',
  web_search: 'search',
  grep: 'search',
  glob: 'search',
  write: 'write',
  edit: 'edit',
  apply_patch: 'edit',
  str_replace_editor: 'edit',
  read_image: 'read',
  run_code: 'code',
  cordis_package_inspect: 'read',
  cordis_runtime_inspect: 'read',
  // The three run-control verbs take one package id and produce a receipt, so
  // the generic row is the decided intent, not an unclassified default: there is
  // no program to show (that is `cordis_define`'s card) and no file to open. The
  // id lands in the summary slot, and the titles below name the act.
  cordis_run: 'others',
  cordis_stop: 'others',
  cordis_undefine: 'others',
}

/** 通用行的静态动作标题，不从工具参数或模型返回的标题拼接。 */
const TOOL_TITLES: Record<string, string> = {
  apply_patch: 'Apply patch',
  str_replace_editor: 'Edit file',
  read_image: 'Read image',
  write_stdin: 'Background session',
  update_plan: 'Update plan',
  todo_write: 'Update plan',
  skill: 'Load skill',
  skill_read: 'Read skill',
  context_compact: 'Compact context',
  memory_list: 'List memory',
  memory_read: 'Read memory',
  memory_save: 'Save memory',
  memory_update: 'Update memory',
  memory_delete: 'Delete memory',
  list_subagent_models: 'Browse models',
  spawn_agent: 'Delegate task',
  subagent: 'Delegate task',
  subagent_fork: 'Delegate task',
  followup_task: 'Send follow-up',
  send_message: 'Message agent',
  list_agents: 'List agents',
  wait_agent: 'Wait for agents',
  interrupt_agent: 'Stop agent',
  report: 'Report result',
  create_goal: 'Create goal',
  get_goal: 'Read goal',
  update_goal: 'Update goal',
  job_output: 'Read job output',
  job_list: 'List jobs',
  job_kill: 'Stop job',
  workflow: 'Run workflow',
  ralph: 'Continue task',
  validate_gen_ui: '校验UI语法',
  browser_close: 'Close browser',
  browser_screenshot: 'Capture screenshot',
  browser_snapshot: 'View page',
  browser_auth_flush: 'Save browser sign-in',
  browser_doctor: 'Check browser',
  browser_status: 'Browser status',
  computer_list_apps: 'List apps',
  cordis_inspect_list: 'Browse plugin capabilities',
  terminal_list: 'List terminals',
  canvas_state: 'View canvas',
  ppt_templates: 'Browse presentation templates',
  schedule_list: 'List reminders',
  cordis_package_inspect: 'Inspect',
  cordis_runtime_inspect: 'Inspect',
  cordis_run: 'Run Cordis Plugin',
  cordis_stop: 'Stop Cordis Plugin',
  cordis_undefine: 'Remove Cordis Plugin',
  pwsh: 'Pwsh',
}

/** 仅为已知前缀指定动作类别；外部工具不把 wire 名当作界面文案。 */
function titleFor(toolName: string): string | undefined {
  return (Object.hasOwn(TOOL_TITLES, toolName) ? TOOL_TITLES[toolName] : undefined)
    ?? (toolName.startsWith('browser_') ? 'Browser'
      : toolName.startsWith('ppt_') ? 'Presentation'
        : toolName.startsWith('computer_') ? 'Computer'
          : toolName.startsWith('schedule_') ? 'Schedule'
            : toolName.startsWith('mcp__') ? 'External tool'
              : undefined)
}

/**
 * Classify a tool name into its row variant.
 * @param toolName - wire tool name.
 * @returns matching variant, others when unknown.
 */
export function classifyTool(toolName: string): ToolRowVariant {
  return (Object.hasOwn(TOOL_VARIANTS, toolName) ? TOOL_VARIANTS[toolName] : undefined) ?? 'others'
}

/** Everything ToolRow needs, derived once from the frozen slice. */
export interface ToolRowModel {
  variant: ToolRowVariant
  title: string
  summary: string
  /** 模型逐次填写的展示说明；与缺省的业务摘要区别开以供卡片确定优先级。 */
  displayDescription: string | undefined
  /**
   * Filesystem path from args (`path` / `file_path`) when the row is a file
   * tool; absent for URL reads and non-file tools. The chat view resolves
   * relative values against the session cwd before opening.
   */
  filePath: string | undefined
  /** Expanded-body input text (pretty args); null = no input section. */
  body: string | null
  /** Flattened result text ({@link resultText}); null while running or when the result carries no text. */
  output: string | null
  /** Images returned by the settled tool result. */
  images: readonly ImageAttachmentRef[]
  /** First line of the result text on an error row; null for every other state. */
  errorSummary: string | null
  state: ToolRowState
}

/**
 * Flatten a settled result's content blocks to display text: text blocks
 * verbatim, other block shapes as pretty JSON. Empty content on a failed call
 * falls back to the structured error's `name: code` line.
 * @param node - the settled result node.
 * @returns the flattened result text (may be empty).
 */
export function resultText(node: ToolResultNode): string {
  const parts: string[] = []
  for (const block of node.content) {
    if (block.type === 'text') parts.push(block.text)
    else parts.push(JSON.stringify(block, null, 2))
  }
  if (parts.length === 0 && node.error !== undefined) {
    parts.push(`${node.error.name}: ${node.error.code}`)
  }
  return parts.join('\n')
}

function parseArgs(argsRaw: string): unknown {
  try {
    return JSON.parse(argsRaw)
  } catch {
    // Non-JSON args (mid-stream truncation): summary/body fall back to the raw string.
    return undefined
  }
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = args[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return undefined
}

/** Summary key preference per variant (args-derived; result-derived summaries are a ledger item). */
const SUMMARY_KEYS: Record<ToolRowVariant, readonly string[]> = {
  bash: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  search: ['query', 'pattern', 'url'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  code: ['description'],
  others: [],
}

/** 委派和技能只显示短描述，不把完整任务或工具输入露出在折叠行。 */
const TOOL_SUMMARY_KEYS: Record<string, readonly string[]> = {
  spawn_agent: ['description'],
  subagent: ['description'],
  subagent_fork: ['description'],
  skill: ['name'],
  skill_read: ['name'],
}

/**
 * 去掉工作区根前缀（仅用于展示）。
 * @param text - 待缩短的路径。
 * @param cwd - 会话工作区根；缺省或空字符串时原样返回。
 * @returns 相对工作区根的路径；不在工作区下时原样返回。
 */
export function relativizeToCwd(text: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return text
  const root = cwd.replace(/[/\\]+$/, '')
  if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`)) return text.slice(root.length + 1)
  return text
}

/**
 * 内置技能资源路径的稳定前缀标记，与宿主 `coding-skill` 的 `INTERNAL_SKILL_ROOT` 同值。
 * 宿主把它展开成技能包的真实安装目录，因此真实路径既不稳定、也不该出现在界面上：
 * 工具参数与读取结果只带这个前缀，展示时换成可读标签。
 */
const INTERNAL_SKILL_ROOT = '${INTERNAL_SKILL_DIR}'

/**
 * 把内置技能资源路径的前缀换成可读标签，其余文本原样返回。
 * @param text - 路径或摘要文本。
 * @returns 展示用文本。
 */
export function labelSkillResourcePath(text: string): string {
  if (!text.includes(INTERNAL_SKILL_ROOT)) return text
  return text.split(`${INTERNAL_SKILL_ROOT}/`).join('内置 Skill ')
}

function deriveSummary(toolName: string, variant: ToolRowVariant, argsRaw: string): string {
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return ''
  const args = parsed as Record<string, unknown>
  if (variant === 'search' && Array.isArray(args.queries)) {
    const queries = args.queries.filter((query): query is string => typeof query === 'string' && query !== '')
    if (queries.length > 0) return queries.map(firstLine).join(', ')
  }
  const keys = Object.hasOwn(TOOL_SUMMARY_KEYS, toolName) ? TOOL_SUMMARY_KEYS[toolName] : undefined
  const picked = pickString(args, keys ?? SUMMARY_KEYS[variant])
  if (picked !== undefined) return firstLine(picked)
  if (toolName.startsWith('cordis_')) {
    const legacy = pickString(args, ['id', 'what', 'name'])
    if (legacy !== undefined) return firstLine(legacy)
  }
  return ''
}

/** Path keys only — never `url` (web_fetch lands on the read variant). */
const FILE_PATH_KEYS = ['path', 'file_path'] as const

/** File-tool variants whose summary may be an openable workspace path. */
const FILE_PATH_VARIANTS: ReadonlySet<ToolRowVariant> = new Set(['read', 'write', 'edit'])

function deriveFilePath(variant: ToolRowVariant, argsRaw: string): string | undefined {
  if (!FILE_PATH_VARIANTS.has(variant)) return undefined
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const picked = pickString(parsed as Record<string, unknown>, FILE_PATH_KEYS)
  return picked === undefined ? undefined : firstLine(picked)
}

function deriveBody(variant: ToolRowVariant, argsRaw: string): string | null {
  if (argsRaw === '') return null
  const parsed = parseArgs(argsRaw)
  if (parsed === undefined) return argsRaw
  // The code row's expanded body IS the program (monospace via the row's
  // variant styling), not the args JSON envelope around it.
  if (variant === 'code' && typeof parsed === 'object' && parsed !== null) {
    const code = (parsed as Record<string, unknown>).code
    if (typeof code === 'string' && code !== '') return code
  }
  return JSON.stringify(parsed, null, 2)
}

/**
 * Derive the full row model from a frozen call slice.
 * @param toolName - wire tool name (dispatch-supplied; survives windowless results).
 * @param block - RunningToolCall or ToolResultNode off the snapshot caches.
 * @param cwd - session workspace root; workspace-rooted path summaries display relative to it.
 * @param home - host account home; a leftover POSIX home path displays as `~`.
 * @returns the row model.
 */
export function toolRowModel(toolName: string, block: ToolCallBlock, cwd?: string, home?: string): ToolRowModel {
  const variant = classifyTool(toolName)
  const done = 'kind' in block
  const argsRaw = (done ? block.call?.argsRaw : block.argsRaw) ?? ''
  const state: ToolRowState = !done ? 'running'
    : block.error?.code === 'interrupted' ? 'stopped'
      : block.isError ? 'error' : 'ok'
  const displayDescription = toolDisplayDescription(parseArgs(argsRaw), toolName)
  const legacy = argsRaw === '' ? '' : abbreviateHomePath(
    relativizeToCwd(labelSkillResourcePath(deriveSummary(toolName, variant, argsRaw)), cwd), home,
  )
  const toolTitle = titleFor(toolName)
  const summary = displayDescription ?? legacy
  // 空摘要只显示静态动作；原始参数仍保留在展开区，不能落到标题上。
  const output = done ? (resultText(block) || null) : null
  const errorSummary = state === 'error' && output !== null ? firstLine(output) : null
  return {
    variant,
    title: toolTitle ?? VARIANT_TITLES[variant],
    summary,
    displayDescription,
    filePath: deriveFilePath(variant, argsRaw),
    body: deriveBody(variant, argsRaw),
    output,
    images: done ? imageAttachmentsIn(block.content) : [],
    errorSummary,
    state,
  }
}
