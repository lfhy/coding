import type {
  ChatConversationViewNode, ChatNodeStore, SteeringMessageNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-runtime/client'

const MAX_BLOCKS = 32
const MAX_SOURCE_LENGTH = 512
const MAX_TITLE_LENGTH = 64
const MAX_PREVIEW_LENGTH = 160

/** 当前已加载的持久用户消息在 Chat 流中的导航位置。 */
export interface ConversationAnchor {
  readonly key: string
  readonly seq: number
  readonly title: string
  readonly preview: string
}

function textPreview(
  content: UserMessageNode['content'],
  fallback: { readonly image: string; readonly empty: string },
): { title: string; preview: string } {
  let source = ''
  let hasImage = false
  for (const block of content.slice(0, MAX_BLOCKS)) {
    if (block.type === 'image') hasImage = true
    if (block.type !== 'text') continue
    const remaining = MAX_SOURCE_LENGTH - source.length
    if (remaining <= 0) break
    source += block.text.slice(0, remaining)
  }

  const trimmed = source.trim()
  if (trimmed === '') {
    const label = hasImage ? fallback.image : fallback.empty
    return { title: label, preview: label }
  }
  const firstLine = (trimmed.split(/\r?\n/, 1)[0] ?? '').replace(/\s+/g, ' ').trim()
  return {
    title: firstLine.slice(0, MAX_TITLE_LENGTH),
    preview: trimmed.replace(/\s+/g, ' ').slice(0, MAX_PREVIEW_LENGTH),
  }
}

/**
 * 只从当前已加载且可见的持久人类消息生成导航项，不读取待处理队列或写入会话日志。
 * @param order - Chat 快照中的已加载节点顺序。
 * @param nodes - 按稳定节点 key 查询当前快照的存储。
 * @param fallback - 图片消息和空消息的本地化文案。
 * @returns 与加载窗口顺序一致的导航项。
 */
export function buildConversationAnchors(
  order: readonly string[],
  nodes: Pick<ChatNodeStore, 'get'>,
  fallback: { readonly image: string; readonly empty: string },
): readonly ConversationAnchor[] {
  const anchors: ConversationAnchor[] = []
  const seen = new Set<string>()
  for (const key of order) {
    if (seen.has(key)) continue
    seen.add(key)
    const node: ChatConversationViewNode | undefined = nodes.get(key)
    if (node?.visibility !== 'visible' || (node.kind !== 'user' && node.kind !== 'steering')) continue
    const data = node.data as UserMessageNode | SteeringMessageNode
    anchors.push({ key: node.key, seq: data.seq, ...textPreview(data.content, fallback) })
  }
  return anchors
}
