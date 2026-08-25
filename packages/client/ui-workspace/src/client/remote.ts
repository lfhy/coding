/**
 * 将用户输入限制为可由浏览器直接导航的远程 Host 地址。连接认证、隧道和
 * 发现不在此处实现；目标页面负责自己的 Host 连接。
 * @param input - 用户输入的完整地址。
 * @returns 规范化后的 http(s) 地址。
 * @throws {RemoteHostUrlError} 输入为空、协议不受支持或地址携带凭据。
 */
export function remoteHostUrl(input: string): string {
  const value = input.trim()
  if (value === '') throw new RemoteHostUrlError('empty')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new RemoteHostUrlError('missing-protocol')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RemoteHostUrlError('unsupported-protocol')
  }
  if (!/^https?:\/\//iu.test(value)) {
    throw new RemoteHostUrlError('missing-protocol')
  }
  if (url.username !== '' || url.password !== '') {
    throw new RemoteHostUrlError('credentials')
  }
  return url.toString()
}

/** 远程地址的可本地化校验失败分类。 */
export type RemoteHostUrlErrorCode = 'empty' | 'missing-protocol' | 'unsupported-protocol' | 'credentials'

/** 远程地址校验失败；调用方根据 {@link RemoteHostUrlError.code} 选择本地化文案。 */
export class RemoteHostUrlError extends Error {
  /**
   * @param code - 校验失败分类。
   */
  constructor(readonly code: RemoteHostUrlErrorCode) {
    super(code)
    this.name = 'RemoteHostUrlError'
  }
}
