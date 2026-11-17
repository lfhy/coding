/**
 * Host 为已发送图片追加的路径说明。
 * 它属于模型可见内容：告诉模型原件的路径与固有元数据。
 * 生成方与识别方共用本模块，避免同一形状在宿主、运行时的复制里各写一份。
 */

/** 一张图片的信封字段；`path` 是运行 Host 的机器上的路径。 */
export interface ImageEnvelopeInput {
  readonly path: string
  readonly mediaType: string
  readonly width: number
  readonly height: number
  readonly bytes: number
}

const IMAGE_ENVELOPE = /^<path>[^\n]+<\/path>\n<type>image<\/type>\n<content>\n[^\n]+\n<\/content>$/u

/**
 * 渲染一张图片旁边的路径说明，形式与 `read_image` 的结果一致。
 * 图片本身仍由相邻的图片块承载，因此这条文本只补路径和固有元数据。
 * @param input - 副本路径与该图片的固有元数据。
 * @returns `<path>`／`<type>`／`<content>` 三段说明。
 */
export function imageEnvelopeText(input: ImageEnvelopeInput): string {
  return `<path>${escapeText(input.path)}</path>\n<type>image</type>\n<content>\n${input.mediaType} image, ${input.width}x${input.height} px, ${input.bytes} bytes\n</content>`
}

/**
 * 判断一个文本块是否为图片路径说明。
 * 只有整块与 {@link imageEnvelopeText} 生成的形状完全一致时才成立，用户自己写出的同类文本仍算正文。
 * @param text - 消息中的文本块内容。
 * @returns 是图片路径说明时为 `true`。
 */
export function isImageEnvelope(text: string): boolean {
  return IMAGE_ENVELOPE.test(text)
}

/** 转义会破坏标签结构的字符；路径其余部分保持原样。 */
function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
