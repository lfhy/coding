import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const modelCss = readFileSync(fileURLToPath(new URL('../src/client/ModelsSection.module.css', import.meta.url)), 'utf8')

describe('reference-size model settings geometry', () => {
  it('keeps a middle provider rail beside the mutually exclusive right detail', () => {
    expect(modelCss).toContain('grid-template-columns: minmax(220px, 27%) minmax(0, 1fr)')
    expect(modelCss).toContain('.generalActions')
    expect(modelCss).toContain('.visionDetail')
  })

  it('fits the wide discovery dialog within desktop and 375px viewports', () => {
    expect(modelCss).toContain('width: min(1500px, calc(100vw - 96px))')
    expect(modelCss).toContain('.fetchDialog { width: calc(100vw - 24px); max-width: calc(100vw - 24px); }')
  })
})
