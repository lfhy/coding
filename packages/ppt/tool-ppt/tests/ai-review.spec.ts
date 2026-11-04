import { describe, expect, it } from 'vitest'
import { outlineText } from '../src/ai-review.ts'

describe('AI 审阅大纲', () => {
  it('把每页压成一行摘要', () => {
    const text = outlineText('季度汇报', '16:9', 'ink', [{
      name: '封面', texts: ['季度汇报'], shapes: 1, tables: 0, charts: 0, images: 1, transition: 'fade',
    }])
    expect(text).toContain('《季度汇报》')
    expect(text).toContain('第 1 页「封面」')
    expect(text).toContain('图片 1 张')
    expect(text).toContain('转场 fade')
  })

  it('没有元素时也能描述一页', () => {
    const text = outlineText('空稿', '4:3', 'paper', [{
      name: '空白', texts: [], shapes: 0, tables: 0, charts: 0, images: 0, transition: 'none',
    }])
    expect(text).toContain('第 1 页「空白」')
    expect(text).toContain('转场 none')
  })
})
