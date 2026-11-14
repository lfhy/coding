import type { ConversationSnapshot, ToolCallBlock } from 'coding-client-runtime/client'
import { backgroundStart } from 'coding-tools/tool-action-title'

/**
 * 从已加载的轨迹记录中提取后台启动任务说明，不跨越会话窗口猜测用途。
 * @param nodes - 同一会话窗口内持久化的记录及递归子调用。
 * @returns 会话身份到友好说明的索引；只信任已结算且成功的启动回执。
 */
export function backgroundTaskDescriptions(nodes: ConversationSnapshot['nodes']): ReadonlyMap<string, string> {
  const descriptions = new Map<string, string>()
  const visit = (block: ToolCallBlock): void => {
    if ('kind' in block && block.call !== null && !block.isError
      && (block.call.name === 'bash' || block.call.name === 'exec_command')) {
      const output = block.content
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('\n')
      const start = backgroundStart(block.call.name, block.call.argsRaw, output)
      if (start !== undefined) descriptions.set(start.id, start.description)
    }
    for (const child of block.subCalls) visit(child)
  }
  for (const node of nodes) {
    if (node.kind === 'tool-result') visit(node)
  }
  return descriptions
}
