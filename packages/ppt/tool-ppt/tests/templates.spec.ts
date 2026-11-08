import type { Context } from '@deepseek-ai/cordis'
import { isJsonValue, type JsonValue } from 'coding-session'
import type { ToolDefinition, ToolRunContext } from 'coding-tools'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

const session = { agent: { session: { header: { id: 's1' } } } } as unknown as ToolRunContext
const snapshot = {
  dir: '/workspace/ppt/copy', title: '副本', revision: 0, pages: 2,
  canUndo: false, canRedo: false, deck: { pages: [{ name: '封面' }, { name: '结尾' }] },
}
const detail = {
  id: 'saved-1', name: '品牌模板', pages: 2, createdAt: 1700000000000,
  sourceName: null, dropped: ['图表 1'], deck: { pages: ['private full deck'] },
}

function assertJsonValue(value: unknown): asserts value is JsonValue {
  if (!isJsonValue(value)) throw new Error('工具结果必须是可持久化的 JSON 值')
}

function setup() {
  const definitions = new Map<string, ToolDefinition>()
  const projects = {
    create: vi.fn().mockResolvedValue(snapshot),
    createFromTemplate: vi.fn().mockResolvedValue(snapshot),
    listTemplates: vi.fn().mockResolvedValue([detail]),
    saveTemplate: vi.fn().mockResolvedValue(detail),
    importTemplateFromFile: vi.fn().mockResolvedValue(detail),
    renameTemplate: vi.fn().mockResolvedValue(detail),
    deleteTemplate: vi.fn().mockResolvedValue(undefined),
  }
  apply({
    get: () => projects,
    tools: { register: (tool: ToolDefinition) => { definitions.set(tool.name, tool) } },
  } as unknown as Context)
  const tool = (name: string): ToolDefinition => {
    const definition = definitions.get(name)
    if (definition === undefined) throw new Error(`找不到工具 ${name}`)
    return definition
  }
  return { projects, definitions, tool }
}

describe('PPT 用户模板工具', () => {
  it('列出模板摘要及导入损失，不把完整 deck 泄漏进工具结果', async () => {
    const { projects, tool } = setup()
    const list = tool('ppt_templates')
    const value = await list.execute({}, session)
    expect(projects.listTemplates).toHaveBeenCalledOnce()
    expect(value).toEqual({ templates: [{
      id: detail.id, name: detail.name, pages: detail.pages, createdAt: detail.createdAt,
      sourceName: null, dropped: ['图表 1'],
    }] })
    assertJsonValue(value)
    expect(list.output.render({}, value)).toEqual([{ type: 'text', text: JSON.stringify(value) }])
    expect(JSON.stringify(value)).not.toContain('private full deck')
    expect(list.description).toContain('seven built-in single-page layouts')
  })

  it('保存当前或指定工程，返回摘要且使用调用会话身份', async () => {
    const { projects, tool } = setup()
    const save = tool('ppt_save_template')
    const value = await save.execute({ name: '品牌模板', dir: 'ppt/source' }, session)
    expect(projects.saveTemplate).toHaveBeenCalledWith('s1', { name: '品牌模板', dir: 'ppt/source' })
    expect(value).toEqual({ template: {
      id: detail.id, name: detail.name, pages: detail.pages, createdAt: detail.createdAt,
      sourceName: null, dropped: ['图表 1'],
    } })
    expect(JSON.stringify(value)).not.toContain('private full deck')
    await expect(save.execute({ name: ' ' }, session)).rejects.toThrow('模板名称 name 不能为空')
    expect(projects.saveTemplate).toHaveBeenCalledTimes(1)
  })

  it('以模板 ID 创建副本并保留可选标题和目录，不调用空白新建', async () => {
    const { projects, tool } = setup()
    const create = tool('ppt_create')
    const value = await create.execute({ templateId: 'saved-1', title: '副本', dir: 'ppt/copy' }, session)
    expect(projects.createFromTemplate).toHaveBeenCalledWith('s1', 'saved-1', { title: '副本', dir: 'ppt/copy' })
    expect(projects.create).not.toHaveBeenCalled()
    expect(value).toEqual({ project: {
      dir: snapshot.dir, title: snapshot.title, revision: 0, pages: 2, canUndo: false, canRedo: false,
    } })
    await create.execute({ templateId: 'saved-1' }, session)
    expect(projects.createFromTemplate).toHaveBeenLastCalledWith('s1', 'saved-1', {})
  })

  it('拒绝模板和尺寸主题混用；普通新建仍需标题并维持原参数', async () => {
    const { projects, tool } = setup()
    const create = tool('ppt_create')
    for (const option of [{ size: '4:3' }, { theme: 'paper' }]) {
      await expect(create.execute({ templateId: 'saved-1', ...option }, session))
        .rejects.toThrow('不能同时指定 size 或 theme')
    }
    expect(projects.createFromTemplate).not.toHaveBeenCalled()
    await expect(create.execute({}, session)).rejects.toThrow('需要 title')
    await create.execute({ title: '普通稿', size: '16:9', theme: 'ink', dir: 'ppt/plain' }, session)
    expect(projects.create).toHaveBeenCalledWith('s1', {
      title: '普通稿', size: '16:9', theme: 'ink', dir: 'ppt/plain',
    })
  })

  it('导入工作区 .pptx 直接生成用户模板，不打开或创建工程', async () => {
    const { projects, tool } = setup()
    const value = await tool('ppt_import_template').execute({ source: 'sources/brand.pptx', name: '品牌模板' }, session)
    expect(projects.importTemplateFromFile).toHaveBeenCalledWith('s1', 'sources/brand.pptx', { name: '品牌模板' })
    expect(value).toEqual({ template: {
      id: detail.id, name: detail.name, pages: detail.pages, createdAt: detail.createdAt,
      sourceName: null, dropped: ['图表 1'],
    } })
    expect(JSON.stringify(value)).not.toContain('private full deck')
    expect(projects.create).not.toHaveBeenCalled()
    expect(projects.createFromTemplate).not.toHaveBeenCalled()
    expect(tool('ppt_import_template').description).toContain('does not create or focus')
    await tool('ppt_import_template').execute({ source: 'sources/brand.pptx' }, session)
    expect(projects.importTemplateFromFile).toHaveBeenLastCalledWith('s1', 'sources/brand.pptx', {})
  })

  it('路径错误由工程服务拒绝并原样传播，不能保存模板或切换工程', async () => {
    const { projects, tool } = setup()
    projects.importTemplateFromFile.mockRejectedValueOnce(new Error('来源路径超出工作区'))
    await expect(tool('ppt_import_template').execute({ source: '../outside.pptx' }, session))
      .rejects.toThrow('来源路径超出工作区')
    expect(projects.saveTemplate).not.toHaveBeenCalled()
    expect(projects.create).not.toHaveBeenCalled()
  })

  it('模板改名仅返回摘要，空名称不调用工程服务', async () => {
    const { projects, tool } = setup()
    const rename = tool('ppt_rename_template')
    await expect(rename.execute({ id: 'saved-1', name: ' ' }, session)).rejects.toThrow('名称 name 不能为空')
    expect(projects.renameTemplate).not.toHaveBeenCalled()
    const value = await rename.execute({ id: 'saved-1', name: '新名称' }, session)
    expect(projects.renameTemplate).toHaveBeenCalledWith('saved-1', '新名称')
    expect(value).toEqual({ template: {
      id: detail.id, name: detail.name, pages: detail.pages, createdAt: detail.createdAt,
      sourceName: null, dropped: ['图表 1'],
    } })
    expect(JSON.stringify(value)).not.toContain('private full deck')
  })

  it('删除时把原样名称传到同锁检查的服务，错误名称不得产生成功结果', async () => {
    const { projects, tool } = setup()
    const deletion = tool('ppt_delete_template')
    expect(deletion.description).toContain('user explicitly asks')
    expect(deletion.description).toContain('First call ppt_templates')
    await expect(deletion.execute({ id: 'saved-1', name: ' ' }, session))
      .rejects.toThrow('名称 name 不能为空')
    expect(projects.deleteTemplate).not.toHaveBeenCalled()
    projects.deleteTemplate.mockRejectedValueOnce(new Error('模板名称不匹配'))
    await expect(deletion.execute({ id: 'saved-1', name: '品牌模版' }, session))
      .rejects.toThrow('模板名称不匹配')
    expect(projects.deleteTemplate).toHaveBeenCalledWith('saved-1', '品牌模版')
    const value = await deletion.execute({ id: 'saved-1', name: '品牌模板' }, session)
    expect(projects.deleteTemplate).toHaveBeenCalledTimes(2)
    expect(projects.deleteTemplate).toHaveBeenLastCalledWith('saved-1', '品牌模板')
    expect(value).toEqual({ id: 'saved-1', name: '品牌模板', deleted: true })
  })
})
