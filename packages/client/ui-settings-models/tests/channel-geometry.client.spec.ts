import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const modelCss = readFileSync(fileURLToPath(new URL('../src/client/ModelsSection.module.css', import.meta.url)), 'utf8')
const visionCss = readFileSync(fileURLToPath(new URL('../src/client/VisionSection.module.css', import.meta.url)), 'utf8')

describe('reference-size model settings geometry', () => {
  it('keeps a middle provider rail beside its provider-only detail', () => {
    expect(modelCss).toContain('grid-template-columns: minmax(220px, 27%) minmax(0, 1fr)')
    expect(modelCss).not.toContain('.generalActions')
    expect(modelCss).not.toContain('.visionDetail')
    expect(visionCss).toContain('.section {')
    expect(visionCss).toContain('max-width: 560px')
  })

  it('fits the compact discovery dialog within desktop and 375px viewports', () => {
    expect(modelCss).toContain('width: min(560px, calc(100vw - 48px))')
    expect(modelCss).toContain('.fetchDialog { width: calc(100vw - 48px); }')
    expect(modelCss).toContain('max-height: min(680px, calc(100vh - 48px))')
  })

  it('keeps desktop rows and avatars at the same compact scale as the settings navigation', () => {
    expect(modelCss).toMatch(/\.channelRow \{[^}]*min-height: 44px;[^}]*font-size: 14px;/s)
    expect(modelCss).toMatch(/\.channelAvatar \{[^}]*width: 28px;[^}]*height: 28px;[^}]*font-size: 15px;/s)
    expect(modelCss).toContain('.channelFields .input { height: 38px; }')
    expect(modelCss).not.toContain('@media (min-width: 900px)')
  })
})
