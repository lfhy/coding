/**
 * PPT 创作模式的模型工具：模型用 `ppt_create` / `ppt_open` 选工程，用 `ppt_edit` 迭代
 * 页面与元素，用 `ppt_export` 出成品。存储、版本与导出都在 `coding-ppt-workbench`，
 * 这里只做参数校验、会话解析与结果投影。
 * @module coding-tool-ppt
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from 'coding-agent'
import { defineTool } from 'coding-tools'
import { outlineText, reviewOutline } from './ai-review.ts'
import type { GenericCallView, ObjectValueSchemaSpec } from 'coding-tools'
import type { JsonValue } from 'coding-session'

export const name = 'tool-ppt'
export const inject = ['tools', 'llm']

/**
 * 工具需要的工程服务面。
 *
 * 这里刻意用本地接口而不是 import 工程包：宿主平面（含本包）与浏览器平面是两份
 * 独立的类型程序，模型工具只依赖「服务名字 + 方法签名」这一层契约，工程包的实现
 * 归 `coding-ppt-workbench`。方法语义见该包 README 与 `src/index.ts`。
 */
interface PptProjectsFace {
  create: (sessionId: string, options: {
    title: string
    dir?: string
    size?: '16:9' | '4:3'
    theme?: 'ink' | 'paper' | 'ocean' | 'forest'
  }) => Promise<PptSnapshotFace>
  open: (sessionId: string, dir: string) => Promise<PptSnapshotFace>
  read: (sessionId: string, dir?: string) => Promise<PptSnapshotFace>
  edit: (sessionId: string, dir: string | undefined, ops: unknown, baseRevision?: number) => Promise<PptSnapshotFace>
  check: (sessionId: string, dir?: string) => Promise<PptCheckFace>
  import: (sessionId: string, source: string, options: { dir?: string; title?: string }) => Promise<{
    snapshot: PptSnapshotFace
    dropped: readonly string[]
  }>
  undo: (sessionId: string, dir: string | undefined, steps: number) => Promise<PptSnapshotFace>
  redo: (sessionId: string, dir: string | undefined, steps: number) => Promise<PptSnapshotFace>
  export: (
    sessionId: string,
    dir?: string,
    options?: { skipCheck?: boolean },
  ) => Promise<{
    path: string
    bytes: number
    revision: number
    fonts: readonly { readonly family: string; readonly readonly: boolean; readonly subset: boolean }[]
    skippedFonts: readonly { readonly family: string; readonly reason: string }[]
  }>
}

/** 质检结果。 */
interface PptCheckFace {
  readonly ok: boolean
  readonly issues: readonly {
    readonly severity: 'error' | 'warning'
    readonly code: string
    readonly page: string
    readonly pageName: string
    readonly element?: string
    readonly message: string
  }[]
}

/** 工程快照里工具用到的字段。 */
interface PptSnapshotFace {
  readonly dir: string
  readonly title: string
  readonly revision: number
  readonly pages: number
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly deck: unknown
}

/**
 * 读取工程服务；未装配 PPT 工程包时给出明确诊断而不是 undefined 调用。
 * @param ctx - 宿主上下文。
 * @returns 工程服务面。
 * @throws Error - 当前部署没有挂载 `coding-ppt-workbench` 时。
 */
function projectsOf(ctx: Context): PptProjectsFace {
  const service = ctx.get('pptProjects') as unknown as PptProjectsFace | undefined
  if (service === undefined) throw new Error('PPT project service is not mounted in this deployment')
  return service
}

const THEMES = ['ink', 'paper', 'ocean', 'forest'] as const
const SIZES = ['16:9', '4:3'] as const

/** 工具结果里的工程摘要；不携带整份页面内容。 */
interface PptSummaryValue {
  dir: string
  title: string
  revision: number
  pages: number
  canUndo: boolean
  canRedo: boolean
}

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dir: { type: 'string', required: true },
    title: { type: 'string', required: true },
    revision: { type: 'number', required: true },
    pages: { type: 'number', required: true },
    canUndo: { type: 'boolean', required: true },
    canRedo: { type: 'boolean', required: true },
  },
} as const

function summaryOf(snapshot: PptSnapshotFace): PptSummaryValue {
  return {
    dir: snapshot.dir,
    title: snapshot.title,
    revision: snapshot.revision,
    pages: snapshot.pages,
    canUndo: snapshot.canUndo,
    canRedo: snapshot.canRedo,
  }
}

/**
 * 同一份输出声明：把结果对象序列化成一行 JSON 文本。
 * `schema` 是工具作者 DSL，不是原始 JSON Schema，requiredness 写在属性上。
 * @param schema - 结果对象的 DSL 声明。
 * @returns 工具的 output 字段。
 */
function outputOf<const S extends ObjectValueSchemaSpec>(schema: S): {
  schema: S
  render: (args: unknown, value: unknown) => { type: 'text'; text: string }[]
} {
  return {
    schema,
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  }
}

function present(title: string, kind: 'read' | 'other', rawInput?: unknown): GenericCallView {
  return { card: 'generic', title, kind, ...rawInput === undefined ? {} : { rawInput } }
}

/**
 * 取本次调用所属会话的身份；工具在没有会话的宿主里被直接调用时明确失败。
 * @param exec - 工具执行上下文。
 * @returns 会话 id。
 * @throws Error - 调用没有会话归属时。
 */
function sessionOf(exec: { agent?: { session?: { header?: { id?: string } } } }): string {
  const id = exec.agent?.session?.header?.id
  if (id === undefined || id === '') throw new Error('ppt tools require a session workspace')
  return id
}

/** AI 审阅只读取这几项，用结构类型收窄服务返回的 unknown 内容。 */
interface DeckDigestSource {
  readonly pages: readonly {
    readonly name: string
    readonly transition: string
    readonly elements: readonly { readonly kind: string; readonly text?: { readonly content: string } }[]
  }[]
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function deckSize(deck: unknown): string {
  const size = recordOf(deck)['size']
  return typeof size === 'string' ? size : '16:9'
}

function deckTheme(deck: unknown): string {
  const theme = recordOf(deck)['theme']
  return typeof theme === 'string' ? theme : 'ink'
}

/**
 * 把工程压成 AI 审阅需要的大纲摘要。
 * @param deck - 工程内容。
 * @returns 每页的摘要。
 */
function digestOf(deck: { pages: readonly {
  name: string
  transition: string
  elements: readonly { kind: string; text?: { content: string } }[]
}[] }): {
  name: string
  texts: string[]
  shapes: number
  tables: number
  charts: number
  images: number
  transition: string
}[] {
  return deck.pages.map(page => ({
    name: page.name,
    transition: page.transition,
    texts: page.elements.flatMap(element => (
      element.kind === 'text' && element.text !== undefined ? [element.text.content] : []
    )),
    shapes: page.elements.filter(element => element.kind === 'rect' || element.kind === 'ellipse').length,
    tables: page.elements.filter(element => element.kind === 'table').length,
    charts: page.elements.filter(element => element.kind === 'chart').length,
    images: page.elements.filter(element => element.kind === 'image').length,
  }))
}

const OPS_HELP = 'Array of edit operations, applied atomically in order. Each item is an object with "op":'
  + '\n- {"op":"add_page","at":<index>,"name":<string>,"background":"#rrggbb"|null} — insert a blank page;'
  + '\n- {"op":"remove_page","page":<pageId>} — delete a page (never the last one);'
  + '\n- {"op":"move_page","page":<pageId>,"to":<index>} — reorder;'
  + '\n- {"op":"update_page","page":<pageId>,"name":<string>,"background":"#rrggbb"|null,"transition":"none"|"fade"|"push"};'
  + '\n- {"op":"add_element","page":<pageId>,"element":{...}} — element kinds:'
  + ' text {id?,kind:"text",x,y,w,h,text:{content,size,color,bold,align:"left"|"center"|"right",valign:"top"|"middle"|"bottom"}},'
  + ' rect|ellipse {id?,kind,x,y,w,h,fill}, line {id?,kind:"line",x,y,w,h,color,width},'
  + ' image {id?,kind:"image",x,y,w,h,source:"media/<file>",fit:"cover"|"contain"},'
  + ' table {id?,kind:"table",x,y,w,h,rows,columns,cells:[[{content}]],header?,headerFill?,borderColor?,text?:{size,color,bold,align}};'
  + '\n- {"op":"update_element","page":<pageId>,"element":<elementId>,"frame":{x?,y?,w?,h?},"text":{...},"fill":..,"color":..,"width":..,"source":"media/<file>","fit":..,"cells":[[{content}]]};'
  + '\n- {"op":"remove_element","page":<pageId>,"element":<elementId>};'
  + '\n- {"op":"reorder_element","page":<pageId>,"element":<elementId>,"to":"front"|"back"|"forward"|"backward"} — z-order;'
  + '\n- {"op":"duplicate_element","page":<pageId>,"element":<elementId>} — copy offset by 24px;'
  + '\n- {"op":"update_deck","title":<string>,"size":"16:9"|"4:3","theme":"ink"|"paper"|"ocean"|"forest"}.'
  + '\nCanvas coordinates are base pixels: 1280x720 for 16:9 and 960x720 for 4:3, origin at the top-left.'
  + ' One page holds at most 200 elements; a deck holds at most 200 pages.'

/**
 * 注册七个 PPT 工具。
 * @param ctx - Cordis 上下文，需提供 `tools` 与 `pptProjects`。
 */
export function apply(ctx: Context): void {
  const projects = (): PptProjectsFace => projectsOf(ctx)

  ctx.tools.register(defineTool({
    name: 'ppt_create',
    description: 'Create a new presentation project (one cover page) in the session workspace and focus it in the '
      + 'PPT workbench on the right. Use ppt_edit afterwards to fill pages. Projects live under ppt/<slug> and '
      + 'export to .pptx.',
    parameters: {
      title: { type: 'string', required: true, description: 'Deck title, also used for the directory name and the exported file name.' },
      dir: { type: 'string', description: 'Workspace-relative project directory; omit to derive it from the title.' },
      size: { type: 'string', enum: SIZES, description: 'Canvas size; 16:9 by default.' },
      theme: { type: 'string', enum: THEMES, description: 'Colour theme; ink by default.' },
    },
    output: outputOf({
      type: 'object',
      additionalProperties: false,
      properties: { project: SUMMARY_SCHEMA },
    } as const),
    async execute(args, exec) {
      const snapshot = await projects().create(sessionOf(exec), {
        title: args.title,
        ...args.dir === undefined ? {} : { dir: args.dir },
        ...args.size === undefined ? {} : { size: args.size },
        ...args.theme === undefined ? {} : { theme: args.theme },
      })
      return { project: summaryOf(snapshot) }
    },
    presentCall: args => present('Create deck', 'other', args.title),
  }))

  ctx.tools.register(defineTool({
    name: 'ppt_open',
    description: 'Open an existing presentation project in the PPT workbench and return its summary. '
      + 'Do this before editing a deck you did not create in this session.',
    parameters: {
      dir: { type: 'string', required: true, description: 'Workspace-relative project directory.' },
    },
    output: outputOf({
      type: 'object',
      additionalProperties: false,
      properties: { project: SUMMARY_SCHEMA },
    } as const),
    async execute(args, exec) {
      return { project: summaryOf(await projects().open(sessionOf(exec), args.dir)) }
    },
    presentCall: args => present('Open deck', 'read', args.dir),
  }))

  ctx.tools.register(defineTool({
    name: 'ppt_read',
    description: 'Read the full page and element data of a project so you can plan edits. '
      + 'Prefer this over guessing ids: every edit names the page and element ids it touches.',
    parameters: {
      dir: { type: 'string', description: 'Workspace-relative project directory; omit for the open project.' },
    },
    output: outputOf({
      type: 'object',
      additionalProperties: false,
      properties: { project: SUMMARY_SCHEMA, deck: { type: 'json', required: true } },
    } as const),
    async execute(args, exec) {
      const snapshot = await projects().read(sessionOf(exec), args.dir)
      // 工程是纯 JSON 数据，工具结果的 json 通道要求同样的无类实例结构。
      return { project: summaryOf(snapshot), deck: snapshot.deck as JsonValue }
    },
    presentCall: args => present('Read deck', 'read', args.dir),
  }))

  ctx.tools.register(defineTool({
    name: 'ppt_edit',
    description: 'Apply atomic edit operations to a project. Pass base_revision from your last read or edit to '
      + `reject concurrent changes instead of overwriting them.\n${OPS_HELP}`,
    parameters: {
      ops: { type: 'json', required: true, description: 'Edit operations, applied in order or not at all.' },
      dir: { type: 'string', description: 'Workspace-relative project directory; omit for the open project.' },
      base_revision: { type: 'number', description: 'Revision the edit was planned against.' },
    },
    output: outputOf({
      type: 'object',
      additionalProperties: false,
      properties: { project: SUMMARY_SCHEMA },
    } as const),
    async execute(args, exec) {
      const snapshot = await projects().edit(sessionOf(exec), args.dir, args.ops, args.base_revision)
      return { project: summaryOf(snapshot) }
    },
    presentCall: args => present('Edit deck', 'other', args.ops),
  }))

  ctx.tools.register(defineTool({
    name: 'ppt_undo',
    description: 'Step the presentation back through its edit history. Each edit call is one step unless the '
      + 'history has already been walked back; undo never crosses into an unrelated project.',
    parameters: {
      dir: { type: 'string', description: 'Workspace-relative project directory; omit for the open project.' },
      steps: { type: 'number', description: 'How many steps to go back (1–20, default 1).' },
    },
    output: outputOf({
      type: 'object',
      additionalProperties: false,
      properties: { project: SUMMARY_SCHEMA },
    } as const),
    async execute(args, exec) {
      const snapshot = await projects().undo(sessionOf(exec), args.dir, args.steps ?? 1)
      return { project: summaryOf(snapshot) }
    },
    presentCall: args => present('Undo deck edit', 'other', args.steps),
  }))

  ctx.tools.register(defineTool({
    name: 'ppt_redo',
    description: 'Step the presentation forward again after ppt_undo.',
    parameters: {
      dir: { type: 'string', description: 'Workspace-relative project directory; omit for the open project.' },
      steps: { type: 'number', description: 'How many steps to go forward (1–20, default 1).' },
    },
    output: outputOf({
      type: 'object',
      additionalProperties: false,
      properties: { project: SUMMARY_SCHEMA },
    } as const),
    async execute(args, exec) {
      const snapshot = await projects().redo(sessionOf(exec), args.dir, args.steps ?? 1)
      return { project: summaryOf(snapshot) }
    },
    presentCall: args => present('Redo deck edit', 'other', args.steps),
  }))

  ctx.tools.register(defineTool({
    name: 'ppt_check',
    description: 'Run the deterministic layout checks before exporting: elements outside the canvas, zero-size elements, '
      + 'estimated text overflow and low text/background contrast. Errors block ppt_export; warnings are advice.',
    parameters: {
      dir: { type: 'string', description: 'Workspace-relative project directory; omit for the open project.' },
      ai: { type: 'boolean', description: 'Ask the session model for layout advice on top of the rule checks.' },
    },
    output: outputOf({
      type: 'object',
      additionalProperties: false,
      properties: {
        ok: { type: 'boolean', required: true },
        ai: {
          type: 'object',
          additionalProperties: false,
          properties: {
            performed: { type: 'boolean', required: true },
            suggestions: { type: 'string' },
            reason: { type: 'string' },
          },
        },
        issues: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              severity: { type: 'string', required: true, enum: ['error', 'warning'] },
              code: { type: 'string', required: true },
              page: { type: 'string', required: true },
              pageName: { type: 'string', required: true },
              element: { type: 'string' },
              message: { type: 'string', required: true },
            },
          },
        },
      },
    } as const),
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const result = await projects().check(sessionId, args.dir)
      const issues = result.issues.map(issue => ({ ...issue }))
      if (args.ai !== true) return { ok: result.ok, issues }
      const snapshot = await projects().read(sessionId, args.dir)
      const agent = exec.agent
      if (agent === undefined) {
        return { ok: result.ok, issues, ai: { performed: false, reason: '这次调用没有会话模型可用' } }
      }
      const outline = outlineText(
        snapshot.title,
        deckSize(snapshot.deck),
        deckTheme(snapshot.deck),
        digestOf(snapshot.deck as DeckDigestSource),
      )
      try {
        const suggestions = await reviewOutline(ctx, agent, outline, exec.signal)
        return { ok: result.ok, issues, ai: { performed: true, suggestions } }
      } catch (reason) {
        return {
          ok: result.ok,
          issues,
          ai: { performed: false, reason: reason instanceof Error ? reason.message : String(reason) },
        }
      }
    },
    presentCall: args => present('Check deck', 'read', args.dir),
  }))

  ctx.tools.register(defineTool({
    name: 'ppt_import',
    description: 'Import an existing .pptx from the workspace into a project so the deck can be edited here. '
      + 'Text, autoshapes, lines, pictures and tables become editable elements; charts, SmartArt and animations '
      + 'cannot be represented and are reported back in "dropped".',
    parameters: {
      source: { type: 'string', required: true, description: 'Workspace-relative path of the .pptx file.' },
      dir: { type: 'string', description: 'Workspace-relative project directory to create; defaults to the file name.' },
      title: { type: 'string', description: 'Deck title; defaults to the file name.' },
    },
    output: outputOf({
      type: 'object',
      additionalProperties: false,
      properties: {
        project: SUMMARY_SCHEMA,
        dropped: { type: 'array', required: true, items: { type: 'string' } },
      },
    } as const),
    async execute(args, exec) {
      const imported = await projects().import(sessionOf(exec), args.source, {
        ...args.dir === undefined ? {} : { dir: args.dir },
        ...args.title === undefined ? {} : { title: args.title },
      })
      return { project: summaryOf(imported.snapshot), dropped: [...imported.dropped] }
    },
    presentCall: args => present('Import .pptx', 'other', args.source),
  }))

  ctx.tools.register(defineTool({
    name: 'ppt_export',
    description: 'Export the current revision as a .pptx file under the project directory (export/<title>-v<revision>.pptx). '
      + 'Report the absolute path to the user; open it with their presentation app.',
    parameters: {
      dir: { type: 'string', description: 'Workspace-relative project directory; omit for the open project.' },
      skip_check: { type: 'boolean', description: 'Export even when ppt_check reports blocking layout errors.' },
    },
    output: outputOf({
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', required: true },
        bytes: { type: 'number', required: true },
        revision: { type: 'number', required: true },
        fonts: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              family: { type: 'string', required: true },
              readonly: { type: 'boolean', required: true },
              subset: { type: 'boolean', required: true },
            },
          },
        },
        skippedFonts: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              family: { type: 'string', required: true },
              reason: { type: 'string', required: true },
            },
          },
        },
      },
    } as const),
    async execute(args, exec) {
      const result = await projects().export(sessionOf(exec), args.dir, { skipCheck: args.skip_check === true })
      return {
        path: result.path,
        bytes: result.bytes,
        revision: result.revision,
        fonts: result.fonts.map(font => ({
          family: font.family,
          readonly: font.readonly,
          subset: font.subset,
        })),
        skippedFonts: result.skippedFonts.map(font => ({ family: font.family, reason: font.reason })),
      }
    },
    presentCall: args => present('Export .pptx', 'other', args.dir),
  }))
}
