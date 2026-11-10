import { describe, expect, it } from 'vitest'
import { outputSizes, resolveOutputSize, validateImageOutput, validateOutputSizes } from '../src/output-sizes.ts'

describe('图像尺寸表', () => {
  it('沿用原版兼容接口默认比例，支持自定义档位', () => {
    expect(outputSizes()).toEqual({ '1:1': { '1K': '1024x1024' }, '2:3': { '1K': '1024x1536' }, '3:2': { '1K': '1536x1024' } })
    const sizes = { '16:9': { '2K': '2048x1152', '1K': '1536x864' }, '1:1': { '1K': '1024x1024' } }
    validateOutputSizes(sizes)
    expect(outputSizes(sizes)).toEqual({ '1:1': { '1K': '1024x1024' }, '16:9': { '1K': '1536x864', '2K': '2048x1152' } })
    expect(() => { validateImageOutput('2048x1152', 'high', sizes) }).not.toThrow()
    expect(() => { validateImageOutput('1024x1536', undefined, sizes) }).toThrow(/当前比例/)
  })

  it('把模型给的比例与档位解析成像素尺寸，越界时列出可用组合', () => {
    const sizes = { '16:9': { '2K': '2048x1152', '1K': '1280x720' }, '1:1': { '1K': '1024x1024' } }
    // 只给比例取最小档位；两项都不给表示沿用上游默认。
    expect(resolveOutputSize(sizes, '16:9')).toBe('1280x720')
    expect(resolveOutputSize(sizes, '16:9', '2K')).toBe('2048x1152')
    expect(resolveOutputSize(sizes)).toBeUndefined()
    expect(() => { resolveOutputSize(sizes, '1:1', '4K') }).toThrow(/1K/)
    expect(() => { resolveOutputSize(sizes, '3:2') }).toThrow(/16:9=1K\/2K/)
    expect(() => { resolveOutputSize(sizes, undefined, '1K') }).toThrow(/aspectRatio/)
    // 空表即默认三比例。
    expect(resolveOutputSize({}, '2:3')).toBe('1024x1536')
  })

  it('拒绝未知比例、越界尺寸与质量，不把无效值交给上游', () => {
    expect(() => { validateOutputSizes({ '2:1': { '1K': '1024x512' } }) }).toThrow(/比例/)
    expect(() => { validateOutputSizes({ '1:1': { '8K': '8192x8192' } }) }).toThrow(/分辨率/)
    expect(() => { validateImageOutput(undefined, 'ultra') }).toThrow(/质量/)
  })
})
