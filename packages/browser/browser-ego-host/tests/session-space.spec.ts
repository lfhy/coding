/** 按完整 SessionId 过滤上游 task-spaces.json；重复记录一律拒绝。 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from 'coding-session/types'
import { readTaskSpaceGroups, sessionSpaceArgs, spaceNameForSession, targetIdsForSession } from '../src/session-space.ts'
import { parseInput } from '../src/routes.ts'
import { scriptFor } from '../src/scripts.ts'

let dir: string | undefined
afterEach(async () => {
  vi.unstubAllEnvs()
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

describe('会话空间归属', () => {
  it('两个相同前缀的 SessionId 获得不同空间，只读目标集合不串页', async () => {
    dir = await mkdtemp(join(tmpdir(), 'coding-ego-groups-'))
    vi.stubEnv('EGO_LINUX_STATE_DIR', dir)
    const first = SessionId('session-abcdefgh-first')
    const second = SessionId('session-abcdefgh-second')
    expect(spaceNameForSession(first)).not.toBe(spaceNameForSession(second))
    await writeFile(join(dir, 'task-spaces.json'), JSON.stringify({ spaces: [
      { name: spaceNameForSession(first), targetIds: ['first', 17] },
      { name: spaceNameForSession(second), targetIds: ['second'] },
    ] }))
    expect(await readTaskSpaceGroups()).toHaveLength(2)
    expect([...await targetIdsForSession(first)]).toEqual(['first'])
    expect([...await targetIdsForSession(second)]).toEqual(['second'])
    expect(scriptFor('ego_tabs', { space: spaceNameForSession(second) }, first)).toContain(spaceNameForSession(first))
    expect(scriptFor('ego_tabs', { space: spaceNameForSession(second) }, first)).not.toContain(spaceNameForSession(second))
  })

  it('显式打开默认空间、脚本和其它空间参数都受当前会话约束', () => {
    const first = SessionId('session-abcdefgh-first')
    const second = SessionId('session-abcdefgh-second')
    const own = spaceNameForSession(first)
    expect(sessionSpaceArgs({ name: 'default' }, first, 'ego_space_open')).toEqual({ name: own })
    expect(sessionSpaceArgs({ url: 'https://example.com/' }, first, 'ego_navigate'))
      .toEqual({ url: 'https://example.com/' })
    expect(sessionSpaceArgs({ space: own }, first, 'ego_navigate')).toEqual({ space: own })
    expect(() => sessionSpaceArgs({ space: spaceNameForSession(second) }, first, 'ego_navigate'))
      .toThrow('another task space is not available')
    expect(() => sessionSpaceArgs({ space: 'default' }, first, 'ego_navigate'))
      .toThrow('another task space is not available')
    expect(sessionSpaceArgs({ name: own }, first, 'ego_space_close')).toEqual({ name: own })
    expect(() => sessionSpaceArgs({ name: spaceNameForSession(second) }, first, 'ego_space_close'))
      .toThrow('another task space is not available')
    expect(sessionSpaceArgs({}, first, 'ego_captcha')).toEqual({ space: own })
    expect(sessionSpaceArgs({}, first, 'ego_wait_for_human')).toEqual({ space: own })
    expect(() => sessionSpaceArgs({ space: spaceNameForSession(second) }, first, 'ego_captcha'))
      .toThrow('another task space is not available')
    const script = 'console.log("ready")'
    for (const name of ['ego_cli', 'ego_script']) {
      expect(sessionSpaceArgs({ script }, first, name)).toEqual({
        script: `await taskSpaces.useOrCreate(${JSON.stringify(own)})\n${script}`,
      })
      expect(() => sessionSpaceArgs({ script: 1 }, first, name)).toThrow('invalid browser script')
    }
  })

  it('同名空间双重登记及不合法 target 都不会被接纳', async () => {
    dir = await mkdtemp(join(tmpdir(), 'coding-ego-duplicate-'))
    vi.stubEnv('EGO_LINUX_STATE_DIR', dir)
    const session = SessionId('test-session')
    await writeFile(join(dir, 'task-spaces.json'), JSON.stringify({ spaces: [
      { name: spaceNameForSession(session), targetIds: ['first'] },
      { name: spaceNameForSession(session), targetIds: ['second'] },
    ] }))
    expect((await targetIdsForSession(session)).size).toBe(0)
  })

  it('输入坐标、会话与目标缺失时拒绝生成任何 CDP 字段', () => {
    const page = { targetId: 'owned', url: 'https://example.com', title: 'Example', active: true,
      viewportW: 120, viewportH: 80 }
    expect(parseInput({ sessionId: 'session-a', targetId: 'owned', type: 'mousePressed', x: 10, y: 20,
      button: 'left', buttons: 1, clickCount: 1, injected: 'evil' }, page)).toEqual({
      targetId: 'owned', type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1,
    })
    for (const invalid of [
      { sessionId: '', targetId: 'owned', type: 'mousePressed', x: 1, y: 1 },
      { sessionId: 'session-a', targetId: 'other', type: 'mousePressed', x: 1, y: 1 },
      { sessionId: 'session-a', targetId: 'owned', type: 'mousePressed', x: 120, y: 20 },
      { sessionId: 'session-a', targetId: 'owned', type: 'mouseWheel', x: 1, y: 2, deltaX: Infinity, deltaY: 0 },
    ]) expect(parseInput(invalid, page)).toBeNull()
  })

  it('只转发允许的按键事件字段，拒绝按键注入和任意 CDP 额外参数', () => {
    const page = { targetId: 'owned', url: 'https://example.com', title: 'Example', active: true,
      viewportW: 120, viewportH: 80 }
    const key = { sessionId: 'session-a', targetId: 'owned', type: 'keyDown',
      key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }
    expect(parseInput(key, page)).toEqual({ targetId: 'owned', type: 'keyDown',
      key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 })
    expect(parseInput({ ...key, type: 'keyUp', modifiers: 2 }, page)).toEqual({
      targetId: 'owned', type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 2,
    })
    for (const invalid of [
      { ...key, key: 'a', code: 'KeyA' }, { ...key, code: 'Tab' }, { ...key, windowsVirtualKeyCode: -1 },
      { ...key, windowsVirtualKeyCode: 256 }, { ...key, modifiers: 8 },
      { ...key, text: 'injected' }, { ...key, nativeVirtualKeyCode: 1 },
    ]) expect(parseInput(invalid, page)).toBeNull()
  })
})
