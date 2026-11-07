import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const canvas = readFileSync(fileURLToPath(new URL('../src/client/CanvasPanel.module.css', import.meta.url)), 'utf8')
const gallery = readFileSync(fileURLToPath(new URL('../src/client/GalleryView.module.css', import.meta.url)), 'utf8')
const selectMenu = readFileSync(fileURLToPath(new URL('../src/client/SelectMenu.module.css', import.meta.url)), 'utf8')
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
  it('工作台胶囊按中间预览列而不是整页宽度居中', () => {
    const studioTabs = gallery.slice(gallery.indexOf(".root[data-tab='studio'] .tabsBar"))
    expect(studioTabs).toMatch(/grid-template-columns:\s*minmax\(160px, 210px\)/u)
    expect(studioTabs).toMatch(/minmax\(0, 1fr\) minmax\(260px, 310px\)/u)
    expect(gallery).toMatch(/\.root\[data-tab='studio'\] \.tabs\s*\{[^}]*grid-column:\s*2;[^}]*justify-self:\s*center;/u)
    const narrow = gallery.slice(gallery.indexOf('@media (max-width: 1100px)'))
    expect(narrow).toMatch(/minmax\(120px, 170px\) minmax\(0, 1fr\);/u)
  })
  it('预览工具悬浮在图片区域右下角', () => {
    expect(gallery).toMatch(/\.previewPane\s*\{[^}]*position:\s*relative;[^}]*flex:\s*1;/u)
    expect(gallery).toMatch(/\.previewControls\s*\{[^}]*position:\s*absolute;[^}]*right:\s*12px;[^}]*bottom:\s*12px;/u)
    expect(gallery).toMatch(/\.previewImage\s*\{[^}]*width:\s*auto;[^}]*height:\s*auto;/u)
    expect(gallery).toMatch(
      /\.previewImage\s*\{[^}]*max-width:\s*100%;[^}]*max-height:\s*100%;[^}]*object-fit:\s*contain;/u,
    )
  })
  it('生成方式和输出参数都铺满表单列宽', () => {
    const studioMode = gallery.slice(gallery.indexOf('.studioMode'), gallery.indexOf('\n.studioMode > button'))
    expect(studioMode).toMatch(/display:\s*grid;/u)
    expect(studioMode).toMatch(/grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/u)
    expect(studioMode).toMatch(/align-self:\s*stretch;/u)
    expect(gallery).toMatch(/\.studioMode > button\s*\{[^}]*width:\s*100%;/u)
    expect(selectMenu).toMatch(/\.root\s*\{[^}]*width:\s*100%;/u)
    expect(selectMenu).toMatch(/\.root > span\s*\{[^}]*display:\s*flex;[^}]*width:\s*100%;/u)
  })
  it('顶部不包含独立返回按钮，生成加载动画尊重减少动态效果', () => {
    expect(gallery).not.toContain('.tabBack')
    expect(gallery).toMatch(/\.loadingSpinner\s*\{[^}]*animation:\s*image-gen-loading-spin/u)
    expect(gallery).toMatch(/@keyframes image-gen-loading-spin\s*\{[^}]*rotate\(360deg\)/u)
    const reduced = gallery.slice(gallery.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\.loadingSpinner\s*\{[^}]*animation:\s*none;/u)
  })
})
