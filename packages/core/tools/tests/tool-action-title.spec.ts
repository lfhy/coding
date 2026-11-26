import { describe, expect, it } from 'vitest'
import { toolActionTitle, toolCallPreview } from '../src/tool-action-title.ts'

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

describe('删除调用的动作与目标', () => {
  it('单个路径显示目标，多个路径显示首个路径和数量', () => {
    expect(toolArgsPreviewOf({ file_path: 'src/a.ts' })).toBe('src/a.ts')
    expect(toolArgsPreviewOf({ file_path: ['src/a.ts', 'src/b.ts'] })).toBe('src/a.ts 等 2 个文件')
  })

  it('没有可用目标时不给预览，动作标题仍固定为删除', () => {
    expect(toolArgsPreviewOf({ file_path: [] })).toBeUndefined()
    expect(toolArgsPreviewOf({ file_path: [1, null] })).toBeUndefined()
    expect(toolArgsPreviewOf({})).toBeUndefined()
    expect(toolActionTitle('delete_file')).toBe('Delete')
  })

  it('已有友好说明时把目标放在前面，不让说明遮住文件', () => {
    expect(toolCallPreview('delete_file', JSON.stringify({ file_path: 'src/a.ts' }), '清理临时文件'))
      .toBe('src/a.ts · 清理临时文件')
    expect(toolCallPreview('delete_file', JSON.stringify({ file_path: 'src/a.ts' }))).toBe('src/a.ts')
  })
})

/** 用该工具自己的 JSON 参数走一遍折叠行预览。 */
function toolArgsPreviewOf(args: Record<string, unknown>): string | undefined {
  return toolCallPreview('delete_file', JSON.stringify(args))
}
