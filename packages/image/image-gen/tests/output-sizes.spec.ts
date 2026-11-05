import { describe, expect, it } from 'vitest'
import { outputSizes, validateImageOutput, validateOutputSizes } from '../src/output-sizes.ts'

describe('图像尺寸表', () => {
  it('沿用原版兼容接口默认比例，支持自定义档位', () => {
    expect(outputSizes()).toEqual({ '1:1': { '1K': '1024x1024' }, '2:3': { '1K': '1024x1536' }, '3:2': { '1K': '1536x1024' } })
    const sizes = { '16:9': { '2K': '2048x1152', '1K': '1536x864' }, '1:1': { '1K': '1024x1024' } }
    validateOutputSizes(sizes)
    expect(outputSizes(sizes)).toEqual({ '1:1': { '1K': '1024x1024' }, '16:9': { '1K': '1536x864', '2K': '2048x1152' } })
    expect(() => { validateImageOutput('2048x1152', 'high', sizes) }).not.toThrow()
    expect(() => { validateImageOutput('1024x1536', undefined, sizes) }).toThrow(/当前比例/)
  })

  it('拒绝未知比例、越界尺寸与质量，不把无效值交给上游', () => {
    expect(() => { validateOutputSizes({ '2:1': { '1K': '1024x512' } }) }).toThrow(/比例/)
    expect(() => { validateOutputSizes({ '1:1': { '8K': '8192x8192' } }) }).toThrow(/分辨率/)
    expect(() => { validateImageOutput(undefined, 'ultra') }).toThrow(/质量/)
  })
})
