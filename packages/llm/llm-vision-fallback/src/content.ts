/** 视觉降级唯一的图片替换规则，运行时与持久日志校验共用。 */

import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'

/**
 * 收集嵌套工具结果中的图片引用，顺序与模型内容一致。
 * @param blocks - 原始模型内容。
 * @param refs - 由调用方持有并追加结果的数组。
 * @returns 不返回值；将图片引用顺序追加到 refs。
 */
export function collectImages(blocks: readonly ContentBlock[], refs: ImageBlock['attachment'][]): void {
  for (const block of blocks) {
    if (block.type === 'image') refs.push(block.attachment)
    else if (block.type === 'tool-result') collectImages(block.content, refs)
  }
}

/**
 * 按图片原位替换描述，保留其余文本和工具结果字段。
 * @param blocks - 当前节点的原始内容。
 * @param descriptions - 与图片出现顺序一致的已记录描述。
 * @param position - 跨嵌套块共享的下一描述下标；调用后推进。
 * @returns 不包含原图、只改图片位置的新内容。
 */
export function substituteImages(
  blocks: readonly ContentBlock[],
  descriptions: readonly string[],
  position: { index: number },
): ContentBlock[] {
  return blocks.map((block) => {
    if (block.type === 'image') {
      const description = descriptions[position.index++]
      if (description === undefined) throw new Error('vision-understanding: image description count changed')
      return { type: 'text', text: `[Image description: ${description}]` }
    }
    if (block.type === 'tool-result') {
      return { ...block, content: substituteImages(block.content, descriptions, position) }
    }
    return block
  })
}
