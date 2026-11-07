/** 从工具调用的冻结结果展示图像；图片读取由会话拥有者授权。 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ToolCallViewProps } from 'coding-client-ui-tool/client'
import type { PropsLocale } from 'coding-client-ui-slots'
import { Button, IconDownloadOutline16, ImageLightbox } from 'coding-client-ui-primitives'
import { ImageToolLoading } from './ImageToolLoading.tsx'
import type { NS } from './locales.ts'
import css from './ImageToolRow.module.css'

type ImageRef = Parameters<NonNullable<ToolCallViewProps['loadImage']>>[0]
type ImageToolRowProps = ToolCallViewProps & PropsLocale<typeof NS>
  & { openInStudio: (attachmentId: ImageRef['attachmentId']) => void }
type State = 'running' | 'complete' | 'failed' | 'stopped'

function requestedCount(block: ToolCallViewProps['block']): number | undefined {
  const raw = 'kind' in block ? block.call?.argsRaw : block.argsRaw
  if (raw === undefined) return undefined
  try {
    const args: unknown = JSON.parse(raw)
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
    const prompts = (args as Record<string, unknown>).prompts
    return Array.isArray(prompts) ? prompts.length : 1
  } catch {
    return undefined
  }
}

function imageState(block: ToolCallViewProps['block'], count: number): State {
  if (!('kind' in block)) return 'running'
  if (['interrupted', 'ABORTED', 'ABORTED_BEFORE_DISPATCH'].includes(block.error?.code ?? '')) return 'stopped'
  return block.isError || count === 0 ? 'failed' : 'complete'
}

/**
 * 一张结果图复用共享原图预览，读取失败可重试；不取得 blob URL 的释放所有权。
 * @param props - 持久图片引用、会话授权读取器与本地化文案。
 * @returns 可预览、下载的图片或明确的读取失败状态。
 */
function ResultImage({ attachment, loadImage, openInStudio, inspect, t }: {
  attachment: ImageRef
  loadImage: ToolCallViewProps['loadImage']
  openInStudio: ImageToolRowProps['openInStudio'] | undefined
  inspect: ImageToolRowProps['inspect']
  t: ImageToolRowProps['t']
}) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [open, setOpen] = useState(false)
  const close = useCallback(() => { setOpen(false) }, [])
  useEffect(() => {
    let current = true
    setSrc(null)
    setOpen(false)
    setFailed(false)
    if (loadImage === undefined) {
      setFailed(true)
      return
    }
    void loadImage(attachment).then((url) => {
      if (current) setSrc(url)
    }).catch(() => {
      if (current) setFailed(true)
    })
    return () => { current = false }
  }, [attachment, attempt, loadImage])
  const download = (): void => {
    if (src === null) return
    const anchor = document.createElement('a')
    anchor.href = src
    anchor.download = `image-${attachment.attachmentId.replace(/[^a-zA-Z0-9_-]/gu, '-')}.${attachment.mediaType.split('/')[1] ?? 'png'}`
    anchor.click()
  }
  return <div className={css.result}>
    {failed ? <div className={css.loadError}>
      <span role="status">{t('imageMissing')}</span>
      {loadImage !== undefined && <Button size="sm" onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</Button>}
    </div> : <button type="button" className={css.preview} disabled={src === null}
      aria-label={t('preview')} onClick={() => { setOpen(true) }}>
      {src === null ? <span className={css.reading} role="status">{t('galleryLoading')}</span>
        : <img src={src} alt={attachment.name ?? t('image')}
          width={attachment.width} height={attachment.height} decoding="async"
          onError={() => { setFailed(true) }} />}
    </button>}
    {(src !== null && !failed || openInStudio !== undefined || inspect !== undefined) && <div className={css.imageActions}>
      {src !== null && !failed && <Button size="sm" icon={<IconDownloadOutline16 size={14} />} onClick={download}>{t('download')}</Button>}
      {openInStudio !== undefined && <Button size="sm" onClick={() => { openInStudio(attachment.attachmentId) }}>{t('toolOpenStudio')}</Button>}
      {inspect !== undefined && <Button size="sm" onClick={inspect}>{t('toolCallDetails')}</Button>}
    </div>}
    {open && src !== null && !failed && <ImageLightbox src={src} alt={attachment.name ?? t('image')}
      labels={{ dialog: t('preview'), close: t('closePreview') }} onClose={close} />}
  </div>
}

/**
 * 画图工具调用的等待、结果和中断展示；终态只由记录的调用块决定。
 * @param props - 工具槽位载荷、本地化文案与当前会话的画图入口。
 * @returns 自动结束的点阵等待态或持久结果图片。
 */
export function ImageToolRow({ block, toolName, loadImage, inspect, openInStudio, t }: ImageToolRowProps) {
  const images = useMemo(() => 'kind' in block && !block.isError
    ? block.content.flatMap(part => part.type === 'image' ? [part.attachment] : []) : [], [block])
  const state = imageState(block, images.length)
  const running = state === 'running'
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [running, block.callId])
  const elapsed = 'kind' in block
    ? block.callTime === null ? null : Math.max(0, block.time - block.callTime)
    : Math.max(0, now - block.time)
  const count = requestedCount(block)
  const failedCount = state === 'complete' && count !== undefined ? Math.max(0, count - images.length) : 0
  return <section className={css.root} data-image-tool-row="" data-tool={toolName} data-state={state}
    aria-label={t('toolImageTask')} aria-busy={running}>
    {running ? <ImageToolLoading label={t('toolCreatingImage')} />
      : state === 'complete' ? <>
        <div className={css.status} role="status">{t('toolImagesCreated', { count: String(images.length) })}</div>
        <div className={css.images}>
          {images.map((attachment, index) => <ResultImage key={`${attachment.attachmentId}:${index}`}
            attachment={attachment} loadImage={loadImage}
            openInStudio={index === images.length - 1 ? openInStudio : undefined}
            inspect={index === images.length - 1 ? inspect : undefined} t={t} />)}
        </div>
        {failedCount > 0 && <div className={css.status} role="status">{t('toolImagesFailed', { count: String(failedCount) })}</div>}
      </> : <div className={css.terminal} role={state === 'failed' ? 'alert' : 'status'}>
        {t(state === 'stopped' ? 'toolImageStopped' : 'kind' in block && !block.isError ? 'toolNoImages' : 'toolImageFailed')}
      </div>}
    <div className={css.footer}>
      {elapsed !== null && <span className={css.elapsed} aria-live="off">
        {t('elapsedSeconds', { seconds: (elapsed / 1_000).toFixed(1) })}
      </span>}
      {!running && state !== 'complete' && inspect !== undefined
        && <Button size="sm" onClick={inspect}>{t('toolCallDetails')}</Button>}
    </div>
  </section>
}
