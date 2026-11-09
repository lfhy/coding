import type { Context } from '@deepseek-ai/cordis'
import { isJsonValue, type JsonValue } from 'coding-session'
import { validateJsonSchemaValue, type ToolDefinition, type ToolRunContext } from 'coding-tools'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'

const session = { agent: { session: { header: { id: 's1' } } } } as unknown as ToolRunContext
const snapshot = {
  dir: '/workspace/ppt/draft', title: '修复草稿', revision: 1, pages: 2,
  canUndo: false, canRedo: false, deck: { pages: [] },
}
const sourceSha256 = 'a'.repeat(64)
const report = {
  sourceSlides: 2, importedPages: 2,
  pages: [{
    sourceIndex: 1, pageId: 'p1', slidePart: 'ppt/slides/slide1.xml',
    source: { text: 1, image: 1, table: 0, chart: 1, diagram: 0, other: 0 },
    imported: { text: 1, image: 1, table: 0, chart: 0 },
    status: 'partial', losses: ['chart', 'text'], textPreview: ['营业额'], truncated: false,
  }, {
    sourceIndex: 2, pageId: 'p2', slidePart: 'ppt/slides/slide2.xml',
    source: { text: 0, image: 1, table: 0, chart: 0, diagram: 0, other: 0 },
    imported: { text: 0, image: 1, table: 0, chart: 0 },
    status: 'image_only', losses: [], textPreview: [], truncated: false,
  }],
}

function setup() {
  const definitions = new Map<string, ToolDefinition>()
  const projects = {
    import: vi.fn().mockResolvedValue({ snapshot, dropped: ['图表'], report, sourceSha256 }),
    importEvidence: vi.fn().mockResolvedValue({
      sourceIndex: 1, sourceSha256, content: '{"slideXml":"<p:sld/>"}', totalChars: 24, nextOffset: null,
    }),
    importTemplateFromFile: vi.fn(),
    saveTemplate: vi.fn(),
  }
  apply({
    get: () => projects,
    tools: { register: (definition: ToolDefinition) => { definitions.set(definition.name, definition) } },
  } as unknown as Context)
  const tool = (name: string): ToolDefinition => {
    const definition = definitions.get(name)
    if (definition === undefined) throw new Error(`找不到工具 ${name}`)
    return definition
  }
  return { projects, tool }
}

function assertJsonResult(value: unknown): asserts value is JsonValue {
  if (!isJsonValue(value)) throw new Error('工具结果必须是可持久化的 JSON 值')
}

describe('PPT 导入修复工具', () => {
  it('准备草稿，返回逐页损失与哈希，不写用户模板库', async () => {
    const { projects, tool } = setup()
    const prepare = tool('ppt_prepare_template')
    expect(prepare.parameters).toMatchObject({ required: ['source'] })
    const result = await prepare.execute({ source: 'sources/brand.pptx', name: '修复草稿', dir: 'ppt/draft' }, session)
    expect(projects.import).toHaveBeenCalledWith('s1', 'sources/brand.pptx', {
      title: '修复草稿', dir: 'ppt/draft',
    })
    expect(result).toEqual({
      project: { dir: snapshot.dir, title: snapshot.title, revision: 1, pages: 2, canUndo: false, canRedo: false },
      dropped: ['图表'], report, sourceSha256,
    })
    assertJsonResult(result)
    expect(validateJsonSchemaValue(prepare.output.schema, result, 'value')).toEqual([])
    expect(prepare.output.render({}, result)).toEqual([{ type: 'text', text: JSON.stringify(result) }])
    expect(projects.importTemplateFromFile).not.toHaveBeenCalled()
    expect(projects.saveTemplate).not.toHaveBeenCalled()
    expect(prepare.description).toContain('ppt_import_evidence')
    expect(prepare.description).toContain('ppt_save_template')
    expect(prepare.description).toContain('typography hierarchy')
    expect(prepare.description).toContain('replaceable content')
    expect(prepare.description).toContain('a full-page image is not editable content')
    expect(prepare.description).toContain('Never invent source values')
    expect(tool('ppt_save_template').description).toContain('does not extract a design')
    expect(tool('ppt_import_template').description).toContain('Source text is replaced with generic placeholders')
    await prepare.execute({ source: 'sources/brand.pptx' }, session)
    expect(projects.import).toHaveBeenLastCalledWith('s1', 'sources/brand.pptx', {})
    await expect(prepare.execute({}, session)).rejects.toThrow('source')
  })

  it('导入普通工程也返回逐页报告和来源哈希', async () => {
    const { projects, tool } = setup()
    const result = await tool('ppt_import').execute({ source: 'sources/brand.pptx', title: '普通导入' }, session)
    expect(projects.import).toHaveBeenCalledWith('s1', 'sources/brand.pptx', { title: '普通导入' })
    expect(result).toMatchObject({ dropped: ['图表'], report, sourceSha256 })
  })

  it('证据工具保留会话和哈希，拒绝无效页码与片段边界', async () => {
    const { projects, tool } = setup()
    const evidence = tool('ppt_import_evidence')
    expect(evidence.parameters).toMatchObject({ required: ['source', 'sourceIndex', 'sourceSha256'] })
    const result = await evidence.execute({
      source: 'sources/brand.pptx', sourceIndex: 1, sourceSha256, offset: 8000, limit: 16000,
    }, session)
    expect(projects.importEvidence).toHaveBeenCalledWith('s1', 'sources/brand.pptx', {
      sourceIndex: 1, sourceSha256, offset: 8000, limit: 16000,
    })
    expect(result).toEqual({
      sourceIndex: 1, sourceSha256, content: '{"slideXml":"<p:sld/>"}', totalChars: 24, nextOffset: null,
    })
    for (const invalid of [
      { sourceIndex: 0 }, { sourceIndex: -1 }, { offset: -1 }, { limit: 0 }, { limit: 16001 },
      { sourceIndex: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      await expect(evidence.execute({ source: 'sources/brand.pptx', sourceIndex: 1, sourceSha256, ...invalid }, session))
        .rejects.toThrow('sourceIndex 必须为正整数')
    }
    expect(projects.importEvidence).toHaveBeenCalledTimes(1)
    await expect(evidence.execute({ source: 'sources/brand.pptx', sourceIndex: 1 }, session))
      .rejects.toThrow('sourceSha256')
  })
})
