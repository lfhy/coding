/**
 * 已发送输入图片的托管副本与模型可见路径说明。
 * 图片字节仍由附件服务拥有；本模块只把同一批已准入的图片再复制一份到全局文件库，
 * 让模型在后续步骤里能按路径回看原件，而不是只看到无法定位的图片块。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from 'coding-attachment'
import type { Session } from 'coding-session'

/** 一张已发送输入图片在文件库中的副本；`path` 是本机受管理目录里的绝对路径。 */
export interface InputImageCopy {
  readonly path: string
  readonly mediaType: ImageAttachmentRef['mediaType']
  readonly bytes: number
  readonly width: number
  readonly height: number
}

/** 输入图片已通过附件准入，却没能写入文件库。调用方据此拒绝本条 prompt。 */
export class InputImageCopyError extends Error {
  /**
   * @param message - 不含本机路径的失败说明。
   * @param options - 原始失败，仅用于 Host 日志。
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'InputImageCopyError'
  }
}

/** 可选文件库服务的最小结构：复制输入图片并给出副本绝对路径。 */
interface InputImageLibrary {
  saveInputImage(input: {
    sessionId: string
    attachmentId: string
    mediaType: ImageAttachmentRef['mediaType']
    name?: string
    data: Uint8Array
  }): Promise<{ path: string }>
}

/**
 * 把本批已准入的输入图片复制到全局文件库。
 * 组合没有挂载文件库时整批返回 `undefined`，附件仍按原样进入会话；
 * 已挂载却复制失败时抛出 {@link InputImageCopyError}，避免静默接受一条模型无法定位的图片消息。
 * 早期已写入的副本不会因后续一条失败而删除，磁盘与文件库元数据分属两个介质。
 * @param ctx - Host 上下文，用于读取可选文件库与附件服务。
 * @param session - 接收本批图片的会话，决定文件库归属。
 * @param refs - 与请求中的图片部分同序的已准入引用。
 * @returns 与 `refs` 同序的副本列表。
 */
export async function copyInputImagesToFileLibrary(
  ctx: Context,
  session: Session,
  refs: readonly ImageAttachmentRef[],
): Promise<readonly (InputImageCopy | undefined)[]> {
  if (refs.length === 0) return []
  const library = ctx.get('fileLibrary') as InputImageLibrary | undefined
  if (library === undefined) return refs.map(() => undefined)
  const copies: InputImageCopy[] = []
  for (const ref of refs) {
    try {
      const stored = await ctx.attachments.readImage(ref)
      const saved = await library.saveInputImage({
        sessionId: session.id,
        attachmentId: String(ref.attachmentId),
        mediaType: stored.ref.mediaType,
        ...ref.name === undefined ? {} : { name: ref.name },
        data: stored.data,
      })
      copies.push({
        path: saved.path,
        mediaType: stored.ref.mediaType,
        bytes: stored.ref.bytes,
        width: stored.ref.width,
        height: stored.ref.height,
      })
    } catch (error: unknown) {
      ctx.logger.warn('api-proxy: input image was admitted but could not be saved to the file library', error)
      throw new InputImageCopyError('the input image could not be saved to the managed files library', { cause: error })
    }
  }
  return copies
}
