// @vitest-environment jsdom
// 已发送图片的路径说明只服务模型：用户气泡、复制文本与对话导航都不显示它。

import { afterEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from 'coding-client-test-runtime'
import { zh as commonZh } from 'coding-client-locale/src/locales/zh.ts'
import { isImageEnvelope } from 'coding-client-runtime/client'
import { PendingSteeringBubble } from '../src/client/chat/MessageItem.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)
const envelope = '<path>/home/demo/.coding/files/uploads/1-image.png</path>\n<type>image</type>\n<content>\nimage/png image, 2x3 px, 7 bytes\n</content>'
const attachment = { attachmentId: 'image-1' as never, mediaType: 'image/png' as const, bytes: 7, width: 2, height: 3 }

it('recognizes only the whole Host envelope', () => {
  expect(isImageEnvelope(envelope)).toBe(true)
  expect(isImageEnvelope('<path>look</path>')).toBe(false)
  expect(isImageEnvelope(`${envelope}\n我的补充说明`)).toBe(false)
})

it('renders the image without exposing the model-only path envelope', () => {
  const view = render(<PendingSteeringBubble
    content={[{ type: 'text', text: envelope }, { type: 'image', attachment }]}
    renderMessageImages={({ images }) => <div data-testid="images">{String(images.length)}</div>}
    t={t}
  />)
  expect(view.getByTestId('images').textContent).toBe('1')
  expect(view.container.textContent).not.toContain('.coding/files')
})
