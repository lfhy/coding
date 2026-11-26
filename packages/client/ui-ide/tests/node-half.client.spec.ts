import { describe, expect, it, vi } from 'vitest'
import { apply as applyNode } from '../src/index.ts'
import { apply as applyInvariant, inject, name } from '../src/invariant.ts'

describe('ui-ide node halves', () => {
  it('浏览器包的服务端半不注册能力', () => {
    expect(applyNode).toBeTypeOf('function')
    applyNode()
  })

  it('companion 登记包名并返回所属注销句柄', async () => {
    const dispose = vi.fn()
    const register = vi.fn((_packageName: string, _install: () => void) => dispose)
    const result = await applyInvariant({ invariants: { register } } as never)

    expect(name).toBe('client-ui-ide-invariant')
    expect(inject).toEqual(['invariants'])
    expect(register).toHaveBeenCalledWith('coding-client-ui-ide', expect.any(Function))
    register.mock.calls[0]?.[1]()
    expect(result).toBe(dispose)
  })
})
