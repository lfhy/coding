import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveRuntimeConfig, type RuntimeConfigOptions } from '../src/runtime-config.ts'

const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(): Promise<RuntimeConfigOptions> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-electron-runtime-'))
  fixtures.push(root)
  const userHome = join(root, 'user')
  const repoRoot = join(root, 'repo')
  const resourcesPath = join(root, 'dist', 'Coding.app', 'Contents', 'Resources')
  await Promise.all([
    mkdir(userHome),
    mkdir(join(repoRoot, 'dist'), { recursive: true }),
    mkdir(join(repoRoot, 'apps', 'desktop', 'packaging', 'icon.iconset'), { recursive: true }),
    mkdir(resourcesPath, { recursive: true }),
    mkdir(join(resourcesPath, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true }),
    mkdir(join(resourcesPath, 'remote-agent'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(repoRoot, 'dist', 'coding-electron-helper-darwin-arm64'), ''),
    writeFile(join(repoRoot, 'apps', 'desktop', 'packaging', 'icon.iconset', 'icon_512x512@2x.png'), ''),
    writeFile(join(resourcesPath, 'coding-electron-helper'), ''),
    writeFile(join(resourcesPath, 'coding-host'), ''),
    writeFile(join(resourcesPath, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), ''),
    writeFile(join(resourcesPath, 'CodingIcon.png'), ''),
    writeFile(join(resourcesPath, 'metadata.json'), '{"version":"0.1.0-rc.8","sha256":"secret-sha"}\n'),
  ])
  return {
    packaged: false, userHome, repoRoot, resourcesPath, platform: 'darwin', arch: 'arm64',
    environment: {
      PATH: '/bin', DEEPSEEK_API_KEY: 'local-key', DEEPSEEK_BASE_URL: 'https://example.test',
      DSH_REMOTE_BRIDGE_URL: 'old-origin', DSH_REMOTE_BRIDGE_TOKEN: 'old-token',
      DSH_AGENTS_HOME: '/tmp/old-agents', DSH_HOME: '/tmp/old-home',
      DSH_CWD: '/tmp/old-cwd', DSH_APP_VERSION: 'old-version',
      CODING_HOST_COMMAND: '/tmp/injected-host', CODING_REPO_ROOT: '/tmp/other-repo',
      ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--require=/tmp/inject.js',
    },
  }
}

function expectCleanEnvironment(environment: NodeJS.ProcessEnv): void {
  expect(environment).toEqual({ PATH: '/bin', DEEPSEEK_API_KEY: 'local-key', DEEPSEEK_BASE_URL: 'https://example.test' })
}

describe('Electron runtime configuration', () => {
  it('将开发 Home 和工作区隔离，并传递精确的 helper 参数与环境', async () => {
    const options = await fixture()
    const result = await resolveRuntimeConfig(options)
    const home = join(options.userHome, '.dsh-electron-dev')
    expect(result).toMatchObject({
      home, cwd: join(home, 'workspace'), userData: join(home, 'electron-user-data'),
      version: 'dev',
      iconPath: join(options.repoRoot, 'apps', 'desktop', 'packaging', 'icon.iconset', 'icon_512x512@2x.png'),
      helper: {
        executable: join(options.repoRoot, 'dist', 'coding-electron-helper-darwin-arm64'),
        args: ['--home', home, '--cwd', join(home, 'workspace'), '--host-version', 'dev', '--repo-root', options.repoRoot],
        cwd: options.repoRoot,
      },
    })
    expectCleanEnvironment(result.helper.env)
    expect(options.environment.DSH_HOME).toBe('/tmp/old-home')
    await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('从 Resources 读取生产版本且不触碰安装版 Home', async () => {
    const options = { ...await fixture(), packaged: true }
    const installedHome = join(options.userHome, '.dsh')
    await symlink(join(options.userHome, 'missing-installed-target'), installedHome)
    const result = await resolveRuntimeConfig(options)
    expect(result).toMatchObject({
      home: installedHome, cwd: options.userHome,
      userData: join(options.userHome, '.dsh-electron-user-data'),
      iconPath: join(options.resourcesPath, 'CodingIcon.png'),
      version: '0.1.0-rc.8',
      helper: {
        executable: join(options.resourcesPath, 'coding-electron-helper'),
        args: ['--home', installedHome, '--cwd', options.userHome, '--host-version', '0.1.0-rc.8',
          '--runtime-root', options.resourcesPath, '--exclusive-desktop-instance'],
        cwd: options.userHome,
      },
    })
    expectCleanEnvironment(result.helper.env)
    expect((await lstat(installedHome)).isSymbolicLink()).toBe(true)
    await expect(lstat(result.userData)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([['linux', 'arm64'], ['darwin', 'x64']] as const)(
    '拒绝 %s/%s 的安装版运行', async (platform, arch) => {
      const options = await fixture()
      await expect(resolveRuntimeConfig({ ...options, packaged: true, platform, arch }))
        .rejects.toThrow('requires macOS arm64')
    },
  )

  it.each(['coding-electron-helper', 'CodingIcon.png', 'coding-host', 'metadata.json'])(
    '拒绝缺失的生产资源 %s', async (file) => {
      const options = { ...await fixture(), packaged: true }
      await rm(join(options.resourcesPath, file))
      await expect(resolveRuntimeConfig(options)).rejects.toThrow(`required file is unavailable: ${join(options.resourcesPath, file)}`)
    },
  )

  it('拒绝无效版本而不回显 metadata 的其他字段', async () => {
    const options = { ...await fixture(), packaged: true }
    const metadata = join(options.resourcesPath, 'metadata.json')
    for (const value of ['{"version":"../invalid","sha256":"secret-sha"}', '{"sha256":"secret-sha"}', '{']) {
      await writeFile(metadata, value)
      await expect(resolveRuntimeConfig(options)).rejects.toThrow(/invalid runtime .*metadata/u)
      await expect(resolveRuntimeConfig(options)).rejects.not.toThrow('secret-sha')
    }
    expect(await readFile(metadata, 'utf8')).toBe('{')
  })

  it('拒绝生产资源目录和文件的链接', async () => {
    const options = { ...await fixture(), packaged: true }
    await symlink(options.resourcesPath, `${options.resourcesPath}-link`)
    await expect(resolveRuntimeConfig({ ...options, resourcesPath: `${options.resourcesPath}-link` }))
      .rejects.toThrow('symbolic link')
    const helper = join(options.resourcesPath, 'coding-electron-helper')
    await rm(helper)
    await symlink(join(options.repoRoot, 'dist', 'coding-electron-helper-darwin-arm64'), helper)
    await expect(resolveRuntimeConfig(options)).rejects.toThrow('symbolic link')
  })

  it('拒绝生产 userData 链接和缺失的 Host 入口', async () => {
    const options = { ...await fixture(), packaged: true }
    const entry = join(options.resourcesPath, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    await rm(entry)
    await expect(resolveRuntimeConfig(options)).rejects.toThrow('required file is unavailable')
    await writeFile(entry, '')
    await symlink(options.userHome, join(options.userHome, '.dsh-electron-user-data'))
    await expect(resolveRuntimeConfig(options)).rejects.toThrow('symbolic link')
  })

  it('拒绝开发资源缺件、开发 Home 链接与相对输入路径', async () => {
    const options = await fixture()
    await rm(join(options.repoRoot, 'dist', 'coding-electron-helper-darwin-arm64'))
    await expect(resolveRuntimeConfig(options)).rejects.toThrow('required file is unavailable')
    await writeFile(join(options.repoRoot, 'dist', 'coding-electron-helper-darwin-arm64'), '')
    await symlink(join(options.userHome, '.dsh'), join(options.userHome, '.dsh-electron-dev'))
    await expect(resolveRuntimeConfig(options)).rejects.toThrow('symbolic link')
    await expect(resolveRuntimeConfig({ ...options, repoRoot: 'relative/repository' })).rejects.toThrow('absolute path')
  })
})
