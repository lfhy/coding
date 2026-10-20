/**
 * DOM 围栏表面发现与语言归一化。
 *
 * 宿主会把每段围栏代码渲染成共享 CodeBlock 表面（稳定类 `md-code-block`，
 * 语言标签是 banner 内无子节点的标签元素）。本模块负责：
 * - 多表面候选发现（issue #6）：已知类名表面、`<pre>` 结构回溯、
 *   Desktop 0.11.0 的纯文本 `<dsh-ui>` 标签 span；
 * - 表面合法性闸门：消息级容器、插件自有 DOM、嵌套表面一律拒绝（issue #13/#19）；
 * - 语言读取与归一化：DOM 标签 / ChatSnapshot 源码两条来源统一收敛为内部
 *   `'dsh-ui'`（新围栏语言 `gen-ui` 与历史 `dsh-ui` 等价），`svg` 维持独立；
 *   普通 JSON、无语言围栏不得因内容相似被误接管。
 *
 * 安全边界：本模块只读 DOM、不下发渲染；所有判定必须可被全量扫描与
 * mutation 路径共用，避免两条路径结论不一致。
 */
import { repairFenceJson, trimToBalancedRoot } from '../shared/fence-repair.ts'
import { isGenuiFenceLanguage } from '../shared/fence-language.ts'
import { validateCanonicalGenuiSpec } from './guard.ts'
import { diagnoseUnknownGenuiFields } from './genui-runtime/diagnostics.ts'
import { normalizeGenuiSpec } from './genui-runtime/normalize.ts'

/** 优先用宿主代码块内容的语义标记定位包装节点；隐藏语言或改变类名不能阻断
 * 原始消息的围栏识别。类名也用于仍以这些表面呈现的代码块。 */
const CODE_BLOCK_SELECTORS = '.md-code-block, .code-block, .code-block-small'

/** 本通道已接管块上的标记属性。 */
const PROCESSED = 'data-genui-rendered'
/** AssistantMarkdown 上的流式标记（ absence = 已定稿）。 */
const STREAMING = '[data-streaming]'
/** 插件自有渲染根的容器类名。 */
const CONTAINER_CLASS = 'genui-dom-fence'
/** 不可渲染围栏的可见诊断容器类名。 */
const DIAGNOSTIC_CLASS = 'genui-dom-fence-diagnostic'
/** 接管永不触达的宿主容器：我们自己的挂载树。所有发现路径共享该闸门，
 * 变更节点不可能进入全量扫描会拒绝的队列。 */
const SURFACE_EXCLUDES = `.${CONTAINER_CLASS}, .${DIAGNOSTIC_CLASS}, [data-genui-svg-fence]`
/** 标签文本 span 的同类排除：宿主把这些行渲染在 transcript 之外（推理、
 * 工具输出、侧栏、插件面板）。 */
const TAG_TEXT_EXCLUDES = `.${CONTAINER_CLASS}, .${DIAGNOSTIC_CLASS}, [data-chat-group-part="reasoning"], [data-tool], [data-sidebar-chat], [data-sidebar-right-session], [data-sidebar-right-panel], [data-panel-conversation], [data-plugin-panel]`
/** 围栏可能出现的上下文：代码体、表面类名或表面的内容持有节点。
 * 散文与布局变化不通过该闸门。 */
const CODE_CONTEXT = `pre, ${CODE_BLOCK_SELECTORS}, [data-code-block-content]`

/** 拥有会话行（每条消息的稳定身份）。宿主在路由 key 缺失（Safari 等
 * fallback 渲染路径）时会省略 `data-chat-anchor-key`，因此回退链永不放弃。 */
const FLOW_ROW = '[data-chat-flow-key], [data-chat-flow-kind]'
const ASSISTANT_FLOW_ROW = '[data-chat-flow-kind="assistant-step"]'

/** `<pre>` 向上走到围栏表面根的最大跳数（banner + pre 持有层）。 */
const SURFACE_HOPS = 4

/** 绝不属于代码块表面的块级内容：真正的围栏表面是「banner 装饰 + 一个
 * 代码体」。同时含段落/列表/表格（或多个 `<pre>`）的是消息级容器，
 * 接管它会藏起整条回复（issue #19 中 issue #13 类问题的残余变体）。 */
const BLOCK_CONTENT_SELECTOR = 'p, ul, ol, dl, table, h1, h2, h3, h4, h5, h6, blockquote, hr, img, figure'

export {
  CODE_BLOCK_SELECTORS,
  CODE_CONTEXT,
  CONTAINER_CLASS,
  DIAGNOSTIC_CLASS,
  SURFACE_EXCLUDES,
  TAG_TEXT_EXCLUDES,
  PROCESSED,
  STREAMING,
  FLOW_ROW,
  ASSISTANT_FLOW_ROW,
}

/**
 * 已知**真实语言标识符**的闭集：语言 id 有限、由本插件维护，白名单列它是
 * 对的。反例——宿主各语言里通用代码块标题的叫法（`Code` / `代码块` /
 * «Код» …）——是**无界集合**，白名单永远列不全：旧实现只列英中两种时，
 * 其它宿主 locale 的本地化标题被当成真语言，围栏永远不被接管（#258）。
 * 因此判定反转：标签命中本集合才视为「带语言」，其余（空标签、本地化
 * 通用词）一律视为「无语言」，交给 {@link isGenericGenuiFence} 的内容
 * 校验把关——同一份正文的渲染结果不因宿主语言而不同。
 */
const KNOWN_LANGUAGE_LABELS = new Set([
  // 插件自有语言（gen-ui 为新语言，dsh-ui 为历史别名）
  'dsh-ui', 'gen-ui', 'svg',
  // 数据 / 标记 / 纯文本
  'json', 'json5', 'yaml', 'yml', 'toml', 'ini', 'xml', 'html', 'css', 'scss', 'sass', 'less',
  'markdown', 'md', 'text', 'txt', 'plain', 'plaintext', 'log', 'console', 'diff', 'patch',
  // 助手回复里常见的编程语言
  'js', 'jsx', 'javascript', 'ts', 'tsx', 'typescript', 'python', 'py', 'bash', 'sh', 'shell', 'zsh',
  'sql', 'graphql', 'gql', 'rust', 'go', 'golang', 'java', 'kotlin', 'kt', 'swift', 'scala', 'dart',
  'c', 'h', 'cpp', 'c++', 'cxx', 'cs', 'csharp', 'php', 'ruby', 'rb', 'perl', 'lua', 'r', 'matlab',
  'haskell', 'hs', 'elixir', 'ex', 'erlang', 'clojure', 'clj', 'groovy', 'objc', 'objective-c',
  'dockerfile', 'docker', 'makefile', 'make', 'cmake', 'protobuf', 'proto',
])

/**
 * 内部围栏语言：GenUI 统一归一为 `'dsh-ui'`（`gen-ui` 与历史 `dsh-ui`
 * 等价，减少全链路改动面），SVG 维持独立；其余已知语言是「明确的非
 * GenUI」，必须与「来源暂不可用」区分，否则普通 JSON 会被误接管。
 */
export type DomFenceLanguage = 'dsh-ui' | 'svg' | 'other'

/**
 * 把任一来源（DOM 标签或 ChatSnapshot 源码）的原始语言归一化为内部值。
 *
 * @param language - 原始语言字符串；null 表示围栏无语言，undefined 表示来源不可用。
 * @returns `'dsh-ui'`（含 gen-ui 别名）、`'svg'`、`'other'`（明确非 GenUI）、null 或 undefined 原样保留语义。
 */
export function normalizeFenceLanguage(language: string | null | undefined): DomFenceLanguage | null | undefined {
  if (language === null || language === undefined) return language
  if (isGenuiFenceLanguage(language)) return 'dsh-ui'
  if (language === 'svg') return 'svg'
  return 'other'
}

/** DOM lib 标注 `textContent: string`（getter 侧不产 null）；局部标 `string | null`
 * 是对「空文本节点序列化为 null」这一宿主现实的保守描述，收窄后语义不变。 */
function textOf(node: Node): string {
  const text: string | null = node.textContent
  return text ?? ''
}

/** 读取 DSH Desktop 0.11.0 将围栏呈现为纯文本标签时的正文（仅历史 `dsh-ui` 标签）。 */
export function tagTextBodyOf(block: Element): string | null {
  if (block.tagName !== 'SPAN' || block.childElementCount !== 0) return null
  const text = textOf(block)
  const opening = '<dsh-ui>'
  const closing = '</dsh-ui>'
  if (!text.startsWith(opening) || !text.endsWith(closing)) return null
  const flowKind = block.closest('[data-chat-flow-kind]')?.getAttribute('data-chat-flow-kind')
  // `getAttribute` 未命中返回 null；非 assistant-step 一律拒绝。
  if (flowKind !== null && flowKind !== 'assistant-step') return null
  return text.slice(opening.length, -closing.length).trim()
}

/**
 * banner 的语言标签：文本恰好是语言的叶元素。CodeBlock 把标签渲染成无子
 * 节点 div，deepsuite 风格表面用 span；跨宿主唯一的结构不变量是「叶元素
 * 持有语言文本」且「位于代码体之外」——代码正文里出现字面 `dsh-ui` 不得
 * 自我指认。持有多个代码块的容器也不得借嵌套块的标签自我指认（#13：
 * 共享 markdown 根曾被误认成围栏并藏起整条消息）。
 */
function infostringOf(block: Element): 'dsh-ui' | 'svg' | null {
  const pre = block.querySelector('pre')
  for (const el of block.querySelectorAll('*')) {
    if (el.childElementCount !== 0) continue
    const lang = textOf(el).trim()
    if (lang !== 'dsh-ui' && lang !== 'gen-ui' && lang !== 'svg') continue
    if (pre !== null && pre.contains(el)) continue
    // 属于嵌套已知代码表面的标签是该表面的 banner，不是本块的：只接受
    // 最近已知表面就是本块（或未知表面——结构回溯仍支持）的标签。
    const owner = closestCodeBlockSurface(el)
    if (owner !== null && owner !== block) continue
    return lang === 'svg' ? 'svg' : 'dsh-ui'
  }
  return null
}

/**
 * 读取宿主仍暴露在 CodeBlock banner 里的语言。
 *
 * 只有标签命中 {@link KNOWN_LANGUAGE_LABELS} 才返回语言；空标签与本地化
 * 通用词（«Код» / 代码块 …）是宿主的**呈现文案**、不是语义，一律返回
 * null——此前它们会被当成真语言，连 ChatSnapshot 来源都被短路（#258）。
 */
export function domLanguageLabelOf(block: Element): string | null {
  const label = labelTextOf(block)
  return label !== '' && KNOWN_LANGUAGE_LABELS.has(label.toLowerCase()) ? label : null
}

/** banner 标签的原始文本（流式期间为空——宿主在回复定稿后才渲染语言）。
 * 返回代码体之外的首个叶元素（banner 总是以语言开头），span 标签宿主与
 * div 标签宿主读取一致。 */
function labelTextOf(block: Element): string {
  const pre = block.querySelector('pre')
  for (const el of block.querySelectorAll('*')) {
    if (el.childElementCount !== 0) continue
    if (pre !== null && pre.contains(el)) continue
    return textOf(el).trim()
  }
  return ''
}

/** 在同一处收集代码块包装节点，供候选扫描和原始围栏序号共用。 */
export function codeBlockSurfaces(scope: ParentNode): HTMLElement[] {
  const surfaces = new Set(scope.querySelectorAll<HTMLElement>(CODE_BLOCK_SELECTORS))
  for (const content of scope.querySelectorAll<HTMLElement>('[data-code-block-content]')) {
    if (content.parentElement !== null) surfaces.add(content.parentElement)
  }
  return [...surfaces].sort((left, right) => left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
}

/** 返回拥有代码内容语义节点、或已知代码块类名的最近包装节点。 */
export function closestCodeBlockSurface(
  element: Element | null,
  owners?: WeakMap<Element, Element | null>,
): Element | null {
  // 缓存仅在同一次同步候选扫描内复用，后续 DOM 更新会创建新的缓存。
  const visited: Element[] = []
  let owner: Element | null = null
  for (let current = element; current !== null; current = current.parentElement) {
    if (owners?.has(current)) {
      owner = owners.get(current) ?? null
      break
    }
    visited.push(current)
    if (current.matches(CODE_BLOCK_SELECTORS)
      || [...current.children].some(child => child.hasAttribute('data-code-block-content'))) {
      owner = current
      break
    }
  }
  for (const current of visited) owners?.set(current, owner)
  return owner
}

/** Settled 闸门：任何祖先都没有流式标记。 */
export function isSettled(block: Element): boolean {
  return block.closest(STREAMING) === null
}

/** 拥有该块的会话行（见 {@link FLOW_ROW} 的回退链说明）。 */
export function rowOf(block: Element): Element {
  return block.closest('[data-chat-anchor-key]') ?? block.closest(FLOW_ROW) ?? block
}

/**
 * 仅在通用 CodeBlock 的内容经过**与带标签路径相同的标点级修复**后仍是合规
 * GenUI 规范时，恢复丢失的围栏语言。
 *
 * 宿主会隐去它不认识的语言（高亮器不支持 `dsh-ui`/`gen-ui`），于是同一份
 * 围栏在 DOM 里表现为通用标题的普通代码块；ChatSnapshot 来源不可用时，
 * 内容识别是唯一出路。此前这里要求 `JSON.parse(raw)` 直接通过，导致正文
 * 只差一个未转义引号（tier-1 能修）的围栏永远不被接管（真实会话 seq
 * 40530）。结构级修复（tier-2）刻意不参与：内容识别是兜底，不该接管只是
 * 「长得像 JSON」的普通代码。
 */
export function isGenericGenuiFence(block: Element, raw: string): boolean {
  const row = block.closest<HTMLElement>(ASSISTANT_FLOW_ROW)
  if (row === null || row.dataset.chatGroupPart === 'reasoning') return false
  // domLanguageLabelOf 已反转（#258）：banner 是已知真实语言 ⇒ 不是通用块；
  // 空标签或本地化通用词 ⇒ null，进入内容校验。
  if (domLanguageLabelOf(block) !== null || !block.querySelector('[data-code-block-banner]')) return false
  const repaired = repairFenceJson(raw)
  const candidate = repaired === null ? raw : repaired.text
  let value: unknown
  try {
    value = JSON.parse(candidate)
  } catch {
    // 「合法 JSON + 尾部杂字符」（真实样本：模型把工具调用模板泄漏在 JSON
    // 之后且围栏未闭合）同样要能认出：裁到平衡根值再试一次，只裁剪不补全。
    const trimmed = trimToBalancedRoot(candidate)
    if (trimmed === null) return false
    try {
      value = JSON.parse(trimmed)
    } catch {
      return false
    }
  }
  if (!validateCanonicalGenuiSpec(value).ok || diagnoseUnknownGenuiFields(value).length > 0) return false
  return JSON.stringify(normalizeGenuiSpec(value).value) === JSON.stringify(value)
}

/** 读取宿主代码块或纯文本标签中的围栏正文。 */
export function rawOf(block: Element): string {
  const tagTextBody = tagTextBodyOf(block)
  if (tagTextBody !== null) return tagTextBody
  const pre = block.querySelector('pre')
  if (pre === null) return ''
  // 文本节点与高亮产生的元素节点统一取 textContent：围栏正文必须包含全部
  // 文本（无论宿主是否加了语法高亮包装）。
  let text = ''
  for (const node of pre.childNodes) {
    text += textOf(node)
  }
  return text
}

/** 该元素像单个代码块表面而非消息容器吗？唯一允许的非代码内容是 banner 装饰。 */
export function isPlausibleFenceSurface(candidate: Element): boolean {
  const pres = candidate.querySelectorAll('pre')
  if (pres.length > 1) return false
  const pre = pres[0] ?? null
  for (const el of candidate.querySelectorAll(BLOCK_CONTENT_SELECTOR)) {
    if (pre !== null && pre.contains(el)) continue
    return false
  }
  return true
}

/** 从 `<pre>` 向上找围栏表面根：同时持有 banner 标签与该 pre 的祖先。
 * `SURFACE_HOPS`（或 scope 边界）内没有 GenUI 标签、或标签持有者不是代码
 * 表面而是消息级容器时返回 null。 */
export function surfaceOf(pre: HTMLElement, scope: ParentNode = document): HTMLElement | null {
  let el: HTMLElement | null = pre.parentElement
  for (let hops = 0; el !== null && el !== scope && hops < SURFACE_HOPS; hops += 1, el = el.parentElement) {
    if (infostringOf(el) === null) continue
    if (!isPlausibleFenceSurface(el)) return null
    return el
  }
  return null
}

/** `surfaceOf` 刚拒绝的「有标签但不可信」祖先（若有）：#19 守卫的诊断，
 * 被跳过的围栏不允许静默。 */
export function implausibleLabeledAncestorOf(pre: HTMLElement, scope: ParentNode = document): HTMLElement | null {
  let el: HTMLElement | null = pre.parentElement
  for (let hops = 0; el !== null && el !== scope && hops < SURFACE_HOPS; hops += 1, el = el.parentElement) {
    if (infostringOf(el) === 'dsh-ui' && !isPlausibleFenceSurface(el)) return el
  }
  return null
}

/** 候选不是围栏的原因。独立汇报使全量扫描保留诊断、mutation 路径得到同一结论。 */
export type SurfaceRejection = 'nested' | 'plugin-owned' | 'implausible' | null

/** 每条发现路径共用的候选闸门。 */
export function surfaceRejection(candidate: Element, owners?: WeakMap<Element, Element | null>): SurfaceRejection {
  // 修饰类可以嵌在表面内（如 `code-block` 内的 `code-block-small`）：只有
  // 最外层匹配元素是候选，围栏不会被重复计数或双重接管。
  if (closestCodeBlockSurface(candidate.parentElement, owners) !== null) return 'nested'
  if (candidate.closest(SURFACE_EXCLUDES) !== null) return 'plugin-owned'
  // 碰巧带表面类名的消息级容器不得接管：藏起它就是藏起整条回复（#19）。
  if (!isPlausibleFenceSurface(candidate)) return 'implausible'
  return null
}

/** 标签文本 span 的同一策略：assistant 散文里完整的 `<dsh-ui>` 标签是围栏，
 * 其它一律不是。 */
export function isTakeoverTagText(span: Element, owners?: WeakMap<Element, Element | null>): boolean {
  if (tagTextBodyOf(span) === null) return false
  if (closestCodeBlockSurface(span, owners) !== null) return false
  return span.closest(TAG_TEXT_EXCLUDES) === null
}

/** 节点所在的最外层表面。mutation 驱动的发现必须落在全量扫描会选中的候选
 * 上，而不是它内部的修饰节点。 */
export function outermostSurfaceOf(node: Element | null): HTMLElement | null {
  let candidate = closestCodeBlockSurface(node)
  while (candidate !== null) {
    const parent = closestCodeBlockSurface(candidate.parentElement)
    if (parent === null) return candidate as HTMLElement
    candidate = parent
  }
  return null
}

/** 每次 install 重置一次的漂移诊断标记（测试与热重载各有新的告警预算）。 */
let driftWarned = false
/** 被拒绝的表面只诊断一次；绝不记录其会话文本。 */
let plausibilityWarned = new WeakSet<Element>()

/** 重置表面诊断的一次性标记；由渲染通道安装时调用。 */
export function resetSurfaceDiagnostics(): void {
  driftWarned = false
  plausibilityWarned = new WeakSet<Element>()
}

function warnImplausibleSurface(surface: Element): void {
  if (plausibilityWarned.has(surface)) return
  plausibilityWarned.add(surface)
  const pres = surface.querySelectorAll('pre')
  const tags = [...surface.querySelectorAll(BLOCK_CONTENT_SELECTOR)]
    .filter(el => !el.closest('pre')).map(el => el.tagName.toLowerCase())
  console.warn(`[genui] 跳过带 GenUI 标签但疑似消息容器的节点：pre=${pres.length}, outside-code=${[...new Set(tags)].join(',') || 'none'}；保留原文，防止隐藏整条消息（issue #19）`)
}

/**
 * scope 下所有 GenUI 围栏表面与完整标签文本 span，按 DOM 序返回。
 *
 * 先已知表面类名（廉价、有序），再结构回溯——每个 banner 标为 GenUI 语言
 * 的 `<pre>`——未知表面形状的宿主也能渲染。标签 + `<pre>` 闸门使结构回溯
 * 无误报：没有确切 GenUI 标签的随机代码表面绝不被接管。
 *
 * `includeScope` 时 scope 元素本身也是候选：mutation 交来的是变更节点，
 * 围栏可能就是该节点（挂到行上的未知类表面、整体到达的标签文本 span）。
 */
export function findFenceCandidates(scope: ParentNode = document, options: { includeScope?: boolean } = {}): HTMLElement[] {
  const self = options.includeScope === true && scope instanceof Element ? scope : null
  const surfaceOwners = new WeakMap<Element, Element | null>()
  const seen = new Set<HTMLElement>()
  const out: HTMLElement[] = []
  const surfaces = codeBlockSurfaces(scope)
  if (self !== null && (self.matches(CODE_BLOCK_SELECTORS)
    || [...self.children].some(child => child.hasAttribute('data-code-block-content')))) {
    surfaces.unshift(self as HTMLElement)
  }
  for (const el of surfaces) {
    if (seen.has(el)) continue
    const rejection = surfaceRejection(el, surfaceOwners)
    if (rejection !== null) {
      if (rejection === 'implausible' && infostringOf(el) !== null) warnImplausibleSurface(el)
      continue
    }
    out.push(el)
    seen.add(el)
  }
  const pres = [...scope.querySelectorAll<HTMLElement>('pre')]
  if (self !== null && self.tagName === 'PRE') pres.unshift(self as HTMLElement)
  // 以变更节点为根的扫描必须能到达「就是该节点」的表面，而 `surfaceOf`
  // 在 scope 边界停下：仅对这次扫描把边界上移一跳。下面三个检查是共享
  // 闸门对 `<pre>`（而非它解析出的表面）的三个结论。
  const surfaceScope: ParentNode = self === null ? scope : self.parentElement ?? self
  for (const pre of pres) {
    // 已知表面内的 `<pre>` 已由选择器轮处理。再向上爬会越过自己的表面进
    // 入共享容器——例如同时持有围栏与 python 块的 markdown 根——回溯会把
    // 整个容器误标成围栏，连同其它代码块一起藏掉（#13）。
    if (closestCodeBlockSurface(pre, surfaceOwners) !== null
      || pre.closest(SURFACE_EXCLUDES) !== null) continue
    const surface = surfaceOf(pre, surfaceScope)
    if (surface === null) {
      // 诊断 #19 守卫：有标签但不是代码表面（散文/多个代码体）的祖先被
      // 有意跳过。
      const rejected = implausibleLabeledAncestorOf(pre, surfaceScope)
      if (rejected !== null) warnImplausibleSurface(rejected)
      continue
    }
    if (seen.has(surface)) continue
    // 宿主 DOM 漂移诊断：围栏仍渲染（结构回溯），但表面类名是本构建未知
    // 的——每次安装告警一次，未来漂移不再静默。
    if (!driftWarned) {
      driftWarned = true
      console.warn('[genui] 围栏表面类名未被已知选择器命中（宿主 DOM 漂移），已按 label+pre 结构识别 GenUI 围栏')
    }
    out.push(surface)
    seen.add(surface)
  }
  const spans = [...scope.querySelectorAll<HTMLElement>('span')]
  if (self !== null && self.tagName === 'SPAN') spans.unshift(self as HTMLElement)
  for (const span of spans) {
    // 普通文本不进入祖先和代码块归属查找。
    if (!isTakeoverTagText(span, surfaceOwners)) continue
    out.push(span)
  }
  return out.sort((left, right) => left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
}
