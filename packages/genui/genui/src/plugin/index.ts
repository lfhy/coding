/**
 * GenUI 宿主半：向系统提示词登记 ```dsh-ui 围栏语言说明、注册
 * render_ui／validate_dsh_ui 模型工具、以 bundled provider 注册 genui 技能，
 * 并在 webserver 上挂懒引擎资产路由（mermaid／three／echarts 按需下发）。
 * 浏览器半（`src/client`）负责围栏渲染；没有浏览器半时围栏只是普通代码块。
 * @module coding-genui
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from 'coding-system-prompt'
import type {} from 'coding-tools'
import type {} from 'coding-host-webserver'
import type { SkillProvider } from 'coding-skill'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRenderUiTool, createValidateDshUiTool } from './tool.ts'
import { installFenceFeedback } from './fence-feedback.ts'

/* ---------------- 懒引擎资产路由 ---------------- */

/**
 * mermaid／three／echarts 引擎以独立 IIFE 形态产出到 `lib/assets/`，浏览器
 * 半只在某个 spec 真正需要时才注入执行。本路由经 webServer 服务以最长
 * 前缀规则胜过通用 `/plugins` bundle 路由，宿主源码无需改动；服务在本
 * 插件启动时可选，注册由依赖 fiber 持有，跟随晚绑定与插件卸载。
 */

/** /plugins 下的路由前缀；其下所有内容都是本插件的引擎资产。 */
const ASSET_ROUTE_PATH = '/plugins/coding-genui/assets'

/** 仅接受扁平文件名：无斜杠、无穿越，且必须是 js 资产。 */
const ASSET_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.js$/

/** 资产路由处理器本体（经可选 webServer 注入注册）。 */
async function serveGenuiAsset(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    res.end()
    return
  }
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
  } catch {
    res.writeHead(400)
    res.end()
    return
  }
  const rel = pathname.startsWith(`${ASSET_ROUTE_PATH}/`) ? pathname.slice(ASSET_ROUTE_PATH.length) : null
  if (rel === null) {
    res.writeHead(404)
    res.end()
    return
  }
  const file = rel.slice(1)
  if (!ASSET_FILE_RE.test(file)) {
    res.writeHead(404)
    res.end()
    return
  }
  try {
    // lib/index.js → ./assets/ = <pkg>/lib/assets/（懒引擎资产的输出目录）。
    const dir = fileURLToPath(new URL('./assets/', import.meta.url))
    const body = await readFile(join(dir, file))
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
    })
    res.end(body)
  } catch {
    // 资产缺失（旧构建）——响亮的 404；浏览器半展示各自的降级提示。
    res.writeHead(404)
    res.end()
  }
}

const RENDER_UI_TOOL_GUIDANCE = '- Tool channel: render_ui 工具把同一 spec 渲染为工具行卡片；围栏用于回答内联 UI。'

/** 注入每个组装后系统提示词的围栏语言说明。
 *  刻意保持精简：`genui` 技能携带完整组件→字段映射；本段只保留必须
 *  常驻的契约（围栏语法、类型白名单与关键行为规则）。 */
export const GENUI_SECTION_TEXT = `You can render interactive UI components INSIDE your reply — between paragraphs — by emitting a fenced block with the language tag \`dsh-ui\` containing a JSON spec:

\`\`\`dsh-ui
{"title":"<user-language text>","gap":14,"items":[...]}
\`\`\`

Allowed \`type\` values; the \`genui\` skill, when available, carries the full content→component mapping and per-component field details:

- 布局: text · row · col · grid · card · divider · spacer · hero（封面块，一条回答最多一个）
- 展示: badge · stat · progress · list · table · keyvalue · timeline · file-tree · breadcrumb · callout · steps · diff · json · code · copy · avatar · audio · video
- 图表: chart {"kind":"bars|line|donut","data":[{"label":"...","value":n}],"series":[{"label":"...","data":[...]}]?,"horizontal":true?,"stacked":true?}（series：bars 分组/堆叠 / line 多序列；horizontal 横向柱） · echart (preset 名或 option 直通，预设清单见 skill) · plot (函数图)
- 交互: button · input · textarea · select · checkbox · switch · slider · radio · submit · quiz · link · tabs · accordion
- 高级: mermaid (流程图/时序/甘特/ER 等，关键字见 skill) · diagram (架构/流程图) · scene3d (3D WebGL)

**默认就该出 UI**：出现下列情况至少出一个围栏：
- ≥3 条并列要点 → \`list\`；数字对比 → \`table\`；指标/进度/状态 → \`stat\`/\`progress\`/\`badge\`
- 步骤/时间线 → \`steps\`/\`timeline\`/\`mermaid\`；架构/流程 → \`diagram\` 或 \`mermaid\`；单条风险/结论摘要 → \`callout\`；代码/改动 → \`code\`/\`diff\`/\`json\`
- 行内富文本：支持公式、\`code\`、加粗、高亮、链接；禁用 Markdown table 与 fenced code，改用 table/code/diff/json。
- 默认无卡：卡片用于并排项、数据对象或需底色的风险清单。

**发回答前最后自检一次**：有没有 ≥3 条并列要点、任何对比、任何数字/指标、任何步骤或流程？有就先转成组件。**状态汇报、进度说明、提交与改动清单同样算**。
- 趋势/占比 → \`chart\`（≤8 点）或 \`echart\`（多序列/要交互时）；配色默认跟随主题，只有语义需要时才用 \`palette\`/\`card.accent\`；grid 子节点用 \`"span":2\` 跨列做宽窄混排；数据多时给 \`table\`/\`chart\`/\`list\` 配 \`input\`(id)+\`filter\` 绑定就地筛选。
- 多组件回答先套 skill「编排范式」，别一行一个往下堆；章节分隔 \`divider\` 带 \`label\`。

**字段速查**（完整见 genui skill）：\`stat\` \`{"label","value","delta"?}\` · \`table\` \`{"columns":[...],"rows":[[...]],"types"?,"details"?,"filter"?,"export"?}\` · \`progress\` \`{"value":0-100,"label"?,"variant"?,"target"?}\` · \`keyvalue\` \`{"pairs":[{"key","value"}]}\` · \`steps\` \`{"steps":[{"title","desc"?}]}\` · \`file-tree\` \`{"items":[{"name","type":"file|dir","children"?}]}\` · \`callout\` \`{"content","tone"?,"title"?}\`

**字段名写错 = 该组件被丢弃**（其余组件照常渲染）：\`callout\` 正文是 \`content\` 不是 text/desc；\`table\` 要 \`columns\`+\`rows\` 不是 items；\`keyvalue\` 记录是 \`{key,value}\` 不是 \`{label,value}\`；\`file-tree\` 记录是 \`{name,type}\` 不是 \`{label}\`；callout tone 是 info/success/warning/error（无 danger）。不确定就调 \`validate_dsh_ui\`。

Rules:
- LANGUAGE: reply+UI=conversation language; schema fixed. NEVER infer it from prompt/skill/examples/tools. Replace \`<user-language ...>\`; never emit these placeholders literally.
- JSON 严格：坏组件被丢弃，坏围栏变代码块；≥3 节点或含 table 时调 validate_dsh_ui，按诊断修改并重验；小围栏字段存疑也先验证。
- warning=block_markdown：按 replacement 改写并重验。
- 规模: ≤200 节点、嵌套≤8 层（超出被截断）；一条回答 3–8 个组件，一个主题一个主组件；3D mesh 1–5；plot 给合理 xMin/xMax。
- LOCAL-FIRST + actions: UI 能自己做的状态变化（判卷、判题、重置、展开、选中）就地完成，零往返；action 只用于必须模型参与的事。交互以 [genui-action] name + 组件数据回传，届时重渲染更新 UI；无 action 的按钮禁用。
- Durable state: 交互状态按「会话+内容指纹」持久化——刷新/重放恢复；相同内容保留，新内容重置。
- 卷子模式: 每题一个 radio（group+answer+explanation）+ 一个 submit（groups 全列），本地判分。
- Secrets ban: 不索取密码、API Key、Token、恢复码；需要时拒绝并解释。
${RENDER_UI_TOOL_GUIDANCE}
- 围栏位置：\`dsh-ui\` 只写在**回答正文**；写在 reasoning/思考块里不渲染、用户看不到——思考里验证好 spec，正文再输出同一份。
- Panel: "panel":true 只渲染进会话面板 dock 并原地更新；"append":true 追加合并；上限 200 节点/200 次追加，满了发 replace 重建。面板来的 [genui-action] 只回一个 panel:true 围栏 + 至多一行 10 字内确认。`

/** 围栏语言段在系统提示词中的落位：工具段（order 150）之前、code-only 折叠规则（99）之后。 */
const GENUI_SECTION_ORDER = 120

/** 注册 bundled genui 技能；宿主半启动时同步读取 SKILL.md。 */
const BUNDLED_SKILL_RANK = 600
const BUNDLED_SKILL_PROVIDER = 'coding-genui'
const BUNDLED_SKILL_DESCRIPTION = 'GenUI dsh-ui component/schema reference. Preserve conversation language for all user-visible text.'
const BUNDLED_SKILL_INVOCATION = { modelInvocable: true, userInvocable: true } as const

/** 经 provider 路径注册，使 source=bundled 的技能获得 bundled 优先级。 */
function bundledSkillProvider(): SkillProvider {
  const moduleDirectory = dirname(fileURLToPath(new URL(import.meta.url)))
  const path = basename(moduleDirectory) === 'plugin'
    ? resolve(moduleDirectory, '../../SKILL.md')
    : resolve(moduleDirectory, '../SKILL.md')
  const raw = readFileSync(path, 'utf8')
  const end = raw.indexOf('\n---\n', 4)
  if (!raw.startsWith('---\n') || end < 0) throw new Error('genui SKILL.md has invalid frontmatter')
  return {
    name: BUNDLED_SKILL_PROVIDER,
    list: () => Promise.resolve([{
      name: 'genui',
      description: BUNDLED_SKILL_DESCRIPTION,
      invocation: BUNDLED_SKILL_INVOCATION,
      source: 'bundled',
      provider: BUNDLED_SKILL_PROVIDER,
      path,
      resourceBase: { kind: 'directory', path: dirname(path) },
      rank: BUNDLED_SKILL_RANK,
      locator: path,
    }]),
    get: () => Promise.resolve({
      name: 'genui',
      description: BUNDLED_SKILL_DESCRIPTION,
      invocation: BUNDLED_SKILL_INVOCATION,
      source: 'bundled',
      provider: BUNDLED_SKILL_PROVIDER,
      path,
      resourceBase: { kind: 'directory', path: dirname(path) },
      content: raw.slice(end + 5),
    }),
  }
}

/**
 * 插件配置（宿主直接传入，未校验：宿主半刻意不引 schema 库）。
 */
export interface GenuiPluginConfig {
  /**
   * 在最终 dsh-ui 围栏无法渲染的回合中请求模型发送一次修正版。
   * 默认开启，设置为 false 可以关闭同回合围栏修正。GenUI 回合的
   * reasoning-only 响应仍会交给宿主重试策略处理。每回合和每个围栏正文
   * 最多请求一次，子代理不触发，每次修正请求会消耗模型步数。
   */
  fenceFeedback?: boolean

  /**
   * 是否注册 render_ui 模型工具。默认开启，设置为 false 时关闭；
   * 不影响 validate_dsh_ui 和 dsh-ui 围栏渲染。
   */
  renderUiTool?: boolean
}

/**
 * 注册 GenUI 输出语言段与 render_ui 工具。
 * @param ctx - cordis context。
 * @param config - 插件配置。
 */
export const name = 'coding-genui'
export const inject = ['systemPrompt']

export function apply(ctx: Context, config?: GenuiPluginConfig): void {
  const renderUiToolEnabled = config?.renderUiTool !== false
  ctx.systemPrompt.section({
    name: 'genui:fence',
    order: GENUI_SECTION_ORDER,
    text: renderUiToolEnabled ? GENUI_SECTION_TEXT : GENUI_SECTION_TEXT.replace(`${RENDER_UI_TOOL_GUIDANCE}\n`, ''),
  })
  installFenceFeedback(ctx, config?.fenceFeedback !== false, renderUiToolEnabled)
  // 无工具访问的宿主保留围栏通道。依赖 fiber 在 tools 服务可用时启动，
  // 并在服务或本插件被替换前卸载自己的注册。
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.effect(function* () {
      if (renderUiToolEnabled) {
        yield toolsCtx.tools.register(createRenderUiTool())
      }
      yield toolsCtx.tools.register(createValidateDshUiTool())
    }, 'coding-genui: model tools')
  })

  ctx.inject(['skills'], (skillCtx) => {
    skillCtx.effect(() => skillCtx.skills.registerProvider(() => bundledSkillProvider()), 'coding-genui: bundled skill')
  })

  // webServer.register 返回裸 disposer，用显式 effect 把路由绑定到依赖 fiber，
  // 而不是留在宿主路由表里。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: ASSET_ROUTE_PATH, handler: serveGenuiAsset }),
      'coding-genui: asset route',
    )
  })
}
