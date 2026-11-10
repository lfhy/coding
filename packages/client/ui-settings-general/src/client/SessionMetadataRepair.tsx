import { useEffect, useId, useRef, useState } from 'react'
import type { IApiClient } from 'coding-api-remotes/client'
import { Button } from 'coding-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import css from './SessionMetadataRepair.module.css'

type RebuildResponse = Awaited<ReturnType<IApiClient['sessions']['rebuildMetadata']>>
type RebuildReport = Extract<RebuildResponse['result'], { ok: true }>['value']

/** 注册侧提供只读日志、重建派生缓存的本地 Host 操作。 */
export interface SessionMetadataRepairInjected {
  /** 请求失败时拒绝；取消后 Host 停止继续扫描，已完成的缓存重建保留。 */
  rebuildMetadata: (signal: AbortSignal) => Promise<RebuildReport>
}

/** 通用设置行及其本地操作、语言依赖。 */
export type SessionMetadataRepairProps = PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings'> & SessionMetadataRepairInjected

/**
 * 展示元数据重建进度及逐会话失败，不将日志损坏描述为可修复。
 * @param props - 组合后的设置行 props。
 * @returns 设置行、操作按钮和可访问的结果反馈。
 */
export function SessionMetadataRepair({ rebuildMetadata, t }: SessionMetadataRepairProps) {
  const descriptionId = useId()
  const request = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<RebuildReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => () => { request.current?.abort() }, [])

  async function repair(): Promise<void> {
    if (request.current !== null) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setReport(null)
    setError(null)
    try {
      const result = await rebuildMetadata(controller.signal)
      if (!controller.signal.aborted) setReport(result)
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      request.current = null
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  return (
    <div className={css.row}>
      <div className={css.header}>
        <div className={css.copy}>
          <div className={css.title}>{t('metadata.title')}</div>
          <div className={css.description} id={descriptionId}>{t('metadata.description')}</div>
        </div>
        <Button
          variant="outline"
          disabled={busy}
          aria-describedby={descriptionId}
          onClick={() => { void repair() }}
        >
          {t('metadata.repair')}
        </Button>
      </div>
      {busy && <div className={css.description} role="status">{t('metadata.loading')}</div>}
      {report !== null && (
        <>
          <div className={css.description} role="status">
            {t('metadata.result', {
              total: report.total,
              rebuilt: report.rebuilt,
              skipped: report.skippedLive,
              failed: report.failures.length,
            })}
          </div>
          {report.failures.length > 0 && (
            <div className={css.error} role="alert">
              <div>{t('metadata.failures')}</div>
              <ul className={css.failures}>
                {report.failures.map(failure => (
                  <li key={failure.sessionId}>{failure.sessionId}：{failure.message}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {error !== null && <div className={css.error} role="alert">{t('metadata.error', { reason: error })}</div>}
    </div>
  )
}
