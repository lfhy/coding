/**
 * Service Definition for the `ctx.git` capability seam: how the host reads a
 * local repository and performs its remote operations.
 *
 * 一个 Git 提供方要么驱动本机的 `git` 可执行文件，要么内置一份纯 JavaScript
 * 实现；两者的认证材料来源、失败词汇和仓库语义由本包统一，消费方因此只依赖
 * {@link Git} 的服务签名。`capability()` 报告当前实现实际能做什么：没有安装
 * `git` 的机器仍能克隆仓库，但已克隆仓库的分支、提交与推送仍需要完整实现，
 * 消费方用 `capability().operations` 决定是否展示这些入口，而不是在调用后才失败。
 * @module coding-git
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { credentialRef } from 'coding-credentials'
import type { CredentialRef } from 'coding-credentials'

/** 本 seam 的操作词汇；能力报告与失败诊断共用同一组名字。 */
export const GIT_OPERATIONS = ['status', 'branches', 'history', 'checkout', 'push', 'pull', 'clone'] as const

/** 一项 Git 操作的静态名字。 */
export type GitOperation = typeof GIT_OPERATIONS[number]

/** 工作区 Git 的文件变更及相对上游的提交差距。 */
export interface GitStatus {
  branch: string | null
  ahead: number
  behind: number
  additions: number
  deletions: number
  files: Array<{ path: string; status: string; additions: number; deletions: number }>
}

/** 当前仓库的本地分支列表与 HEAD 所指分支；游离 HEAD 的 current 为 null。 */
export interface GitBranches {
  branches: string[]
  current: string | null
}

/** 写操作的提交结果；pull 与 clone 不创建提交。 */
export interface GitOperationResult {
  branch: string | null
  commitCreated: boolean
  commit?: string
}

/** 一个提交及其在 DAG 中的直接父提交（按父顺序）。 */
export interface GitCommit {
  /** 完整提交哈希。 */
  id: string
  parents: string[]
  subject: string
  author: string
  /** 作者时间，ISO-8601 且保留作者自己的时区偏移。 */
  authoredAt: string
  /** 指向该提交的分支短名及 `tag: <name>` 标签。 */
  refs: string[]
}

/** 一次历史读取的范围；调用方已按协议上限校验过 count。 */
export interface GitHistoryQuery {
  /** 本次最多读取的提交条数；省略时读取 60 条。 */
  count?: number
  /** 从该提交（含）沿父边读取；省略时从全部 refs 与 HEAD 读取。 */
  from?: string
}

/** 最近的提交，按拓扑顺序；非仓库时整个值为 null。 */
export interface GitHistory {
  commits: GitCommit[]
  /** 已有超过本次请求条数的提交，调用方可增加 count 重新请求。 */
  truncated: boolean
  current: string | null
  branches: string[]
}

/** 一次远端操作的凭据；值绝不回显，只在调用方向上携带明文。 */
export interface GitCredentials {
  username: string
  password: string
  /** 远端操作成功后把这组凭据保存到本机凭据存储；省略时只用于本次操作。 */
  remember?: boolean
}

/** 克隆时要写入的提交身份；省略的两个字段由提供方取本机配置。 */
export interface GitCommitIdentity {
  name?: string
  email?: string
}

/** 一次克隆请求；调用方负责先解析出目标目录的绝对路径。 */
export interface GitCloneInput {
  /** 远端地址：HTTPS、SSH 或本机路径。 */
  url: string
  /** 目标目录绝对路径；目录必须不存在或为空。 */
  path: string
  /** 要检出的分支或标签；省略时使用远端 HEAD。 */
  ref?: string
  /** 只取该深度的历史；省略时取完整历史。 */
  depth?: number
  /** HTTPS 代理（`http://`、`https://` 或 `socks5://`）；省略时沿用 git 配置与环境。 */
  proxy?: string
  /** 写入仓库的用户身份；省略的字段取本机 git 配置。 */
  identity?: GitCommitIdentity
  credentials?: GitCredentials
}

/** 克隆结果；branch 是检出分支短名，无分支历史时为 null。 */
export interface GitCloneResult {
  path: string
  branch: string | null
  /** 本次实际执行克隆的机制，界面据此说明“未安装 git 时使用内置实现”。 */
  mechanism: 'cli' | 'js'
}

/** 当前实现实际支持的操作集合。 */
export interface GitCapability {
  /** 执行操作的机制：本机 `git` 命令行，或内置的纯 JavaScript 实现。 */
  mechanism: 'cli' | 'js'
  /** 该机制在本机可完成的操作；消费方据此隐藏不可用的入口。 */
  operations: readonly GitOperation[]
}

/** 可供调用方区分环境、仓库、上游和冲突的失败。 */
export class GitOperationError extends Error {
  /**
   * @param code - 静态失败码，消费方据此映射协议错误。
   * @param message - 面向操作者的诊断；不包含凭据。
   * @param remote - 本次操作涉及的远端展示名（如 `https://github.com`）。
   * @param credentialRef - 本次认证尝试过、但被拒绝的本机凭据引用。
   */
  constructor(
    public readonly code:
    | 'GIT_UNAVAILABLE'
    | 'GIT_NO_REPOSITORY'
    | 'GIT_REMOTE_UNAVAILABLE'
    | 'GIT_CONFLICT'
    | 'GIT_FAILED'
    | 'GIT_BRANCH_NOT_FOUND'
    | 'GIT_AUTH_REQUIRED'
    | 'GIT_AUTH_FAILED'
    | 'GIT_CREDENTIALS_UNAVAILABLE'
    | 'GIT_TARGET_EXISTS',
    message: string,
    public readonly remote?: string,
    public readonly credentialRef?: CredentialRef,
  ) {
    super(message)
    this.name = 'GitOperationError'
  }
}

/**
 * 本机 Git 凭据存储。值对该接口是不透明字符串——编解码归本包，存储只按引用
 * 读写，所以实现方（凭据 seam）不需要理解 Git 的凭据结构。
 */
export interface GitCredentialStore {
  /** 读取引用当前的值；未配置时返回 undefined。 */
  read(ref: CredentialRef): Promise<string | undefined>
  /** 该引用现在是否可写；凭据服务缺失或被只读来源遮蔽时为 false。 */
  writable(ref: CredentialRef): Promise<boolean>
  /** 写入值；拒绝表示这组凭据没有保存成功。 */
  write(ref: CredentialRef, value: string): Promise<void>
}

/**
 * 一次远端或克隆操作的认证输入。凭据来源按固定优先级解析：宿主凭据助手、
 * 本机凭据存储，最后才是调用方显式提供的凭据。
 */
export interface GitRemoteOptions {
  /**
   * 调用方本次显式提供的凭据（认证弹窗的答案）。一旦提供就独占本次认证：它来自
   * 上一轮前两级都失败的往返，用户重输的凭据不该再被它们覆盖。
   */
  credentials?: GitCredentials
  /** 本机 Git 凭据存储；未提供时只尝试宿主的凭据助手。 */
  store?: GitCredentialStore
  /** 非致命诊断（已存凭据读不出、写回失败）；记录后仍按当前可用来源继续。 */
  warn?: (message: string) => void
}

/**
 * HTTPS 远端主机在凭据存储中的引用名。只由主机名派生，绝不包含凭据值，所以
 * 界面可以把它当作“哪一组凭据”回传。
 * @param host - URL.host（含非默认端口）。
 * @returns 形如 GIT_CREDENTIAL_GITHUB_COM 的凭据引用。
 */
export function gitCredentialRef(host: string): CredentialRef {
  return credentialRef(`GIT_CREDENTIAL_${host.toUpperCase().replace(/[^A-Z0-9]/gu, '_')}`)
}

/** 凭据文档里的值连主机名一起保存：归一化到同一引用时要复核，否则一组凭据会被交给另一个主机。 */
export function encodeGitCredential(host: string, credentials: GitCredentials): string {
  return JSON.stringify({ host, username: credentials.username, password: credentials.password })
}

/**
 * 解析本包写入的凭据值。
 * @param host - 期望的远端主机；与存档不一致时视为没有该主机的凭据。
 * @param value - 凭据存储里的原始字符串。
 * @returns 结构相符的凭据，否则 undefined。
 */
export function decodeGitCredential(host: string, value: string): GitCredentials | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { host: storedHost, username, password } = parsed as Record<string, unknown>
  if (storedHost !== host || typeof username !== 'string' || username === ''
    || typeof password !== 'string' || password === '') return undefined
  return { username, password }
}

/**
 * HTTPS 远端的可认证身份：host 用作凭据引用，display 用于展示和诊断。
 * @param url - 远端 URL；带内嵌用户信息或非 HTTPS 时不可认证。
 * @returns 该远端的身份，或 undefined。
 */
export function gitRemoteIdentity(url: string): { host: string; display: string } | undefined {
  try {
    const parsed = new URL(url.trim())
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return undefined
    return { host: parsed.host, display: `https://${parsed.host}` }
  } catch { return undefined }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    git: Git
  }
}

/**
 * 抽象的 Git 服务。子类实现 {@link capability} 与各操作并作为插件加载，注册为 `ctx.git`；一个上下文只有一个实现，加载第二个按 Cordis 的重复服务规则失败。
 */
export abstract class Git extends Service {
  constructor(ctx: Context) {
    super(ctx, 'git')
  }

  /**
   * 当前实现的能力。探测本机可执行文件需要一次命令，因此结果是异步的。
   * @returns 机制与它在本机可完成的操作。
   */
  abstract capability(): Promise<GitCapability>

  /**
   * 读取工作目录所属仓库的状态。
   * @param cwd - 会话记录里的工作目录。
   * @param signal - 调用方取消信号。
   * @returns 非仓库为 null。
   * @throws {GitOperationError} 环境、仓库或命令失败。
   */
  abstract status(cwd: string, signal: AbortSignal): Promise<GitStatus | null>

  /**
   * 列出全部本地分支。
   * @param cwd - 仓库工作目录。
   * @param signal - 调用方取消信号。
   * @returns 非仓库为 null。
   */
  abstract branches(cwd: string, signal: AbortSignal): Promise<GitBranches | null>

  /**
   * 只读查询最近提交及其父边和 ref 标签。
   * @param cwd - 仓库工作目录。
   * @param signal - 调用方取消信号。
   * @param query - 已校验的条数与可选起点。
   * @returns 非仓库为 null。
   */
  abstract history(cwd: string, signal: AbortSignal, query: GitHistoryQuery): Promise<GitHistory | null>

  /**
   * 切换已有本地分支；脏工作树阻止切换。
   * @param cwd - 仓库工作目录。
   * @param signal - 调用方取消信号。
   * @param branch - 已存在的本地分支短名。
   * @returns 切换后的最新状态。
   */
  abstract checkout(cwd: string, signal: AbortSignal, branch: string): Promise<GitStatus>

  /**
   * 提交全部未忽略改动并推送当前上游分支。
   * @param cwd - 仓库工作目录。
   * @param signal - 调用方取消信号。
   * @param options - 本次凭据、本机存储与诊断出口。
   * @returns 推送结果；无 staged 差异时不创建提交。
   */
  abstract push(cwd: string, signal: AbortSignal, options?: GitRemoteOptions): Promise<GitOperationResult>

  /**
   * 从当前上游做只允许快进的拉取。
   * @param cwd - 仓库工作目录。
   * @param signal - 调用方取消信号。
   * @param options - 本次凭据、本机存储与诊断出口。
   * @returns 拉取后的分支。
   */
  abstract pull(cwd: string, signal: AbortSignal, options?: GitRemoteOptions): Promise<GitOperationResult>

  /**
   * 把远端仓库克隆到目标目录。
   * @param input - 远端地址、目标目录、可选分支／深度／代理／身份与凭据。
   * @param signal - 调用方取消信号；取消后不留下半成品目录。
   * @param options - 本机已保存凭据的读取入口与诊断出口。
   * @returns 目标目录、检出的分支与实际使用的机制。
   * @throws {GitOperationError} 目标已存在、认证、远端或克隆失败。
   */
  abstract clone(input: GitCloneInput, signal: AbortSignal, options?: GitRemoteOptions): Promise<GitCloneResult>
}

export default Git
