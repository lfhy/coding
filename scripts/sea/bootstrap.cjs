/* Coding SEA bootstrapper: materialize the embedded Host closure before exec. */

const { createHash } = require('node:crypto')
const { createRequire } = require('node:module')
const { mkdirSync, existsSync, renameSync, rmSync, writeFileSync, readFileSync, chmodSync, readdirSync } = require('node:fs')
const { homedir } = require('node:os')
const { dirname, join, resolve, relative, sep } = require('node:path')
const { gunzipSync } = require('node:zlib')
const { pathToFileURL } = require('node:url')

require = createRequire(__filename)

const metadata = JSON.parse(require('node:sea').getAsset('coding-runtime-manifest.json', 'utf8'))
const archive = require('node:sea').getAsset('coding-runtime.tgz')
const home = resolve(process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME : join(homedir(), '.dsh'))
const runtime = join(home, 'runtime', metadata.version)
const marker = join(runtime, '.coding-runtime.json')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function materialized() {
  if (!existsSync(marker)) return false
  try {
    const current = JSON.parse(readFileSync(marker, 'utf8'))
    return current.version === metadata.version && current.sha256 === metadata.sha256 && existsSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  } catch {
    return false
  }
}

function octal(buffer, start, length) {
  const value = buffer.subarray(start, start + length).toString('utf8').replace(/\0.*$/u, '').trim()
  return value === '' ? 0 : Number.parseInt(value, 8)
}

function archivePath(root, value) {
  const target = resolve(root, value)
  const contained = relative(root, target)
  if (contained === '' || contained === '..' || contained.startsWith(`..${sep}`)) {
    throw new Error(`Coding runtime archive contains an unsafe path: ${JSON.stringify(value)}`)
  }
  return target
}

function unpack(buffer, destination) {
  const tar = gunzipSync(buffer)
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
    const target = archivePath(destination, filename)
    if (type === '5') {
      mkdirSync(target, { recursive: true, mode: mode || 0o700 })
    } else if (type === '0') {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
      writeFileSync(target, tar.subarray(bodyStart, bodyEnd), { mode: mode || 0o600 })
      chmodSync(target, mode || 0o600)
    } else {
      throw new Error(`Coding runtime archive has unsupported entry type ${JSON.stringify(type)} for ${JSON.stringify(filename)}`)
    }
    offset = bodyStart + Math.ceil(size / 512) * 512
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
        if (name !== metadata.version) rmSync(join(home, 'runtime', name), { recursive: true, force: true })
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
