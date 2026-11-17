/** 本机 `git` 的仓库读取与写操作（状态、分支、历史、切换、推送、拉取）。 @module coding-git-local/cli-repository */

import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { GitOperationError } from 'coding-git'
import type {
  GitBranches, GitCommit, GitHistory, GitHistoryQuery, GitOperationResult, GitRemoteOptions, GitStatus,
} from 'coding-git'
import { branchName, checked, failure, guard, upstream } from './cli-process.ts'
import type { GitExecutor } from './cli-process.ts'
import { claimRemember, commitRemember, refuseLocalCredentials, remoteCommand } from './credentials.ts'

/** 与协议层的 `GIT_HISTORY_MAX_COUNT` 同一上限；提供方不放宽消费方已校验的请求。 */
const HISTORY_MAX_COUNT = 300
/** 请求省略条数时读取的最近提交数，与协议层默认值一致。 */
const HISTORY_DEFAULT_COUNT = 60
const HISTORY_OUTPUT_LIMIT = 2 * 1024 * 1024
const HISTORY_REFS_LIMIT = 256 * 1024
const HISTORY_TEXT_LIMIT = 4096
const HISTORY_SHA = /^[0-9a-f]{40}$/u
const HISTORY_REF = /^refs\/(heads|remotes|tags)\/(.+)$/u
const HISTORY_DATE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/u

async function untrackedLines(path: string, signal: AbortSignal): Promise<number> {
  const info = await lstat(path)
  if (!info.isFile() || info.size > 1024 * 1024) return 0
  let lines = 0
  let last = 0
  let bytes = 0
  for await (const chunk of createReadStream(path, { signal })) {
    const data = chunk as Buffer
    if (data.includes(0)) return 0
    bytes += data.length
    for (const byte of data) if (byte === 10) lines++
    if (data.length > 0) last = data.at(-1) ?? 0
  }
  return lines + (bytes > 0 && last !== 10 ? 1 : 0)
}

/**
 * 返回仓库的文件及行数；非仓库返回 null。
 * @param exec - 本次调用的执行世界（本机或远端主机）。
 * @param cwd - 会话记录里的工作目录。
 * @param signal - 调用方取消信号。
 * @returns 仓库状态或 null。
 */
export async function cliStatus(exec: GitExecutor, cwd: string, signal: AbortSignal): Promise<GitStatus | null> {
  if (!await guard(exec, cwd, signal)) return null
  const branch = await branchName(exec, cwd, signal)
  const raw = await checked(exec, cwd, signal, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const root = (await checked(exec, cwd, signal, ['rev-parse', '--show-toplevel'])).trim()
  const entries = raw.split('\0')
  const files: GitStatus['files'] = []
  for (let i = 0; i < entries.length - 1; i++) {
    const entry = entries[i]
    if (entry === undefined) throw new GitOperationError('GIT_FAILED', 'Incomplete Git status output')
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    if (status.includes('R') || status.includes('C')) i++ // porcelain -z 的重命名项额外包含旧路径
    files.push({ path, status, additions: 0, deletions: 0 })
  }
  const head = await exec.run(cwd, signal, ['rev-parse', '--verify', 'HEAD'])
  const diffArgs = head.code === 0 ? ['diff', 'HEAD', '--numstat', '-z'] : ['diff', '--cached', '--numstat', '-z']
  const stats = await checked(exec, cwd, signal, diffArgs)
  const unstaged = head.code === 0 ? '' : await checked(exec, cwd, signal, ['diff', '--numstat', '-z'])
  const parts = [stats, unstaged].filter(Boolean).join('').split('\0')
  const counts = new Map<string, { additions: number; deletions: number }>()
  for (let i = 0; i < parts.length - 1; i++) {
    const row = parts[i]
    if (row === undefined) throw new GitOperationError('GIT_FAILED', 'Incomplete Git numstat output')
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/su.exec(row)
    if (!match) throw new GitOperationError('GIT_FAILED', 'Unexpected Git numstat output')
    const oldPath = match[3] === '' ? parts[i + 1] : undefined
    const path = match[3] === '' ? parts[i + 2] : match[3]
    if (path === undefined || (match[3] === '' && (!oldPath || !path))) {
      throw new GitOperationError('GIT_FAILED', 'Incomplete Git rename numstat output')
    }
    if (match[3] === '') i += 2
    const previous = counts.get(path)
    counts.set(path, {
      additions: (previous?.additions ?? 0) + (Number(match[1]) || 0),
      deletions: (previous?.deletions ?? 0) + (Number(match[2]) || 0),
    })
  }
  for (const file of files) {
    const count = counts.get(file.path)
    if (count !== undefined) Object.assign(file, count)
    // 远端工作区的未跟踪文件在宿主上不可读，因此只跳过行数统计，状态本身保持可见。
    else if (file.status === '??' && !exec.remote) {
      try { file.additions = await untrackedLines(join(root, file.path), signal) }
      catch { signal.throwIfAborted(); throw new GitOperationError('GIT_FAILED', `Cannot count untracked file ${file.path}`) }
    }
  }
  let ahead = 0
  let behind = 0
  const tracking = await exec.run(cwd, signal, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (tracking.code === 0) {
    const distance = await checked(exec, cwd, signal, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
    const match = /^(\d+)\s+(\d+)/u.exec(distance)
    if (!match) throw new GitOperationError('GIT_FAILED', 'Unexpected Git ahead/behind output')
    ahead = Number(match[1]); behind = Number(match[2])
  }
  return {
    branch, ahead, behind, files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  }
}

/**
 * 返回全部本地分支；非仓库返回 null。
 * @param exec - 本次调用的执行世界。
 * @param cwd - 仓库工作目录。
 * @param signal - 调用方取消信号。
 * @returns 分支列表与当前分支。
 */
export async function cliBranches(exec: GitExecutor, cwd: string, signal: AbortSignal): Promise<GitBranches | null> {
  if (!await guard(exec, cwd, signal)) return null
  const raw = await checked(exec, cwd, signal, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  return {
    branches: raw.split('\n').filter(Boolean).sort((a, b) => a.localeCompare(b)),
    current: await branchName(exec, cwd, signal),
  }
}

function historyFailure(message: string): GitOperationError {
  return new GitOperationError('GIT_FAILED', message)
}

/**
 * 解析 git log 的 NUL 字段与记录；格式错误时拒绝整页，不返回部分提交。
 * @param raw - `git log -z --format='%H%x00%P%x00%s%x00%an%x00%aI'` 的输出。
 * @returns 严格检查过的提交数组；引用由独立的 ref 列表按哈希附着。
 */
export function parseGitHistory(raw: string): GitCommit[] {
  if (Buffer.byteLength(raw, 'utf8') > HISTORY_OUTPUT_LIMIT) throw historyFailure('Git history output exceeded the size limit')
  if (raw === '') return []
  const parts = raw.split('\0')
  if (parts.pop() !== '' || (parts.length % 5) !== 0) throw historyFailure('Incomplete Git history output')
  const commits: GitCommit[] = []
  for (let index = 0; index < parts.length; index += 5) {
    const [id, parentLine, subject, author, authoredAt] = parts.slice(index, index + 5)
    if (id === undefined || !HISTORY_SHA.test(id) || parentLine === undefined
      || parentLine !== '' && !parentLine.split(' ').every(parent => HISTORY_SHA.test(parent))
      || subject === undefined || author === undefined || authoredAt === undefined || !HISTORY_DATE.test(authoredAt)
      || Buffer.byteLength(subject, 'utf8') > HISTORY_TEXT_LIMIT || Buffer.byteLength(author, 'utf8') > HISTORY_TEXT_LIMIT) {
      throw historyFailure('Malformed Git history output')
    }
    commits.push({ id, parents: parentLine === '' ? [] : parentLine.split(' '), subject, author, authoredAt, refs: [] })
  }
  return commits
}

/**
 * 从独立的 NUL 字段反查分支和标签，确保带逗号或换行的合法引用不会打断日志解析。
 * @param raw - `git for-each-ref` 的完整输出。
 * @returns 完整哈希索引的引用名与全部本地分支名。
 */
export function parseGitHistoryRefs(raw: string): { refs: Map<string, string[]>; branches: string[] } {
  if (Buffer.byteLength(raw, 'utf8') > HISTORY_REFS_LIMIT) throw historyFailure('Git refs output exceeded the size limit')
  if (raw === '') return { refs: new Map(), branches: [] }
  const lines = raw.split('\n')
  if (lines.pop() !== '' || lines.some(line => !line.endsWith('\0'))) throw historyFailure('Incomplete Git refs output')
  const refs = new Map<string, string[]>()
  const branches: string[] = []
  for (const line of lines) {
    const parts = line.slice(0, -1).split('\0')
    const [name, id, peeled] = parts
    const parsed = name === undefined ? null : HISTORY_REF.exec(name)
    if (parts.length !== 3 || parsed === null || id === undefined || !HISTORY_SHA.test(id)
      || peeled === undefined || peeled !== '' && !HISTORY_SHA.test(peeled)) {
      throw historyFailure('Malformed Git refs output')
    }
    const kind = parsed[1]
    const short = parsed[2]
    if (kind === undefined || short === undefined) throw historyFailure('Malformed Git refs output')
    if (kind === 'heads') branches.push(short)
    const target = peeled || id
    refs.set(target, [...(refs.get(target) ?? []), kind === 'tags' ? `tag: ${short}` : short])
  }
  return { refs, branches: branches.sort((a, b) => a.localeCompare(b)) }
}

/**
 * 只读查询最近提交及其父边和 ref 标签：读操作绝不 fetch、暂存或写仓库。
 * @param exec - 本次调用的执行世界。
 * @param cwd - 由会话头取得的仓库工作目录。
 * @param signal - 请求取消信号。
 * @param query - 已校验的条数及可选的完整 SHA-1 起点。
 * @returns 非仓库为 null；无提交的仓库返回空列表与本地分支。
 */
export async function cliHistory(
  exec: GitExecutor,
  cwd: string,
  signal: AbortSignal,
  query: GitHistoryQuery,
): Promise<GitHistory | null> {
  if (!await guard(exec, cwd, signal)) return null
  const count = query.count ?? HISTORY_DEFAULT_COUNT
  if (!Number.isSafeInteger(count) || count < 1 || count > HISTORY_MAX_COUNT
    || query.from !== undefined && !HISTORY_SHA.test(query.from)) {
    throw historyFailure('Invalid Git history request')
  }
  const current = await branchName(exec, cwd, signal)
  const refOutput = await exec.run(cwd, signal, [
    'for-each-ref', '--format=%(refname)%00%(objectname)%00%(*objectname)%00', 'refs/heads', 'refs/remotes', 'refs/tags',
  ], { outputLimit: HISTORY_REFS_LIMIT })
  if (refOutput.code !== 0) throw failure(refOutput)
  const { refs, branches } = parseGitHistoryRefs(refOutput.stdout)
  // from 仅接受完整哈希；末尾 SHA 实参绝不携带 Git 的 --option 前缀。
  if (query.from !== undefined) {
    const verified = await exec.run(cwd, signal, ['rev-parse', '--verify', '--end-of-options', `${query.from}^{commit}`])
    if (verified.code !== 0 || !HISTORY_SHA.test(verified.stdout.trim())) {
      throw new GitOperationError('GIT_FAILED', 'Git history start commit was not found')
    }
  }
  // ref 与 HEAD 均可缺席（尚无首次提交）；空库不用解析 HEAD。
  const head = await exec.run(cwd, signal, ['rev-parse', '--verify', 'HEAD^{commit}'])
  if (head.code !== 0 && !/needed a single revision/i.test(head.stderr)) throw failure(head)
  if (head.code !== 0 && query.from === undefined && refs.size === 0) {
    return { commits: [], truncated: false, current, branches }
  }
  const args = [
    'log', '-z', '--topo-order', '--no-patch', '--format=%H%x00%P%x00%s%x00%an%x00%aI',
    '-n', String(count + 1),
    ...(query.from === undefined ? ['--all', ...(head.code === 0 ? ['HEAD'] : [])] : [query.from]),
  ]
  const result = await exec.run(cwd, signal, args, { outputLimit: HISTORY_OUTPUT_LIMIT })
  if (result.code !== 0) throw failure(result)
  const commits = parseGitHistory(result.stdout)
  if (commits.length > count + 1) throw historyFailure('Unexpected Git history count')
  const truncated = commits.length > count
  return {
    commits: commits.slice(0, count).map(commit => ({ ...commit, refs: refs.get(commit.id) ?? [] })),
    truncated, current, branches,
  }
}

/**
 * 仅切换已有本地分支；切换前拒绝脏工作树，并返回切换后的最新状态。
 * @param exec - 本次调用的执行世界。
 * @param cwd - 仓库工作目录。
 * @param signal - 调用方取消信号。
 * @param branch - 已存在的本地分支短名。
 * @returns 切换后的仓库状态。
 */
export async function cliCheckout(exec: GitExecutor, cwd: string, signal: AbortSignal, branch: string): Promise<GitStatus> {
  const available = await cliBranches(exec, cwd, signal)
  if (available === null) throw new GitOperationError('GIT_NO_REPOSITORY', 'Not a Git repository')
  if (!available.branches.includes(branch)) throw new GitOperationError('GIT_BRANCH_NOT_FOUND', `Local Git branch not found: ${branch}`)
  const status = await cliStatus(exec, cwd, signal)
  if (status === null) throw new GitOperationError('GIT_NO_REPOSITORY', 'Not a Git repository')
  if (status.branch === branch) return status
  if (status.files.length > 0) throw new GitOperationError('GIT_CONFLICT', 'Cannot switch branches with uncommitted changes')
  await checked(exec, cwd, signal, ['switch', '--no-overwrite-ignore', '--', branch])
  const result = await cliStatus(exec, cwd, signal)
  if (result === null) throw new GitOperationError('GIT_NO_REPOSITORY', 'Not a Git repository')
  return result
}

function commitMessage(status: GitStatus): string {
  const files = status.files
  if (files.length === 0) return 'Update workspace changes'
  const action = files.every(file => file.status === '??' || file.status.startsWith('A')) ? 'Add'
    : files.every(file => file.status.includes('D')) ? 'Remove'
      : files.every(file => file.status.includes('R')) ? 'Rename' : 'Update'
  if (files.length === 1) {
    const path = files[0]?.path.replace(/[\r\n\t]/gu, ' ').trim() ?? ''
    return `${action} ${path.slice(0, 60) || 'workspace file'}`
  }
  const directories = new Set(files.map(file => file.path.split('/')[0]))
  const scope = directories.size === 1 && files[0]?.path.includes('/') ? `${files[0].path.split('/')[0]} files` : 'workspace files'
  return `${action} ${String(files.length)} ${scope} (+${String(status.additions)}/-${String(status.deletions)})`
}

/**
 * 显式推送会暂存所有非忽略文件并自动提交；无上游时不修改工作树。本机工作区的凭据按
 * {@link GitRemoteOptions} 的优先级解析，remember 只在推送成功后写入本机存储；远端
 * 工作区使用远端主机自己的凭据，不读写宿主凭据。
 * @param exec - 本次调用的执行世界。
 * @param cwd - 仓库工作目录。
 * @param signal - 调用方取消信号。
 * @param options - 本次凭据、本机存储与诊断出口。
 * @returns 推送结果；无 staged 差异时不创建提交。
 */
export async function cliPush(
  exec: GitExecutor,
  cwd: string,
  signal: AbortSignal,
  options: GitRemoteOptions = {},
): Promise<GitOperationResult> {
  refuseLocalCredentials(exec, options)
  if (!await guard(exec, cwd, signal)) throw new GitOperationError('GIT_NO_REPOSITORY', 'Not a Git repository')
  const branch = await branchName(exec, cwd, signal)
  if (branch === null) throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Cannot push a detached HEAD')
  const upstreamName = await upstream(exec, cwd, signal)
  const slash = upstreamName.name.indexOf('/')
  if (slash < 1 || slash === upstreamName.name.length - 1) {
    throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Upstream has no remote branch')
  }
  const remote = upstreamName.name.slice(0, slash)
  const remoteBranch = upstreamName.name.slice(slash + 1)
  // 记住凭据在触碰远端之前认领；认证预检必须先于暂存和提交，只有实际 push 才改变远端状态。
  const remember = exec.remote ? undefined : await claimRemember(upstreamName.pushUrl, options)
  await remoteCommand(exec, cwd, signal, ['ls-remote', '--exit-code', remote, `refs/heads/${remoteBranch}`], upstreamName.pushUrl, options)
  const pending = await cliStatus(exec, cwd, signal)
  await checked(exec, cwd, signal, ['add', '--all', '--', ':/'])
  const staged = await exec.run(cwd, signal, ['diff', '--cached', '--quiet'])
  if (staged.code !== 0 && staged.code !== 1) throw failure(staged)
  const commitCreated = staged.code === 1
  const summary = commitCreated ? commitMessage(pending ?? {
    branch, ahead: 0, behind: 0, additions: 0, deletions: 0, files: [],
  }) : undefined
  if (summary !== undefined) await checked(exec, cwd, signal, ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', summary])
  const commit = commitCreated ? (await checked(exec, cwd, signal, ['rev-parse', 'HEAD'])).trim() : undefined
  await remoteCommand(exec, cwd, signal, ['-c', 'core.hooksPath=/dev/null', 'push', '--porcelain', remote, `HEAD:refs/heads/${remoteBranch}`], upstreamName.pushUrl, options)
  await commitRemember(remember, options)
  return { branch, commitCreated, ...(commit === undefined ? {} : { commit }) }
}

/**
 * 只接受快进拉取；分叉或脏文件阻挡快进时明确报告冲突，不进行 rebase 或合并提交。
 * @param exec - 本次调用的执行世界。
 * @param cwd - 仓库工作目录。
 * @param signal - 调用方取消信号。
 * @param options - 本次凭据、本机存储与诊断出口。
 * @returns 拉取后的分支；pull 不创建提交。
 */
export async function cliPull(
  exec: GitExecutor,
  cwd: string,
  signal: AbortSignal,
  options: GitRemoteOptions = {},
): Promise<GitOperationResult> {
  refuseLocalCredentials(exec, options)
  if (!await guard(exec, cwd, signal)) throw new GitOperationError('GIT_NO_REPOSITORY', 'Not a Git repository')
  const branch = await branchName(exec, cwd, signal)
  if (branch === null) throw new GitOperationError('GIT_REMOTE_UNAVAILABLE', 'Cannot pull a detached HEAD')
  const tracking = await upstream(exec, cwd, signal)
  const remember = exec.remote ? undefined : await claimRemember(tracking.fetchUrl, options)
  await remoteCommand(exec, cwd, signal, ['-c', 'core.hooksPath=/dev/null', '-c', 'pull.ff=only', 'pull', '--ff-only'], tracking.fetchUrl, options)
  await commitRemember(remember, options)
  return { branch, commitCreated: false }
}
