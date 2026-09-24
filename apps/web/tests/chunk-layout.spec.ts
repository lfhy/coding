import { expect, it } from 'vitest'
import { loadConfigFromFile } from 'vite'
import { fileURLToPath } from 'node:url'

const loaded = await loadConfigFromFile(
  { command: 'build', mode: 'production' },
  fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
)
if (loaded === null) throw new Error('Web Vite config was not loaded')
const config = loaded.config
const output = config.build?.rollupOptions?.output
if (output === undefined || Array.isArray(output)) throw new Error('Web build must define one output')
const manualChunks = output.manualChunks

if (typeof manualChunks !== 'function') throw new Error('Web build must classify vendor modules')
const classify = (id: string) => manualChunks(id, {} as Parameters<typeof manualChunks>[1])

const npmModule = (name: string, file = 'dist/index.js'): string =>
  `/repo/node_modules/.pnpm/placeholder/node_modules/${name}/${file}`

it('caches unrelated synchronous rendering families independently', () => {
  expect(classify(npmModule('katex'))).toBe('vendor-math')
  expect(classify(npmModule('shiki'))).toBe('vendor-highlight')
  expect(classify(npmModule('mdast-util-from-markdown'))).toBe('vendor-markdown')
  expect(classify(npmModule('micromark-extension-gfm'))).toBe('vendor-markdown')
  expect(classify(npmModule('react/jsx-runtime'))).toBeUndefined()
  expect(classify('/repo/packages/client/ui-primitives/lib/index.js')).toBeUndefined()
})

it('keeps boot grammars cached while deferring all other read-card grammars', () => {
  for (const name of ['typescript', 'shellscript', 'json']) {
    expect(classify(npmModule('@shikijs/langs', `dist/${name}.mjs`))).toBe('vendor-highlight')
  }
  for (const name of ['python', 'cpp', 'cpp-macro']) {
    expect(classify(npmModule('@shikijs/langs', `dist/${name}.mjs`))).toBeUndefined()
  }
  expect(config.build?.chunkSizeWarningLimit).toBe(650)
})
