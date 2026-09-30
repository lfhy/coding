/** 浏览器导航命令输入的 URL 结构校验；不解析 DNS 或限制目标地址。 @module @deepseek-ai/dsh-browser-playwright/url */

import { BrowserUseError } from '@deepseek-ai/dsh-browser'

/**
 * 导航命令接受至多 4096 字符的无凭据绝对 HTTP(S) URL，结构无效时抛出 BrowserUseError。
 * @param raw - 模型或人工导航命令输入的 URL。
 * @returns 解析后的 URL；不产生网络请求。
 */
export function validateBrowserUrl(raw: string): URL {
  if (raw.length > 4096) throw new BrowserUseError('browser URL exceeds 4096 characters', 'BROWSER_FAILED')
  let url: URL
  try { url = new URL(raw) } catch { throw new BrowserUseError(`invalid browser URL: ${raw}`, 'BROWSER_INVALID_URL') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new BrowserUseError(`browser URL denied: ${raw}`, 'BROWSER_DENIED')
  }
  const authority = raw.match(/^https?:\/\/([^/?#\\\s]+)(?:[/?#]|$)/i)?.[1]
  if (!authority) throw new BrowserUseError(`invalid browser URL: ${raw}`, 'BROWSER_INVALID_URL')
  if (authority.includes('@')) throw new BrowserUseError(`browser URL denied: ${raw}`, 'BROWSER_DENIED')
  return url
}
