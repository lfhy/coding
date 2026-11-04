import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const canvas = readFileSync(fileURLToPath(new URL('../src/client/CanvasPanel.module.css', import.meta.url)), 'utf8')
const gallery = readFileSync(fileURLToPath(new URL('../src/client/GalleryView.module.css', import.meta.url)), 'utf8')

describe('窄屏画廊与画布样式', () => {
  it('让有原生像素尺寸的画布在工作台内收缩，并保留画廊列表独立滚动', () => {
    expect(canvas).toMatch(/\.root\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0;/u)
    expect(canvas).toMatch(/\.surface\s*\{[^}]*flex:\s*1;[^}]*min-width:\s*0;/u)
    expect(canvas).toMatch(/\.canvas\s*\{[^}]*flex:\s*0 1 960px;[^}]*width:\s*100%;[^}]*min-width:\s*0;/u)
    expect(gallery).toMatch(/\.root\s*\{[^}]*min-width:\s*0;/u)
    expect(gallery).toMatch(/\.list\s*\{[^}]*min-width:\s*0;[^}]*overflow-y:\s*auto;/u)
  })
})
