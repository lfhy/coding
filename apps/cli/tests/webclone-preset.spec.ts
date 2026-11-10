/**
 * 网页复刻模式（`webclone`）的组装契约。
 *
 * 本模式与标准模式的唯一区别是它自带复刻技能，因此这里固定四件事：这份组装能被 roster
 * 正常发现并解析、技能目录只在本预设里注册、随模式分发的技能满足技能文件契约，以及
 * persona 覆盖了脱离技能也必须成立的规则（授权、登录续期、工具选择与交付口径）。
 * 真实复刻需要联网与浏览器，不在 keyless 测试里跑，所以断言落在组装文本与解析结果上。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { discoverPresets, readPresetMetadata } from 'coding-agent-presets'
import { isCordisGroupEntry, loadCordisYaml } from '../../../scripts/cordis-yaml.ts'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const PRESET_ROOT = join(ROOT, 'apps/cli/config/agent-presets')
const WEBCLONE_DIR = join(PRESET_ROOT, 'webclone')
const COMPOSITION = join(WEBCLONE_DIR, 'agent.cordis.yml')
const SKILL_FILESYSTEM_PACKAGE = 'coding-skill-filesystem'

/** 随本模式分发的技能目录。新增或删除技能时同步这份清单与 `preset.yml` 的描述。 */
const SKILLS = ['clone-website', 'framer-and-motion', 'website-inspection']

/** Loader entry 的最小形状，用于遍历组装。 */
interface Entry {
  id?: unknown
  name?: unknown
  config?: unknown
}

/** 解析一份组装文本为最外层的 entry 列表。 */
async function loadEntries(path: string): Promise<Entry[]> {
  const document = loadCordisYaml(await readFile(path, 'utf8'))
  if (!Array.isArray(document)) throw new TypeError(`${path} is not a Loader entry array`)
  return document as Entry[]
}

/** 一行 entry 的 `config` 对象。 */
function configOf(entry: Entry): Record<string, unknown> {
  return (entry.config ?? {}) as Record<string, unknown>
}

/** 只保留指定插件包的行。 */
function rowsOf(entries: Entry[], name: string): Entry[] {
  return entries.filter(entry => entry.name === name)
}

/** 递归收集 group 内的行。 */
function flatten(entries: Entry[]): Entry[] {
  return entries.flatMap(entry => isCordisGroupEntry(entry) ? [entry, ...flatten(entry.config as Entry[])] : [entry])
}

describe('webclone preset discovery', () => {
  it('is supplied by the shipped root alongside every other preset, and is loadable', async () => {
    const presets = await discoverPresets([{ path: PRESET_ROOT, trust: 'system' }])

    expect(presets.map(preset => preset.id).sort())
      .toEqual(['codex', 'cordis', 'image', 'longrun', 'minimal', 'ppt', 'reverse', 'standard', 'webclone'])
    const webclone = presets.find(preset => preset.id === 'webclone')
    // `broken` 是发现过程给出的原因；能挂载的预设没有这个字段。
    expect(webclone).toMatchObject({ id: 'webclone', trust: 'system' })
    expect(webclone?.broken).toBeUndefined()
  })

  it('publishes display metadata so the mode picker shows it by name', async () => {
    const metadata = await readPresetMetadata(WEBCLONE_DIR)

    expect(metadata.name).toBe('网页复刻模式')
    expect(metadata.description).toContain('复刻')
    // 随包预设靠 order 排序；与其它预设的 order 冲突会让名单顺序不稳定。
    expect(metadata.order).toBeGreaterThan(8)
  })
})

describe('webclone keeps the standard tool surface', () => {
  it('mounts the same model-facing rows as the standard mode', async () => {
    const standard = flatten(await loadEntries(join(PRESET_ROOT, 'standard/agent.cordis.yml')))
    const webclone = flatten(await loadEntries(COMPOSITION))

    const names = (entries: Entry[]) => entries.map(entry => String(entry.name)).sort()
    expect(names(webclone)).toEqual(names(standard))
    // 与标准模式一样提供原生调用与 Code Mode 两种工具呈现。
    const [presentation] = rowsOf(webclone, 'coding-agent-tool-presentation')
    expect(configOf(presentation!).mode).toBe('both')
  })

  it('registers no MCP server, so nothing leaks into other modes', async () => {
    const rows = await loadEntries(COMPOSITION)

    expect(rowsOf(rows, 'coding-mcp-client')).toEqual([])
  })
})

describe('webclone skills ship with the preset', () => {
  it('discovers its own skill directory through the filesystem provider', async () => {
    const [row] = rowsOf(await loadEntries(COMPOSITION), SKILL_FILESYSTEM_PACKAGE)

    expect(row).toBeDefined()
    const dirs = configOf(row!).customSkillDirs as { __jsExpr: string }[]
    expect(dirs).toHaveLength(1)
    // `baseUrl` 是组装文件所在目录，随 preset 一起被复制和安装。
    expect(dirs[0]?.__jsExpr).toContain('skills/')
    expect(dirs[0]?.__jsExpr).toContain('baseUrl')
  })

  it('appears in no other preset and no host composition', async () => {
    const presets = await readdir(PRESET_ROOT, { withFileTypes: true })
    const others = presets.filter(entry => entry.isDirectory() && entry.name !== 'webclone').map(entry => entry.name)

    for (const preset of others) {
      const entries = await loadEntries(join(PRESET_ROOT, preset, 'agent.cordis.yml'))
      // 其它预设可以有各自的 customSkillDirs（`cordis` 就有），但都不能指向本模式的目录。
      const skillDirs = rowsOf(entries, SKILL_FILESYSTEM_PACKAGE)
        .flatMap(entry => (configOf(entry).customSkillDirs ?? []) as { __jsExpr?: string }[])
        .map(dir => dir.__jsExpr ?? '')
        .join('\n')
      expect(skillDirs, `${preset} must not load the webclone skills`).not.toContain('agent-presets/webclone')
    }
    // 宿主组合挂载的技能目录对每个会话可见，那会绕过模式约束。
    for (const bundle of ['base', 'web-app']) {
      const source = await readFile(join(ROOT, 'packages/bundle', bundle, 'cordis.patch.yml'), 'utf8')
      expect(source, `${bundle} must not load the webclone skills`).not.toContain('agent-presets/webclone')
    }
  })

  it('ships one valid SKILL.md per skill, named after its directory', async () => {
    const dirs = await readdir(join(WEBCLONE_DIR, 'skills'), { withFileTypes: true })

    expect(dirs.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()).toEqual(SKILLS)
    for (const name of SKILLS) {
      const source = await readFile(join(WEBCLONE_DIR, 'skills', name, 'SKILL.md'), 'utf8')
      const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source)
      expect(frontmatter, `${name}/SKILL.md needs YAML frontmatter`).not.toBeNull()
      const data = loadCordisYaml(frontmatter![1]!) as Record<string, unknown>
      // 目录名、frontmatter 名与显式调用命令是同一个标识符。
      expect(data.name).toBe(name)
      expect(typeof data.description).toBe('string')
      expect((data.description as string).length).toBeLessThan(500)
      expect(source.length).toBeGreaterThan(500)
    }
  })

  it('ships a cloning persona that keeps the rules which must not depend on the skill', async () => {
    const [persona] = rowsOf(await loadEntries(COMPOSITION), 'coding-persona')
    const config = configOf(persona!)
    const text = String(config.text)

    // 技能入口：模型可以从提示词本身找到总纲与两份参考技能。
    expect(text).toContain('clone-website')
    expect(text).toContain('website-inspection')
    expect(text).toContain('framer-and-motion')
    // 四步流程与「真实内容」的验收口径必须写在提示词里，因为技能按需加载、不保证已读。
    expect(text).toContain('排期映射')
    expect(text).toContain('对比修复')
    // 授权与边界：只复刻自有或已获授权的页面，不用于冒充，凭据不落盘。
    expect(text).toContain('授权')
    expect(text).toContain('凭据')
    // 登录续期：登录必须在右侧 Agent 浏览器面板由用户本人完成，之后复核页面再继续。
    expect(text).toContain('Agent 浏览器')
    expect(text).toContain('browser_wait_for_human')
    // 面板只转发点击、滚动、普通文字与受限按键；扫码与人机验证要抬出独立窗口。
    expect(text).toContain('在浏览器窗口中打开')
    expect(text).toContain('browser_navigate')
    // 视觉判断必须看图，语义快照不算视觉验证。
    expect(text).toContain('browser_screenshot')
    // 交付类技能仍随模式提供：新工程初始化与后端实现。
    expect(text).toContain('project-init')
    expect(text).toContain('go-backend')
    // 复刻产物默认落成 Go 后端 + `web/` 前端、由 `go:embed` 内嵌，而不是一堆静态文件。
    expect(text).toContain('go:embed')
    expect(text).toContain('web/dist')
    expect(text).toContain('index.html')
    // 画图工具：模型侧名称、什么时候该用、什么时候不该用、工具缺席时怎么说，都要写进提示词。
    expect(text).toContain('`generate_image`')
    expect(text).toContain('`canvas_state`')
    // 插件包叫 coding-tool-image-gen，但模型工具名是下划线四件套，不能写成 image-gen。
    expect(text).toContain('不叫 `image-gen`')
    expect(text).toContain('真实素材永远优先')
    expect(text).toContain('品牌 logo')
    expect(text).toContain('docs/research/<site>/')
    expect(text).toContain('工具缺席时不要说')
    // 生成占位图时要按区块宽高比要图，避免插入后再裁切。
    expect(text).toContain('aspectRatio')
    // 部署的 `coding:guidelines`（order −98）先于 persona 渲染：它要求小步提交，
    // persona 必须把这条要求接到复刻工程上（版本基线、可回滚的切片、忽略原始素材）。
    expect(text).toContain('git init')
    expect(text).toContain('.gitignore')
    expect(text).toContain('基线提交')
    expect(text).toContain('切片')
    // persona 不能设成 complete：工具指引、技能目录与运行时上下文仍需参与组装。
    expect(config.complete).toBeUndefined()
    // 一段完整的模式提示词，而不是一句身份描述。
    expect(text.length).toBeGreaterThan(1500)
  })
})
