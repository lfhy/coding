/**
 * 笔记专用模式（`notes`）的组装契约。
 *
 * 这个模式与标准模式共用同一套工具，差别在技能与 persona：只保留笔记、阅读、导出和文件整理
 * 相关的技能，导出走 `note-export` 并把产物落到用户主目录；工程脚手架类技能（项目初始化、
 * 前端、Go 后端）不再提供。技能目录是模型看得见的事实，因此断言落在组装文本与 persona 正文上，
 * 不依赖真实模型回合。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { discoverPresets, readPresetMetadata } from 'coding-agent-presets'
import { loadCordisYaml } from '../../../scripts/cordis-yaml.ts'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const PRESET_ROOT = join(ROOT, 'apps/cli/config/agent-presets')
const NOTES_DIR = join(PRESET_ROOT, 'notes')
const COMPOSITION = join(NOTES_DIR, 'agent.cordis.yml')

/** 笔记模式提供的随包技能。 */
const SKILL_PACKAGES = [
  'coding-skill-filesystem',
  'coding-skill-browser-use',
  'coding-skill-note-export',
]
/** 只在工程类模式里出现的开发脚手架技能，笔记模式不再提供。 */
const DEVELOPER_SKILLS = [
  'coding-skill-project-init',
  'coding-skill-frontend-development',
  'coding-skill-go-backend',
]

/** Loader entry 的最小形状。 */
interface Entry {
  id?: unknown
  name?: unknown
  disabled?: unknown
  config?: unknown
}

/** 解析一份组装文本为最外层的 entry 列表。 */
async function loadEntries(path: string): Promise<Entry[]> {
  const document = loadCordisYaml(await readFile(path, 'utf8'))
  if (!Array.isArray(document)) throw new TypeError(`${path} is not a Loader entry array`)
  return document as Entry[]
}

/** 只保留实际装配的行：`disabled: true` 的可选提供方行不算。 */
function activeRows(entries: Entry[]): Entry[] {
  return entries.filter(entry => entry.disabled !== true)
}

/** 一行 entry 的 `config` 对象。 */
function configOf(entry: Entry): Record<string, unknown> {
  return (entry.config ?? {}) as Record<string, unknown>
}

describe('notes preset discovery', () => {
  it('is supplied by the shipped root and loads', async () => {
    const presets = await discoverPresets([{ path: PRESET_ROOT, trust: 'system' }])
    const notes = presets.find(preset => preset.id === 'notes')

    expect(notes).toMatchObject({ id: 'notes', trust: 'system' })
    expect(notes?.broken).toBeUndefined()
  })

  it('publishes display metadata so the mode picker shows it by name', async () => {
    const metadata = await readPresetMetadata(NOTES_DIR)

    expect(metadata.name).toBe('笔记专用模式')
    expect(metadata.description).toContain('笔记')
    expect(metadata.order).toBe(10)
  })
})

describe('notes composition', () => {
  it('mounts the note skills and no developer scaffolding skill', async () => {
    const names = new Set(activeRows(await loadEntries(COMPOSITION)).map(row => row.name))

    for (const skill of SKILL_PACKAGES) expect(names.has(skill), skill).toBe(true)
    // 工程脚手架技能从这份 roster 里移除；要搭工程应切到标准模式。
    for (const skill of DEVELOPER_SKILLS) expect(names.has(skill), skill).toBe(false)
    // 文件与对话能力仍是完整的一套，本模式不是删减版工具面。
    for (const tool of ['coding-tool-fs', 'coding-tool-skill', 'coding-tool-bash', 'coding-tool-ppt']) {
      expect(names.has(tool), tool).toBe(true)
    }
  })

  it('只在笔记模式挂载标签发布路由与模型工具', async () => {
    const notes = activeRows(await loadEntries(COMPOSITION))
    expect(notes.filter(row => row.name === 'coding-tool-notes-tabs')).toEqual([
      expect.objectContaining({ id: 'tool-notes-tabs', name: 'coding-tool-notes-tabs' }),
    ])
    const others = ['standard', 'ppt', 'chat']
    for (const id of others) {
      const entries = activeRows(await loadEntries(join(PRESET_ROOT, id, 'agent.cordis.yml')))
      expect(entries.some(row => row.name === 'coding-tool-notes-tabs'), id).toBe(false)
    }
  })

  it('keeps the skill catalog reminder on so a new turn re-checks the export skill', async () => {
    const skillTool = activeRows(await loadEntries(COMPOSITION))
      .find(row => row.name === 'coding-tool-skill')

    expect(configOf(skillTool!)).toEqual({ turnReminder: true })
  })
})

describe('notes persona', () => {
  it('routes exports to the user home directory through the note-export skill', async () => {
    const persona = activeRows(await loadEntries(COMPOSITION))
      .find(row => row.id === 'persona')
    expect(persona?.name).toBe('coding-persona')

    const text = String(configOf(persona!).text)
    // 导出要先加载技能，产物落在用户主目录下，并在回复里给出绝对路径。
    expect(text).toContain('# 导出')
    expect(text).toContain('`note-export`')
    expect(text).toContain('主目录下的 `笔记导出` 目录')
    expect(text).toContain('绝对路径')
    // 只读原笔记；写主目录被拒时的退路要写清楚，不能假装写成功。
    expect(text).toContain('不改写、不移动、不重命名')
    expect(text).toContain('升权')
    expect(text).toContain('退回笔记目录下的 `导出/`')
    // 与应用内导出一致的渲染走笔记页按钮，不许声称命令行产物与界面相同。
    expect(text).toContain('笔记页右上角的导出按钮')
    expect(text).toContain('不要声称两者一致')
    // 本模式的技能范围要说明白，避免模型在没有开发技能时凭空承诺。
    expect(text).toContain('# 本模式的技能范围')
    expect(text).toContain('切到标准模式')
  })
})
