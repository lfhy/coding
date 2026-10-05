/** 使用本机 CONNECT/TLS 对拒绝响应和取消后的连接释放做回归测试。 */
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createSecureContext, TLSSocket } from 'node:tls'
import { describe, expect, it, vi } from 'vitest'
import { DuckDuckGoSearchProvider } from '../src/provider.ts'

// 测试代理只在本地使用此自签名证书；测试专用 Agent 不校验该证书。
vi.mock('undici', async (importOriginal) => {
  const original = await importOriginal<typeof import('undici')>()
  return {
    ...original,
    ProxyAgent: class extends original.ProxyAgent {
      constructor(uri: string) { super({ uri, requestTls: { rejectUnauthorized: false } }) }
    },
  }
})

const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCMky1wz7SKspex
XOwBi3uSvTdbL3il2H1l3rEA763FwxqJXNwcT7rNG0T0zQwQgwBxKyqHy6dYFl5s
7QG+ieQP0vrMWXq+evrut7v/cjUic99/NF0OjrjJtMPfAh2tIgTNL/+fcbiOwIYq
F718rrszzxzKYkUnn+GExfZnGiTlsUukXPOQiJSu/ALbnzbF017vDL1SmB5rb9ny
K2kODxmQamiw5h+Lm3FKOcHxbyeJmg1p6q1xaoxIUl8gXrxPivAanFbatqg0cpjg
UT/oXgxC8+nDcfv6rkSkajCbuBw6LgdkBix3GYI3erXMfHxhfDQCeWGYfBk+t9ZP
TqINB7Y5AgMBAAECggEAAhu1dWEKEz/vLjfnarUDsQ1RKpcNS0hyRgA3XZ0amTIO
QHPh8bNA6RFRAQ5fsVIzpB7afA+h9nxcZWwPCANjphibDgxD/t4TjBe5lDDLavU7
q3nWsPCTRSQmwV4T4Zw2X/jpr6OaGdr5kCFLxFZPBK2FICRl5tybGl2JLt3pon+2
4uY924hnjecYeIAGSlYAa263UJpUFIELMiJ1gm5mAfOdFVsa+X3c0czTXexnyrIc
oBLoWyTXuT/TO7Fvjpg7kqU6dZECTeH0zxu1QVH1rThRhmg//HlGmZ8uWSRr9r4g
dMONSZkY/EC80cFQGtXzajgQJW7XetfPAmSiiQhwgQKBgQC+K/IA0O4Yvu1mQIB3
afbZ+kYZwuVj0tCEKDqoNjtBSb6bA5JhHYinoa5/F8yeJzmupTxU51dCGW0caKi5
DTFrPE794qf97D4jdfsPbFahrrnpMUI48BR6IUjyZYdea/+dNvU0rM8RFaJ5arZE
5+xtHu0hUBFFL3tr60lepaNIgQKBgQC9PDfUwa8aWQx2nnE0iYdY7EaO5uHsGD+Q
WJE5dv4nK2OMkeWlVdxFPKzyf5MttVuyKjguItDwfujICTlAjp8mBwSvM8auekaT
aqhmdSLMTXKfAJ2CMZGqPeeGuxXJ6BLRvM5G1VuT+aSlWXAKcQyzNmFHFqPTpzy2
6dwQaFfRuQKBgE9aoRIsHJ5g1Ukssy6hHeuZXrUTOYstBeuPqeJVNuaocgvXMrap
j0N72QeZk72O2qgAtSssmaGwYHJRTc5iLfP0Z3XTpYv0j31Wltu5tnCjK1qePmbp
73GDACB9sz34TOJ6c1l2nrUfVPvbRpF8QZDLLeIPuhUnmhXPSX9gGMGBAoGBAIOu
tNdLlHMMRn0A0pwRm+rIOG1Wwx4M3aavyxcm88MEEXkPSbPc5LQVffAd0Kg9DLsV
YBTSy3yfg5M3v+xpktvehGb666YclqIc1WS+3GE4/6sfvXuMzOWfwE5kP8xJv1bO
QOjPrbNyRB1/+FR7yK+pBtZ2LbiqJrjOUgHk6j+ZAoGAIb8cLP8fbQ2CQ9zOYHmj
tuUWdphCDuUgjyGbxsYFLfBlB44CsJRk6lbqc49kcARtwroKt5ziXGHJ8X0Lr5fH
h0qI4GuFFJVhJIyMy2ErABdRsoDwi/h8+PRgU1fGjZBgMwcsNEO1ItLTPVgb6iQr
CYC6SUzFWdyOGizt1kYpCLY=
-----END PRIVATE KEY-----`

const CERT = `-----BEGIN CERTIFICATE-----
MIIDPzCCAiegAwIBAgIUMzbfwqdbzNKvBl3M6Ic+oKefAOEwDQYJKoZIhvcNAQEL
BQAwHjEcMBoGA1UEAwwTaHRtbC5kdWNrZHVja2dvLmNvbTAgFw0yNjEwMDUwOTUz
MzhaGA8yMTI2MDkxMTA5NTMzOFowHjEcMBoGA1UEAwwTaHRtbC5kdWNrZHVja2dv
LmNvbTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAIyTLXDPtIqyl7Fc
7AGLe5K9N1sveKXYfWXesQDvrcXDGolc3BxPus0bRPTNDBCDAHErKofLp1gWXmzt
Ab6J5A/S+sxZer56+u63u/9yNSJz3380XQ6OuMm0w98CHa0iBM0v/59xuI7AhioX
vXyuuzPPHMpiRSef4YTF9mcaJOWxS6Rc85CIlK78AtufNsXTXu8MvVKYHmtv2fIr
aQ4PGZBqaLDmH4ubcUo5wfFvJ4maDWnqrXFqjEhSXyBevE+K8BqcVtq2qDRymOBR
P+heDELz6cNx+/quRKRqMJu4HDouB2QGLHcZgjd6tcx8fGF8NAJ5YZh8GT631k9O
og0HtjkCAwEAAaNzMHEwHQYDVR0OBBYEFC3glm/iKW/IOss/fcNmTCW3pUAoMB8G
A1UdIwQYMBaAFC3glm/iKW/IOss/fcNmTCW3pUAoMA8GA1UdEwEB/wQFMAMBAf8w
HgYDVR0RBBcwFYITaHRtbC5kdWNrZHVja2dvLmNvbTANBgkqhkiG9w0BAQsFAAOC
AQEASlZ5qnok/v9pY5LFgtm22u+UVEvrlkfg/4HtX86TBDYx2/6ZnCkXnLxPP7Cz
cSDF8FAOOFUlCRNkn4SSBBh2OIQ0V+8wf9oBI231ARcHbDvlUP5ti6NQDaZF7SPH
UByUJ4BiK5+cq4xhi406x3yyhjAP5+gpLe9KGDACHm9WtArhcUPaRW1Lj855X2UK
2Zkbw6IQU216PnANCukE/yaYTaoVu8ZveOavdulPRqFYX5jQLfndOQS3Av1BP2y6
JrAgdR2ShdM7aoZ6f300cMNc3ya92/88wc39ld31pwRGHTMuW9eBTSj1Tg7IuVbC
MDhWzZHixmaVZ+YWPB0Rc2mykQ==
-----END CERTIFICATE-----`

async function streamingProxy(status: number, contentType: string): Promise<{
  url: string
  sent: Promise<void>
  sockets: Set<TLSSocket>
  close(): Promise<void>
}> {
  const sockets = new Set<TLSSocket>()
  const tlsContext = createSecureContext({ key: KEY, cert: CERT })
  let markSent!: () => void
  const sent = new Promise<void>((resolve) => { markSent = resolve })
  const proxy = createServer()
  proxy.on('connect', (_request, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    const tunnel = new TLSSocket(socket, { isServer: true, secureContext: tlsContext })
    sockets.add(tunnel)
    tunnel.on('error', () => {})
    tunnel.on('close', () => sockets.delete(tunnel))
    tunnel.on('end', () => { tunnel.end() })
    tunnel.once('data', () => {
      tunnel.write(`HTTP/1.1 ${String(status)} Test\r\nContent-Type: ${contentType}\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n`)
      markSent()
    })
  })
  await new Promise<void>((resolve) => { proxy.listen(0, '127.0.0.1', resolve) })
  return {
    url: `http://127.0.0.1:${String((proxy.address() as AddressInfo).port)}`,
    sent,
    sockets,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => { proxy.close(() => { resolve() }) })
    },
  }
}

describe('DuckDuckGo streaming proxy cleanup', () => {
  it.each([
    [503, 'text/html', 'WEB_PROVIDER_ERROR'],
    [200, 'application/json', 'WEB_PROVIDER_ERROR'],
  ])('releases unfinished status %i / %s responses', async (status, contentType, code) => {
    const proxy = await streamingProxy(status, contentType)
    try {
      const search = new DuckDuckGoSearchProvider(() => proxy.url).search({ query: 'q' })
      await proxy.sent
      await expect(search).rejects.toThrow(expect.objectContaining({ code }))
      await vi.waitFor(() => { expect(proxy.sockets.size).toBe(0) })
    } finally {
      await proxy.close()
    }
  })

  it('aborts an unfinished HTML body and releases the tunnel', async () => {
    const proxy = await streamingProxy(200, 'text/html')
    const controller = new AbortController()
    try {
      const search = new DuckDuckGoSearchProvider(() => proxy.url).search({ query: 'q' }, controller.signal)
      await proxy.sent
      controller.abort()
      await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
      await vi.waitFor(() => { expect(proxy.sockets.size).toBe(0) })
    } finally {
      controller.abort()
      await proxy.close()
    }
  })
})
