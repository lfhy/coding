import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PPT_FORMAT, type PptDeck } from 'coding-ppt-model'
import { REMOTE_WORKSPACE_MARKER } from 'coding-subprocess'
import PptProjects from '../src/index.ts'
import { buildPptx } from '../src/export/pptx.ts'
import { publishProject, readWorkspaceFile } from '../src/template-project.ts'

const deck: PptDeck = {
  format: PPT_FORMAT, title: '副本', size: '16:9', theme: 'ink',
  pages: [{ id: 'page', name: '页', background: null, transition: 'none', elements: [
    { id: 'image', kind: 'image', x: 0, y: 0, w: 10, h: 10, fit: 'contain', source: 'media/logo.png' },
  ] }],
}

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ppt-atomic-project-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('工程原子发布', () => {
  it('缺媒体或目标已有空目录时保留目标且不留临时工程', async () => {
    const target = join(root, 'ppt', 'copy')
    await expect(publishProject(root, target, deck, [])).rejects.toMatchObject({ code: 'bad-request' })
    await mkdir(target, { recursive: true })
    await expect(publishProject(root, target, deck, [{ part: 'media/logo.png', bytes: new Uint8Array([1]) }]))
      .rejects.toMatchObject({ code: 'conflict' })
    expect((await lstat(target)).isDirectory()).toBe(true)
    expect(await readdir(target)).toEqual([])
    expect((await readdir(join(root, 'ppt'))).filter(name => name.startsWith('.ppt-project-'))).toEqual([])
  })

  it('拒绝越界和链接父目录，成功后媒体与历史一同可见', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ppt-outside-'))
    try {
      await symlink(outside, join(root, 'linked'))
      await expect(publishProject(root, join(root, 'linked', 'copy'), deck, [{ part: 'media/logo.png', bytes: new Uint8Array([1]) }]))
        .rejects.toMatchObject({ code: 'forbidden' })
      await expect(publishProject(root, join(outside, 'copy'), deck, [{ part: 'media/logo.png', bytes: new Uint8Array([1]) }]))
        .rejects.toMatchObject({ code: 'forbidden' })
      const target = join(root, 'ppt', 'copy')
      const snapshot = await publishProject(root, target, deck, [{ part: 'media/logo.png', bytes: new Uint8Array([1]) }])
      expect(snapshot).toMatchObject({ dir: target, revision: 1 })
      expect(await readFile(join(target, 'media', 'logo.png'))).toEqual(Buffer.from([1]))
      expect(await readFile(join(target, 'history.json'), 'utf8')).toContain('"nextRevision": 2')
    } finally { await rm(outside, { recursive: true, force: true }) }
  })

  it('读取导入源文件前拒绝链接与超限文件', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'ppt-outside-source-'))
    try {
      await writeFile(join(outside, 'deck.pptx'), new Uint8Array([1]))
      await symlink(join(outside, 'deck.pptx'), join(root, 'link.pptx'))
      await expect(readWorkspaceFile(root, 'link.pptx', 8)).rejects.toMatchObject({ code: 'forbidden' })
      await writeFile(join(root, 'large.pptx'), new Uint8Array(9))
      await expect(readWorkspaceFile(root, 'large.pptx', 8)).rejects.toMatchObject({ code: 'bad-request' })
    } finally { await rm(outside, { recursive: true, force: true }) }
  })

  it('工作区文件导入只保存模板，不创建工程或更换会话焦点', async () => {
    const sessionId = 'ppt-file-import'
    const ctx = new Context()
    ctx.provide('sessions', { get: (id: string) => id === sessionId ? { header: { cwd: root } } : undefined } as never)
    ctx.provide('webServer', { register: () => () => undefined } as never)
    ctx.provide('connection', { requestRejection: () => undefined } as never)
    try {
      await ctx.plugin(PptProjects, { templatesDir: join(root, 'templates') })
      const projects = ctx.pptProjects
      const source = join(root, 'source.pptx')
      await writeFile(source, buildPptx({ ...deck, pages: [{ ...deck.pages[0]!, elements: [] }] }))
      const template = await projects.importTemplateFromFile(sessionId, 'source.pptx', { name: '保存的模板' })
      expect(template).toMatchObject({ name: '保存的模板', sourceName: 'source.pptx' })
      expect(projects.activeDir(sessionId)).toBeUndefined()
      expect(await readdir(root)).not.toContain('ppt')
      await expect(projects.importTemplateFromFile(sessionId, '../other.pptx'))
        .rejects.toMatchObject({ code: 'forbidden' })
      await writeFile(join(root, 'huge.pptx'), new Uint8Array(8 * 1024 * 1024 + 1))
      await expect(projects.importTemplateFromFile(sessionId, 'huge.pptx'))
        .rejects.toMatchObject({ code: 'bad-request' })
      await symlink(source, join(root, 'link.pptx'))
      await expect(projects.importTemplateFromFile(sessionId, 'link.pptx'))
        .rejects.toMatchObject({ code: 'forbidden' })
      await writeFile(join(root, REMOTE_WORKSPACE_MARKER), JSON.stringify({
        version: 3, remoteRoot: '/srv/project', connectionId: 'connection-1', generation: 1, mode: 'agent',
      }))
      await expect(projects.importTemplateFromFile(sessionId, 'source.pptx'))
        .rejects.toMatchObject({ code: 'forbidden' })
      expect(await projects.listTemplates()).toHaveLength(1)
      await expect(projects.deleteTemplate(template.id, '旧名称'))
        .rejects.toMatchObject({ code: 'conflict' })
      expect(await projects.listTemplates()).toHaveLength(1)
      await projects.deleteTemplate(template.id, template.name)
      expect(await projects.listTemplates()).toHaveLength(0)
    } finally { await ctx.fiber.dispose() }
  })
})
