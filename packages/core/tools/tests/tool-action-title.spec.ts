import { describe, expect, it } from 'vitest'
import { toolActionTitle } from '../src/tool-action-title.ts'

describe('思维导图的工具行动说明', () => {
  it.each([
    ['read', '读取思维导图'],
    ['create', '新建思维导图'],
    ['edit', '编辑思维导图'],
  ])('按 %s 动作显示 %s，不泄露调用参数', (action, title) => {
    expect(toolActionTitle('notes_mindmap', JSON.stringify({ action, revision: 'internal-revision' }))).toBe(title)
  })

  it('参数尚未闭合或动作未知时只显示导图操作', () => {
    expect(toolActionTitle('notes_mindmap', '{"action":')).toBe('操作思维导图')
    expect(toolActionTitle('notes_mindmap', '{"action":"future"}')).toBe('操作思维导图')
  })
})
