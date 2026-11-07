// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ImageToolLoading } from '../src/client/ImageToolLoading.tsx'

afterEach(() => { cleanup(); vi.useRealTimers() })

describe('图片工具等待点阵', () => {
  it('向辅助技术提供状态文案，点阵保持装饰性且不虚构进度', () => {
    const { container } = render(<ImageToolLoading label="正在创建图像" />)
    expect(screen.getByRole('status').textContent).toBe('正在创建图像')
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(container.textContent).not.toMatch(/\d|%/u)
    expect(container.querySelector('canvas, svg, img')).toBeNull()
    expect(container.querySelectorAll('*')).toHaveLength(3)
  })

  it('文案更新不创建计时器，父组件可以直接替换为真实图片', () => {
    vi.useFakeTimers()
    const { rerender } = render(<div aria-busy="true"><ImageToolLoading label="正在创建图像" /></div>)
    expect(screen.getByRole('status').closest('[aria-busy="true"]')).toBeTruthy()
    rerender(<ImageToolLoading label="Creating image" />)
    expect(screen.getByRole('status').textContent).toBe('Creating image')
    expect(vi.getTimerCount()).toBe(0)
    rerender(<img src="/api/image-gen/image?sessionId=test&id=result" alt="生成结果" />)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('img', { name: '生成结果' }).getAttribute('src')).toContain('id=result')
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('点阵适配父级并以低节点 CSS 动效遵守减少动态偏好', () => {
    // jsdom 不绘制 CSS mask；此处检查静态约束，实际视觉由浏览器验收。
    const source = readFileSync(resolve('packages/client/ui-image-gen/src/client/ImageToolLoading.module.css'), 'utf8')
    expect(source).toMatch(/width:\s*100%/u)
    expect(source).toMatch(/aspect-ratio:\s*1/u)
    expect(source).toMatch(/mask-image:\s*radial-gradient/u)
    expect(source).toMatch(/mask-size:\s*10px 10px/u)
    expect(source).toMatch(/@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*animation:\s*none/u)
    const keyframes = [...source.matchAll(/(?:\d+%,?\s*)+\{([^}]+)\}/gu)]
    expect(keyframes).toHaveLength(4)
    for (const block of keyframes) {
      const properties = [...block[1]!.matchAll(/([\w-]+)\s*:/gu)].map(match => match[1])
      expect(properties.every(property => property === 'transform' || property === 'opacity')).toBe(true)
    }
    expect(source).not.toMatch(/#[\da-f]{3,8}\b|\brgba?\(/iu)
    expect(source).toContain('var(--dsw-alias-label-primary)')
    expect(source).toContain('var(--ds-ease-in-out)')
  })
})
