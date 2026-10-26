/** 颜色工具：解析、混色、可读性与分组色相。 */
import { describe, expect, it } from 'vitest'
import {
  blendOnto, hueOf, luminance, parseColor, readableOn, shade, toHex, withAlpha,
} from '../src/themes/color.ts'

describe('theme color helpers', () => {
  it('parses hex, shorthand hex, alpha hex, and rgb()/rgba()', () => {
    expect(parseColor('#abc')).toEqual({ r: 170, g: 187, b: 204, a: 1 })
    expect(parseColor('#11223380')?.a).toBeCloseTo(0.502, 2)
    expect(parseColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30, a: 1 })
    expect(parseColor('rgba(10, 20, 30, 0.4)')?.a).toBeCloseTo(0.4)
    expect(parseColor('hsl(1 2% 3%)')).toBeUndefined()
    expect(parseColor('transparent')).toBeUndefined()
    expect(parseColor(undefined)).toBeUndefined()
  })

  it('dilutes colors and keeps their hue', () => {
    expect(withAlpha('#112233', 0.5)).toBe('rgba(17, 34, 51, 0.5)')
    expect(withAlpha('rgba(17, 34, 51, 0.5)', 0.5)).toBe('rgba(17, 34, 51, 0.25)')
    expect(withAlpha('nope', 0.5)).toBeUndefined()
    expect(toHex({ r: 300, g: -20, b: 12.4, a: 1 })).toBe('#ff000c')
  })

  it('shifts lightness in the direction of the active scheme', () => {
    expect(shade('#404040', 0.5, true)).toBe('#a0a0a0')
    expect(shade('#404040', 0.5, false)).toBe('#202020')
    expect(shade('nope', 0.5, true)).toBeUndefined()
  })

  it('picks readable text on a background', () => {
    expect(readableOn('#ffffff')).toBe('#141414')
    expect(readableOn('#101010')).toBe('#f4f4f5')
    expect(readableOn('not-a-color')).toBe('#141414')
    expect(luminance('#ffffff')).toBeCloseTo(1)
    expect(luminance(undefined)).toBe(0)
  })

  it('blends translucent colors onto a base', () => {
    expect(blendOnto('rgba(255, 255, 255, 0.5)', '#000000')).toBe('#808080')
    expect(blendOnto('transparent', '#000000')).toBe('transparent')
    expect(blendOnto('#123456', undefined)).toBe('#123456')
  })

  it('maps hues onto the documented color families', () => {
    expect(hueOf('#ff2200')).toBeLessThan(35)
    expect(hueOf('#22ff00')).toBeGreaterThan(90)
    expect(hueOf('#0000ff')).toBeGreaterThan(230)
    expect(hueOf('#808080')).toBe(-2)
    expect(hueOf('nope')).toBe(-1)
  })
})
