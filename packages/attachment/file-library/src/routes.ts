/** 只读文件列表路由；鉴权和严格回环同源检查先于领域读取。@module coding-file-library/routes */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'coding-client-connection'
import type {} from 'coding-host-webserver'
import type { FileLibrary } from './index.ts'

function trusted(ctx: Context, req: IncomingMessage, res: ServerResponse): boolean {
  const rejected = ctx.connection.requestRejection(req)
  if (rejected !== undefined) { res.writeHead(rejected); res.end(); return false }
  const host = req.headers.host
  const port = ctx.webServer.port
  if (ctx.webServer.host !== '127.0.0.1'
    || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
    || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host ?? '')
    || req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) {
    res.writeHead(403); res.end(); return false
  }
  return true
}

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(data))
}

function parameter(value: string | null, fallback: number): number {
  if (value === null) return fallback
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new TypeError('分页参数无效')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new TypeError('分页参数无效')
  return parsed
}

/** 按服务的插件生命周期注册可撤销的只读路由。 */
export function installFileRoutes(ctx: Context, service: FileLibrary): void {
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: '/api/files/list',
      handler: (req, res) => {
        if (!trusted(webCtx, req, res)) return
        if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          if ([...url.searchParams.keys()].some(key => key !== 'offset' && key !== 'limit')
            || url.searchParams.getAll('offset').length > 1 || url.searchParams.getAll('limit').length > 1) {
            throw new TypeError('分页参数无效')
          }
          json(res, 200, service.list(parameter(url.searchParams.get('offset'), 0), parameter(url.searchParams.get('limit'), 50)))
        } catch (error) {
          if (error instanceof TypeError) { json(res, 400, { error: error.message }); return }
          webCtx.logger.warn('file-library list request failed', error)
          json(res, 503, { error: '文件列表暂不可用' })
        }
      },
    }), 'file-library: GET /api/files/list')
  })
}
