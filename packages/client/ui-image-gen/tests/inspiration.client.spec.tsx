// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InspirationView } from '../src/client/InspirationView.tsx'
import { inspirationCases } from '../src/client/inspiration.ts'
import { createGalleryUiStore } from '../src/client/gallery-ui-store.ts'
import { zh } from '../src/client/locales.ts'

const t = (key: keyof typeof zh) => zh[key]
afterEach(cleanup)

function choose(label: string, option: string): void {
  fireEvent.click(screen.getByRole('button', { name: label }))
  fireEvent.click(screen.getByRole('menuitem', { name: option }))
}

describe('原画廊灵感索引与收藏', () => {
  it('保留两套来源的完整案例，并只引用本地缩略图', () => {
    const cases = inspirationCases()
    expect(cases).toHaveLength(976)
    expect(new Set(cases.map(item => item.id)).size).toBe(cases.length)
    expect(cases.some(item => item.sourceId === 'awesome-gpt-image-2')).toBe(true)
    expect(cases.some(item => item.sourceId === 'handraw-style')).toBe(true)
    expect(cases.every(item => /^\/api\/image-gen\/inspiration\/v1\/[a-f0-9]{16}\.webp$/u.test(item.imageUrl))).toBe(true)
    expect(cases.every(item => item.width > 0 && item.height > 0)).toBe(true)
  })

  it('检索、选中、收藏并把真实 Prompt 带入工作台', () => {
    const favorite = vi.fn()
    const use = vi.fn()
    const copy = vi.fn()
    render(<InspirationView favorites={[]} onFavorite={favorite} onUse={use} onCopy={copy} t={t} />)
    expect(screen.getByText('找到 976 个案例')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('搜索案例、Prompt、风格…'), { target: { value: '幼儿词汇拆解学习卡' } })
    expect(screen.getByText('找到 1 个案例')).toBeTruthy()
    const detail = screen.getByRole('complementary', { name: '灵感详情' })
    expect(detail.querySelector('textarea')?.value).toContain('vocabulary poster')
    fireEvent.click(detail.querySelector('button[aria-label="加入收藏"]')!)
    expect(favorite).toHaveBeenCalledWith('awesome-gpt-image-2:544')
    fireEvent.click(screen.getByRole('button', { name: '带入工作台' }))
    expect(use).toHaveBeenCalledWith(expect.stringContaining('vocabulary poster'))
    fireEvent.click(screen.getByRole('button', { name: '复制 Prompt' }))
    expect(copy).toHaveBeenCalled()
  })

  it('来源与分类复用工作台菜单，并随来源切换重置分类', () => {
    const cases = inspirationCases()
    const awesome = cases.filter(item => item.sourceId === 'awesome-gpt-image-2')
    const handdraw = cases.filter(item => item.sourceId === 'handraw-style')
    const category = awesome.find(item => item.category !== '')!.category
    render(<InspirationView favorites={[]} onFavorite={vi.fn()} onUse={vi.fn()} onCopy={vi.fn()} t={t} />)
    expect(screen.queryByRole('combobox')).toBeNull()
    expect(screen.getByRole('button', { name: '来源' }).textContent).toBe('全部来源')
    expect(screen.getByRole('button', { name: '分类' }).textContent).toBe('全部分类')
    choose('来源', 'GPT Image 2')
    expect(screen.getByText(`找到 ${awesome.length} 个案例`)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '分类' }))
    expect(screen.getByRole('menu').style.maxHeight).toBe('min(320px, calc(100vh - 24px))')
    expect(screen.getAllByRole('menuitem').map(item => item.textContent))
      .toEqual(['全部分类', ...[...new Set(awesome.map(item => item.category))].filter(Boolean).sort()])
    fireEvent.click(screen.getByRole('menuitem', { name: category }))
    expect(screen.getByText(`找到 ${awesome.filter(item => item.category === category).length} 个案例`)).toBeTruthy()
    expect(screen.getByRole('button', { name: '分类' }).textContent).toBe(category)
    choose('来源', '手绘风格')
    expect(screen.getByText(`找到 ${handdraw.length} 个案例`)).toBeTruthy()
    expect(screen.getByRole('button', { name: '分类' }).textContent).toBe('全部分类')
    fireEvent.click(screen.getByRole('button', { name: '分类' }))
    expect(screen.getAllByRole('menuitem').map(item => item.textContent))
      .toEqual(['全部分类', ...[...new Set(handdraw.map(item => item.category))].filter(Boolean).sort()])
    fireEvent.click(screen.getByRole('menuitem', { name: '全部分类' }))
    choose('来源', '全部来源')
    expect(screen.getByText('找到 976 个案例')).toBeTruthy()
  })

  it('会话级收藏和隐藏不修改持久图库目录', () => {
    const instance = createGalleryUiStore().create()
    instance.actions.toggleFavorite('one')
    instance.actions.hide(['two'])
    instance.actions.toggleInspirationFavorite('handraw-style:s-001')
    expect(instance.store.getSnapshot()).toEqual({
      favorites: ['one'], hidden: ['two'], inspirationFavorites: ['handraw-style:s-001'],
    })
  })
})
