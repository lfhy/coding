/** 检查随 Host 分发的浏览器入口与实际 CLI 加载路径一致。 */
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const cli = new URL('../runtime/ego-linux/bin/ego-browser.mjs', import.meta.url)
const harness = new URL('../runtime/ego-browser/dist/out/index.js', import.meta.url)
const harnessSha256 = 'd5ca73e4976375dc1464bd1c3f438ada41431b815db439c0f6134d2430af85d6'

describe('Ego 浏览器运行时资源', () => {
  it('提供 CLI 实际加载的上游 harness 构建产物', async () => {
    const source = await readFile(cli, 'utf8')
    const specifier = source.match(/const HARNESS\s*=\s*new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/u)?.[1]
    if (specifier === undefined) throw new Error('ego-linux CLI 缺少静态 HARNESS 路径')

    expect(fileURLToPath(new URL(specifier, cli))).toBe(fileURLToPath(harness))
    expect((await stat(harness)).isFile()).toBe(true)
    expect(createHash('sha256').update(await readFile(harness)).digest('hex')).toBe(harnessSha256)
  })
})
