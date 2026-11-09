/** Loader 真实装配图库、工程与模型工具，核对同会话接图到预览及导出。 */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { unzipSync } from 'fflate'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import LocalAttachmentStore from 'coding-attachment-local'
import ImageGeneration from 'coding-image-gen'
import { apply as mountImageTools } from 'coding-tool-image-gen'
import { CallId } from 'coding-llm'
import SessionStore, { SessionId, type Session } from 'coding-session'
import { renderPageHtml } from '../../ppt-workbench/src/render-html.ts'
import SystemPrompt from 'coding-system-prompt'
import ToolRuntime from 'coding-tools'
import { afterEach, describe, expect, it } from 'vitest'
import PptProjects from '../../ppt-workbench/src/index.ts'
import { apply as mountPptTools } from '../src/index.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
let ctx: Context | undefined
let root: string | undefined
let upstream: ReturnType<typeof createServer> | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (upstream) await new Promise<void>(resolve => upstream!.close(() => { resolve() }))
  upstream = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Loader 装配真实服务，外部浏览器/网络不参与接图与 PPTX 嵌入。 */
async function boot(endpoint = ''): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'ppt-gallery-flow-'))
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(specifier: string) {
    if (specifier === 'coding-session') return SessionStore
    if (specifier === 'coding-attachment-local') return LocalAttachmentStore
    if (specifier === 'coding-image-gen') return ImageGeneration
    if (specifier === 'coding-system-prompt') return SystemPrompt
    if (specifier === 'coding-tools') return ToolRuntime
    if (specifier === 'coding-ppt-workbench') return PptProjects
    if (specifier === 'coding-tool-ppt') return { inject: ['tools'], apply: mountPptTools }
    if (specifier === 'coding-tool-image-gen') return { inject: ['tools', 'imageGeneration'], apply: mountImageTools }
    if (specifier === 'test-credentials') return {
      apply(host: Context) { host.provide('credentials', { resolve: async () => undefined } as never) },
    }
    if (specifier === 'test-file-library') return {
      apply(host: Context) { host.provide('fileLibrary', {
        saveGeneratedImage: async () => ({ record: { id: 'test-copy' }, path: '' }),
      } as never) },
    }
    if (specifier === 'test-web-server') return {
      apply(host: Context) { host.provide('webServer', { port: 0, host: '127.0.0.1', register: () => () => {} } as never) },
    }
    if (specifier === 'test-connection') return {
      apply(host: Context) { host.provide('connection', { requestRejection: () => undefined } as never) },
    }
    throw new Error(`unknown test plugin: ${specifier}`)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  const config = join(root, 'cordis.yml')
  await writeFile(config, [
    '- name: coding-session',
    '- name: coding-attachment-local',
    '  config:',
    `    dshHome: ${JSON.stringify(root)}`,
    '- name: test-credentials',
    '- name: test-file-library',
    '- name: test-web-server',
    '- name: test-connection',
    '- name: coding-image-gen',
    '  config:',
    `    enabled: ${endpoint !== ''}`,
    ...endpoint ? [
      `    endpoint: ${JSON.stringify(endpoint)}`,
      '    model: mock',
      '    apiKeyRef: ""',
    ] : [],
    '- name: coding-system-prompt',
    '- name: coding-tools',
    '- name: coding-ppt-workbench',
    '  config:',
    `    templatesDir: ${JSON.stringify(join(root, 'templates'))}`,
    '- name: coding-tool-ppt',
    '- name: coding-tool-image-gen',
    '',
  ].join('\n'))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  expect(ctx.tools.schemas().some(schema => schema.name === 'ppt_attach_gallery_image')).toBe(true)
  return ctx
}

function execute(host: Context, session: Session, name: string, args: object) {
  return host.tools.execute({ name, arguments: args, agent: { session } as never,
    signal: new AbortController().signal, callId: CallId(`ppt-${session.seq}`) })
}

/** 可重复的本地生图响应，验证模型工具经图像服务写图库而非伪造图库事件。 */
async function imageProvider(): Promise<string> {
  upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('无法获取本地图像服务端口')
  return `http://127.0.0.1:${address.port}/v1`
}

describe('图库图片接入演示稿', () => {
  it('将模型工具生成的图片加入同一份工程，工具卸载后撤销接入注册', async () => {
    const endpoint = await imageProvider()
    const host = await boot(endpoint)
    const session = host.sessions.create(SessionId('ppt-generated'), { meta: { cwd: root! } })
    expect((await execute(host, session, 'ppt_create', { title: '生成图片测试' })).isError).toBe(false)
    const generated = await execute(host, session, 'generate_image', { prompt: '简洁示意图' })
    expect(generated.isError, JSON.stringify(generated)).toBe(false)
    const imageId = (generated.value as { id: string }).id
    expect(host.imageGeneration.gallery(session.events)).toMatchObject([{ id: imageId, model: 'mock' }])
    const attached = await execute(host, session, 'ppt_attach_gallery_image', { imageId })
    expect(attached.isError).toBe(false)
    const source = (attached.value as { source: string }).source
    const snapshot = await host.pptProjects.read(session.id)
    expect((await execute(host, session, 'ppt_edit', { base_revision: snapshot.revision,
      ops: [{ op: 'add_element', page: snapshot.deck.pages[0]!.id,
        element: { kind: 'image', source, fit: 'contain', x: 800, y: 420, w: 250, h: 140 } }] })).isError).toBe(false)
    const exported = await host.pptProjects.export(session.id, undefined, { skipCheck: true })
    expect(Buffer.from(unzipSync(await readFile(exported.path))['ppt/media/image1.png']!)).toEqual(PNG)
    const registry = host.tools
    await host.fiber.dispose()
    ctx = undefined
    expect(registry.schemas().some(schema => schema.name === 'ppt_attach_gallery_image')).toBe(false)
  })

  it('只认同会话图库，接入后以版本编辑图片并嵌入导出的 PPTX', async () => {
    const host = await boot()
    const session = host.sessions.create(SessionId('ppt-gallery-owner'), { meta: { cwd: root! } })
    const other = host.sessions.create(SessionId('ppt-gallery-other'), { meta: { cwd: root! } })
    const image = await host.imageGeneration.importReference(session, { data: PNG, mediaType: 'image/png' })
    const created = await execute(host, session, 'ppt_create', { title: '图库成稿' })
    expect(created.isError).toBe(false)
    expect((await execute(host, other, 'ppt_attach_gallery_image', { imageId: image.id })).isError).toBe(true)
    expect((await execute(host, session, 'ppt_attach_gallery_image', { imageId: image.id, dir: '../outside' })).isError).toBe(true)
    expect((await execute(host, session, 'ppt_attach_gallery_image', { imageId: image.id, dir: 'ppt/missing' })).isError).toBe(true)
    const missing = await execute(host, session, 'ppt_attach_gallery_image', { imageId: image.attachmentId })
    expect(missing.isError).toBe(true)
    const attach = await execute(host, session, 'ppt_attach_gallery_image', { imageId: image.id })
    expect(attach.isError).toBe(false)
    const source = (attach.value as { source: string }).source
    expect(source).toMatch(/^media\/up-[\w-]+\.png$/u)
    const before = await host.pptProjects.read(session.id)
    expect(before.deck.pages.flatMap(page => page.elements).filter(element => element.kind === 'image')).toEqual([])
    expect(await host.pptProjects.media(session.id, undefined, source)).toEqual(PNG)
    const page = before.deck.pages[0]!
    const edited = await execute(host, session, 'ppt_edit', { base_revision: before.revision,
      ops: [{ op: 'add_element', page: page.id,
        element: { kind: 'image', source, fit: 'contain', x: 800, y: 420, w: 250, h: 140 } }] })
    expect(edited.isError).toBe(false)
    expect((await execute(host, session, 'ppt_edit', { base_revision: before.revision,
      ops: [{ op: 'add_element', page: page.id,
        element: { kind: 'image', source, fit: 'contain', x: 800, y: 420, w: 250, h: 140 } }] })).isError).toBe(true)
    const after = await host.pptProjects.read(session.id)
    expect(after.deck.pages[0]!.elements.some(element => element.kind === 'image' && element.source === source)).toBe(true)
    const imageBytes = await host.pptProjects.media(session.id, undefined, source)
    expect(imageBytes).toEqual(PNG)
    const preview = renderPageHtml(after.deck, after.deck.pages[0]!, { [source]: imageBytes })
    expect(preview).toContain(`data:image/png;base64,${PNG.toString('base64')}`)
    const exported = await host.pptProjects.export(session.id, undefined, { skipCheck: true })
    const parts = unzipSync(await readFile(exported.path))
    expect(Object.keys(parts)).toContain('ppt/media/image1.png')
    expect(Buffer.from(parts['ppt/media/image1.png']!)).toEqual(PNG)
    expect(Buffer.from(parts['ppt/slides/slide1.xml']!).toString()).toContain('<p:pic>')
  })
})
