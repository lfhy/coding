/** Build the Coding SEA Host runtime and native Go client binaries. */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const runtimeManifest = join(root, 'apps', 'runtime', 'package.json')
const artifacts = join(root, '.artifacts', 'coding-runtime')
const staging = join(artifacts, 'deploy')
const dist = join(root, 'dist', 'coding-runtime')
const seaBootstrap = join(root, 'scripts', 'sea', 'bootstrap.cjs')
const seaConfig = join(artifacts, 'sea-config.json')
const seaBlob = join(artifacts, 'sea-prep.blob')
const archive = join(artifacts, 'coding-runtime.tgz')
const goAssetDir = join(root, 'apps', 'internal', 'runtime')

function command(command: string, args: string[], cwd = root): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: 'true' } })
    child.once('error', error => reject(error))
    child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`${command} ${args.join(' ')} exited ${String(code)}`)))
  })
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function main(): Promise<void> {
  const values = parseArgs({
    options: {
      target: { type: 'string' },
      'skip-build': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  }).values
  const manifest = JSON.parse(await readFile(runtimeManifest, 'utf8')) as { version: string }
  if (!values['skip-build']) await command('pnpm', ['run', 'build'])
  if (values['dry-run']) {
    console.log(`build:runtime: deploy ${runtimeManifest} into ${staging}`)
    console.log('build:runtime: create tgz and Node SEA blob with useCodeCache=false/useSnapshot=false')
    return
  }
  await rm(artifacts, { recursive: true, force: true })
  await rm(dist, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  await command('pnpm', [
    '--filter', 'coding-host-runtime', 'deploy', '--legacy', '--prod',
    '--config.node-linker=hoisted', '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true', staging,
  ])
  await command('tar', ['--format=ustar', '-chzf', archive, '-C', staging, '.'])
  const archiveBytes = await readFile(archive)
  const metadata = { version: manifest.version, sha256: sha256(archiveBytes) }
  const metadataPath = join(staging, 'coding-runtime-manifest.json')
  await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`)
  await writeFile(seaConfig, `${JSON.stringify({
    main: seaBootstrap,
    output: seaBlob,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    useSnapshot: false,
    assets: {
      'coding-runtime.tgz': archive,
      'coding-runtime-manifest.json': metadataPath,
    },
  }, null, 2)}\n`)
  await command(process.execPath, ['--experimental-sea-config', seaConfig])
  await mkdir(dist, { recursive: true })
  const target = values.target ?? `${process.platform}-${process.arch}`
  const output = join(dist, `coding-host-${target}${process.platform === 'win32' ? '.exe' : ''}`)
  await copyFile(process.execPath, output)
  if (process.platform === 'darwin') await command('codesign', ['--remove-signature', output])
  const postject = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const args = ['--yes', 'postject@1.0.0-alpha.6', output, 'NODE_SEA_BLOB', seaBlob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2']
  if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA')
  await command(postject, args)
  if (process.platform === 'darwin') await command('codesign', ['--sign', '-', output])
  await copyFile(output, join(goAssetDir, process.platform === 'win32' ? 'coding-host.exe' : 'coding-host'))
  await writeFile(join(goAssetDir, 'metadata.json'), `${JSON.stringify({ ...metadata, placeholder: false })}\n`)
  console.log(`build:runtime: ${output} (${(await stat(output)).size} bytes), runtime sha256 ${metadata.sha256}`)
}

await main()
