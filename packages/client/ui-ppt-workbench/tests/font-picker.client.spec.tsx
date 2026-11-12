// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FontPicker } from '../src/client/FontPicker.tsx'

afterEach(() => { cleanup() })

function mount(value = '', fonts: readonly string[] = ['黑体', 'Songti SC']) {
  const onChange = vi.fn()
  render(
    <FontPicker
      value={value}
      fonts={fonts}
      disabled={false}
      label="字体"
      defaultLabel="HarmonyOS Sans SC（默认）"
      searchPlaceholder="搜索字体"
      emptyHint="没有匹配的字体"
      onChange={onChange}
    />,
  )
  return { onChange, trigger: screen.getByRole('combobox', { name: '字体' }) }
}

describe('字体选择器', () => {
  it('展开后把焦点放进搜索框，并按关键字收窄候选', async () => {
    const { trigger } = mount('')
    fireEvent.click(trigger)
    const search = screen.getByRole('textbox', { name: '搜索字体' })
    await waitFor(() => { expect(document.activeElement).toBe(search) })
    // 空值表示跟随默认：默认字体排在首位，其后是本机已装族名。
    expect(within(screen.getByRole('listbox', { name: '字体' })).getAllByRole('option')).toHaveLength(3)
    fireEvent.change(search, { target: { value: 'song' } })
    const options = within(screen.getByRole('listbox', { name: '字体' })).getAllByRole('option')
    expect(options.map(option => option.textContent)).toEqual(['永和 Aa 123Songti SC'])
  })

  it('没有匹配项时给出空态提示，而不是一张空列表', () => {
    const { trigger } = mount('')
    fireEvent.click(trigger)
    const search = screen.getByRole('textbox', { name: '搜索字体' })
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.getByText('没有匹配的字体')).toBeTruthy()
    expect(within(screen.getByRole('listbox', { name: '字体' })).queryAllByRole('option')).toHaveLength(0)
  })

  it('方向键移动、回车提交，选中后收起列表', async () => {
    const { trigger, onChange } = mount('')
    fireEvent.click(trigger)
    const search = screen.getByRole('textbox', { name: '搜索字体' })
    await waitFor(() => { expect(document.activeElement).toBe(search) })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('黑体')
    expect(screen.queryByRole('listbox', { name: '字体' })).toBeNull()
  })

  it('方向键到边界后停住，Escape 收起并把焦点还给触发按钮', async () => {
    const { trigger, onChange } = mount('')
    fireEvent.click(trigger)
    const search = screen.getByRole('textbox', { name: '搜索字体' })
    await waitFor(() => { expect(document.activeElement).toBe(search) })
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('HarmonyOS Sans SC')
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('textbox', { name: '搜索字体' }), { key: 'Escape' })
    await waitFor(() => { expect(document.activeElement).toBe(trigger) })
    expect(screen.queryByRole('listbox', { name: '字体' })).toBeNull()
  })

  it('点击列表外收起，不提交任何值', () => {
    const { trigger, onChange } = mount('')
    fireEvent.click(trigger)
    expect(screen.getByRole('listbox', { name: '字体' })).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('listbox', { name: '字体' })).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('元素已有字体时按钮显示它，候选去重后仍只有一份', () => {
    const { trigger } = mount('黑体')
    expect(trigger.textContent).toContain('黑体')
    fireEvent.click(trigger)
    const options = within(screen.getByRole('listbox', { name: '字体' })).getAllByRole('option')
    // 已选族名排在最前；默认字体只在本机列表里出现时才作为候选项，不重复插入。
    expect(options.map(option => option.textContent)).toEqual([
      '永和 Aa 123黑体',
      '永和 Aa 123Songti SC',
    ])
  })

  it('禁用时按钮不可展开', () => {
    render(
      <FontPicker
        value=""
        fonts={[]}
        disabled
        label="字体"
        defaultLabel="HarmonyOS Sans SC（默认）"
        searchPlaceholder="搜索字体"
        emptyHint="没有匹配的字体"
        onChange={() => {}}
      />,
    )
    const trigger = screen.getByRole('combobox', { name: '字体' }) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    fireEvent.click(trigger)
    expect(screen.queryByRole('listbox', { name: '字体' })).toBeNull()
  })
})
