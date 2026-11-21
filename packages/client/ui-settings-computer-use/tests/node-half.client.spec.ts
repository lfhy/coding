import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('电脑操作设置的 Host 半边', () => {
  it('不注册任何 Host 行为，命名空间由电脑控制能力持有', () => {
    expect(() => { apply() }).not.toThrow()
  })
})
