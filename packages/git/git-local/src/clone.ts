/** 克隆：优先本机 `git`，没有可执行文件时退回内置的 JavaScript 实现。 @module coding-git-local/clone */

import { access, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import fs from 'node:fs'
import { GitOperationError, gitCredentialRef, gitRemoteIdentity } from 'coding-git'
import type { GitCloneInput, GitCloneResult, GitRemoteOptions } from 'coding-git'
import gitJs from 'isomorphic-git'
import { createNodeHttpClient } from './http-node.ts'
import { LOCAL_GIT, checked, runGit } from './cli-process.ts'
import { remoteCommand, storedCredential } from './credentials.ts'

/** 克隆大仓库的独立预算：远端握手、打包传输与检出都算在一次命令里。 */
const CLONE_TIMEOUT = 30 * 60_000

/**
 * 确认目标目录可以接收克隆：必须不存在，或是不含任何内容的已有目录。
 * @param path - 目标目录绝对路径。
 * @throws {GitOperationError} 目标已存在非空内容。
 */
async function ensureTargetFree(path: string): Promise<void> {
  try {
    const info = await stat(path)
    if (!info.isDirectory()) throw new GitOperationError('GIT_TARGET_EXISTS', 'Clone target exists and is not a directory')
    const entries = await readdir(path)
    if (entries.length > 0) throw new GitOperationError('GIT_TARGET_EXISTS', 'Clone target directory is not empty')
  } catch (error: unknown) {
    if (error instanceof GitOperationError) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new GitOperationError('GIT_FAILED', `Cannot inspect the clone target: ${(error as Error).message}`)
    }
  }
}

/**
 * 传真失败时清理本次创建的目录，避免留下半成品工作区。
 * @param path - 目标目录。
 * @param existed - 本次开始前该目录是否已存在。
 */
async function discardPartial(path: string, existed: boolean): Promise<void> {
  if (existed) return
  await rm(path, { recursive: true, force: true }).catch(() => {})
}

/**
 * 把提交身份写进新仓库的本地配置，后续自动提交使用同一身份；空值保持目标机器上的
 * git 配置不变。`git clone` 的 `-c` 只影响该次命令，不会落到新仓库。
 * @param path - 已克隆的工作树。
 * @param input - 本次克隆输入。
 * @param signal - 调用方取消信号。
 */
async function applyIdentity(path: string, input: GitCloneInput, signal: AbortSignal): Promise<void> {
  const identity = input.identity
  if (identity === undefined) return
  if (identity.name !== undefined && identity.name !== '') {
    await checked(LOCAL_GIT, path, signal, ['config', '--local', 'user.name', identity.name])
  }
  if (identity.email !== undefined && identity.email !== '') {
    await checked(LOCAL_GIT, path, signal, ['config', '--local', 'user.email', identity.email])
  }
}

/**
 * 用本机 `git clone` 克隆；认证按宿主助手、本机凭据、调用方凭据的固定优先级解析。
 * @param input - 克隆输入。
 * @param signal - 调用方取消信号。
 * @param available - 本机 `git` 是否可执行。
 * @param options - 本机凭据存储与诊断出口。
 * @returns 目标目录与检出分支。
 */
export async function cloneWithCli(
  input: GitCloneInput,
  signal: AbortSignal,
  available: () => Promise<boolean>,
  options: GitRemoteOptions,
): Promise<GitCloneResult> {
  if (!await available()) throw new GitOperationError('GIT_UNAVAILABLE', 'Git is not installed')
  const parent = dirname(input.path)
  await mkdir(parent, { recursive: true })
  const existed = await access(input.path).then(() => true, () => false)
  await ensureTargetFree(input.path)
  const args = [
    ...input.proxy === undefined || input.proxy === '' ? [] : ['-c', `http.proxy=${input.proxy}`],
    'clone',
    ...input.ref === undefined || input.ref === '' ? [] : ['--branch', input.ref],
    ...input.depth === undefined ? [] : ['--depth', String(input.depth), '--single-branch'],
    '--',
    input.url,
    input.path,
  ]
  try {
    await remoteCommand(LOCAL_GIT, parent, signal, args, input.url, options, { timeout: CLONE_TIMEOUT })
  } catch (error: unknown) {
    await discardPartial(input.path, existed)
    throw error
  }
  await applyIdentity(input.path, input, signal)
  const head = await runGit(input.path, signal, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return { path: input.path, branch: head.code === 0 ? head.stdout.trim() : null, mechanism: 'cli' }
}

/**
 * 用内置的 JavaScript 实现克隆，供没有安装 `git` 的机器使用。
 * @param input - 克隆输入；代理无法在内置实现中生效，因此显式拒绝。
 * @param signal - 调用方取消信号。
 * @param options - 本机凭据存储（只用于读取已保存的凭据）。
 * @returns 目标目录与检出分支。
 */
export async function cloneWithJs(
  input: GitCloneInput,
  signal: AbortSignal,
  options: GitRemoteOptions,
): Promise<GitCloneResult> {
  const identity = gitRemoteIdentity(input.url)
  const saved = identity === undefined
    ? undefined
    : await storedCredential(gitCredentialRef(identity.host), identity.host, options)
  const credentials = input.credentials ?? saved
  await mkdir(dirname(input.path), { recursive: true })
  const existed = await access(input.path).then(() => true, () => false)
  await ensureTargetFree(input.path)
  try {
    await gitJs.clone({
      fs,
      // 显式代理优先；留空时适配器仍会读 HTTPS_PROXY／ALL_PROXY（并尊重 NO_PROXY）。
      http: createNodeHttpClient({
        ...input.proxy === undefined || input.proxy === '' ? {} : { proxy: { url: input.proxy } },
      }),
      dir: input.path,
      url: input.url,
      ...input.ref === undefined || input.ref === '' ? {} : { ref: input.ref, singleBranch: true },
      ...input.depth === undefined ? {} : { depth: input.depth },
      ...credentials === undefined ? {} : {
        // 携带一组凭据后不再二次询问：被拒就交给上层的认证弹窗，避免实现内静默重试。
        onAuth: () => ({ username: credentials.username, password: credentials.password }),
        onAuthFailure: () => ({ cancel: true }),
      },
    })
    if (input.identity !== undefined) {
      if (input.identity.name !== undefined && input.identity.name !== '') {
        await gitJs.setConfig({ fs, dir: input.path, path: 'user.name', value: input.identity.name })
      }
      if (input.identity.email !== undefined && input.identity.email !== '') {
        await gitJs.setConfig({ fs, dir: input.path, path: 'user.email', value: input.identity.email })
      }
    }
    const branch = await gitJs.currentBranch({ fs, dir: input.path, fullname: false })
    return { path: input.path, branch: branch ?? null, mechanism: 'js' }
  } catch (error: unknown) {
    await discardPartial(input.path, existed)
    signal.throwIfAborted()
    throw classifyCloneFailure(error, input.url, credentials !== undefined)
  }
}

/** 把内置实现的上游错误归一为 Git seam 的失败词汇，并区分“需要认证”与一般失败。 */
function classifyCloneFailure(error: unknown, url: string, hadCredentials: boolean): GitOperationError {
  const identity = gitRemoteIdentity(url)
  const code = (error as { code?: string }).code
  // 代理拨号失败没有 HTTP 状态可读，单独归一为“远端不可达”。
  if (code === 'PROXY_DIAL_FAILED' || code === 'PROXY_LINK_INVALID') {
    return new GitOperationError('GIT_REMOTE_UNAVAILABLE', error instanceof Error ? error.message : 'Proxy connection failed')
  }
  if (code === 'HttpError') {
    if (identity !== undefined) {
      return new GitOperationError(hadCredentials ? 'GIT_AUTH_FAILED' : 'GIT_AUTH_REQUIRED',
        hadCredentials ? 'Git authentication failed' : 'Git credentials required', identity.display)
    }
    return new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Git remote is unreachable')
  }
  if (code === 'UrlParseError' || code === 'UnknownTransportError') {
    return new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'The built-in Git implementation only supports http(s) remotes')
  }
  if (code === 'NotFoundError') return new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Git remote ref was not found')
  if (code === 'InvalidRefNameError') return new GitOperationError('GIT_BRANCH_NOT_FOUND', 'Requested Git ref does not exist')
  return new GitOperationError('GIT_FAILED', error instanceof Error ? error.message : 'Git clone failed')
}
