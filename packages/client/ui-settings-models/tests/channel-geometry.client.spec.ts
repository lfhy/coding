import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const modelCss = readFileSync(fileURLToPath(new URL('../src/client/ModelsSection.module.css', import.meta.url)), 'utf8')
const shellCss = readFileSync(fileURLToPath(new URL('../../ui-settings-general/src/client/SettingsRoot.module.css', import.meta.url)), 'utf8')

describe('reference-size model settings geometry', () => {
  it('gives the model section a near-viewport panel and a roughly one-quarter provider rail', () => {
    expect(shellCss).toContain('width: min(1800px, calc(100vw - 48px))')
    expect(shellCss).toContain('height: min(1320px, calc(100vh - 48px))')
    expect(modelCss).toContain('grid-template-columns: minmax(220px, 27%) minmax(0, 1fr)')
  })

  it('fits the wide discovery dialog within desktop and 375px viewports', () => {
    expect(modelCss).toContain('width: min(1500px, calc(100vw - 96px))')
    expect(modelCss).toContain('.fetchDialog { width: calc(100vw - 24px); max-width: calc(100vw - 24px); }')
  })
})
