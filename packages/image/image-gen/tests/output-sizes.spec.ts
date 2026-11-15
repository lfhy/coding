import { describe, expect, it } from 'vitest'
import { outputSizes, resolveOutputSize, validateImageOutput, validateOutputSizes } from '../src/output-sizes.ts'

describe('图像尺寸表', () => {
  it('默认表使用官方 popular sizes，含 2K 与 4K 档位', () => {
    expect(outputSizes()).toEqual({
      '1:1': { '1K': '1024x1024', '2K': '2048x2048' },
      '2:3': { '1K': '1024x1536' },
      '3:2': { '1K': '1536x1024' },
      '16:9': { '2K': '2048x1152', '4K': '3840x2160' },
      '9:16': { '4K': '2160x3840' },
    })
    // 默认表本身也必须落在自定义表的约束内。
    expect(() => { validateOutputSizes(outputSizes()) }).not.toThrow()
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
    // 空表即默认表：2K 只在官方给出的比例与档位里可用。
    expect(resolveOutputSize({}, '2:3')).toBe('1024x1536')
    expect(resolveOutputSize({}, '1:1', '2K')).toBe('2048x2048')
    expect(resolveOutputSize({}, '16:9', '4K')).toBe('3840x2160')
    expect(resolveOutputSize({}, '9:16', '4K')).toBe('2160x3840')
    expect(() => { resolveOutputSize({}, '2:3', '2K') }).toThrow(/2:3 不支持分辨率 2K/)
  })

  it('拒绝未知比例、越界尺寸与质量，不把无效值交给上游', () => {
    expect(() => { validateOutputSizes({ '2:1': { '1K': '1024x512' } }) }).toThrow(/比例/)
    expect(() => { validateOutputSizes({ '1:1': { '8K': '8192x8192' } }) }).toThrow(/分辨率/)
    expect(() => { validateImageOutput(undefined, 'ultra') }).toThrow(/质量/)
  })

  it('按官方约束拒绝非 16 倍数、超边长、超像素区间与过长长宽比', () => {
    expect(() => { validateOutputSizes({ '1:1': { '1K': '1024x1000' } }) }).toThrow(/16 的倍数/)
    expect(() => { validateOutputSizes({ '1:1': { '2K': '4096x4096' } }) }).toThrow(/最长边/)
    expect(() => { validateOutputSizes({ '1:1': { '1K': '512x512' } }) }).toThrow(/总像素/)
    expect(() => { validateOutputSizes({ '21:9': { '4K': '3840x1152' } }) }).toThrow(/长宽比/)
    expect(() => { validateOutputSizes({ '1:1': { '4K': '8192x4096' } }) }).toThrow(/分辨率/)
  })
})
