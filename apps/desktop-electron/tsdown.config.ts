import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['src/main.ts'],
    outDir: 'lib',
    format: 'esm',
    fixedExtension: false,
    platform: 'node',
    target: 'node22',
    deps: {
      alwaysBundle: ['ws', 'coding-home-paths', /^coding-browser-electron(?:\/|$)/u,
        /^coding-attachment\/image-processing$/u],
      neverBundle: ['electron'],
    },
    dts: false,
    clean: true,
  },
  {
    entry: ['src/preload.ts'],
    outDir: 'lib',
    format: 'cjs',
    fixedExtension: true,
    platform: 'node',
    target: 'node22',
    deps: { neverBundle: ['electron'] },
    dts: false,
    clean: false,
  },
])
