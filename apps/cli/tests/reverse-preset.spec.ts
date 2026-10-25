/**
 * 逆向分析模式（`reverse`）的组装契约。
 *
 * 本模式与其它预设的唯一区别是它自带 REA 的 MCP 工具与逆向调查技能，因此这里固定三件事：
 * 这份组装能被 roster 正常发现并解析、REA 服务器只在这个预设里挂载（其它预设与宿主组合都
 * 不挂），以及随模式分发的技能目录满足技能文件契约。挂载真实 MCP 进程需要网络与 REA 引擎，
 * 不在 keyless 测试里启动，所以断言落在组装文本与其解析结果上。
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { discoverPresets, readPresetMetadata } from 'coding-agent-presets'
import { isCordisGroupEntry, isJsExpr, loadCordisYaml } from '../../../scripts/cordis-yaml.ts'

const ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const PRESET_ROOT = join(ROOT, 'apps/cli/config/agent-presets')
const REVERSE_DIR = join(PRESET_ROOT, 'reverse')
const COMPOSITION = join(REVERSE_DIR, 'agent.cordis.yml')

/** REA 只在这个预设里注册工具；这些名字出现在别处就说明模式约束被破坏。 */
const MCP_PACKAGE = 'coding-mcp-client'
const PINNED_REA_PACKAGE = 'rea-agents@6.7.0'

/** 随本模式分发的技能目录。新增或删除技能时同步这份清单与 `preset.yml` 的描述。 */
const SKILLS = [
  'android-apk-analysis',
  'clean-room-cloning',
  'feature-tracing',
  'firmware-embedded-analysis',
  'game-analysis',
  'javascript-electron-analysis',
  'kernel-driver-analysis',
  'native-binary-analysis',
  'protection-research',
  'rea-tool-workflow',
  'reverse-engineering',
  'version-comparison',
  'vulnerability-research',
]

/** Loader entry 的最小形状，用于遍历组装。 */
interface Entry {
  id?: unknown
  name?: unknown
  disabled?: unknown
  config?: unknown
}

/** 展开后的一行：entry 本身，以及它在该平台上是否被（自身或父 group）停用。 */
interface FlatRow {
  entry: Entry
  disabled: boolean
}

/** 解析一份组装文本为最外层的 entry 列表。 */
async function loadEntries(path: string): Promise<Entry[]> {
  const document = loadCordisYaml(await readFile(path, 'utf8'))
  if (!Array.isArray(document)) throw new TypeError(`${path} is not a Loader entry array`)
  return document as Entry[]
}

/** 组装里的一条 entry 是否在给定平台上被停用。 */
function disabledOn(entry: Entry, platform: 'win32' | 'darwin' | 'linux'): boolean {
  if (entry.disabled === true) return true
  if (!isJsExpr(entry.disabled)) return false
  // 组装里只用一种门控形态：`process.platform ===|!== '<target>'`。
  const match = /^process\.platform\s*(===|!==)\s*'(\w+)'$/.exec(entry.disabled.__jsExpr.trim())
  expect(match, `unsupported disabled gate: ${entry.disabled.__jsExpr}`).not.toBeNull()
  const [, operator, expected] = match!
  return operator === '===' ? platform === expected : platform !== expected
}

/** 递归展开 group 的 `config`，逐行带上「是否因父级被停用而失效」。 */
function flatten(entries: Entry[], platform: 'win32' | 'darwin' | 'linux', inherited = false): FlatRow[] {
  const result: FlatRow[] = []
  for (const entry of entries) {
    const disabled = inherited || disabledOn(entry, platform)
    result.push({ entry, disabled })
    if (isCordisGroupEntry(entry)) {
      result.push(...flatten(entry.config as Entry[], platform, disabled))
    }
  }
  return result
}

/** 当前平台上生效的行。 */
async function activeRows(path: string, platform: 'win32' | 'darwin' | 'linux'): Promise<Entry[]> {
  return flatten(await loadEntries(path), platform)
    .filter(row => !row.disabled)
    .map(row => row.entry)
}

/** 一行 entry 的 `config` 对象。 */
function configOf(entry: Entry): Record<string, unknown> {
  return (entry.config ?? {}) as Record<string, unknown>
}

/** 只保留指定插件包的行。 */
function rowsOf(entries: Entry[], name: string): Entry[] {
  return entries.filter(entry => entry.name === name)
}

describe('reverse preset discovery', () => {
  it('is supplied by the shipped root alongside every other preset, and is loadable', async () => {
    const presets = await discoverPresets([{ path: PRESET_ROOT, trust: 'system' }])

    expect(presets.map(preset => preset.id).sort())
      .toEqual(['code', 'codex', 'cordis', 'minimal', 'reverse', 'standard'])
    const reverse = presets.find(preset => preset.id === 'reverse')
    // `broken` 是发现过程给出的原因；能挂载的预设没有这个字段。
    expect(reverse).toMatchObject({ id: 'reverse', trust: 'system' })
    expect(reverse?.broken).toBeUndefined()
  })

  it('publishes display metadata so the mode picker shows it by name', async () => {
    const metadata = await readPresetMetadata(REVERSE_DIR)

    expect(metadata.name).toBe('逆向分析模式')
    expect(metadata.description).toContain('REA')
    // 随包预设靠 order 排序；与其它预设的 order 冲突会让名单顺序不稳定。
    expect(metadata.order).toBeGreaterThan(5)
  })
})

describe('REA tools are available only in the reverse mode', () => {
  it.each(['darwin', 'linux', 'win32'] as const)('mounts exactly one REA server on %s', async (platform) => {
    const rows = rowsOf(await activeRows(COMPOSITION, platform), MCP_PACKAGE)

    expect(rows).toHaveLength(1)
    const config = configOf(rows[0]!)
    expect(config.serverName).toBe('rea')
    expect(config.transport).toBe('stdio')
    // `npx` 需要 `-y` 才不会停在安装确认上；版本固定，避免技能正文与服务器工具面脱节。
    expect(config.args).toContain(PINNED_REA_PACKAGE)
    expect(config.args).toContain('mcp')
    if (platform === 'win32') {
      // Windows 上 npx 是命令垫片，必须经 cmd.exe 启动。
      expect(config.command).toBe('cmd.exe')
      expect((config.args as string[]).slice(0, 2)).toEqual(['/d', '/c'])
    } else {
      expect(config.command).toBe('npx')
    }
  })

  it('keeps the mode usable when the engine cannot start', async () => {
    const [row] = rowsOf(await activeRows(COMPOSITION, 'darwin'), MCP_PACKAGE)
    const config = configOf(row!)

    // 默认值即 false；显式打开会让缺引擎的机器连整个模式都挂载失败。
    expect(config.failOnStartupError).toBeUndefined()
    // Ghidra 冷启动默认 330 秒，默认 60 秒的调用超时会掐断真实分析。
    expect(config.toolCallTimeoutMs).toBeGreaterThanOrEqual(300_000)
  })

  it('appears in no other preset and no host composition', async () => {
    const presets = await readdir(PRESET_ROOT, { withFileTypes: true })
    const others = presets.filter(entry => entry.isDirectory() && entry.name !== 'reverse').map(entry => entry.name)

    for (const preset of others) {
      const entries = await loadEntries(join(PRESET_ROOT, preset, 'agent.cordis.yml'))
      expect(rowsOf(entries, MCP_PACKAGE), `${preset} must not mount an MCP server`).toEqual([])
    }
    // 宿主组合挂载的 MCP 服务器对每个会话可见，那会绕过模式约束。
    for (const bundle of ['base', 'web-app']) {
      const entries = await loadEntries(join(ROOT, 'packages/bundle', bundle, 'cordis.patch.yml'))
      expect(rowsOf(entries, MCP_PACKAGE), `${bundle} must not mount an MCP server`).toEqual([])
    }
  })
})

describe('reverse mode skills ship with the preset', () => {
  it('discovers its own skill directory through the filesystem provider', async () => {
    const [row] = (await loadEntries(COMPOSITION)).filter(entry => entry.name === 'coding-skill-filesystem')

    expect(row).toBeDefined()
    const dirs = configOf(row!).customSkillDirs as { __jsExpr: string }[]
    expect(dirs).toHaveLength(1)
    // `baseUrl` 是组装文件所在目录，随 preset 一起被复制和安装。
    expect(dirs[0]?.__jsExpr).toContain('skills/')
    expect(dirs[0]?.__jsExpr).toContain('baseUrl')
  })

  it('ships one valid SKILL.md per skill, named after its directory', async () => {
    const dirs = await readdir(join(REVERSE_DIR, 'skills'), { withFileTypes: true })

    expect(dirs.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()).toEqual(SKILLS)
    for (const name of SKILLS) {
      const source = await readFile(join(REVERSE_DIR, 'skills', name, 'SKILL.md'), 'utf8')
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

  it('tells the model how the REA tools are named', async () => {
    const [persona] = (await loadEntries(COMPOSITION)).filter(entry => entry.id === 'persona')
    const text = String(configOf(persona!).text)

    expect(text).toContain('mcp__rea__')
    expect(text).toContain('reverse-engineering')
    // 授权边界是这个模式的必要约束，不是一个可选的礼貌提示。
    expect(text).toContain('授权')
  })
})
