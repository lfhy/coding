import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from 'coding-client-locale/client'
import { SlotRegistry } from 'coding-client-runtime/client'
import type { PropsRenderSlots } from 'coding-client-ui-slots'
import { expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import { apply as invariantApply } from '../src/invariant.ts'

it('等待笔记声明，随声明重挂，并在贡献者卸载时清理', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SlotRegistry).await()
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
    const plugin = ctx.plugin({ apply, inject })
    await plugin.await()
    const slot = 'notes.document.mindmap'
    const owner = ({ renderSlot }: PropsRenderSlots<typeof slot>) => renderSlot(slot, { path: '示例.codingmindmap', shown: false })
    const declare = () => ctx.slots.register({ name: 'root', children: { [slot]: { kind: 'single', scope: 'session' } } }, owner)
    expect(ctx.slots.entries(slot)).toHaveLength(0)

    const dispose = declare()
    expect(ctx.slots.entries(slot).map(entry => entry.locale)).toEqual(['mindmap'])
    dispose()
    expect(ctx.slots.entries(slot)).toHaveLength(0)

    declare()
    expect(ctx.slots.entries(slot)).toHaveLength(1)
    await plugin.dispose()
    expect(ctx.slots.entries(slot)).toHaveLength(0)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('Node 入口无需文件服务；伴生插件登记本包归属', async () => {
  expect(nodeApply).not.toThrow()
  const dispose = vi.fn()
  const register = vi.fn((_name: string, install: () => void) => {
    install()
    return dispose
  })
  await expect(invariantApply({ invariants: { register } } as unknown as Parameters<typeof invariantApply>[0])).resolves.toBe(dispose)
  expect(register).toHaveBeenCalledWith('coding-client-ui-mindmap', expect.any(Function))
})
