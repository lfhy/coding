import { describe, expect, it } from 'vitest'
import type { SessionId } from 'coding-session/types'
import { createRetainedWorkbenchStore } from '../src/client/store.ts'
import { SidebarRightController } from '../src/client/sidebar-tab-service.ts'
import { SidebarRightTabRegistry } from '../src/client/sidebar-tab-registry.ts'

const SESSION = 'file-opener-session' as SessionId

function bench() {
  const store = createRetainedWorkbenchStore().create()
  const opened: SessionId[] = []
  const controller = new SidebarRightController(
    new SidebarRightTabRegistry(),
    { openWorkbench: (sessionId) => { opened.push(sessionId) } },
    () => SESSION,
  )
  const actions = store.actions
  controller.attach(actions)
  return { store, opened, controller }
}

describe('SidebarRightController file actions', () => {
  it('opens a file tab and the right workbench for the requested Session', () => {
    const { store, opened, controller } = bench()
    expect(controller.openFileForSession(SESSION, { name: 'a.ts', segments: ['src', 'a.ts'] })).toBe(true)
    expect(store.getSnapshot().sessions[SESSION]).toMatchObject({
      view: 'files', activeId: JSON.stringify(['src', 'a.ts']),
      tabs: [{ type: 'file', name: 'a.ts', segments: ['src', 'a.ts'] }],
    })
    expect(opened).toEqual([SESSION])
  })

  it('opens the file manager for a folder request and reports unavailable workbench wiring', () => {
    const { store, opened, controller } = bench()
    expect(controller.openFileManagerForSession(SESSION)).toBe(true)
    expect(store.getSnapshot().sessions[SESSION]).toMatchObject({ view: 'files', activeId: 'file-manager' })
    expect(opened).toEqual([SESSION])
    controller.detach()
    expect(controller.openFileForSession(SESSION, { name: 'b.ts', segments: ['b.ts'] })).toBe(false)
    expect(controller.openFileManagerForSession(SESSION)).toBe(false)
  })
})
