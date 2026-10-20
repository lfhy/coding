/** GenUI 围栏的最终回复诊断；提取规则与修正反馈本身分开维护。 */

import { droppedNodeFailure } from './genui-diagnostic.ts'
import { resolveFence } from '../shared/fence-resolve.ts'
import { extractGenuiFences, fenceFingerprint, type ExtractedFence } from './fence-extraction.ts'

/** 一条围栏无法渲染时交给模型的诊断。 */
export interface FenceFailure {
  readonly index: number
  readonly fingerprint: string
  /** 与 validate_dsh_ui 工具一致的可执行诊断。 */
  readonly detail: string
}

/** `null` 表示围栏可以渲染；否则返回失败原因。 */
function fenceFailureDetail(fence: ExtractedFence): string | null {
  const resolution = resolveFence(fence.raw, { settled: true })
  if (resolution.spec !== null) return null
  // Markdown 收尾缺失不等于 JSON 失败；可渲染的未闭合围栏不应重复修正。
  if (!fence.closed) return 'error=unterminated_fence\nrequired=closing_fence'
  if (resolution.processed !== null) {
    const dropped = droppedNodeFailure(resolution.processed, resolution.value)
    return dropped?.join('\n')
      ?? ['error=invalid_spec', ...resolution.processed.errors.map(error => `diagnostic=${JSON.stringify(error)}`)].join('\n')
  }
  return 'error=invalid_json\nrepair=failed'
}

/**
 * 按浏览器最终渲染规则诊断回复中的所有 GenUI 围栏。
 *
 * @param text - assistant 回复正文。
 * @returns 仍会退化为代码块的围栏，按文档顺序排列。
 */
export function fenceFailures(text: string): FenceFailure[] {
  const failures: FenceFailure[] = []
  for (const fence of extractGenuiFences(text)) {
    const detail = fenceFailureDetail(fence)
    if (detail !== null) failures.push({ index: fence.index, fingerprint: fenceFingerprint(fence.raw), detail })
  }
  return failures
}

export { extractGenuiFences, extractDshUiFences, fenceFingerprint } from './fence-extraction.ts'
export type { ExtractedFence } from './fence-extraction.ts'
