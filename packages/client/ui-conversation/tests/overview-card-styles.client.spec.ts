import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const overviewCss = readFileSync(fileURLToPath(new URL('../src/client/skeleton/OverviewCard.module.css', import.meta.url)), 'utf8')
const sidebarCss = readFileSync(fileURLToPath(new URL('../../ui-sidebar/src/client/SidebarRoot.module.css', import.meta.url)), 'utf8')

/** 概览卡与侧栏使用相同的主题底色，预设和壁纸切换时保持同步。 */
describe('会话概览卡表面', () => {
  it('与左侧边栏共享背景变量', () => {
    const overview = overviewCss.match(/\.card\s*\{[^}]*\bbackground:\s*var\((--dsw-[\w-]+)\);/)?.[1]
    const sidebar = sidebarCss.match(/\.root\s*\{[^}]*\bbackground:\s*var\((--dsw-[\w-]+)\);/)?.[1]
    expect(overview).toBe('--dsw-specific-sidebar-fill')
    expect(overview).toBe(sidebar)
  })
})
