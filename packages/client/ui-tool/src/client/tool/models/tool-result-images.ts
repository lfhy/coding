import type { ContentBlock } from 'coding-llm/types'
import type { ImageAttachmentRef } from 'coding-attachment'

/** Extract image references from direct or nested tool-result content. */
export function imageAttachmentsIn(content: readonly ContentBlock[]): readonly ImageAttachmentRef[] {
  const images: ImageAttachmentRef[] = []
  const visit = (blocks: readonly ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === 'image') images.push(block.attachment)
      else if (block.type === 'tool-result') visit(block.content)
    }
  }
  visit(content)
  return images
}
