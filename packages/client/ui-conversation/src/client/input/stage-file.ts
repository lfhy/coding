/** 非图片文件经同源 Host 暂存到本机 Home；只返回真实已发布路径。 */

import { stagedFilePathName } from '../contract/staged-file-mention.ts'

const MAX_FILE_BYTES = 32 * 1024 * 1024

/**
 * 保存原始文件字节，拒绝不完整或不可信的路径响应。
 * @param sessionId - 当前会话，Host 校验其本机执行身份与生命周期。
 * @param file - 浏览器拖入的原始文件。
 * @returns 可用于本会话引用的规范本机绝对路径。
 * @throws 状态码为 413 表示文件超限，409 表示工作区不支持或不可用；其他错误统一处理。
 */
export async function stageConversationFile(sessionId: string, file: File): Promise<string> {
  if (file.size > MAX_FILE_BYTES) throw new FileStageError(413)
  let encodedName: string
  try {
    encodedName = encodeURIComponent(file.name)
  } catch {
    throw new FileStageError(400)
  }
  let response: Response
  try {
    response = await fetch('/open-in-app/attach', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-session-id': sessionId,
        'x-file-name': encodedName,
      },
      body: file,
    })
  } catch {
    throw new FileStageError(0)
  }
  if (!response.ok) throw new FileStageError(response.status)
  const value: unknown = await response.json().catch(() => null)
  if (typeof value !== 'object' || value === null || !('path' in value) || typeof value.path !== 'string'
    || stagedFilePathName(value.path) === undefined) throw new FileStageError(0)
  return value.path
}

/** 暂存失败只携带状态码，绝不把服务端内部路径显示给用户。 */
export class FileStageError extends Error {
  constructor(readonly status: number) { super('File staging failed') }
}
