/**
 * 长线任务模式（`longrun`）的组装契约。
 *
 * 这个模式与标准模式的差别只有三处，而这三处正是它的协议本身：多挂 `wait_agent`（主
 * Agent 派发后进入等待）、把委派深度收到 1（等待链只有一层，验收只由顶层发起）、不挂
 * 第二套编排器（`workflow`／`ralph` 会绕过验收闸门）。派发、等待与验收要真实模型回合，
 * keyless 测试不启动子代理，因此断言落在组装文本的解析结果与 persona 正文上。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { discoverPresets, readPresetMetadata } from 'coding-agent-presets'
import { isCordisGroupEntry, loadCordisYaml } from '../../../scripts/cordis-yaml.ts'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const PRESET_ROOT = join(ROOT, 'apps/cli/config/agent-presets')
const LONGRUN_DIR = join(PRESET_ROOT, 'longrun')
const COMPOSITION = join(LONGRUN_DIR, 'agent.cordis.yml')

/** 等待与验收由这些行提供；改名就要同步 persona 正文。 */
const CONTROL_PACKAGE = 'coding-tool-subagent-control'
const WAIT_AGENT_ROW = `${CONTROL_PACKAGE}/wait-agent`
const SUBAGENT_PACKAGE = 'coding-tool-subagent'
/** 本模式刻意不挂的第二套编排器与 Code Mode 呈现。 */
const OMITTED_PACKAGES = [
  'coding-workflow-worker-thread',
  'coding-tool-workflow',
  'coding-tool-ralph',
  'coding-agent-tool-presentation',
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

/** 递归展开 group，得到每一行 entry（保留 group 自身）。 */
function flatten(entries: Entry[]): Entry[] {
  return entries.flatMap(entry => [
    entry,
    ...isCordisGroupEntry(entry) ? flatten(entry.config as Entry[]) : [],
  ])
}

/** 只保留实际装配的行：`disabled: true` 的可选提供方行不算。 */
function activeRows(entries: Entry[]): Entry[] {
  return flatten(entries).filter(entry => entry.disabled !== true)
}

/** 一行 entry 的 `config` 对象。 */
function configOf(entry: Entry): Record<string, unknown> {
  return (entry.config ?? {}) as Record<string, unknown>
}

describe('longrun preset discovery', () => {
  it('is supplied by the shipped root and loads', async () => {
    const presets = await discoverPresets([{ path: PRESET_ROOT, trust: 'system' }])
    const longrun = presets.find(preset => preset.id === 'longrun')

    expect(longrun).toMatchObject({ id: 'longrun', trust: 'system' })
    expect(longrun?.broken).toBeUndefined()
  })

  it('publishes display metadata so the mode picker shows it by name', async () => {
    const metadata = await readPresetMetadata(LONGRUN_DIR)

    expect(metadata.name).toBe('长线任务模式')
    expect(metadata.description).toContain('验收')
    // 随包预设靠 order 排序；与其它预设冲突会让名单顺序不稳定。
    expect(metadata.order).toBe(2)
  })
})

describe('longrun composition', () => {
  it('adds the wait tool the WAIT AGENTS stage calls', async () => {
    const rows = activeRows(await loadEntries(COMPOSITION))
    const waitAgent = rows.filter(row => row.name === WAIT_AGENT_ROW)

    expect(waitAgent).toHaveLength(1)
    // 发送与列出子代理的行必须在同一组装里，否则 persona 里的三条指令有两处没有工具。
    expect(rows.filter(row => row.name === CONTROL_PACKAGE)).toHaveLength(1)
    expect(rows.filter(row => row.name === `${CONTROL_PACKAGE}/list-agents`)).toHaveLength(1)
  })

  it('keeps the delegation depth at one so the wait chain stays flat', async () => {
    const rows = activeRows(await loadEntries(COMPOSITION))
      .filter(row => row.name === SUBAGENT_PACKAGE)

    expect(rows.map(row => configOf(row).provider).sort()).toEqual(['fork', 'spawn'])
    for (const row of rows) {
      const config = configOf(row)
      // 后台可继续：调用立刻返回子代理 id，主 Agent 才进得去等待。
      expect(config.backgroundMode).toBe('continuable')
      // 数值上限在挂载时校验 provider 的 `depthLimit` 能力；写成默认值会放开三层委派。
      expect(config.maxDepth).toBe(1)
    }
  })

  it('omits the second orchestration model and the Code Mode presentation', async () => {
    const names = new Set(activeRows(await loadEntries(COMPOSITION)).map(row => row.name))

    for (const omitted of OMITTED_PACKAGES) expect(names.has(omitted)).toBe(false)
    // 反向断言：标准模式的工具行仍在这里，本模式是标准工具面加协议，不是删减版。
    expect(names.has('coding-tool-fs')).toBe(true)
    expect(names.has('coding-tool-skill')).toBe(true)
    expect(names.has('coding-tool-goal')).toBe(true)
  })
})

describe('longrun persona', () => {
  it('carries the dispatch → wait → review → fix protocol and the handoff rule', async () => {
    const persona = activeRows(await loadEntries(COMPOSITION))
      .find(row => row.id === 'persona')
    expect(persona?.name).toBe('coding-persona')

    const text = String(configOf(persona!).text)
    // 三个角色的分工：主 Agent、执行者、验收者各有一条可执行的规则。
    for (const anchor of ['# 角色', '主 Agent', '执行者', '验收者']) expect(text).toContain(anchor)
    // 派发：并行、自足提示词、一步一 commit。
    for (const anchor of ['同一个 assistant 消息', '自足', '一步一 commit']) expect(text).toContain(anchor)
    // 等待：阻塞等投递而不是轮询，超时是正常事件。
    expect(text).toContain('`wait_agent`')
    expect(text).toContain('不要用 `list_agents` 反复轮询')
    expect(text).toContain('超时是正常事件')
    // 验收与修复循环：独立验收者，未通过发回原执行者。
    for (const anchor of ['REVIEW AGENT', '缺口清单', '`send_message`', '`followup_task`']) {
      expect(text).toContain(anchor)
    }
    // 交接只留主线，不保留处理细节。
    expect(text).toContain('交接只保留主线')
    expect(text).toContain('过程细节')
  })
})
