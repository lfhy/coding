/**
 * isomorphic-git 的 Node HTTP 适配器：直接用 `node:https` 传输，不经过第三方请求库。
 * 这样克隆可以按调用方的信号中止，也不受通用请求库对长连接与空闲超时的默认策略影响。
 * @module coding-git-local/http-node
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http'
import type { GitHttpRequest, GitHttpResponse, HttpClient } from 'isomorphic-git'

export type { GitHttpRequest, GitHttpResponse, HttpClient }

/** 把响应头压平成单值字符串表；同名多值按逗号连接，与 fetch 的语义一致。 */
function flattenHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const flat: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    flat[key] = Array.isArray(value) ? value.join(', ') : value
  }
  return flat
}

/** 按块产出响应体；调用方中途停止读取时销毁连接。 */
async function* readBody(response: IncomingMessage): AsyncGenerator<Uint8Array> {
  for await (const chunk of response) yield chunk as Uint8Array
}

/**
 * 创建面向 isomorphic-git 的 HTTP 客户端。
 * @param timeoutMs - 单次请求的空闲超时；小于等于 0 表示只依赖调用方信号。
 * @returns 可传给 `git.clone({ http })` 的客户端。
 */
export function createNodeHttpClient(timeoutMs = 0): HttpClient {
  return {
    request: async (request) => {
      const { protocol, hostname, port, pathname, search } = new URL(request.url)
      const transport = protocol === 'https:' ? httpsRequest : httpRequest
      const options: RequestOptions = {
        hostname,
        ...port === '' ? {} : { port: Number(port) },
        path: `${pathname}${search}`,
        method: request.method ?? 'GET',
        headers: { 'user-agent': 'git/coding', ...request.headers },
      }
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const outgoing = transport(options, resolve)
        outgoing.once('error', reject)
        if (timeoutMs > 0) outgoing.setTimeout(timeoutMs, () => { outgoing.destroy(new Error('Git HTTP request timed out')) })
        request.signal?.addEventListener('abort', () => { outgoing.destroy(new Error('Git HTTP request was cancelled')) }, { once: true })
        // 请求体按块写入：克隆的上传请求会带上 wants 列表，可能由多个分片组成。
        void (async () => {
          const body = request.body
          if (body === undefined) { outgoing.end(); return }
          try {
            for await (const chunk of body as AsyncIterable<Uint8Array>) outgoing.write(chunk)
            outgoing.end()
          } catch (error: unknown) {
            outgoing.destroy(error instanceof Error ? error : new Error(String(error)))
          }
        })()
      })
      return {
        url: request.url,
        ...request.method === undefined ? {} : { method: request.method },
        headers: flattenHeaders(response.headers),
        body: readBody(response),
        statusCode: response.statusCode ?? 0,
        statusMessage: response.statusMessage ?? '',
      }
    },
  }
}
