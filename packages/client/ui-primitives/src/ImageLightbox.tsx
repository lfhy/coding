import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { IconCloseOutline16 } from 'coding-client-ui-icons'
import css from './ImageLightbox.module.css'

/** 原图预览所需的对话框和关闭按钮文案。 */
export interface ImageLightboxLabels { dialog: string; close: string }

/** 在当前文档中呈现可关闭的原图预览，并把焦点交还给打开控件。 */
export function ImageLightbox({ src, alt, labels, onClose }: {
  src: string
  alt: string
  labels: ImageLightboxLabels
  onClose: () => void
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown); restoreRef.current?.focus() }
  }, [onClose])
  return createPortal(
    <div className={css.backdrop} role="dialog" aria-modal="true" aria-label={labels.dialog}>
      <div className={css.mask} aria-hidden="true" onMouseDown={onClose} />
      <img className={css.image} src={src} alt={alt} />
      <button ref={closeRef} type="button" className={css.close} aria-label={labels.close} onClick={onClose}>
        <IconCloseOutline16 size={16} />
      </button>
    </div>, document.body,
  )
}
