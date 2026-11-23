/** 覆盖 Linux 运行时的空间读取边界，避免只读查询创建空白锚页或切换全局选择。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

let createTaskSpacesApi: typeof import('../runtime/ego-linux/src/task-spaces.mjs').createTaskSpacesApi
let createTabsApi: typeof import('../runtime/ego-linux/src/tabs.mjs').createTabsApi

async function loadRuntime(): Promise<void> {
  ({ createTaskSpacesApi } = await import('../runtime/ego-linux/src/task-spaces.mjs'))
  ;({ createTabsApi } = await import('../runtime/ego-linux/src/tabs.mjs'))
}

let stateDir: string | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  if (stateDir) await rm(stateDir, { recursive: true, force: true })
  stateDir = undefined
})

describe('桌面任务空间的默认标签', () => {
  it('按桌面呈现顺序选择空间内的第一个目标，不借用同登录态下的其他页面', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'coding-ego-tabs-focus-'))
    vi.stubEnv('EGO_LINUX_STATE_DIR', stateDir)
    vi.stubEnv('EGO_LINUX_CDP_URL', 'ws://127.0.0.1:1/test')
    await writeFile(join(stateDir, 'task-spaces.json'), JSON.stringify({
      spaces: [
        { id: 1, name: 'first', targetIds: ['blank', 'link'], browserContextId: null },
        { id: 2, name: 'second', targetIds: ['other'], browserContextId: null },
      ],
      selectedId: 2,
      nextId: 3,
    }))
    vi.resetModules()
    await loadRuntime()
    const call = vi.fn(async (method: string) => method === 'Target.getTargets'
      ? { targetInfos: [
        { targetId: 'other', type: 'page', url: 'https://other.example/' },
        { targetId: 'link', type: 'page', url: 'https://first.example/' },
        { targetId: 'blank', type: 'page', url: 'about:blank' },
      ] } : {})
    await createTaskSpacesApi({ call }).useTaskSpace(1)
    expect(call).toHaveBeenLastCalledWith('Target.activateTarget', { targetId: 'link' })
    vi.stubEnv('EGO_LINUX_CDP_URL', undefined)
    await createTaskSpacesApi({ call }).useTaskSpace(1)
    expect(call).toHaveBeenLastCalledWith('Target.activateTarget', { targetId: 'blank' })
  })
})

describe('Linux 运行时的只读标签查询', () => {
  it('空间不存在时不创建锚页、不改变选中空间，也不返回其它空间标签', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'coding-ego-tabs-'))
    vi.stubEnv('EGO_LINUX_STATE_DIR', stateDir)
    await writeFile(join(stateDir, 'task-spaces.json'), JSON.stringify({
      spaces: [{ id: 1, name: 'other', targetIds: ['foreign'], browserContextId: null }],
      selectedId: 1,
      nextId: 2,
    }))
    let targetCalls = 0
    vi.resetModules()
    await loadRuntime()
    const cdp = {
      activeHint: () => undefined,
      call: async (method: string) => {
        if (method !== 'Target.getTargets') throw new Error(`unexpected CDP method: ${method}`)
        targetCalls++
        return { targetInfos: [
          { targetId: 'foreign', type: 'page', url: 'https://foreign.example/' },
          { targetId: 'new', type: 'page', url: 'about:blank' },
        ] }
      },
    }
    const tabs = createTabsApi(cdp, { getScope: () => null })
    const spaces = createTaskSpacesApi(cdp)
    const result = await spaces.listTabsForSpace('missing', tabs)
    expect(result).toEqual({ tabs: [] })
    expect(targetCalls).toBe(0)
    expect(JSON.parse(await readFile(join(stateDir, 'task-spaces.json'), 'utf8'))).toMatchObject({
      selectedId: 1,
      nextId: 2,
      spaces: [{ id: 1, name: 'other', targetIds: ['foreign'] }],
    })
  })

  it('已有空间按自身 context 或 targetIds 查询，并且不选中该空间', async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'coding-ego-tabs-owned-'))
    vi.stubEnv('EGO_LINUX_STATE_DIR', stateDir)
    await writeFile(join(stateDir, 'task-spaces.json'), JSON.stringify({
      spaces: [{ id: 1, name: 'owned', targetIds: ['owned'], browserContextId: null }],
      selectedId: null,
      nextId: 2,
    }))
    vi.resetModules()
    await loadRuntime()
    const cdp = {
      activeHint: () => undefined,
      call: async (method: string) => {
        if (method !== 'Target.getTargets') throw new Error(`unexpected CDP method: ${method}`)
        return { targetInfos: [
          { targetId: 'owned', type: 'page', url: 'https://owned.example/' },
          { targetId: 'foreign', type: 'page', url: 'https://foreign.example/' },
        ] }
      },
    }
    const tabs = createTabsApi(cdp, { getScope: () => null })
    const spaces = createTaskSpacesApi(cdp)
    const listed = await spaces.listTabsForSpace('owned', tabs)
    expect(listed).toMatchObject({ tabs: [{ targetId: 'owned' }] })
    const savedState = JSON.parse(await readFile(join(stateDir, 'task-spaces.json'), 'utf8')) as { selectedId: unknown }
    expect(savedState.selectedId).toBeNull()
  })
})
