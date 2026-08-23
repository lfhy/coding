/* Coding SEA bootstrapper: materialize the embedded Host closure before exec. */

const { createHash } = require('node:crypto')
const { createRequire } = require('node:module')
const { mkdirSync, existsSync, renameSync, rmSync, writeFileSync, readFileSync, chmodSync, copyFileSync, readdirSync } = require('node:fs')
const { homedir } = require('node:os')
const { dirname, join, resolve, relative, sep } = require('node:path')
const { gunzipSync } = require('node:zlib')
const { pathToFileURL } = require('node:url')

require = createRequire(__filename)

const metadata = JSON.parse(require('node:sea').getAsset('coding-runtime-manifest.json', 'utf8'))
const archive = Buffer.from(require('node:sea').getAsset('coding-runtime.tgz'))
const home = resolve(process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME : join(homedir(), '.dsh'))
// 物化目录只按内容 hash 命名。产品版本写在 marker 里，语义版本变化本身不触发重新解压。
const runtimeId = String(metadata.sha256)
const runtime = join(home, 'runtime', runtimeId)
const marker = join(runtime, '.coding-runtime.json')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function materialized() {
  if (!existsSync(marker)) return false
  try {
    const current = JSON.parse(readFileSync(marker, 'utf8'))
    return current.sha256 === metadata.sha256 && existsSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  } catch {
    return false
  }
}

function octal(buffer, start, length) {
  const value = buffer.subarray(start, start + length).toString('utf8').replace(/\0.*$/u, '').trim()
  return value === '' ? 0 : Number.parseInt(value, 8)
}

function archivePath(root, value) {
  // "./" 是归档根目录条目，物化目标就是 destination 本身，跳过即可。
  if (value === './' || value === '.') return null
  const target = resolve(root, value)
  const contained = relative(root, target)
  if (contained === '' || contained === '..' || contained.startsWith(`..${sep}`)) {
    throw new Error(`Coding runtime archive contains an unsafe path: ${JSON.stringify(value)}`)
  }
  return target
}

function parsePaxPath(body) {
  // pax 扩展头由重复的 "<len> key=value\n" 记录组成，len 是含数字与空格的十进制总长；返回最后一条 path 记录。
  let path = null
  let cursor = 0
  while (cursor < body.length) {
    const space = body.indexOf(' ', cursor)
    if (space < 0) throw new Error('Coding runtime pax header is malformed')
    const length = Number.parseInt(body.subarray(cursor, space).toString('utf8'), 10)
    if (!Number.isSafeInteger(length) || length <= 0 || cursor + length > body.length) {
      throw new Error('Coding runtime pax header has an invalid record length')
    }
    const record = body.subarray(cursor + 1, cursor + length - 1).toString('utf8')
    const eq = record.indexOf('=')
    if (eq < 0) throw new Error('Coding runtime pax header has a malformed record')
    if (record.slice(0, eq) === 'path') path = record.slice(eq + 1)
    cursor += length
  }
  return path
}

function unpack(buffer, destination) {
  const tar = gunzipSync(buffer)
  // 扩展头只作用于紧随其后的条目；全局头作用于后续所有条目直到被覆盖。
  let extendedPath = null
  let globalPath = null
  let total = 0
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    total += 1
    offset += 512 + Math.ceil(octal(header, 124, 12) / 512) * 512
  }
  let done = 0
  let last = -1
  const progress = () => {
    // 冷物化每 500 个条目上报一次；日志量保持有界，启动器只转发百分比。
    const step = Math.floor((done / total) * 200)
    if (done !== total && step === last) return
    last = step
    process.stdout.write(`${JSON.stringify({ type: 'coding-runtime-progress', done, total })}\n`)
  }
  progress()
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) return
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '')
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/u, '')
    const filename = prefix === '' ? name : `${prefix}/${name}`
    const size = octal(header, 124, 12)
    const mode = octal(header, 100, 8)
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156])
    const bodyStart = offset + 512
    const bodyEnd = bodyStart + size
    if (bodyEnd > tar.length) throw new Error('Coding runtime archive is truncated')
    const body = tar.subarray(bodyStart, bodyEnd)
    if (type === 'x' || type === 'g') {
      const parsed = parsePaxPath(body)
      if (type === 'x') extendedPath = parsed
      else if (parsed !== null) globalPath = parsed
      offset = bodyStart + Math.ceil(size / 512) * 512
      continue
    }
    const entryPath = extendedPath ?? globalPath ?? filename
    extendedPath = null
    const target = archivePath(destination, entryPath)
    if (target === null) {
      // 根目录条目：目录本身已由 ensureRuntime 创建。
    } else if (type === '5') {
      mkdirSync(target, { recursive: true, mode: mode || 0o700 })
    } else if (type === '0') {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      writeFileSync(target, body, { mode: mode || 0o600 })
      chmodSync(target, mode || 0o600)
    } else if (type === '1') {
      // 硬链接：pnpm deploy 的 .bin 入口共享目标 inode，物化为可执行副本。
      const linkname = header.subarray(157, 257).toString('utf8').replace(/\0.*$/u, '')
      const source = archivePath(destination, linkname.replace(/^\.\//u, ''))
      if (source === null) throw new Error(`Coding runtime archive has a root hardlink for ${JSON.stringify(filename)}`)
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      copyFileSync(source, target)
      chmodSync(target, 0o755)
    } else {
      throw new Error(`Coding runtime archive has unsupported entry type ${JSON.stringify(type)} for ${JSON.stringify(filename)}`)
    }
    offset = bodyStart + Math.ceil(size / 512) * 512
    done += 1
    progress()
  }
  throw new Error('Coding runtime archive is missing its terminal block')
}

function ensureRuntime() {
  if (materialized()) return
  const parent = join(home, 'runtime')
  mkdirSync(parent, { recursive: true, mode: 0o700 })
  const temporary = `${runtime}.tmp-${process.pid}-${Date.now()}`
  rmSync(temporary, { recursive: true, force: true })
  mkdirSync(temporary, { recursive: true, mode: 0o700 })
  if (sha256(archive) !== metadata.sha256) throw new Error('Coding runtime asset checksum mismatch')
  unpack(archive, temporary)
  writeFileSync(join(temporary, '.coding-runtime.json'), `${JSON.stringify(metadata)}\n`, { mode: 0o600 })
  rmSync(runtime, { recursive: true, force: true })
  renameSync(temporary, runtime)
}

ensureRuntime()
const entry = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
process.env.DSH_APP_VERSION = metadata.version
process.chdir(process.env.DSH_CWD && process.env.DSH_CWD.trim() ? process.env.DSH_CWD : runtime)
void import(pathToFileURL(entry).href).then(() => {
  const recordPath = join(home, 'host.json')
  const cleanup = () => {
    try {
      const record = JSON.parse(readFileSync(recordPath, 'utf8'))
      if (record.version !== metadata.version || record.pid !== process.pid) return false
      for (const name of readdirSync(join(home, 'runtime'))) {
        if (name !== runtimeId) rmSync(join(home, 'runtime', name), { recursive: true, force: true })
      }
      return true
    } catch {
      return false
    }
  }
  const interval = setInterval(() => {
    if (cleanup()) clearInterval(interval)
  }, 250)
}).catch(error => {
  console.error(`Coding Host failed to start: ${String(error)}`)
  process.exitCode = 1
})
