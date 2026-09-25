import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPackage, extractFile, getRawHeader, listPackage } from '@electron/asar'
import { packageElectronMacosApp, type PackagingPaths } from './package-electron-macos-app.ts'

const fixtureRoots: string[] = []
const version = '0.1.0-rc.8'
const remoteArtifacts = [
  ['darwin', 'amd64', 'coding-remote-agent-darwin-amd64'],
  ['darwin', 'arm64', 'coding-remote-agent-darwin-arm64'],
  ['linux', 'amd64', 'coding-remote-agent-linux-amd64'],
  ['linux', 'arm64', 'coding-remote-agent-linux-arm64'],
  ['windows', 'amd64', 'coding-remote-agent-windows-amd64.exe'],
  ['windows', 'arm64', 'coding-remote-agent-windows-arm64.exe'],
] as const

async function file(path: string, contents: string | Buffer = 'fixture'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, contents)
}

async function fixture(): Promise<PackagingPaths> {
  const directory = await mkdtemp(join(tmpdir(), 'coding-electron-package-'))
  fixtureRoots.push(directory)
  const paths: PackagingPaths = {
    electron: join(directory, 'electron'),
    shell: join(directory, 'shell'),
    runtime: join(directory, 'coding-runtime'),
    helper: join(directory, 'coding-electron-helper-darwin-arm64'),
    remoteAgent: join(directory, 'remote-agent'),
    icon: join(directory, 'AppIcon.icns'),
    nativeIcon: join(directory, 'CodingIcon.png'),
    output: join(directory, 'dist', 'Coding.app'),
  }
  const electronContents = join(paths.electron, 'Electron.app', 'Contents')
  await file(join(paths.electron, 'version'), '44.0.0\n')
  await file(join(electronContents, 'Info.plist'))
  await file(join(electronContents, 'MacOS', 'Electron'), Buffer.from('cffaedfe', 'hex'))
  const defaultSource = join(directory, 'default-source')
  await file(join(defaultSource, 'package.json'), '{}\n')
  await createPackage(defaultSource, join(electronContents, 'Resources', 'default_app.asar'))
  await rm(defaultSource, { recursive: true })
  await mkdir(join(electronContents, 'Frameworks', 'Electron Framework.framework'), { recursive: true })
  for (const suffix of ['', ' (Renderer)', ' (GPU)', ' (Plugin)']) {
    const contents = join(electronContents, 'Frameworks', `Electron Helper${suffix}.app`, 'Contents')
    await file(join(contents, 'Info.plist'))
    await file(join(contents, 'MacOS', `Electron Helper${suffix}`), Buffer.from('cffaedfe', 'hex'))
  }
  await file(join(paths.shell, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh-desktop-electron', version, type: 'module', main: 'lib/main.js',
    devDependencies: { electron: '44.0.0' },
  })}\n`)
  await file(join(paths.shell, 'lib', 'main.js'), 'console.log("test")\n')
  await file(join(paths.shell, 'lib', 'preload.cjs'))
  await file(join(paths.runtime, 'coding-node-darwin-arm64'), Buffer.from('cffaedfe', 'hex'))
  await file(join(paths.runtime, 'metadata.json'), `${JSON.stringify({ version, sha256: '0'.repeat(64) })}\n`)
  await file(join(paths.runtime, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  await file(join(paths.runtime, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), `${JSON.stringify({ version })}\n`)
  await file(paths.helper, Buffer.from('cffaedfe', 'hex'))
  await file(paths.icon)
  await file(paths.nativeIcon, 'png-fixture')
  await file(join(paths.remoteAgent, 'manifest.json'), `${JSON.stringify({
    version, protocol: 1,
    artifacts: remoteArtifacts.map(([goos, goarch, filename]) => ({ goos, goarch, file: filename })),
  })}\n`)
  for (const [, , name] of remoteArtifacts) await file(join(paths.remoteAgent, name))
  return paths
}

function fakeCommands() {
  const calls: Array<[string, string[]]> = []
  let archiveIntegrity = ''
  const run = async (command: string, args: string[]): Promise<string> => {
    calls.push([command, args])
    if (command === '/usr/libexec/PlistBuddy') {
      if (args[1]?.includes('default_app.asar:hash')) {
        const archive = join(args[2] ?? '', '..', 'Resources', 'default_app.asar')
        return createHash('sha256').update(getRawHeader(archive).headerString).digest('hex')
      }
      if (args[1]?.startsWith('Add :ElectronAsarIntegrity:Resources/app.asar:hash string ')) {
        archiveIntegrity = args[1].split(' ').at(-1) ?? ''
      }
      if (args[1]?.includes('Print :ElectronAsarIntegrity:Resources/app.asar:hash')) return archiveIntegrity
      return ''
    }
    if (command === 'lipo') return 'arm64'
    if (command === 'file') {
      const name = args[1] ?? ''
      if (name.includes('darwin-amd64')) return 'Mach-O 64-bit executable x86_64'
      if (name.includes('darwin-arm64')) return 'Mach-O 64-bit executable arm64'
      if (name.includes('linux-amd64')) return 'ELF 64-bit LSB executable, x86-64'
      if (name.includes('linux-arm64')) return 'ELF 64-bit LSB executable, ARM aarch64'
      if (name.includes('windows-amd64')) return 'PE32+ executable (console) x86-64'
      return 'PE32+ executable (console) Aarch64'
    }
    return ''
  }
  return { run, calls }
}

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('macOS Electron application packaging', () => {
  it('rejects other platforms or CPU architectures before reading artifacts', async () => {
    const paths = await fixture()
    const { run } = fakeCommands()
    await expect(packageElectronMacosApp(paths, { run, platform: 'linux', arch: 'arm64' }))
      .rejects.toThrow('only native macOS arm64')
    await expect(packageElectronMacosApp(paths, { run, platform: 'darwin', arch: 'x64' }))
      .rejects.toThrow('only native macOS arm64')
  })

  it('rejects a missing helper without removing an existing independent application', async () => {
    const paths = await fixture()
    const previous = join(paths.output, 'previous.txt')
    await file(previous, 'preserved')
    await rm(paths.helper)
    const { run } = fakeCommands()
    await expect(packageElectronMacosApp(paths, { run, platform: 'darwin', arch: 'arm64' }))
      .rejects.toThrow('coding-electron-helper-darwin-arm64')
    expect(await readFile(previous, 'utf8')).toBe('preserved')
  })

  it('rejects a missing native PNG before changing an existing application', async () => {
    const paths = await fixture()
    const previous = join(paths.output, 'previous.txt')
    await file(previous, 'preserved')
    await rm(paths.nativeIcon)
    const { run } = fakeCommands()
    await expect(packageElectronMacosApp(paths, { run, platform: 'darwin', arch: 'arm64' }))
      .rejects.toThrow('CodingIcon.png')
    expect(await readFile(previous, 'utf8')).toBe('preserved')
  })

  it('rejects mismatched Host/agent versions and a wrong architecture', async () => {
    const paths = await fixture()
    const { run } = fakeCommands()
    await file(join(paths.runtime, 'metadata.json'), `${JSON.stringify({ version: 'wrong', sha256: '0'.repeat(64) })}\n`)
    await expect(packageElectronMacosApp(paths, { run, platform: 'darwin', arch: 'arm64' }))
      .rejects.toThrow('Host runtime version differs')
    await file(join(paths.runtime, 'metadata.json'), `${JSON.stringify({ version, sha256: '0'.repeat(64) })}\n`)
    const wrongArch = async (command: string, args: string[]) => command === 'lipo' && args[1] === paths.helper
      ? 'x86_64' : run(command, args)
    await expect(packageElectronMacosApp(paths, { run: wrongArch, platform: 'darwin', arch: 'arm64' }))
      .rejects.toThrow('expected arm64 Mach-O')
  })

  it('rejects incomplete or redirected runtime and remote-agent resources', async () => {
    const paths = await fixture()
    const { run } = fakeCommands()
    await rm(join(paths.remoteAgent, 'coding-remote-agent-linux-arm64'))
    await expect(packageElectronMacosApp(paths, { run, platform: 'darwin', arch: 'arm64' }))
      .rejects.toThrow('coding-remote-agent-linux-arm64')
    await file(join(paths.remoteAgent, 'coding-remote-agent-linux-arm64'))
    await symlink(paths.icon, join(paths.runtime, 'runtime', 'escape'))
    await expect(packageElectronMacosApp(paths, { run, platform: 'darwin', arch: 'arm64' }))
      .rejects.toThrow('symbolic link in resource closure')
  })

  it('rejects a tampered Electron default archive before replacing the old app', async () => {
    const paths = await fixture()
    const previous = join(paths.output, 'previous.txt')
    await file(previous, 'preserved')
    const { run } = fakeCommands()
    const wrongIntegrity = async (command: string, args: string[]) =>
      command === '/usr/libexec/PlistBuddy' && args[1]?.includes('default_app.asar:hash')
        ? '0'.repeat(64) : run(command, args)
    await expect(packageElectronMacosApp(paths, { run: wrongIntegrity, platform: 'darwin', arch: 'arm64' }))
      .rejects.toThrow('Electron source ASAR integrity does not match')
    expect(await readFile(previous, 'utf8')).toBe('preserved')
  })

  it('replaces the previous dist/Coding.app after assembling and signing the new app', async () => {
    const paths = await fixture()
    await file(join(paths.output, 'Contents', 'MacOS', 'Coding'), 'previous bundle')
    await file(join(paths.output, 'previous.txt'), 'previous bundle')
    const { run, calls } = fakeCommands()
    await expect(packageElectronMacosApp(paths, { run, platform: 'darwin', arch: 'arm64' }))
      .resolves.toBe(paths.output)
    await expect(stat(join(paths.output, 'previous.txt'))).rejects.toThrow()
    const resources = join(paths.output, 'Contents', 'Resources')
    expect((await stat(join(paths.output, 'Contents', 'MacOS', 'Coding'))).isFile()).toBe(true)
    expect(await readFile(join(paths.output, 'Contents', 'MacOS', 'Coding'))).toEqual(Buffer.from('cffaedfe', 'hex'))
    await expect(stat(join(paths.output, 'Contents', 'MacOS', 'Electron'))).rejects.toThrow()
    await expect(stat(join(paths.output, '..', '.Coding.previous.app'))).rejects.toThrow()
    for (const [key, value] of [
      ['CFBundleName', 'Coding'],
      ['CFBundleDisplayName', 'Coding'],
      ['CFBundleExecutable', 'Coding'],
      ['CFBundleIdentifier', 'com.coding.desktop'],
    ]) {
      expect(calls.some(([command, args]) => command === '/usr/libexec/PlistBuddy'
        && args[1] === `Set :${key} ${value}`)).toBe(true)
    }
    for (const [suffix, identifier] of [
      ['', 'helper'], [' (Renderer)', 'helper.renderer'],
      [' (GPU)', 'helper.gpu'], [' (Plugin)', 'helper.plugin'],
    ]) {
      expect(calls.some(([command, args]) => command === '/usr/libexec/PlistBuddy'
        && args[1] === `Set :CFBundleIdentifier com.coding.desktop.${identifier}`
        && args[2]?.endsWith(`Electron Helper${suffix}.app/Contents/Info.plist`))).toBe(true)
    }
    const archive = join(resources, 'app.asar')
    const packagedManifest = JSON.parse(extractFile(archive, 'package.json').toString('utf8')) as { main?: unknown }
    expect(packagedManifest.main).toBe('lib/main.js')
    expect(extractFile(archive, 'lib/main.js').toString('utf8')).toBe('console.log("test")\n')
    expect(listPackage(archive, { isPack: false })).toContain('/lib/preload.cjs')
    for (const item of ['coding-host', 'coding-electron-helper', 'metadata.json',
      'runtime/node_modules/@deepseek-ai/dsh/lib/bin.js', 'remote-agent/manifest.json', 'CodingIcon.png']) {
      expect((await stat(join(resources, item))).isFile()).toBe(true)
    }
    expect(await readFile(join(resources, 'CodingIcon.png'), 'utf8'))
      .toBe('png-fixture')
    await expect(stat(join(resources, 'app'))).rejects.toThrow()
    await expect(stat(join(resources, 'default_app.asar'))).rejects.toThrow()
    const signs = calls.filter(([command, args]) => command === 'codesign' && args.includes('--sign'))
    expect(signs.at(-1)?.[1].at(-1)).toContain('.Coding.staging-')
    expect(signs.slice(0, -1).some(([, args]) => args.at(-1)?.includes('Electron Helper.app'))).toBe(true)
    expect(calls.some(([command, args]) => command === 'codesign' && args.includes('--deep') && args.includes('--verify'))).toBe(true)
    const updateIntegrity = calls.find(([command, args]) => command === '/usr/libexec/PlistBuddy'
      && args[1]?.startsWith('Add :ElectronAsarIntegrity:Resources/app.asar:hash string '))
    expect(updateIntegrity?.[1][1]).toContain(
      createHash('sha256').update(getRawHeader(archive).headerString).digest('hex'),
    )
  })

  it('restores the previous application when staged replacement fails', async () => {
    const paths = await fixture()
    const previous = join(paths.output, 'previous.txt')
    await file(previous, 'preserved')
    const { run } = fakeCommands()
    const move: typeof rename = async (source, destination) => {
      if (String(source).includes('.Coding.staging-') && String(destination) === paths.output) {
        throw new Error('injected stage rename failure')
      }
      return rename(source, destination)
    }
    await expect(packageElectronMacosApp(paths, { run, move, platform: 'darwin', arch: 'arm64' }))
      .rejects.toThrow('injected stage rename failure')
    expect(await readFile(previous, 'utf8')).toBe('preserved')
    await expect(stat(join(paths.output, '..', '.Coding.previous.app'))).rejects.toThrow()
  })

  it('preserves the previous application when signing the staged bundle fails', async () => {
    const paths = await fixture()
    const previous = join(paths.output, 'previous.txt')
    await file(previous, 'preserved')
    const { run } = fakeCommands()
    const failSigning = async (command: string, args: string[]) => {
      if (command === 'codesign') throw new Error('injected signing failure')
      return run(command, args)
    }
    await expect(packageElectronMacosApp(paths, { run: failSigning, platform: 'darwin', arch: 'arm64' }))
      .rejects.toThrow('injected signing failure')
    expect(await readFile(previous, 'utf8')).toBe('preserved')
    await expect(stat(join(paths.output, '..', '.Coding.previous.app'))).rejects.toThrow()
  })

  it('recovers an interrupted previous-app backup before rejecting bad inputs', async () => {
    const paths = await fixture()
    const backup = join(paths.output, '..', '.Coding.previous.app')
    await file(join(backup, 'previous.txt'), 'restorable')
    await rm(paths.helper)
    const { run } = fakeCommands()
    await expect(packageElectronMacosApp(paths, { run, platform: 'darwin', arch: 'arm64' }))
      .rejects.toThrow('coding-electron-helper-darwin-arm64')
    expect(await readFile(join(paths.output, 'previous.txt'), 'utf8')).toBe('restorable')
  })

  it('refuses an installed application output path even with test command injection', async () => {
    const paths = await fixture()
    const { run } = fakeCommands()
    await expect(packageElectronMacosApp({ ...paths, output: '/Applications/Coding.app' },
      { run, platform: 'darwin', arch: 'arm64' })).rejects.toThrow('refusing to overwrite')
  })

  it('refuses an output directory redirected by a symbolic link', async () => {
    const paths = await fixture()
    const redirected = join(paths.output, '..', '..', 'redirected')
    await mkdir(redirected, { recursive: true })
    await symlink(redirected, join(paths.output, '..'))
    const { run } = fakeCommands()
    await expect(packageElectronMacosApp(paths, { run, platform: 'darwin', arch: 'arm64' }))
      .rejects.toThrow('output directory must not be a symbolic link')
    expect((await stat(redirected)).isDirectory()).toBe(true)
  })

  it('refuses a redirected application before recovering a backup', async () => {
    const paths = await fixture()
    const redirected = join(paths.output, '..', '..', 'redirected')
    await file(join(redirected, 'unchanged'))
    await file(join(paths.output, '..', '.Coding.previous.app', 'previous.txt'), 'preserved')
    await symlink(redirected, paths.output)
    const { run } = fakeCommands()
    await expect(packageElectronMacosApp(paths, { run, platform: 'darwin', arch: 'arm64' }))
      .rejects.toThrow('output path must not be a symbolic link')
    expect(await readFile(join(redirected, 'unchanged'), 'utf8')).toBe('fixture')
    expect(await readFile(join(paths.output, '..', '.Coding.previous.app', 'previous.txt'), 'utf8')).toBe('preserved')
  })
})
