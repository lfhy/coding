import { describe, expect, it } from 'vitest'
import {
  CANONICAL_LIMITATIONS_HEADINGS,
  isCanonicalLimitationsHeading,
  isLimitationsLike,
} from './package-readme-limitations.ts'

describe('package README limitations headings', () => {
  it.each(CANONICAL_LIMITATIONS_HEADINGS)('accepts canonical heading %s', (heading) => {
    expect(isCanonicalLimitationsHeading(heading, 2)).toBe(true)
  })

  it('keeps language variants and wrong depth fail-closed', () => {
    expect(isLimitationsLike('已知限制与暂缓事项')).toBe(true)
    expect(isCanonicalLimitationsHeading('## 已知限制与暂缓事项', 2)).toBe(false)
    expect(isCanonicalLimitationsHeading('### 已知限制与延后工作', 3)).toBe(false)
    expect(isCanonicalLimitationsHeading('## Known limitations', 2)).toBe(false)
  })

  it('does not classify unrelated headings as limitations', () => {
    expect(isLimitationsLike('行为')).toBe(false)
    expect(isLimitationsLike('Model Experience')).toBe(false)
  })
})
