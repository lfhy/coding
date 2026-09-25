/** 组装并本机签名独立的 macOS arm64 Electron 应用；不执行安装。 */
import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir, lstat, mkdir, cp, rm, rename, writeFile, copyFile, chmod, open } from 'node:fs/promises'
import { join, dirname, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createPackage, extractFile, getRawHeader, listPackage } from '@electron/asar'

const execFile = promisify(execFileCallback)
const root = resolve(import.meta.dirname, '..')
const electronVersion = '44.0.0'
const applicationName = 'Coding.app'
const applicationExecutable = 'Coding'
const applicationBundleIdentifier = 'com.coding.desktop'
const remoteArtifacts = [
  ['darwin', 'amd64', 'coding-remote-agent-darwin-amd64', /Mach-O.*x86_64/u],
  ['darwin', 'arm64', 'coding-remote-agent-darwin-arm64', /Mach-O.*arm64/u],
  ['linux', 'amd64', 'coding-remote-agent-linux-amd64', /ELF.*x86-64/u],
  ['linux', 'arm64', 'coding-remote-agent-linux-arm64', /ELF.*(?:aarch64|ARM64)/u],
  ['windows', 'amd64', 'coding-remote-agent-windows-amd64.exe', /PE32\+.*x86-64/u],
  ['windows', 'arm64', 'coding-remote-agent-windows-arm64.exe', /PE32\+.*(?:Aarch64|ARM64)/u],
] as const

type Run = (command: string, args: string[]) => Promise<string>

export interface PackagingPaths {
  electron: string
  shell: string
  runtime: string
  helper: string
  remoteAgent: string
  icon: string
  nativeIcon: string
  output: string
}

interface PackagingOptions {
  platform?: string
  arch?: string
  run?: Run
  move?: typeof rename
}

const defaultPaths: PackagingPaths = {
  electron: join(root, 'apps', 'desktop-electron', 'node_modules', 'electron', 'dist'),
  shell: join(root, 'apps', 'desktop-electron'),
  runtime: join(root, 'dist', 'coding-runtime'),
  helper: join(root, 'dist', 'coding-electron-helper-darwin-arm64'),
  remoteAgent: join(root, 'dist', 'remote-agent'),
  icon: join(root, 'apps', 'desktop', 'packaging', 'AppIcon.icns'),
  nativeIcon: join(root, 'apps', 'desktop', 'packaging', 'icon.iconset', 'icon_512x512@2x.png'),
  output: join(root, 'dist', applicationName),
}

async function runCommand(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFile(command, args, { maxBuffer: 1024 * 1024 })
  return stdout.trim()
}

async function requireFile(path: string): Promise<void> {
  const entry = await lstat(path).catch(() => undefined)
  if (!entry?.isFile()) throw new Error(`package: required regular file missing: ${path}`)
}

async function requireDirectory(path: string): Promise<void> {
  const entry = await lstat(path).catch(() => undefined)
  if (!entry?.isDirectory()) throw new Error(`package: required directory missing: ${path}`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** 拒绝生产资源中的符号链接；Electron 框架自身的版本链接由上游保留。 */
async function rejectSymlinks(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`package: symbolic link in resource closure: ${child}`)
    if (entry.isDirectory()) await rejectSymlinks(child)
  }
}

async function assertArm64(path: string, run: Run): Promise<void> {
  await requireFile(path)
  if (await run('lipo', ['-archs', path]) !== 'arm64') {
    throw new Error(`package: expected arm64 Mach-O: ${path}`)
  }
}

async function readVersion(path: string): Promise<string> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { version?: unknown }).version !== 'string') {
    throw new Error(`package: invalid version metadata: ${path}`)
  }
  return (parsed as { version: string }).version
}

function asarHeaderHash(path: string): string {
  return createHash('sha256').update(getRawHeader(path).headerString).digest('hex')
}

async function fileHash(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function validate(paths: PackagingPaths, run: Run): Promise<string> {
  const electronApp = join(paths.electron, 'Electron.app')
  await requireDirectory(electronApp)
  if ((await readFile(join(paths.electron, 'version'), 'utf8')).trim() !== electronVersion) {
    throw new Error(`package: expected Electron ${electronVersion}`)
  }
  const sourceArchive = join(electronApp, 'Contents', 'Resources', 'default_app.asar')
  await requireFile(sourceArchive)
  let sourceHash: string
  try {
    sourceHash = await run('/usr/libexec/PlistBuddy', [
      '-c', 'Print :ElectronAsarIntegrity:Resources/default_app.asar:hash',
      join(electronApp, 'Contents', 'Info.plist'),
    ])
  } catch (error) {
    throw new Error('package: Electron source ASAR integrity is unavailable; cannot update its structure', { cause: error })
  }
  if (sourceHash !== asarHeaderHash(sourceArchive)) {
    throw new Error('package: Electron source ASAR integrity does not match its Info.plist')
  }
  await assertArm64(join(electronApp, 'Contents', 'MacOS', 'Electron'), run)
  await requireDirectory(join(electronApp, 'Contents', 'Frameworks', 'Electron Framework.framework'))
  for (const suffix of ['', ' (Renderer)', ' (GPU)', ' (Plugin)']) {
    const helper = join(electronApp, 'Contents', 'Frameworks', `Electron Helper${suffix}.app`)
    await assertArm64(join(helper, 'Contents', 'MacOS', `Electron Helper${suffix}`), run)
  }
  const electronBinaries: string[] = []
  await walk(electronApp, electronBinaries, [])
  for (const binary of electronBinaries) await assertArm64(binary, run)

  const shellManifest = join(paths.shell, 'package.json')
  const manifest = JSON.parse(await readFile(shellManifest, 'utf8')) as {
    name?: unknown
    version?: unknown
    main?: unknown
    type?: unknown
    devDependencies?: { electron?: unknown }
  }
  if (manifest.name !== '@deepseek-ai/dsh-desktop-electron' || typeof manifest.version !== 'string'
    || manifest.type !== 'module' || manifest.main !== 'lib/main.js'
    || manifest.devDependencies?.electron !== electronVersion) {
    throw new Error('package: unexpected Electron application manifest')
  }
  await requireFile(join(paths.shell, 'lib', 'main.js'))
  await requireFile(join(paths.shell, 'lib', 'preload.cjs'))
  await requireFile(paths.icon)
  await requireFile(paths.nativeIcon)

  await assertArm64(join(paths.runtime, 'coding-node-darwin-arm64'), run)
  await requireDirectory(join(paths.runtime, 'runtime'))
  await rejectSymlinks(join(paths.runtime, 'runtime'))
  const cliPackage = join(paths.runtime, 'runtime', 'node_modules', '@deepseek-ai', 'dsh')
  await requireFile(join(cliPackage, 'lib', 'bin.js'))
  const metadataPath = join(paths.runtime, 'metadata.json')
  const version = await readVersion(metadataPath)
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as { sha256?: unknown }
  if (typeof metadata.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(metadata.sha256)) {
    throw new Error('package: invalid Host runtime archive digest metadata')
  }
  // 该摘要属于构建阶段的 tar.gz，而非预展开目录；无不可变归档时不能伪造目录校验。
  if (version !== manifest.version) throw new Error('package: Host runtime version differs from Electron application')
  if (await readVersion(join(cliPackage, 'package.json')) !== version) {
    throw new Error('package: deployed Host CLI version differs from runtime metadata')
  }
  await assertArm64(paths.helper, run)

  const agentManifest = join(paths.remoteAgent, 'manifest.json')
  const agent: unknown = JSON.parse(await readFile(agentManifest, 'utf8'))
  const record = agent as { version?: unknown; protocol?: unknown; artifacts?: unknown }
  if (typeof agent !== 'object' || agent === null || record.version !== version
    || record.protocol !== 1 || !Array.isArray(record.artifacts) || record.artifacts.length !== remoteArtifacts.length) {
    throw new Error('package: invalid remote-agent manifest or version')
  }
  await rejectSymlinks(paths.remoteAgent)
  const expected = new Set<string>()
  for (const [goos, goarch, file, architecture] of remoteArtifacts) {
    expected.add(`${goos}/${goarch}/${file}`)
    await requireFile(join(paths.remoteAgent, file))
    if (!architecture.test(await run('file', ['-b', join(paths.remoteAgent, file)]))) {
      throw new Error(`package: remote-agent architecture mismatch: ${file}`)
    }
  }
  for (const artifact of record.artifacts) {
    if (typeof artifact !== 'object' || artifact === null) throw new Error('package: invalid remote-agent artifact')
    const item = artifact as { goos?: unknown; goarch?: unknown; file?: unknown }
    if (!expected.delete(`${String(item.goos)}/${String(item.goarch)}/${String(item.file)}`)) {
      throw new Error('package: unexpected remote-agent artifact')
    }
  }
  if (expected.size !== 0) throw new Error('package: incomplete remote-agent manifest')
  return version
}

async function walk(path: string, binaries: string[], bundles: string[]): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (/\.(?:app|framework|bundle|xpc)$/u.test(entry.name)) bundles.push(child)
      await walk(child, binaries, bundles)
    } else if (entry.isFile()) {
      const handle = await open(child, 'r')
      const header = Buffer.alloc(4)
      try {
        await handle.read(header, 0, 4, 0)
      } finally {
        await handle.close()
      }
      const magic = header.toString('hex')
      if (['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(magic)) binaries.push(child)
    }
  }
}

async function signAndVerify(app: string, run: Run): Promise<void> {
  const binaries: string[] = []
  const bundles: string[] = []
  await walk(app, binaries, bundles)
  if (!binaries.includes(join(app, 'Contents', 'MacOS', applicationExecutable))) {
    throw new Error('package: no Electron Mach-O executable in assembled application')
  }
  const depth = (path: string): number => path.split(sep).length
  binaries.sort((a, b) => depth(b) - depth(a))
  bundles.sort((a, b) => depth(b) - depth(a))
  for (const path of binaries) await run('codesign', ['--force', '--sign', '-', path])
  for (const path of bundles) await run('codesign', ['--force', '--sign', '-', path])
  await run('codesign', ['--force', '--sign', '-', app])
  for (const path of bundles) await run('codesign', ['--verify', '--strict', path])
  await run('codesign', ['--verify', '--deep', '--strict', app])
}

/**
 * 只写 dist/Coding.app；输入未齐备时不触碰已有输出。
 * @param paths - 构建产物和独立输出的绝对路径。
 * @param options - 本机架构及系统命令入口，可供无安装副作用的测试注入。
 * @returns 完成逐层 ad-hoc 签名和校验后的应用路径。
 */
export async function packageElectronMacosApp(
  paths: PackagingPaths = defaultPaths,
  options: PackagingOptions = {},
): Promise<string> {
  if ((options.platform ?? process.platform) !== 'darwin' || (options.arch ?? process.arch) !== 'arm64') {
    throw new Error('package: only native macOS arm64 packaging is supported')
  }
  const output = resolve(paths.output)
  const expectedOutput = join(root, 'dist', applicationName)
  // 输出不能由调用者重定向到用户安装目录。
  if (output !== expectedOutput && !options.run) throw new Error(`package: output must be ${expectedOutput}`)
  if (output === resolve('/Applications/Coding.app')) {
    throw new Error('package: refusing to overwrite the installed application')
  }
  const move = options.move ?? rename
  const outputDirectory = dirname(output)
  for (const directory of [dirname(outputDirectory), outputDirectory]) {
    const entry = await lstat(directory).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (entry?.isSymbolicLink()) throw new Error('package: output directory must not be a symbolic link')
  }
  const backup = join(outputDirectory, '.Coding.previous.app')
  for (const path of [output, backup]) {
    const entry = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (entry?.isSymbolicLink()) throw new Error('package: output path must not be a symbolic link')
  }
  // 若上次在重命名间被中断，先恢复旧包；两者并存则不猜测哪个应删除。
  if (await exists(backup)) {
    if (await exists(output)) throw new Error(`package: unresolved previous application backup: ${backup}`)
    await move(backup, output)
  }
  const run = options.run ?? runCommand
  const version = await validate(paths, run)
  await mkdir(outputDirectory, { recursive: true })
  const stage = join(outputDirectory, `.Coding.staging-${process.pid}.app`)
  await rm(stage, { recursive: true, force: true })
  try {
    await cp(join(paths.electron, 'Electron.app'), stage, { recursive: true, verbatimSymlinks: true })
    const contents = join(stage, 'Contents')
    await rename(join(contents, 'MacOS', 'Electron'), join(contents, 'MacOS', applicationExecutable))
    const resources = join(contents, 'Resources')
    const appDirectory = join(stage, '.asar-source')
    const archive = join(resources, 'app.asar')
    await rm(join(resources, 'default_app.asar'), { force: true })
    await mkdir(join(appDirectory, 'lib'), { recursive: true })
    await copyFile(join(paths.shell, 'lib', 'main.js'), join(appDirectory, 'lib', 'main.js'))
    await copyFile(join(paths.shell, 'lib', 'preload.cjs'), join(appDirectory, 'lib', 'preload.cjs'))
    const appManifest = `${JSON.stringify({
      name: 'coding-electron', version, private: true, type: 'module', main: 'lib/main.js',
    }, null, 2)}\n`
    await writeFile(join(appDirectory, 'package.json'), appManifest)
    await createPackage(appDirectory, archive)
    const archiveHash = await fileHash(archive)
    const integrityHash = asarHeaderHash(archive)
    const files = listPackage(archive, { isPack: false })
    if (files.join(',') !== ['/lib', '/lib/main.js', '/lib/preload.cjs', '/package.json'].join(',')) {
      throw new Error(`package: unexpected app.asar entries: ${files.join(',')}`)
    }
    for (const file of ['package.json', 'lib/main.js', 'lib/preload.cjs']) {
      const source = await readFile(join(appDirectory, file))
      if (!extractFile(archive, file).equals(source)) throw new Error(`package: app.asar verification failed: ${file}`)
    }
    await rm(appDirectory, { recursive: true, force: true })
    await copyFile(join(paths.runtime, 'coding-node-darwin-arm64'), join(resources, 'coding-host'))
    await chmod(join(resources, 'coding-host'), 0o755)
    await cp(join(paths.runtime, 'runtime'), join(resources, 'runtime'), { recursive: true })
    await copyFile(join(paths.runtime, 'metadata.json'), join(resources, 'metadata.json'))
    await cp(paths.remoteAgent, join(resources, 'remote-agent'), { recursive: true })
    await copyFile(paths.helper, join(resources, 'coding-electron-helper'))
    await chmod(join(resources, 'coding-electron-helper'), 0o755)
    await copyFile(paths.icon, join(resources, 'AppIcon.icns'))
    await copyFile(paths.nativeIcon, join(resources, 'CodingIcon.png'))

    const plist = join(contents, 'Info.plist')
    for (const [key, value] of [
      ['CFBundleIdentifier', applicationBundleIdentifier],
      ['CFBundleName', 'Coding'],
      ['CFBundleDisplayName', 'Coding'],
      ['CFBundleIconFile', 'AppIcon.icns'],
      ['CFBundleExecutable', applicationExecutable],
      ['CFBundleShortVersionString', version],
      ['CFBundleVersion', version],
    ]) await run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist])
    await run('/usr/libexec/PlistBuddy', ['-c', 'Delete :ElectronAsarIntegrity:Resources/default_app.asar', plist])
    await run('/usr/libexec/PlistBuddy', ['-c', 'Add :ElectronAsarIntegrity:Resources/app.asar dict', plist])
    await run('/usr/libexec/PlistBuddy', ['-c', 'Add :ElectronAsarIntegrity:Resources/app.asar:algorithm string SHA256', plist])
    await run('/usr/libexec/PlistBuddy', ['-c', `Add :ElectronAsarIntegrity:Resources/app.asar:hash string ${integrityHash}`, plist])
    if (await run('/usr/libexec/PlistBuddy', [
      '-c', 'Print :ElectronAsarIntegrity:Resources/app.asar:hash', plist,
    ]) !== integrityHash || await fileHash(archive) !== archiveHash) {
      throw new Error('package: new app.asar integrity verification failed')
    }
    for (const [suffix, identifier] of [
      ['', 'helper'], [' (Renderer)', 'helper.renderer'],
      [' (GPU)', 'helper.gpu'], [' (Plugin)', 'helper.plugin'],
    ]) {
      const helperPlist = join(contents, 'Frameworks', `Electron Helper${suffix}.app`, 'Contents', 'Info.plist')
      await run('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleIdentifier ${applicationBundleIdentifier}.${identifier}`, helperPlist])
    }
    await signAndVerify(stage, run)
    const hadPrevious = await exists(output)
    if (hadPrevious) await move(output, backup)
    try {
      await move(stage, output)
    } catch (error) {
      if (hadPrevious) {
        try {
          await move(backup, output)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `package: replacement failed; previous app retained at ${backup}`)
        }
      }
      throw error
    }
    if (hadPrevious) await rm(backup, { recursive: true, force: true })
    return output
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageElectronMacosApp().then(
    (path) => { console.log(`package-electron-macos-app: ${path} (local ad-hoc signature; not notarized)`) },
    (error: unknown) => { console.error(error); process.exitCode = 1 },
  )
}
