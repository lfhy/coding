import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/NotesTabs.module.css', import.meta.url)), 'utf8')

describe('NotesTabs desktop hit regions', () => {
  it('keeps tab controls outside the native window drag region', () => {
    expect(css).toMatch(
      /\.tabs\s*:is\(button, a, input, select, textarea, \[role='button'\], \[role='tab'\]\)\s*\{[^}]*-webkit-app-region:\s*no-drag;/u,
    )
  })
})
