import { describe, expect, it } from 'vitest'
import { assetDirCandidates } from '../src/plugin/asset-dirs.ts'

/** 懒引擎资产只在 `lib/assets/` 产出，读取方可能来自 `lib/index.js` 或 `src/plugin`。 */
describe('懒引擎资产目录', () => {
  it('构建产物入口先读同目录的 assets', () => {
    expect(assetDirCandidates('file:///pkg/lib/index.js')[0]).toBe('/pkg/lib/assets/')
  })

  it('源码运行（tsx 加载 src/plugin）回退到同一份 lib 产物', () => {
    const [first, fallback] = assetDirCandidates('file:///pkg/src/plugin/index.ts')
    expect(first).toBe('/pkg/src/plugin/assets/')
    expect(fallback).toBe('/pkg/lib/assets/')
  })
})
