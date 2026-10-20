// @vitest-environment jsdom
/** 加载提示只显示本地化状态，不展示围栏名或未完成源码。 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { StreamingFence } from '../src/client/StreamingFence.tsx'
import { setLocale } from '../src/client/i18n/index.ts'
import { isGenuiFenceLanguage } from '../src/shared/fence-language.ts'

afterEach(cleanup)

describe('流式围栏加载提示', () => {
  it('只显示居中的本地化加载状态', () => {
    setLocale('zh')
    const view = render(<StreamingFence />)
    const status = screen.getByRole('status')
    expect(status.textContent).toBe('正在生成界面…')
    expect(view.container.textContent).toBe('正在生成界面…')
    expect(view.container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(view.container.querySelector('pre, code')).toBeNull()
    view.rerender(<StreamingFence />)
    expect(screen.getByRole('status')).toBe(status)
    act(() => { setLocale('en') })
    expect(status.textContent).toBe('Generating interface…')
  })

  it('只识别规范围栏名和历史别名', () => {
    expect(isGenuiFenceLanguage('gen-ui')).toBe(true)
    expect(isGenuiFenceLanguage('dsh-ui')).toBe(true)
    for (const language of ['json', 'coding-ui', 'gen-ui-dark', '', null, undefined]) {
      expect(isGenuiFenceLanguage(language)).toBe(false)
    }
  })
})
