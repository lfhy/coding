/** Tool-result images share the conversation's session-authorized preview path. */
import { useCallback, useEffect, useState } from 'react'
import type { ImageAttachmentRef } from 'coding-attachment'
import { ImageLightbox } from 'coding-client-ui-primitives'
import type { TranslateNS } from 'coding-client-ui-slots'
import css from './ToolResultImages.module.css'

interface ToolResultImageProps {
  attachment: ImageAttachmentRef
  loadImage: (attachment: ImageAttachmentRef) => Promise<string>
  t: TranslateNS<'conversation'>
}

/** Render one loaded tool image with retry and original-image preview. */
function ToolResultImage({ attachment, loadImage, t }: ToolResultImageProps) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => { setAttempt(value => value + 1) }, [])
  const close = useCallback(() => { setOpen(false) }, [])
  const label = attachment.name ?? t('image.label')

  useEffect(() => {
    let live = true
    setSrc(null)
    setFailed(false)
    void loadImage(attachment).then((url) => {
      if (live) setSrc(url)
    }).catch(() => {
      if (live) setFailed(true)
    })
    return () => { live = false }
  }, [attachment, attempt, loadImage])

  if (failed) {
    return (
      <button type="button" className={css.error} onClick={retry}>
        {t('image.loadFailed')}
      </button>
    )
  }
  return (
    <>
      <button
        type="button"
        className={css.frame}
        title={t('image.openOriginal')}
        aria-label={t('image.openOriginalLabel', { label })}
        onClick={() => { if (src !== null) setOpen(true) }}
      >
        {src === null ? <span className={css.loading}>{t('image.loading')}</span> : <img src={src} alt={label} />}
      </button>
      {open && src !== null && (
        <ImageLightbox
          src={src}
          alt={label}
          labels={{ dialog: t('image.preview'), close: t('image.closePreview') }}
          onClose={close}
        />
      )}
    </>
  )
}

/** Render all image blocks from one expanded tool result. */
export function ToolResultImages({ images, loadImage, t }: {
  images: readonly ImageAttachmentRef[]
  loadImage: (attachment: ImageAttachmentRef) => Promise<string>
  t: TranslateNS<'conversation'>
}) {
  if (images.length === 0) return null
  return (
    <div className={css.gallery} aria-label={t('image.label')}>
      {images.map((attachment, index) => (
        <ToolResultImage
          key={`${String(attachment.attachmentId)}:${String(index)}`}
          attachment={attachment}
          loadImage={loadImage}
          t={t}
        />
      ))}
    </div>
  )
}
