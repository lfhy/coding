import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')

function declarations(css: string, selector: string): string {
  const matches = css.split(`${selector} {`)
  expect(matches.length, `missing ${selector} focus rule`).toBeGreaterThan(1)
  return matches.at(-1)?.split('}')[0] ?? ''
}

describe('输入控件焦点样式', () => {
  it('给没有组件专属焦点样式的输入控件保留主题色键盘焦点圈', () => {
    const rule = declarations(read('../src/styles/base.css'), ":where(input:not([type='checkbox']):not([type='radio']), textarea, select):focus-visible")
    expect(rule).toContain('outline: 2px solid var(--dsw-alias-state-business-primary)')
    expect(rule).toContain('outline-offset: 2px')
  })

  it('可用的复选框和单选框聚焦时使用蓝色焦点圈', () => {
    const fallback = declarations(read('../src/styles/base.css'), ":where(input[type='checkbox'], input[type='radio']):focus-visible:not(:disabled)")
    expect(fallback).toContain('outline: 2px solid var(--dsw-alias-state-business-primary)')
    expect(fallback).toContain('outline-offset: 2px')

    const confirmation = declarations(read('../../ui-primitives/src/RiskConfirmation.module.css'), '.acknowledgement input:focus-visible')
    expect(confirmation).toContain('outline: 2px solid var(--dsw-alias-state-business-primary)')
    expect(confirmation).not.toContain('--dsw-alias-border-l4')
  })

  it('欢迎框和其他输入组件聚焦时不再使用近黑的主品牌色边框', () => {
    const cases = [
      ['../../ui-settings-models/src/client/ModelsSection.module.css', '.input:focus'],
      ['../../ui-primitives/src/Input.module.css', '.wrap:focus-within'],
      ['../../ui-settings-plugins/src/client/fields.module.css', '.input:focus-visible'],
      ['../../ui-agent-preset/src/client/AgentPresetSection.module.css', '.input:focus'],
      ['../../ui-workspace/src/client/RemoteSshWizard.module.css', '.privateKey:focus'],
    ] as const

    for (const [path, selector] of cases) {
      const rule = declarations(read(path), selector)
      expect(rule).toContain('border-color: var(--dsw-alias-state-business-primary)')
      expect(rule).toContain('box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)')
      expect(rule).not.toContain('--dsw-alias-brand-primary')
    }
  })

  it('去掉原生 outline 的输入框仍通过自身或外壳提示键盘焦点', () => {
    const cases = [
      ['../../ui-workspace/src/client/WorkspaceBrowser.module.css', '.searchExpanded:focus-within'],
      ['../../ui-workspace/src/client/WorkspaceBrowser.module.css', '.renameInput:focus-visible'],
      ['../../ui-directory-picker-browse/src/client/DirectoryBrowser.module.css', '.crumbBar:has(.pathInput:focus-visible)'],
      ['../../ui-directory-picker-browse/src/client/DirectoryBrowser.module.css', '.createInput:focus-visible'],
      ['../../ui-commands/src/client/PopupSelectView.module.css', '.search:focus-visible'],
      ['../../ui-conversation/src/client/skeleton/InputBar.module.css', '.card:focus-within'],
      ['../../ui-conversation/src/client/skeleton/HeroShell.module.css', '.modalInput:focus-visible'],
      ['../../ui-workspace/src/client/rows/Rows.module.css', '.renameInput:focus-visible'],
      ['../../ui-open-in-app/src/client/WorkspaceWorkbench.module.css', '.search:focus-within'],
      ['../../ui-user-questions/src/client/QuestionComposer.module.css', '.customRow:has(.customInput:focus-visible)'],
    ] as const

    for (const [path, selector] of cases) {
      const rule = declarations(read(path), selector)
      expect(rule).toContain('border-color: var(--dsw-alias-state-business-primary)')
      expect(rule).toContain('box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)')
    }
  })

  it('焦点色随浅色与深色主题分别选择可见的业务色', () => {
    const theme = read('../src/styles/design-platform.css')
    expect(declarations(theme, 'body')).toContain('--dsw-alias-state-business-primary: var(--dsw-static-deepseek-500)')
    expect(declarations(theme, 'body[data-ds-dark-theme]')).toContain('--dsw-alias-state-business-primary: var(--dsw-static-deepseek-400)')
  })
})
