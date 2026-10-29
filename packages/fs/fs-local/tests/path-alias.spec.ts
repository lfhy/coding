/**
 * 本地后端（单后端部署）对虚拟路径前缀的支持：模型按前缀读到的内容来自真实目录，
 * 而返回给它的 `displayPath`、目录列出的子项路径都保持前缀形式。
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from 'coding-fs-local'

let dir: string
let assets: string
let ctx: Context
let fs: LocalFileSystem
let fiber: Awaited<ReturnType<Context['plugin']>>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-fs-alias-'))
  assets = join(dir, 'assets')
  await mkdir(join(assets, 'styles'), { recursive: true })
  await writeFile(join(assets, 'styles', 'demo.json'), '{"name":"demo"}', 'utf8')
  ctx = new Context()
  fiber = await ctx.plugin(LocalFileSystem, { cwd: dir })
  fs = ctx.fs as LocalFileSystem
})
afterEach(async () => {
  await fiber.dispose()
  await rm(dir, { recursive: true, force: true })
})

describe('local filesystem path aliases', () => {
  it('reads a prefixed target from the real directory and reports the virtual path', async () => {
    fs.registerPathAlias('${INTERNAL_SKILL_DIR}/demo', assets)
    const target = await fs.resolve('${INTERNAL_SKILL_DIR}/demo/styles/demo.json')
    expect(target.displayPath).toBe('${INTERNAL_SKILL_DIR}/demo/styles/demo.json')
    expect(await fs.readText(target)).toBe('{"name":"demo"}')
    const info = await fs.stat(target)
    expect(info?.type).toBe('file')
  })

  it('lists child targets under the virtual prefix', async () => {
    fs.registerPathAlias('${INTERNAL_SKILL_DIR}/demo', assets)
    const root = await fs.resolve('${INTERNAL_SKILL_DIR}/demo')
    const entries = await fs.listDir(root)
    expect(entries.map(entry => entry.name)).toEqual(['styles'])
    expect(entries[0]?.target.displayPath).toBe('${INTERNAL_SKILL_DIR}/demo/styles')
  })

  it('stops treating the prefix as virtual once the registration is disposed', async () => {
    const stop = fs.registerPathAlias('${INTERNAL_SKILL_DIR}/demo', assets)
    stop()
    // 撤回后前缀退回普通相对路径语义：既不展开到资产目录，也读不到文件。
    const target = await fs.resolve('${INTERNAL_SKILL_DIR}/demo/styles/demo.json')
    expect(target.displayPath).toBe(join(dir, '${INTERNAL_SKILL_DIR}/demo/styles/demo.json'))
    await expect(fs.stat(target)).resolves.toBeUndefined()
  })
})
