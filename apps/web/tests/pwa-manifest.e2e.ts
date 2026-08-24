import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  expect(manifest).toEqual({
    id: '/',
    name: 'Coding',
    short_name: 'Coding',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [{
      src: '/favicon.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any',
    }, {
      src: '/favicon.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any',
    }],
  })
})

it('ships the app logo as the site favicon', async () => {
  // 位图 logo 以内嵌 PNG 打包进 SVG，保证任何环境下浏览器都能渲染同一标识。
  const favicon = await readFile(join(DIST_ROOT, 'favicon.svg'), 'utf8')
  expect(favicon).toMatch(/<image[^>]*href="data:image\/png;base64,/)

  const png = await readFile(join(DIST_ROOT, 'favicon.png'))
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
})
