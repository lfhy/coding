import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareDevelopmentDirectories } from '../src/directories.ts'

const temporaryHomes: string[] = []

afterEach(async () => {
  await Promise.all(temporaryHomes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-electron-dirs-'))
  temporaryHomes.push(home)
  const installedHome = join(home, '.dsh')
  const wailsDevelopmentHome = join(home, '.dsh-dev')
  const hostHome = join(home, '.dsh-electron-dev')
  return {
    home, installedHome, wailsDevelopmentHome, hostHome,
    userData: join(hostHome, 'electron-user-data'),
    workspace: join(hostHome, 'workspace'),
  }
}

describe('Electron 开发目录隔离', () => {
  it('先创建私有 Home，再在其中创建 Electron 数据与空工作区', async () => {
    const paths = await fixture()
    await prepareDevelopmentDirectories(paths)
    expect((await stat(paths.userData)).isDirectory()).toBe(true)
    expect((await stat(paths.workspace)).isDirectory()).toBe(true)
  })

  it.each(['installedHome', 'wailsDevelopmentHome'] as const)(
    '拒绝指向 %s 的开发 Home，且不创建任何子目录',
    async (target) => {
      const paths = await fixture()
      await mkdir(paths[target], { mode: 0o700 })
      const marker = join(paths[target], 'keep')
      await writeFile(marker, 'untouched')
      await symlink(paths[target], paths.hostHome, 'dir')
      await expect(prepareDevelopmentDirectories(paths)).rejects.toThrow('symbolic link')
      await expect(readFile(marker, 'utf8')).resolves.toBe('untouched')
      await expect(readFile(paths.userData)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(paths.workspace)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('复开窗口前重新校验被换成安装版链接的开发 Home', async () => {
    const paths = await fixture()
    await prepareDevelopmentDirectories(paths)
    await mkdir(paths.installedHome)
    await rename(paths.hostHome, `${paths.hostHome}-old`)
    await symlink(paths.installedHome, paths.hostHome, 'dir')
    await expect(prepareDevelopmentDirectories(paths)).rejects.toThrow('symbolic link')
    await expect(stat(join(paths.installedHome, 'host.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(paths.installedHome, 'electron-user-data'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
