/** 根据原版工作台的图片复制操作，将非 PNG 图片转成浏览器剪贴板支持的 PNG。 */
async function asPng(image: CanvasImageSource, width: number, height: number): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null) return null
  context.drawImage(image, 0, 0)
  return new Promise((resolve) => { canvas.toBlob(resolve, 'image/png') })
}

export async function copyImageBlob(blob: Blob): Promise<boolean> {
  try {
    if (typeof ClipboardItem === 'undefined') return false
    if (blob.type === 'image/png') {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      return true
    }
    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(blob)
      try {
        const png = await asPng(bitmap, bitmap.width, bitmap.height)
        if (png === null) return false
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
        return true
      } finally { bitmap.close() }
    }
    const image = new Image()
    const source = URL.createObjectURL(blob)
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => { resolve() }
        image.onerror = () => { reject(new Error('无法解码图片')) }
        image.src = source
      })
      const png = await asPng(image, image.naturalWidth, image.naturalHeight)
      if (png === null) return false
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      return true
    } finally { URL.revokeObjectURL(source) }
  } catch { return false }
}
