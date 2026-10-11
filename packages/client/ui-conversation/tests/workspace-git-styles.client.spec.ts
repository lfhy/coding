import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const branchCss = readFileSync(fileURLToPath(new URL('../src/client/skeleton/WorkspaceGit.module.css', import.meta.url)), 'utf8')
const chipCss = readFileSync(fileURLToPath(new URL('../src/client/skeleton/HeroShell.module.css', import.meta.url)), 'utf8')

/** 工作区和 Git 两枚入口的图标与文字应使用同一主题色角色。 */
describe('Hero 工作区行 Git 入口样式', () => {
  it('分支名称与图标沿用工作区 chip 的主文字色', () => {
    const branchColor = branchCss.match(/\.trigger\s*\{[^}]*\bcolor:\s*([^;]+);/)?.[1]
    const iconColor = branchCss.match(/\.triggerIcon\s*\{[^}]*\bcolor:\s*([^;]+);/)?.[1]
    const chipColor = chipCss.match(/\.workspace\s*\{[^}]*\bcolor:\s*([^;]+);/)?.[1]
    expect(branchColor).toBe(chipColor)
    expect(iconColor).toBe(chipColor)
  })
})
