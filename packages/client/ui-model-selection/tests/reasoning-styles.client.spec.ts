import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(fileURLToPath(new URL('../src/client/ModelSelect.module.css', import.meta.url)), 'utf8')

describe('推理等级星点样式', () => {
  it('让 Ultra 星点轻微闪烁，并在减少动态效果时保持静态', () => {
    expect(styles).toMatch(/\.toneUltra \.sliderFill::after\s*\{[^}]*pointer-events:\s*none/u)
    expect(styles).toMatch(/\.toneUltra \.sliderFill::after\s*\{[^}]*animation:\s*dsh-reasoning-stars-twinkle/u)
    expect(styles).toMatch(/@keyframes dsh-reasoning-stars-twinkle\s*\{[\s\S]*filter:\s*brightness/u)

    const reducedMotion = styles.slice(styles.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reducedMotion).toMatch(/\.toneUltra \.sliderFill::after\s*\{[\s\S]*animation:\s*none/u)
  })
})
