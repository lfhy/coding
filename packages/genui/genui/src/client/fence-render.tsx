/**
 * GenUI 围栏解析与定稿诊断；旧 panel/append 字段只作历史数据兼容。
 * 流式渲染仅使用已闭合的组件，不会将不完整 JSON 补成可交互界面。
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type Key, type ReactNode } from 'react'
import { CodeBlock } from 'coding-client-ui-primitives'
import { GENUI_FENCE_LANGUAGE } from '../shared/fence-language.ts'
import { codeBlockLabels } from './primitive-labels.ts'
import { t, useT } from './i18n/index.ts'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { ExportableGenuiBlock } from './artifact/ExportableGenuiBlock.tsx'
import { fenceStateKey } from './interaction-store.ts'
import type { GenuiSpec } from './spec.ts'
import { describeJsonFailure } from '../shared/fence-repair.ts'
import { resolveFence, resolveFenceSpec, type FenceResolution } from '../shared/fence-resolve.ts'

/** 完成态围栏稳定来源，用于每条消息的交互状态隔离。 */
export interface GenuiFenceSource {
  readonly id: string
  readonly order: readonly [number, number, number]
}

/** 围栏所属的会话，以及仅在定稿后提供的稳定来源。 */
export interface GenuiFenceContext {
  readonly sessionId?: string
  readonly source?: GenuiFenceSource
}

const FENCE_ERROR_STYLE: CSSProperties = {
  margin: '0 0 6px', padding: '6px 10px', borderRadius: 6,
  background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-state-error-primary)',
  color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, lineHeight: 1.55, whiteSpace: 'pre-wrap',
}

const CHART_ERROR_PATTERN = new RegExp([
  'variant is unsupported',
  '|kind must be bars, line, or donut',
  '|requires data or series',
  '|(?:data|series) is required for',
  '|(?:\\.data|\\.series)(?:\\[\\d+\\])?(?:\\.(?:data|label|value|color))? must',
  '|series is only supported for bars',
].join(''))

function processSemanticFailure(resolution: FenceResolution): string | null {
  if (resolution.spec !== null || resolution.processed === null) return null
  const chartErrors = resolution.processed.errors.filter(error => CHART_ERROR_PATTERN.test(error))
  return chartErrors.length === 0
    ? t('err.fieldValidation', { errors: resolution.processed.errors.join('；') })
    : t('err.chartValidation', { errors: chartErrors.join('；') })
}

/**
 * 提供定稿围栏不可渲染的原因；未完成的流式正文由 DOM 所有者抑制诊断。
 * @param raw - 围栏原文。
 * @param options - 只有定稿后才能采用结构补全。
 * @returns 可渲染或空正文返回 null，其余为可见诊断。
 */
export function describeFenceFailure(raw: string, options: { settled?: boolean } = {}): string | null {
  const resolution = resolveFence(raw, { settled: options.settled ?? true })
  if (resolution.spec !== null) return null
  const semantic = processSemanticFailure(resolution)
  if (semantic !== null) return t('err.fenceKeptAsCode', { diagnostic: semantic })
  if (raw.trim() === '') return null
  const parseDiagnostic = describeJsonFailure(raw)
  return parseDiagnostic === null ? null : t('err.fenceParse', { diagnostic: parseDiagnostic })
}

/**
 * 在恢复原始代码块时显示错误，避免无效围栏仅剩难以察觉的裸 JSON。
 * @param props - 围栏原文及是否允许定稿修复。
 * @returns 诊断提示；可渲染的正文返回 null。
 */
export function FenceDiagnostic({ raw, settled = false }: { raw: string; settled?: boolean }): ReactNode {
  useT()
  const message = describeFenceFailure(raw, { settled })
  return message === null ? null : <div style={FENCE_ERROR_STYLE} role="alert">{message}</div>
}

function FenceFallback({ raw, fenceKey }: { raw: string; fenceKey: Key }) {
  useT()
  const ref = useRef<HTMLDivElement | null>(null)
  const [settled, setSettled] = useState(false)
  useLayoutEffect(() => {
    if (ref.current !== null && ref.current.closest('[data-streaming]') === null) setSettled(true)
  })
  return (
    <div ref={ref}>
      {settled && <FenceDiagnostic raw={raw} />}
      <CodeBlock key={fenceKey} {...codeBlockLabels()} code={`${raw}\n`} lang={GENUI_FENCE_LANGUAGE} />
    </div>
  )
}

/**
 * 在流式阶段只解析已完成的组件；完整结构的补全仅允许在定稿后进行。
 * @param raw - 围栏正文。
 * @param context - 会话归属与可选的定稿来源。
 * @returns 通过校验的规格，否则返回 null。
 */
export function resolveGenuiSpec(raw: string, context?: GenuiFenceContext): GenuiSpec | null {
  return resolveFenceSpec(raw, { settled: context?.source !== undefined })
}

function renderInlineFence(key: Key, context: GenuiFenceContext | undefined, spec: GenuiSpec): ReactNode {
  const sessionId = context?.sessionId
  const stateKey = sessionId === undefined || context?.source === undefined
    ? undefined
    : fenceStateKey(sessionId, context.source.id, JSON.stringify(spec))
  return (
    <ErrorBoundary key={JSON.stringify([sessionId, key])} label={t('err.boundary.fence')}>
      <ExportableGenuiBlock
        spec={spec}
        animateEntrance={context?.source === undefined}
        stateKey={stateKey}
        exportEnabled={context?.source !== undefined}
      />
    </ErrorBoundary>
  )
}

/**
 * DOM 接管成功时提供内联界面；任何 panel/append 历史字段均不再产生面板副作用。
 * @param raw - 围栏原文。
 * @param key - 稳定 DOM 身份。
 * @param context - 所属会话及定稿来源。
 * @returns 完整组件或 null（由 DOM 通道显示加载态/恢复原文）。
 */
export function renderResolvedFenceNode(raw: string, key: Key, context?: GenuiFenceContext): ReactNode | null {
  const spec = resolveGenuiSpec(raw, context)
  return spec === null ? null : renderInlineFence(key, context, spec)
}

/**
 * 组件级渲染入口；解析失败时保留可复制的原始代码块。
 * @param raw - 围栏原文。
 * @param key - 稳定渲染身份。
 * @param context - 所属会话及定稿来源。
 * @returns 内联界面或源码降级块。
 */
export function renderGenuiFence(raw: string, key: Key, context?: GenuiFenceContext): ReactNode {
  return renderResolvedFenceNode(raw, key, context) ?? <FenceFallback key={key} fenceKey={key} raw={raw} />
}
