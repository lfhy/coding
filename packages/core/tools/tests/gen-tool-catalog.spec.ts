/**
 * 工具 schema 目录生成器的注册清单与输出约定测试。
 */

import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from 'coding-tools'
import * as ToolBrowser from 'coding-tool-browser'
import { describe, expect, it } from 'vitest'
import {
  assertManifestComplete,
  assertToolsHarvested,
  collectToolCatalog,
  render,
  type ToolCatalog,
  type ToolPackage,
} from '../../../../scripts/gen-tool-catalog.ts'

/** JSON Schema shape enough to reach the values AST extraction can't. */
interface JsonSchema {
  type: string
  properties?: Record<string, JsonSchema>
  items?: JsonSchema
  enum?: string[]
  required?: string[]
}

describe('gen-tool-catalog collectToolCatalog', () => {
  it('boots every shipped tool package and harvests its model-facing schemas', async () => {
    const catalog = await collectToolCatalog()
    const names = catalog.flatMap(entry => entry.schemas.map(s => s.name)).sort()
    expect(names).toEqual([
      'apply_patch', 'ask_user_question', 'bash', 'bash', 'browser_act', 'browser_auth_flush', 'browser_captcha',
      'browser_cdp', 'browser_check', 'browser_cli', 'browser_click', 'browser_click', 'browser_close',
      'browser_dialog', 'browser_doctor', 'browser_download', 'browser_drag', 'browser_fill', 'browser_fill',
      'browser_help', 'browser_hover', 'browser_http', 'browser_js', 'browser_key', 'browser_login_import',
      'browser_navigate', 'browser_navigate', 'browser_page_info', 'browser_read_element', 'browser_screenshot',
      'browser_screenshot', 'browser_script', 'browser_scroll', 'browser_scroll', 'browser_select',
      'browser_snapshot', 'browser_snapshot', 'browser_space_close', 'browser_space_open', 'browser_status',
      'browser_tabs', 'browser_upload', 'browser_upload', 'browser_viewport', 'browser_wait',
      'browser_wait_for_human', 'browser_wait_for_response', 'browser_wait_for_selector', 'browser_wait_for_url', 'canvas_state',
      'computer_click', 'computer_confirm', 'computer_drag', 'computer_list_apps', 'computer_observe',
      'computer_perform_action', 'computer_press_key', 'computer_scroll', 'computer_set_value',
      'computer_type_text', 'computer_wait', 'context_compact', 'cordis_define', 'cordis_inspect_list',
      'cordis_inspect_query', 'cordis_inspect_self', 'cordis_run', 'cordis_stop', 'cordis_undefine', 'create_goal',
      'edit', 'edit_image', 'exit_plan_mode', 'followup_task', 'followup_task', 'generate_image', 'generate_images',
      'get_goal', 'glob', 'grep', 'interrupt_agent',
      'interrupt_agent', 'job_kill', 'job_list', 'job_output', 'list_agents', 'list_agents', 'lsp',
      'memory_delete', 'memory_list', 'memory_read', 'memory_save', 'memory_update', 'ppt_check', 'ppt_create',
      'ppt_delete_template', 'ppt_edit', 'ppt_export', 'ppt_import', 'ppt_import_template', 'ppt_open',
      'ppt_read', 'ppt_redo', 'ppt_rename_template', 'ppt_render',
      'ppt_save_template', 'ppt_templates', 'ppt_undo',
      'pwsh', 'pwsh', 'ralph',
      'read', 'read_image', 'report', 'run_code', 'schedule_create', 'schedule_delete', 'schedule_list',
      'send_message', 'send_message', 'session_event_read', 'session_event_search', 'session_event_trace',
      'session_search', 'session_trace', 'skill', 'spawn_teammate', 'str_replace_editor', 'subagent',
      'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update', 'terminal_close', 'terminal_list',
      'terminal_open', 'terminal_read', 'terminal_send', 'terminal_signal', 'todo_write', 'update_goal',
      'wait_agent', 'wait_agent', 'web_fetch', 'web_search', 'workflow', 'write', 'write_stdin',
    ])
    // parameters 与模型实际看到的 JSON Schema 使用同一结构。
    for (const entry of catalog) {
      for (const schema of entry.schemas) {
        expect((schema.parameters as unknown as JsonSchema).type).toBe('object')
      }
    }
  })

  it('harvests ten browser operations with action-specific arguments and one result shape', async () => {
    const catalog = await collectToolCatalog()
    const browser = catalog.find(entry => entry.pkg === 'coding-tool-browser')
    const actions = ['navigate', 'snapshot', 'click', 'fill', 'upload', 'act', 'scroll', 'viewport', 'screenshot', 'close']
    expect(browser?.schemas.map(schema => schema.name)).toEqual(actions.map(action => `browser_${action}`).sort())
    expect(browser?.note).toContain('active tab and session revision')

    const definitions: ToolDefinition[] = []
    ToolBrowser.apply({
      tools: { register: (tool: ToolDefinition) => { definitions.push(tool) } },
      systemPrompt: { section: () => () => {} },
    } as unknown as Context)
    expect(definitions.map(definition => definition.name)).toEqual(actions.map(action => `browser_${action}`))
    for (const definition of definitions) {
      const parameters = definition.parameters as unknown as JsonSchema
      expect(parameters.properties).not.toHaveProperty('action')
      const result = definition.output.schema as JsonSchema
      // 批量动作额外报告逐步骤结果；其余动作只有固定的三段结果。
      const extras = definition.name === 'browser_act' ? ['steps'] : []
      expect(Object.keys(result.properties ?? {})).toEqual(['action', 'observation', 'image', ...extras])
      expect(result.required).toEqual(['action', 'observation', 'image'])
      expect(result.properties?.action).toMatchObject({ const: definition.name.slice('browser_'.length) })
      const observation = result.properties?.observation
      expect(observation?.properties?.tabId?.type).toBe('string')
      expect(observation?.required).toContain('tabId')
    }
  })

  it('resolves a runtime-spread enum to its literal members (the payoff over AST)', async () => {
    const catalog = await collectToolCatalog()
    const todo = catalog
      .flatMap(entry => entry.schemas)
      .find(s => s.name === 'todo_write')
    // `todo-todo` writes `enum: [...STATUSES]` — a source AST would see the
    // spread, not the values. Booting yields the shipped enum literals.
    const status = (((todo?.parameters as unknown as JsonSchema).properties?.todos)?.items)?.properties?.status
    expect(status?.enum).toEqual(['pending', 'in_progress', 'completed'])
  })

  it('attributes each harvested tool with its registering plugin source', async () => {
    const catalog = await collectToolCatalog()
    const bash = catalog.find(entry => entry.pkg === 'coding-tool-bash')
    expect(bash?.sources.bash).toBe('packages/shell/tool-bash/src/index.ts')
    const ppt = catalog.find(entry => entry.pkg === 'coding-tool-ppt')
    expect(ppt?.schemas).toHaveLength(15)
    expect(ppt?.sources.ppt_render).toBe('packages/ppt/tool-ppt/src/index.ts')
    expect(ppt?.sources.ppt_templates).toBe('packages/ppt/tool-ppt/src/index.ts')
    expect(ppt?.sources.ppt_save_template).toBe('packages/ppt/tool-ppt/src/index.ts')
    expect(ppt?.sources.ppt_import_template).toBe('packages/ppt/tool-ppt/src/index.ts')
    expect(ppt?.sources.ppt_rename_template).toBe('packages/ppt/tool-ppt/src/index.ts')
    expect(ppt?.sources.ppt_delete_template).toBe('packages/ppt/tool-ppt/src/index.ts')
    const control = catalog.find(entry => entry.pkg === 'coding-tool-subagent-control')
    expect(control?.sources).toEqual({
      interrupt_agent: 'packages/subagent/tool-subagent-control/src/index.ts',
      followup_task: 'packages/subagent/tool-subagent-control/src/index.ts',
      list_agents: 'packages/subagent/tool-subagent-control/src/list-agents.ts',
      send_message: 'packages/subagent/tool-subagent-control/src/index.ts',
      wait_agent: 'packages/subagent/tool-subagent-control/src/wait-agent.ts',
    })
  })

  it('harvests search tools without depending on the generator process PATH', async () => {
    const oldPath = process.env.PATH
    try {
      process.env.PATH = ''
      const catalog = await collectToolCatalog()
      const search = catalog.find(entry => entry.pkg === 'coding-tool-fs-search')
      expect(search?.schemas.map(s => s.name).sort()).toEqual(['glob', 'grep'])
    } finally {
      if (oldPath === undefined) delete process.env.PATH
      else process.env.PATH = oldPath
    }
  })

  it('records the shipped `subagent_fork` alias in a note (config-driven tool name)', async () => {
    // `tool-subagent`'s registered name is the load-time `toolName` config, so the shipped
    // agents surface this one package as both `subagent` and `subagent_fork`.
    const catalog = await collectToolCatalog()
    const subagent = catalog.find(entry => entry.pkg === 'coding-tool-subagent')
    expect(subagent?.schemas.map(s => s.name)).toEqual(['subagent'])
    expect(subagent?.note).toMatch(/subagent_fork/)
  })
})

describe('gen-tool-catalog assertManifestComplete', () => {
  it('passes when the manifest lists every on-disk tool package (the default)', () => {
    expect(() => { assertManifestComplete() }).not.toThrow()
  })

  it('throws, naming the omitted package, when a tool package is missing from the manifest', () => {
    // An empty manifest scanned against the real tree: every `tool-*` package
    // is unlisted, so the guard must fire and name them.
    expect(() => { assertManifestComplete([]) }).toThrow(/not in the boot manifest/)
    expect(() => { assertManifestComplete([]) }).toThrow(/tool-bash/)
  })
})

describe('gen-tool-catalog assertToolsHarvested', () => {
  const entry: ToolPackage = {
    pkg: 'coding-tool-demo',
    dir: 'tool-demo',
    source: 'packages/demo/tool-demo/src/index.ts',
    requires: ['ctx.tools', 'ctx.somethingUnmounted'],
    writes: ['tool/result'],
    mount: () => Promise.resolve(),
  }

  it('accepts a boot that registered at least one tool', () => {
    expect(() => { assertToolsHarvested(entry, 1) }).not.toThrow()
  })

  it('throws, naming the package and its requirements, when a boot registers nothing', () => {
    // The failure this guards is silent by construction: the package is in the
    // manifest, its plugin merely stays PENDING on an unmounted service, and the
    // catalog would ship without its tools while every gate stays green.
    expect(() => { assertToolsHarvested(entry, 0) }).toThrow(/coding-tool-demo booted without registering a single tool/)
    expect(() => { assertToolsHarvested(entry, 0) }).toThrow(/ctx.somethingUnmounted/)
  })
})

describe('gen-tool-catalog render', () => {
  it('emits a package heading, a tool heading, and a json schema fence', () => {
    const catalog: ToolCatalog = [
      {
        pkg: 'coding-tool-demo',
        sources: { demo: 'packages/demo/tool-demo/src/index.ts' },
        requires: ['ctx.tools'],
        writes: ['tool/result'],
        schemas: [{ name: 'demo', description: 'A demo tool.', parameters: { type: 'object', properties: {} } }],
      },
    ]
    const md = render(catalog)
    expect(md).toContain('| `coding-tool-demo` | `demo` | `ctx.tools` | `tool/result` |')
    expect(md).toContain('## `coding-tool-demo`')
    expect(md).toContain('### `demo`')
    expect(md).toContain('A demo tool.')
    expect(md).toContain('```json')
    expect(md).toContain('Source: [`packages/demo/tool-demo/src/index.ts`]')
  })
})
