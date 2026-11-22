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

describe('办公笔记的工具行动说明', () => {
  it.each([
    ['read', '读取办公笔记'],
    ['create', '新建办公笔记'],
    ['edit', '编辑办公笔记'],
    ['export', '导出办公笔记'],
  ])('在 %s 调用中显示 %s', (action, title) => {
    expect(toolActionTitle('notes_office', JSON.stringify({ action, path: 'hidden' }))).toBe(title)
  })

  it('参数尚未闭合或动作未知时显示通用标题', () => {
    expect(toolActionTitle('notes_office', '{"action":')).toBe('操作办公笔记')
    expect(toolActionTitle('notes_office', '{"action":"future"}')).toBe('操作办公笔记')
  })
})
