/** Build the Coding SEA Host runtime and native Go client binaries. */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')
const runtimeManifest = join(root, 'apps', 'runtime', 'package.json')
const artifacts = join(root, '.artifacts', 'coding-runtime')
const staging = join(artifacts, 'deploy')
const dist = join(root, 'dist', 'coding-runtime')
const desktopRuntime = join(dist, 'runtime')
const desktopMetadata = join(dist, 'metadata.json')
const seaBootstrap = join(root, 'scripts', 'sea', 'bootstrap.cjs')
const seaConfig = join(artifacts, 'sea-config.json')
const seaBlob = join(artifacts, 'sea-prep.blob')
const archive = join(artifacts, 'coding-runtime.tgz')

function command(command: string, args: string[], cwd = root): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, CI: 'true' } })
    child.once('error', (error) => { reject(error) })
    child.once('exit', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} ${args.join(' ')} exited ${String(code)}`))
    })
  })
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Walk the staging tree and report any symbolic link below `directory`. */
async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * Legacy pnpm deploy leaves workspace links behind and can omit hoisted direct
 * dependencies (vendored cosmokit/schemastery): replace links with dereferenced
 * copies and restore missing hoists from the workspace node_modules.
 */
async function normalizeStaging(staging: string): Promise<void> {
  // 预扫 packages 两级目录，建立 scoped 包名 → 源码目录的映射，供缺失
  // 依赖的回填使用（legacy deploy 不会搬运 workspace:^ 的传递依赖）。
  const workspacePackageDirs = new Map<string, string>()
  for (const group of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const entry of await readdir(join(root, 'packages', group.name), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifestPath = join(root, 'packages', group.name, entry.name, 'package.json')
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: string }
      if (manifest.name !== undefined) workspacePackageDirs.set(manifest.name, dirname(manifestPath))
    }
  }
  const manifestPath = join(staging, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dependencies?: Record<string, string> }
  // 仓库根 node_modules 不含 workspace link 包；vendored 框架包从其内层
  // node_modules 解析（pnpm 的 link 产物所在位置）。
  const searchRoots = [
    join(root, 'node_modules'),
    join(root, 'packages', 'bundle', 'base', 'node_modules'),
    join(root, 'packages', 'bundle', 'web-app', 'node_modules'),
    join(root, 'packages', 'boot', 'app-boot', 'node_modules'),
  ]
  const names = [...new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    // Legacy deploy 会丢掉深层 workspace 依赖（dsh-app-boot 的 group 等），
    // 每个部署包的 dependency 声明都要补齐扫描来源。
    '@deepseek-ai/cosmokit',
    '@deepseek-ai/schemastery',
    '@deepseek-ai/cordis-plugin-group',
  ])].sort()
  for (const dependency of names) {
    const destination = join(staging, 'node_modules', dependency)
    if (existsSync(destination)) continue
    // vendor 根目录的包名与目录名不同：目录名按依赖名映射。
    const vendorName = dependency.replace(/^@deepseek-ai\//u, '').replace(/^cordis-plugin-/u, '')
    // 工作区包的目录与 scoped 名不对应（@deepseek-ai/dsh-timeout 在
    // packages/util/timeout）：直接遍历 packages 二级目录按 name 匹配。
    const workspaceDir = workspacePackageDirs.get(dependency)
    const workspaceCandidates = workspaceDir === undefined ? [] : [workspaceDir]
    const source = [...searchRoots.map(search => join(search, dependency)), ...workspaceCandidates, join(root, 'vendor', vendorName)]
      .find(candidate => existsSync(candidate))
    if (source === undefined) continue
    const nestedNodeModules = join(source, 'node_modules')
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}${sep}`),
    } satisfies { recursive: boolean; dereference: boolean; filter: (source: string, destination: string) => boolean })
  }
  // 部署闭包内每个包的 dependencies 也要补：legacy hoister 只搬直接依赖。
  // 扫描两轮：外层补齐后新出现的包自身的依赖在第二轮被覆盖。
  for (let round = 0; round < 2; round += 1) {
    const scopes = [
      join(staging, 'node_modules', '@deepseek-ai'),
      join(staging, 'node_modules'),
    ]
    for (const scope of scopes) {
      for (const entry of await readdir(scope, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const packageManifestPath = join(scope, entry.name, 'package.json')
        if (!existsSync(packageManifestPath)) continue
        const packageManifest = JSON.parse(await readFile(packageManifestPath, 'utf8')) as {
          dependencies?: Record<string, string>
          peerDependencies?: Record<string, string>
        }
        for (const dependency of Object.keys({ ...packageManifest.dependencies, ...packageManifest.peerDependencies })) {
          const destination = join(staging, 'node_modules', dependency)
          if (existsSync(destination)) continue
          const vendorName = dependency.replace(/^@deepseek-ai\//u, '').replace(/^cordis-plugin-/u, '')
          // 工作区包的目录与 scoped 名不对应时按 name 映射查找。
          const workspaceDir = workspacePackageDirs.get(dependency)
          const workspaceCandidates = workspaceDir === undefined ? [] : [workspaceDir]
          const source = [...searchRoots.map(search => join(search, dependency)), ...workspaceCandidates, join(root, 'vendor', vendorName)]
            .find(candidate => existsSync(candidate))
          if (source === undefined) continue
          const nestedNodeModules = join(source, 'node_modules')
          await cp(source, destination, {
            recursive: true,
            dereference: true,
            filter: path => path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}${sep}`),
          } satisfies { recursive: boolean; dereference: boolean; filter: (source: string, destination: string) => boolean })
        }
      }
    }
  }
  let remaining = await findSymlink(join(staging, 'node_modules'))
  while (remaining !== undefined) {
    const segments = remaining.split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(segments.slice(0, binIndex + 1).join(sep), { recursive: true, force: true })
      remaining = await findSymlink(join(staging, 'node_modules'))
      continue
    }
    const resolvedSource: string = await realpath(remaining)
    const nestedNodeModules = join(resolvedSource, 'node_modules')
    await rm(remaining, { recursive: true, force: true })
    await cp(resolvedSource, remaining, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}${sep}`),
    })
    remaining = await findSymlink(join(staging, 'node_modules'))
  }
}

async function main(): Promise<void> {
  const values = parseArgs({
    args: process.argv.slice(2).filter(argument => argument !== '--'),
    options: {
      target: { type: 'string' },
      'skip-build': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  }).values
  const manifest = JSON.parse(await readFile(runtimeManifest, 'utf8')) as { version: string }
  if (!values['skip-build']) await command(process.execPath, ['--import', 'tsx/esm', join(root, 'scripts', 'build.ts')])
  const cliBin = join(root, 'apps', 'cli', 'lib', 'bin.js')
  if (!existsSync(cliBin)) {
    throw new Error(`build:runtime: missing ${cliBin}; pnpm run build must emit the CLI bin before deploy`)
  }
  if (values['dry-run']) {
    console.log(`build:runtime: deploy ${runtimeManifest} into ${staging}`)
    console.log('build:runtime: create tgz and Node SEA blob with useCodeCache=false/useSnapshot=false')
    return
  }
  await rm(artifacts, { recursive: true, force: true })
  await rm(dist, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  await mkdir(dist, { recursive: true })
  await command('pnpm', [
    '--filter', 'coding-host-runtime', 'deploy', '--legacy', '--prod',
    '--config.node-linker=hoisted', '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true', staging,
  ])
  const stagedBin = join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(stagedBin)) {
    throw new Error(`build:runtime: deploy omitted ${stagedBin}`)
  }
  await normalizeStaging(staging)
  await cp(staging, desktopRuntime, { recursive: true, dereference: true })
  const desktopBin = join(desktopRuntime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(desktopBin)) {
    throw new Error(`build:runtime: desktop runtime omitted ${desktopBin}`)
  }
  const desktopSymlink = await findSymlink(desktopRuntime)
  if (desktopSymlink !== undefined) {
    throw new Error(`build:runtime: desktop runtime contains symbolic link ${desktopSymlink}`)
  }
  await command('tar', ['--format=pax', '-chzf', archive, '-C', staging, '.'])
  const archiveBytes = await readFile(archive)
  const metadata = { version: manifest.version, sha256: sha256(archiveBytes) }
  const metadataPath = join(staging, 'coding-runtime-manifest.json')
  const metadataText = `${JSON.stringify(metadata)}\n`
  await writeFile(metadataPath, metadataText)
  await writeFile(desktopMetadata, metadataText)
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
  const target = values.target ?? `${process.platform}-${process.arch}`
  const output = join(dist, `coding-host-${target}${process.platform === 'win32' ? '.exe' : ''}`)
  const desktopHost = join(dist, `coding-node-${target}${process.platform === 'win32' ? '.exe' : ''}`)
  await copyFile(process.execPath, desktopHost)
  await chmod(desktopHost, 0o755)
  await copyFile(process.execPath, output)
  // Homebrew 的 node 是 555，copyFile 会保留只读位；postject 需要写回同一路径。
  await chmod(output, 0o755)
  if (process.platform === 'darwin') await command('codesign', ['--remove-signature', output])
  const postject = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const args = ['--yes', 'postject@1.0.0-alpha.6', output, 'NODE_SEA_BLOB', seaBlob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2']
  if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA')
  await command(postject, args)
  if (process.platform === 'darwin') await command('codesign', ['--sign', '-', output])
  console.log(`build:runtime: ${output} (${(await stat(output)).size} bytes), desktop runtime ${desktopRuntime}, runtime sha256 ${metadata.sha256}`)
}

await main()
