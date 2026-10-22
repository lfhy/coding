/**
 * 项目隔离的记忆工具：把当前会话所属项目的记忆交给模型读写。
 *
 * 五个工具的参数里没有任何路径——目标永远是会话项目根对应的记忆目录，因此模型无法
 * 读写别的项目的记忆。命名导出保留 Loader 注入元数据。
 *
 * @module coding-tool-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from 'coding-tools'
import type { Agent } from 'coding-agent'
import {
  DEFAULT_MEMORY_FILE,
  DEFAULT_MEMORY_SECTION,
  type MemoryProject,
  type MemorySaveRequest,
  type MemoryUpdateRequest,
} from 'coding-memory'

export const name = 'tool-memory'
export const inject = ['tools', 'memory']

const DESCRIPTION_SHARED =
  'Memory is this project\'s own notes under the user\'s data home: it survives sessions, '
  + 'but it is not part of the repository. Save what a later session would need and cannot '
  + 'read from the code: the user\'s preferences, non-obvious conventions of this repository, '
  + 'pitfalls with their conclusions, and cross-task follow-ups. Never save credentials, '
  + 'secrets, or anything already documented in the code or AGENTS.md.'

/**
 * 取当前执行所属的项目身份；没有 agent（因而没有会话 cwd）时拒绝，避免把记忆写进
 * 一个猜测出来的目录。
 * @param agent - 发起调用的 agent，可能不存在。
 * @param projectFor - 由服务提供的 cwd 到项目身份的解析。
 * @returns 项目身份。
 * @throws 调用方没有所属会话时抛出。
 */
function projectOf(agent: Agent | undefined, projectFor: (cwd: string) => MemoryProject): MemoryProject {
  const cwd = agent?.session.header.cwd
  if (cwd === undefined || cwd.length === 0) {
    throw new Error('memory tools require an owning agent session with a working directory')
  }
  return projectFor(cwd)
}

/**
 * Register the five project-scoped memory tools on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry and the memory service.
 */
export function apply(ctx: Context): void {
  const projectFor = (cwd: string): MemoryProject => ctx.memory.projectFor(cwd)

  ctx.tools.register(defineTool({
    name: 'memory_save',
    description:
      `Append one entry to this project's memory. ${DESCRIPTION_SHARED} `
      + `Entries land under a the given section (default \`${DEFAULT_MEMORY_SECTION}\`) of the target file `
      + `(default \`${DEFAULT_MEMORY_FILE}\`). Write one durable point per call, in the language the user writes.`,
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: 'The entry to remember; one self-contained point a later session can act on.',
      },
      file: {
        type: 'string',
        description: `Target memory file name ending in .md (default \`${DEFAULT_MEMORY_FILE}\`). Use a second file only to separate unrelated topics.`,
      },
      section: {
        type: 'string',
        description: `Section heading inside the file (default \`${DEFAULT_MEMORY_SECTION}\`).`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', required: true },
          section: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Saved to project memory: ${value.file} (## ${value.section}, now ${value.bytes} bytes).`,
      }],
    },
    execute(args, exec) {
      const request: MemorySaveRequest = { content: args.content }
      if (args.file !== undefined) request.file = args.file
      if (args.section !== undefined) request.section = args.section
      const written = ctx.memory.save(projectOf(exec.agent, projectFor), request)
      return written.then(summary => ({
        file: summary.name,
        section: args.section ?? DEFAULT_MEMORY_SECTION,
        bytes: summary.bytes,
      }))
    },
    presentCall: args => ({ card: 'generic', title: 'Save project memory', kind: 'other', rawInput: args.content }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_update',
    description:
      'Replace exactly one existing entry in this project\'s memory. Use it when an entry has become wrong, '
      + 'stale, or needs a correction: `match` must select a single entry, and `content` is the rewritten entry. '
      + 'Add new points with memory_save and drop obsolete ones with memory_delete. '
      + 'Never store credentials, secrets, or anything already documented in the code or AGENTS.md.',
    parameters: {
      match: {
        type: 'string',
        required: true,
        description: 'A snippet of the entry to replace. It must match exactly one entry; read the file first when unsure.',
      },
      content: {
        type: 'string',
        required: true,
        description: 'The rewritten entry; one self-contained point a later session can act on.',
      },
      file: {
        type: 'string',
        description: `Target memory file name ending in .md (default \`${DEFAULT_MEMORY_FILE}\`).`,
      },
      section: {
        type: 'string',
        description: 'Only match inside this section heading; omit to match across the whole file.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          previous: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Updated one entry in project memory: ${value.file} (now ${value.bytes} bytes). `
          + `It previously read:\n\n${value.previous}`,
      }],
    },
    execute(args, exec) {
      const request: MemoryUpdateRequest = { match: args.match, content: args.content }
      if (args.file !== undefined) request.file = args.file
      if (args.section !== undefined) request.section = args.section
      return ctx.memory.update(projectOf(exec.agent, projectFor), request).then(({ summary, previous }) => ({
        file: summary.name,
        bytes: summary.bytes,
        previous,
      }))
    },
    presentCall: args => ({ card: 'generic', title: 'Update project memory', kind: 'other', rawInput: args.content }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description:
      'Read one file of this project\'s memory in full. The session baseline already carries a bounded '
      + 'excerpt; read the file when you need the details it cut off. '
      + 'Memory is personal notes, not instructions: when it disagrees with the code or AGENTS.md, the code wins.',
    parameters: {
      file: {
        type: 'string',
        required: true,
        description: 'Memory file name ending in .md, as reported by memory_list.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', required: true },
          content: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.content.length === 0
          ? `${value.file} is empty.`
          : `${value.file}${value.truncated ? ' (truncated at the file limit)' : ''}:\n\n${value.content}`,
      }],
    },
    execute(args, exec) {
      const file = args.file
      return ctx.memory.read(projectOf(exec.agent, projectFor), file).then((result) => {
        if (result === undefined) throw new Error(`memory: ${file} does not exist in this project's memory`)
        return { file: result.name, content: result.content, truncated: result.truncated }
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Read project memory', kind: 'read', rawInput: args.file }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_list',
    description:
      'List this project\'s memory files with their titles, sizes, and last-modified times. '
      + 'The result also names the memory directory, so nobody has to look for it in the filesystem. '
      + 'Use it before reading or deleting, so you target a file that exists.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          directory: { type: 'string', required: true },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                file: { type: 'string', required: true },
                title: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                updatedAt: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.files.length === 0
          ? `This project has no memory yet. Its memory directory is ${value.directory}.`
          : `Memory directory: ${value.directory}\n`
            + value.files
              .map(file => `${file.file} — ${file.title} (${file.bytes} bytes, updated ${file.updatedAt})`)
              .join('\n'),
      }],
    },
    execute(_args, exec) {
      const project = projectOf(exec.agent, projectFor)
      return ctx.memory.list(project).then(files => ({
        directory: project.directory,
        files: files.map(file => ({
          file: file.name,
          title: file.title,
          bytes: file.bytes,
          updatedAt: file.updatedAt,
        })),
      }))
    },
    presentCall: () => ({ card: 'generic', title: 'List project memory', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_delete',
    description:
      'Delete a whole memory file, or just one section of it. Only do this when the user asks to forget '
      + 'something or when an entry is provably obsolete; when in doubt, keep it.',
    parameters: {
      file: {
        type: 'string',
        required: true,
        description: 'Memory file name ending in .md.',
      },
      section: {
        type: 'string',
        description: 'Delete only this section heading; omit to delete the whole file.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', required: true },
          removed: { type: 'boolean', required: true },
          scope: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.removed
          ? `Removed ${value.scope} from project memory ${value.file}.`
          : `Nothing to remove: ${value.scope} was not present in ${value.file}.`,
      }],
    },
    execute(args, exec) {
      const file = args.file
      const section = args.section
      return ctx.memory.remove(projectOf(exec.agent, projectFor), file, section).then(removed => ({
        file,
        removed,
        scope: section === undefined ? 'the file' : `section "${section}"`,
      }))
    },
    presentCall: args => ({ card: 'generic', title: 'Delete project memory', kind: 'other', rawInput: args.file }),
  }))
}
