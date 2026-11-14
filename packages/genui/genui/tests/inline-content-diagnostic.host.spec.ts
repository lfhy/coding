import { expect, it } from 'vitest'
import { collectInlineContentWarnings } from '../src/plugin/inline-content-diagnostic.ts'

it('检查话题引导所有可见文字与预设消息中的块级语法', () => {
  const warnings = collectInlineContentWarnings({ items: [{
    type: 'topic-guide', id: 'next', question: '继续？\n| 话题 | 说明 |\n| --- | --- |',
    options: [
      { label: '```代码```', message: '第一行\n| 名称 | 值 |\n| --- | --- |' },
      { label: '普通话题', message: '继续讨论' },
    ],
    confirmLabel: '```确认```',
  }] })
  expect(warnings).toEqual([
    { path: 'items[0].question', kind: 'markdown_table', replacement: 'table' },
    { path: 'items[0].options[0].label', kind: 'fenced_code', replacement: 'code' },
    { path: 'items[0].options[0].message', kind: 'markdown_table', replacement: 'table' },
    { path: 'items[0].confirmLabel', kind: 'fenced_code', replacement: 'code' },
  ])
})
