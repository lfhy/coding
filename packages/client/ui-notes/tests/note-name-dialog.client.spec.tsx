// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { NoteNameDialog } from '../src/client/NoteNameDialog.tsx'
import { zh } from '../src/client/locales.ts'

type DialogProps = Parameters<typeof NoteNameDialog>[0]
const dictionary: Readonly<Record<string, string>> = zh
const t: DialogProps['t'] = (key, params) => dictionary[key]!.replace('{name}', typeof params?.name === 'string' ? params.name : '')

afterEach(() => { cleanup() })

describe('NoteNameDialog', () => {
  it('缺少 children 的目录仍可作为保存位置并提供新建子目录动作', () => {
    const onChange = vi.fn()
    render(<NoteNameDialog t={t} kind="create" name="草稿" busy={false} error={undefined}
      destination={{
        tree: [{ name: '空目录', path: '空目录', kind: 'dir', mtimeMs: 1 }, { name: 'file.md', path: 'file.md', kind: 'file', mtimeMs: 1 }],
        path: '', onChange, onCreateDirectory: vi.fn(),
      }} onNameChange={vi.fn()} onClose={vi.fn()} onSubmit={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: '新建笔记' })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存到 全部笔记' }))
    expect(within(dialog).getByRole('menuitem', { name: '在「空目录」中新建子目录' })).toBeTruthy()
    expect(within(dialog).queryByRole('menuitem', { name: 'file.md' })).toBeNull()
    fireEvent.click(within(dialog).getByRole('menuitem', { name: '空目录' }))
    expect(onChange).toHaveBeenCalledWith('空目录')
  })

  it('卸载后子目录请求才失败时不再回写错误状态', async () => {
    const pending = Promise.withResolvers<string | undefined>()
    const onCreateDirectory = vi.fn(() => pending.promise)
    const view = render(<NoteNameDialog t={t} kind="create" name="原笔记" busy={false} error={undefined}
      destination={{ tree: [], path: '', onChange: vi.fn(), onCreateDirectory }}
      onNameChange={vi.fn()} onClose={vi.fn()} onSubmit={vi.fn()} />)
    const dialog = screen.getByRole('dialog', { name: '新建笔记' })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存到 全部笔记' }))
    fireEvent.click(within(dialog).getByRole('menuitem', { name: '在「全部笔记」中新建子目录' }))
    fireEvent.change(within(dialog).getByRole('textbox', { name: '目录名称' }), { target: { value: '迟到' } })
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: '创建' })) })
    expect(onCreateDirectory).toHaveBeenCalledWith('迟到', '')
    view.unmount()
    await act(async () => { pending.reject(new Error('请求失败')) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
