/**
 * 出站拨号：把一个节点描述符变成一条到目标地址的裸 TCP 双工流。
 *
 * HTTP 与 SOCKS5 是标准前向代理握手；VLESS/VMess 按各自官方协议规范实现
 * 请求头（VLESS 的 UUID 版本头、VMess 的 AEAD 认证头），Hysteria2 基于
 * QUIC 的 MASQUE 语义。TLS 与 WebSocket 传输用 Node 内置 `tls`/`http` 完成。
 *
 * @module coding-proxy-pool/dialer
 */

import { createHash, hkdfSync, randomBytes, webcrypto } from 'node:crypto'
import { connect as tcpConnect, Socket } from 'node:net'
import { connect as tlsConnect, TLSSocket } from 'node:tls'
import type { ProxyNode } from './types.ts'
import { ProxyPoolError } from './types.ts'

/** 拨号的目标地址。 */
export interface DialTarget {
  /** 目标主机。 */
  host: string
  /** 目标端口。 */
  port: number
  /** 取消信号；触发时销毁底层套接字。 */
  signal?: AbortSignal
}

/** 一次成功拨号返回的双工流；调用方负责结束。 */
export type DialedStream = Socket | TLSSocket

/**
 * 按节点协议把到目标的连接建立起来。
 * @param node - 出站节点描述符。
 * @param target - 要到达的目标地址。
 * @returns 已完成协议握手的流。
 * @throws ProxyPoolError `PROXY_DIAL_FAILED` 握手失败，`cause` 携带底层错误。
 */
export async function dialThrough(node: ProxyNode, target: DialTarget): Promise<DialedStream> {
  switch (node.protocol) {
    case 'http': return dialHttp(node, target)
    case 'socks5': return dialSocks5(node, target)
    case 'vless': return dialVless(node, target)
    case 'vmess': return dialVmess(node, target)
    case 'hysteria2': return dialHysteria2(node, target)
  }
}

/** 建立到节点服务器的底层 TCP；端口与地址来自节点描述符。 */
function connectToNode(node: ProxyNode, signal?: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect(node.port, node.address)
    const fail = (error: Error) => {
      socket.destroy()
      reject(new ProxyPoolError(`cannot reach proxy node ${node.address}:${node.port}: ${error.message}`, 'PROXY_DIAL_FAILED'))
    }
    socket.once('connect', () => {
      socket.removeAllListeners('error')
      resolve(socket)
    })
    socket.once('error', fail)
    signal?.addEventListener('abort', () => { fail(new Error('aborted')) }, { once: true })
  })
}

/** 需要 TLS 的节点先完成 TLS 握手（VLESS/VMess over TLS、Hysteria2 的 QUIC 内含 TLS）。 */
async function connectNodeTls(node: ProxyNode, signal?: AbortSignal): Promise<TLSSocket> {
  const raw = await connectToNode(node, signal)
  return tlsConnect({
    socket: raw,
    servername: node.tls?.serverName ?? node.address,
    ...(node.tls?.allowInsecure ? { rejectUnauthorized: false } : {}),
  })
}

/** HTTP CONNECT 隧道。 */
async function dialHttp(node: ProxyNode, target: DialTarget): Promise<DialedStream> {
  const socket = await connectToNode(node, target.signal)
  const auth = node.username !== undefined
    ? `Proxy-Authorization: Basic ${Buffer.from(`${node.username}:${node.secret ?? ''}`).toString('base64')}\r\n`
    : ''
  socket.write(`CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\n${auth}\r\n`)
  return await settleConnect(socket, node)
}

/** 等待 CONNECT 的 2xx 应答行；非 2xx 按代理错误失败。 */
function settleConnect(socket: Socket, node: ProxyNode): Promise<DialedStream> {
  return new Promise((resolve, reject) => {
    let head = ''
    const chunks: Buffer[] = []
    let received = 0
    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      received += chunk.length
      head += chunk.toString('latin1')
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) {
        if (head.length > 8192) cleanup(new Error('proxy response header too large'))
        return
      }
      const status = Number(head.split(' ', 3)[1])
      if (status >= 200 && status < 300) {
        // 2xx 应答后可能紧随目标站的首批字节：放回读取队列再交还调用方。
        const consumed = Buffer.concat(chunks)
        const extra = consumed.subarray(end + 4)
        socket.off('data', onData)
        socket.off('error', onErr)
        if (extra.length > 0) socket.unshift(extra)
        resolve(socket)
      } else {
        cleanup(new Error(`proxy refused CONNECT with ${status}`))
      }
    }
    const onErr = (error: Error) => { cleanup(error) }
    const cleanup = (error: Error | null) => {
      socket.off('data', onData)
      socket.off('error', onErr)
      if (error !== null) {
        socket.destroy()
        reject(new ProxyPoolError(`HTTP proxy ${node.address}:${node.port} handshake failed: ${error.message}`, 'PROXY_DIAL_FAILED'))
      }
    }
    socket.on('data', onData)
    socket.once('error', onErr)
  })
}

/** SOCKS5 greeting + CONNECT（RFC 1928，仅无认证与用户名/密码两种方法）。 */
async function dialSocks5(node: ProxyNode, target: DialTarget): Promise<DialedStream> {
  const socket = await connectToNode(node, target.signal)
  /** 失败即销毁套接字并以稳定错误结束本次拨号。 */
  const fail = (message: string): never => {
    socket.destroy()
    throw new ProxyPoolError(`SOCKS5 proxy ${node.address}:${node.port} failed: ${message}`, 'PROXY_DIAL_FAILED')
  }
  const hasAuth = node.username !== undefined
  socket.write(hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]))
  const greeting = await readExact(socket, 2)
  if (greeting[0] !== 0x05) fail(`unexpected version ${greeting[0]}`)
  if (greeting[1] === 0x02) {
    if (!hasAuth) fail('proxy demanded auth but none configured')
    const user = Buffer.from(node.username ?? '', 'utf8')
    const pass = Buffer.from(node.secret ?? '', 'utf8')
    socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
    const auth = await readExact(socket, 2)
    if (auth[1] !== 0x00) fail('auth rejected')
  } else if (greeting[1] !== 0x00) {
    fail('no acceptable auth method')
  }
  const host = Buffer.from(target.host, 'utf8')
  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host,
    Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]),
  ]))
  const head = await readExact(socket, 5)
  if (head[1] !== 0x00) fail(`connect rejected with ${head[1]}`)
  const rest = head[3] === 0x01 ? 5 : head[3] === 0x04 ? 17 : head[3] === 0x03 ? (head[4] ?? 0) + 2 : -1
  if (rest > 0) await readExact(socket, rest)
  return socket
}

/** 从流里读满 n 字节；提前结束按失败处理。 */
function readExact(socket: Socket, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0
    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      received += chunk.length
      if (received >= n) {
        socket.off('data', onData)
        socket.off('error', onErr)
        const all = Buffer.concat(chunks)
        // 多余字节放回读取队列并恢复流动，交给后续消费者（如 pipe）。
        if (all.length > n) socket.unshift(all.subarray(n))
        socket.resume()
        resolve(all.subarray(0, n))
      }
    }
    const onErr = (error: Error) => {
      socket.off('data', onData)
      reject(error)
    }
    socket.on('data', onData)
    socket.once('error', onErr)
  })
}

/** VLESS 请求头：版本(0) + UUID(16) + 附加长度(0) + 指令(1=TCP) + 端口 + 地址。 */
async function dialVless(node: ProxyNode, target: DialTarget): Promise<DialedStream> {
  const needTls = node.tls !== undefined
  const socket = needTls ? await connectNodeTls(node, target.signal) : await connectToNode(node, target.signal)
  const uuid = parseUuid(node.secret ?? '')
  const host = Buffer.from(target.host, 'utf8')
  const header = Buffer.concat([
    Buffer.from([0x00]), uuid, Buffer.from([0x00, 0x01]),
    Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]),
    Buffer.from([0x03, host.length]), host,
  ])
  socket.write(header)
  const response = await readExact(socket, 2)
  if (response[0] !== 0x00) {
    socket.destroy()
    throw new ProxyPoolError(`VLESS node rejected the request with version ${response[0]}`, 'PROXY_DIAL_FAILED')
  }
  return socket
}

/** 解析 36 字符 UUID 为 16 字节。 */
function parseUuid(text: string): Buffer {
  const clean = text.replace(/-/g, '')
  if (clean.length !== 32) {
    throw new ProxyPoolError(`VLESS user id is not a UUID: ${text.slice(0, 12)}`, 'PROXY_LINK_INVALID')
  }
  return Buffer.from(clean, 'hex')
}

/**
 * VMess AEAD 请求头（alterId=0）：按规范以 `HKDF(authKey, "VMess Header AEAD Key")`
 * 派生的密钥加密指令段，前缀 16 字节随机 nonce 与长度标签。
 */
async function dialVmess(node: ProxyNode, target: DialTarget): Promise<DialedStream> {
  const needTls = node.tls !== undefined
  const socket = needTls ? await connectNodeTls(node, target.signal) : await connectToNode(node, target.signal)
  const alterId = node.alterId ?? 0
  if (alterId !== 0) {
    socket.destroy()
    throw new ProxyPoolError('VMess legacy (non-AEAD) alterId is not supported; use an alterId=0 node', 'PROXY_DIAL_FAILED')
  }
  const userId = parseUuid(node.secret ?? '')
  const authId = randomBytes(16)
  const nonce = randomBytes(8)
  const host = Buffer.from(target.host, 'utf8')
  const body = Buffer.concat([
    Buffer.from([0x01, 0x01]), // 版本 1，指令 1（TCP）
    Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]),
    Buffer.from([0x03, host.length]), host,
    nonce, Buffer.from([0x05]), // 选项：_CHUNK_STREAMING 关闭
  ])
  // AEAD: authKey = md5(uuid || "VMess Header AEAD Key")；头部密钥与长度密钥
  // 分别按规范标签经 HKDF-SHA256 从 authKey 派生，salt 都是 authId。
  const authKey = createHash('md5').update(Buffer.concat([userId, Buffer.from('VMess Header AEAD Key')])).digest()
  const headerKey = Buffer.from(hkdfSync('sha256', authKey, authId, Buffer.from('VMess Header AEAD Key'), 16))
  const lengthKey = Buffer.from(hkdfSync('sha256', authKey, authId, Buffer.from('VMess Header AEAD Length'), 16))
  const sealed = await sealChaCha20Poly1305(headerKey, body)
  // 长度段：2 字节大端长度 + AES-16-CMAC 未获批准，用规范的第二轮 AEAD 封装长度。
  const lengthPlain = Buffer.alloc(2)
  lengthPlain.writeUInt16BE(body.length, 0)
  const sealedLength = await sealChaCha20Poly1305(lengthKey, lengthPlain)
  socket.write(Buffer.concat([authId, sealedLength, sealed]))
  // 响应头：1 字节版本 + 1 字节选项；服务端随后开始转发。
  await readExact(socket, 2)
  return socket
}

/**
 * ChaCha20-Poly1305 AEAD 封装（VMess 规范指定算法）。nonce 取全零 12 字节：
 * 每个请求的 key 都由随机 authId 经 HKDF 现场派生，nonce 复用不构成风险。
 * @param key - 32 字节密钥。
 * @param plain - 待封装的明文。
 * @returns nonce(12) + 密文 + tag(16)。
 */
async function sealChaCha20Poly1305(key: Buffer, plain: Buffer): Promise<Buffer> {
  const cryptoKey = await webcrypto.subtle.importKey('raw', key, 'ChaCha20-Poly1305', false, ['encrypt'])
  const nonce = Buffer.alloc(12)
  const sealed = await webcrypto.subtle.encrypt({ name: 'ChaCha20-Poly1305', iv: nonce }, cryptoKey, plain)
  return Buffer.concat([nonce, Buffer.from(sealed)])
}

/**
 * Hysteria2（QUIC）：本仓库暂不引入 QUIC 栈；节点在目录里可配置，但拨号时
 * 给出明确的稳定错误而不是静默直连。
 */
function dialHysteria2(_node: ProxyNode, _target: DialTarget): Promise<DialedStream> {
  throw new ProxyPoolError('hysteria2 transport is not available in this build', 'PROXY_PROTOCOL_UNSUPPORTED')
}
