/** 从冻结调用切片派生可回放的插件操作卡片。 */

import type { ToolCallViewProps } from 'coding-client-ui-tool/client'
import { toolDisplayDescription } from 'coding-tools/display-description'
import type {
  CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId, CordisDynamicRunMode,
} from './events.ts'

type Block = ToolCallViewProps['block']

/** 一次工具调用自身的生命周期。 */
export type CordisToolState = 'running' | 'ok' | 'error' | 'stopped'

/** 定义调用冻结的展示数据。 */
export interface CordisDefineCard {
  readonly pluginId: CordisDynamicPluginId | null
  readonly packageId: CordisDynamicPackageId | null
  readonly name: string | null
  readonly displayDescription: string | undefined
  readonly purpose: string | null
  readonly hostCode: string | null
  readonly clientCode: string | null
  readonly output: string | null
  readonly errorSummary: string | null
  readonly state: CordisToolState
}

/** 运行调用冻结的展示数据。 */
export interface CordisRunCard {
  readonly pluginId: CordisDynamicPluginId | null
  readonly packageId: CordisDynamicPackageId | null
  readonly pluginRunId: CordisDynamicPluginRunId | null
  readonly mode: CordisDynamicRunMode | null
  readonly displayDescription: string | undefined
  readonly seq: number | null
  readonly output: string | null
  readonly errorSummary: string | null
  readonly state: CordisToolState
}

/** 停止或移除调用冻结的展示数据。 */
export interface CordisActionCard {
  readonly pluginId: CordisDynamicPluginId | null
  readonly displayDescription: string | undefined
  readonly output: string | null
  readonly errorSummary: string | null
  readonly state: CordisToolState
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

function stringAt(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function objectAt(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key]
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}

function parseArgs(argsRaw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(argsRaw) as unknown
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null
  } catch {
    // 流式调用可能只有截断的 JSON 前缀，旧记录也可能缺少调用参数。
    return null
  }
}

function resultText(block: Extract<Block, { kind: 'tool-result' }>): string | null {
  const text = block.content
    .map(item => item.type === 'text' ? item.text : JSON.stringify(item, null, 2))
    .join('\n')
  if (text !== '') return text
  return block.error === undefined ? null : `${block.error.name}: ${block.error.code}`
}

function stateOf(block: Block): CordisToolState {
  if (!('kind' in block)) return 'running'
  if (block.error?.code === 'interrupted') return 'stopped'
  return block.isError ? 'error' : 'ok'
}

function metaObject(block: Block): Record<string, unknown> | null {
  if (!('kind' in block) || block.isError || typeof block.meta !== 'object' || block.meta === null) return null
  return block.meta as Record<string, unknown>
}

/**
 * 从冻结的调用或结果切片派生定义卡片。
 * @param block - 运行中或已结算的工具调用。
 * @returns 归一化的定义卡片字段。
 */
export function cordisDefineCard(block: Block): CordisDefineCard {
  const settled = 'kind' in block
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
  const args = parseArgs(argsRaw)
  const code = args === null ? null : objectAt(args, 'code')
  const state = stateOf(block)
  const output = settled ? resultText(block) : null
  const meta = metaObject(block)
  return {
    pluginId: meta === null ? null : stringAt(meta, 'pluginId') as CordisDynamicPluginId | null,
    packageId: meta === null ? null : stringAt(meta, 'packageId') as CordisDynamicPackageId | null,
    name: args === null ? null : stringAt(args, 'name'),
    displayDescription: toolDisplayDescription(args, 'cordis_define'),
    purpose: args === null ? null : stringAt(args, 'purpose'),
    hostCode: code === null ? null : stringAt(code, 'host'),
    clientCode: code === null ? null : stringAt(code, 'client'),
    output,
    errorSummary: state === 'error' && output !== null ? firstLine(output) : null,
    state,
  }
}

/**
 * 派生运行卡片与成功激活时的持久元数据。
 * @param block - 运行中或已结算的工具调用。
 * @returns 归一化的运行卡片字段。
 */
export function cordisRunCard(block: Block): CordisRunCard {
  const settled = 'kind' in block
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
  const args = parseArgs(argsRaw)
  const meta = metaObject(block)
  const state = stateOf(block)
  const output = settled ? resultText(block) : null
  const rawMode = args === null ? null : stringAt(args, 'mode')
  const argsPluginId = args === null ? null : stringAt(args, 'pluginId')
  const argsPackageId = args === null ? null : stringAt(args, 'packageId')
  return {
    pluginId: (meta === null ? argsPluginId : stringAt(meta, 'pluginId') ?? argsPluginId) as CordisDynamicPluginId | null,
    packageId: (meta === null ? argsPackageId : stringAt(meta, 'packageId') ?? argsPackageId) as CordisDynamicPackageId | null,
    pluginRunId: (meta === null ? null : stringAt(meta, 'pluginRunId')) as CordisDynamicPluginRunId | null,
    mode: rawMode === 'run' || rawMode === 'update' ? rawMode : null,
    displayDescription: toolDisplayDescription(args, 'cordis_run'),
    seq: settled ? block.seq : null,
    output,
    errorSummary: state === 'error' && output !== null ? firstLine(output) : null,
    state,
  }
}

/**
 * 派生停止或移除调用的卡片信息。
 * @param block - 运行中或已结算的工具调用。
 * @returns 归一化的操作卡片字段。
 */
export function cordisActionCard(block: Block): CordisActionCard {
  const settled = 'kind' in block
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
  const args = parseArgs(argsRaw)
  const state = stateOf(block)
  const output = settled ? resultText(block) : null
  return {
    pluginId: (args === null ? null : stringAt(args, 'pluginId') ?? stringAt(args, 'id')) as CordisDynamicPluginId | null,
    displayDescription: toolDisplayDescription(args, settled ? block.call?.name : block.name),
    output,
    errorSummary: state === 'error' && output !== null ? firstLine(output) : null,
    state,
  }
}
