import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const canvas = readFileSync(fileURLToPath(new URL('../src/client/CanvasPanel.module.css', import.meta.url)), 'utf8')
const gallery = readFileSync(fileURLToPath(new URL('../src/client/GalleryView.module.css', import.meta.url)), 'utf8')
const entry = readFileSync(fileURLToPath(new URL('../src/client/SidebarEntry.module.css', import.meta.url)), 'utf8')

describe('窄屏画廊与画布样式', () => {
  it('画图入口是 42px 整行，折叠后仍是可聚焦的 36px 图标盒', () => {
    expect(entry).toMatch(/\.wide\s*\{[^}]*width:\s*100%;[^}]*height:\s*42px;[^}]*border-radius:\s*12px;/u)
    expect(entry).toMatch(/\.rail\s*\{[^}]*width:\s*36px;[^}]*height:\s*36px;/u)
    expect(entry).toMatch(/\.wide:focus-visible,\s*\.rail:focus-visible\s*\{[^}]*outline:/u)
  })
  it('让有原生像素尺寸的画布在工作台内收缩，并保留画廊列表独立滚动', () => {
    expect(canvas).toMatch(/\.root\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*0;/u)
    expect(canvas).toMatch(/\.surface\s*\{[^}]*flex:\s*1;[^}]*min-width:\s*0;/u)
    expect(canvas).toMatch(/\.canvas\s*\{[^}]*flex:\s*0 1 960px;[^}]*width:\s*100%;[^}]*min-width:\s*0;/u)
    expect(gallery).toMatch(/\.root\s*\{[^}]*min-width:\s*0;/u)
    expect(gallery).toMatch(/\.list\s*\{[^}]*min-width:\s*0;[^}]*overflow-y:\s*auto;/u)
    const narrow = gallery.slice(gallery.indexOf('@media (max-width: 620px)'))
    expect(narrow).toMatch(/\.studioCenter\s*\{[^}]*flex:\s*none;[^}]*min-height:\s*400px;/u)
    expect(narrow).toMatch(/\.studioForm\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/u)
  })
})
