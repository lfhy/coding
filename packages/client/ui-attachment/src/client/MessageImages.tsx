import type { MessageImagesProps } from 'coding-client-ui-conversation/client'
import { ImageGallery } from '../MessageImage.tsx'
import { messageImageLabels } from './labels.ts'

/** Historical message-image slot entry. */
export function MessageImages({ images, loadImage, align, t }: MessageImagesProps) {
  if (loadImage === undefined) return null
  return <ImageGallery images={images} load={loadImage} align={align} labels={messageImageLabels(t)} />
}
