/**
 * Configuration normalization for workspace instruction discovery and rendering.
 *
 * @module @deepseek-ai/dsh-agent-instructions/config
 */

import { relative } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'] as const
const DEFAULT_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const
const DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md'] as const
const DEFAULT_OVERVIEW_FILE_CANDIDATES = ['README.md'] as const
const DEFAULT_MAX_SOURCE_BYTES = 1_048_576
const RESERVED_PATH_SEGMENTS = new Set(['', '.', '..'])

/** 单个项目简介文件渲染头部的默认 UTF-8 字节上限。 */
export const DEFAULT_OVERVIEW_MAX_BYTES = 4096

/** User-facing workspace instruction loader configuration. */
export interface Config {
  /** Harness home containing the fixed user-global `AGENTS.md`; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Directory entries that identify the project root while walking upward from the session cwd. */
  projectRootMarkers?: string[]
  /** UTF-8 byte cap for one rendered baseline or dynamic batch; non-positive or non-finite disables loading. */
  maxBytes: number
  /** Maximum UTF-8 bytes read from one instruction file; larger files are ignored. */
  maxSourceBytes?: number
  /**
   * Ordered same-directory project candidates; every existing file loads, with
   * per-directory trimmed-content duplicates collapsed to the earliest candidate.
   */
  instructionFileCandidates?: string[]
  /**
   * Ordered same-directory local-overlay candidates loaded after the base files
   * under the same per-directory trimmed-content dedup; empty disables the overlay.
   */
  localInstructionFileCandidates?: string[]
  /**
   * 只从项目根目录加载的候选文件：渲染为项目背景而不是指令，空列表禁用项目简介。
   * 同时列在指令候选里的名字仍按指令候选处理。
   */
  overviewFileCandidates?: string[]
  /**
   * 单个项目简介渲染头部的 UTF-8 字节上限；其余内容不进入提示词，指令也不受它限制。
   */
  overviewMaxBytes?: number
}

export const Config: z<Config> = z.object({
  dshHome: z.string(),
  projectRootMarkers: z.array(z.string()).default([...DEFAULT_PROJECT_ROOT_MARKERS]),
  maxBytes: z.number().required(),
  maxSourceBytes: z.number().step(1).min(1).default(DEFAULT_MAX_SOURCE_BYTES),
  instructionFileCandidates: z.array(z.string()).default([...DEFAULT_INSTRUCTION_FILE_CANDIDATES]),
  localInstructionFileCandidates: z.array(z.string()).default([...DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES]),
  overviewFileCandidates: z.array(z.string()).default([...DEFAULT_OVERVIEW_FILE_CANDIDATES]),
  overviewMaxBytes: z.number().step(1).min(1).default(DEFAULT_OVERVIEW_MAX_BYTES),
})

/** Normalized instruction discovery configuration. */
export interface ResolvedDiscoveryConfig {
  dshHome: string
  projectRootMarkers: string[]
  instructionFileCandidates: string[]
  localInstructionFileCandidates: string[]
  overviewFileCandidates: string[]
}

/** Normalized configuration used by discovery and reconciliation. */
export interface ResolvedConfig extends ResolvedDiscoveryConfig {
  maxBytes: number
  maxSourceBytes: number
  overviewMaxBytes: number
}

/**
 * Identify the discovery, precedence, and budget semantics of one baseline.
 * @param config - normalized plugin configuration.
 * @param cwd - absolute session working directory.
 * @param projectRoot - project root selected for the current baseline.
 * @returns stable serialized identity for compatibility checks on resume.
 */
export function workspaceBaselineIdentity(
  config: ResolvedConfig,
  cwd: string,
  projectRoot: string,
): string {
  return JSON.stringify({
    projectRoot: relative(cwd, projectRoot),
    projectRootMarkers: config.projectRootMarkers,
    maxBytes: config.maxBytes,
    maxSourceBytes: config.maxSourceBytes,
    instructionFileCandidates: config.instructionFileCandidates,
    localInstructionFileCandidates: config.localInstructionFileCandidates,
    overviewFileCandidates: config.overviewFileCandidates,
    overviewMaxBytes: config.overviewMaxBytes,
  })
}

/**
 * Resolve defaults, the harness home, and valid same-directory candidates.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    ...resolveDiscoveryConfig(config),
    maxBytes: config.maxBytes,
    maxSourceBytes: config.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
    overviewMaxBytes: config.overviewMaxBytes ?? DEFAULT_OVERVIEW_MAX_BYTES,
  }
}

/**
 * Resolve the subset of configuration used before instruction content is rendered.
 * @param config - optional discovery controls.
 * @returns normalized home, root markers, and instruction candidates.
 */
export function resolveDiscoveryConfig(
  config: Pick<
    Config,
    | 'dshHome'
    | 'projectRootMarkers'
    | 'instructionFileCandidates'
    | 'localInstructionFileCandidates'
    | 'overviewFileCandidates'
  >,
): ResolvedDiscoveryConfig {
  const instructionFileCandidates = resolveInstructionFileCandidates(
    config.instructionFileCandidates,
    DEFAULT_INSTRUCTION_FILE_CANDIDATES,
  )
  const localInstructionFileCandidates = resolveInstructionFileCandidates(
    config.localInstructionFileCandidates,
    DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES,
  )
  const instructionNames = new Set([...instructionFileCandidates, ...localInstructionFileCandidates])
  return {
    dshHome: resolveDshHome(config.dshHome),
    projectRootMarkers: config.projectRootMarkers ?? [...DEFAULT_PROJECT_ROOT_MARKERS],
    instructionFileCandidates,
    localInstructionFileCandidates,
    // 显式声明的指令候选优先于项目简介默认值：把 README.md 配成指令文件时，
    // 不能悄悄降级成模型被告知可以忽略的背景。
    overviewFileCandidates: resolveInstructionFileCandidates(
      config.overviewFileCandidates,
      DEFAULT_OVERVIEW_FILE_CANDIDATES,
    ).filter(candidate => !instructionNames.has(candidate)),
  }
}

function resolveInstructionFileCandidates(candidates: string[] | undefined, fallback: readonly string[]): string[] {
  return (candidates ?? [...fallback]).filter(candidate => (
    !RESERVED_PATH_SEGMENTS.has(candidate) && !/[\\/]/.test(candidate)
  ))
}
