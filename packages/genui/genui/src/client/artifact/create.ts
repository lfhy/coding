import { currentLocale } from '../i18n/index.ts'
import { processGenuiSpec } from '../guard.ts'
import type { BlockInteractionState } from '../interaction-store.ts'
import type { GenuiNode, GenuiSpec } from '../spec.ts'
import { GenuiExportError, GENUI_ARTIFACT_FORMAT, GENUI_ARTIFACT_VERSION, type CreateGenuiArtifactOptions, type GenuiArtifactTheme, type GenuiArtifactV1 } from './types.ts'

/** list 节点 items 的元素形状（spec.ts 内联类型的本地别名）。 */
type GenuiListElement = string | { title: string; desc?: string } | GenuiNode

/** 复制 durable 状态并移除密码字段。 */
function safeState(state: BlockInteractionState | undefined, secretIds: Set<string>): BlockInteractionState | undefined {
  if (state === undefined) return undefined
  const fields = Object.fromEntries(Object.entries(state.fields ?? {}).filter(([id]) => !secretIds.has(id)))
  const multiAnswers = state.multiAnswers === undefined
    ? {}
    : { multiAnswers: Object.fromEntries(Object.entries(state.multiAnswers).map(([id, values]) => [id, [...values]])) }
  return {
    ...(state.answers === undefined ? {} : { answers: { ...state.answers } }),
    ...multiAnswers,
    ...(state.locked === undefined ? {} : { locked: state.locked }),
    ...(Object.keys(fields).length === 0 ? {} : { fields }),
  }
}

/** 复制节点树并递归移除密码默认值。 */
function sanitizeNodes(items: GenuiNode[], secretIds: Set<string>): GenuiNode[] {
  return items.map((item) => {
    const node = JSON.parse(JSON.stringify(item)) as GenuiNode & Record<string, unknown>
    if (node.type === 'input' && node.inputType === 'password') {
      if (typeof node.id === 'string') secretIds.add(node.id)
      delete node.value
    }
    if (Array.isArray(node.items)) {
      if (node.type === 'list') {
        // list 的 items 元素可能是字符串/记录/节点；只对带 type 的节点做密码清理。
        node.items = node.items.map((child): GenuiListElement => {
          if (typeof child === 'object' && 'type' in child) {
            const [sanitized] = sanitizeNodes([child], secretIds)
            if (sanitized !== undefined) return sanitized
          }
          return child
        })
      } else {
        node.items = sanitizeNodes(node.items as GenuiNode[], secretIds)
      }
    }
    if (Array.isArray(node.tabs)) {
      // tabs 经 JSON 克隆后形如 GenuiTab；显式标注形状供 items 递归清理。
      node.tabs = (node.tabs as Array<{ items: GenuiNode[] }>).map(
        tab => ({ ...tab, items: sanitizeNodes(tab.items, secretIds) }),
      )
    }
    if (node.type === 'table' && Array.isArray(node.details)) {
      node.details = node.details.map(row => row === null ? null : sanitizeNodes(row, secretIds))
    }
    return node
  })
}

/** 创建规范化 artifact，并清除密码默认值及对应的持久化字段。 */
export function createGenuiArtifact(
  spec: GenuiSpec,
  state?: BlockInteractionState,
  options: CreateGenuiArtifactOptions = {},
): GenuiArtifactV1 {
  const processed = processGenuiSpec(spec)
  if (processed.spec === null) throw new GenuiExportError('artifact-invalid', 'invalid GenUI spec')
  const { panel: _panel, append: _append, ...portableSpec } = processed.spec
  const secretIds = new Set<string>()
  const sanitizedSpec = { ...portableSpec, items: sanitizeNodes(portableSpec.items, secretIds) }
  const theme: GenuiArtifactTheme = options.theme ?? (typeof document !== 'undefined' && document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light')
  const sanitizedState = safeState(state, secretIds)
  return {
    format: GENUI_ARTIFACT_FORMAT,
    version: GENUI_ARTIFACT_VERSION,
    spec: sanitizedSpec,
    ...(sanitizedState === undefined ? {} : { state: sanitizedState }),
    presentation: { locale: options.locale ?? currentLocale(), theme },
  }
}
