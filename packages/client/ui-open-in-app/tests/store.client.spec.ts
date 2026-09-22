import { describe, expect, it } from 'vitest'
import { createWorkbenchStore, tabIdForSegments } from '../src/client/store.ts'

describe('file workbench store', () => {
  it('uses opaque provider segments as tab identity', () => {
    expect(tabIdForSegments(['C:\\work', 'a/b'])).toBe('["C:\\\\work","a/b"]')
    expect(tabIdForSegments(['/srv', 'a\\b'])).not.toBe(tabIdForSegments(['C:\\work', 'a/b']))
  })

  it('opens, activates, deduplicates, and closes tabs with an adjacent fallback', () => {
    const instance = createWorkbenchStore().create()
    const first = { name: 'first.ts', segments: ['src', 'first.ts'] }
    const second = { name: 'second.ts', segments: ['src', 'second.ts'] }
    const third = { name: 'third.ts', segments: ['src', 'third.ts'] }
    instance.actions.openFile(first)
    instance.actions.openFile(second)
    instance.actions.openFile(third)
    instance.actions.openFile(first)
    expect(instance.store.getSnapshot()).toMatchObject({
      tabs: [first, second, third],
      activeId: tabIdForSegments(first.segments),
    })

    instance.actions.activateFile(tabIdForSegments(second.segments))
    instance.actions.activateFile('missing')
    expect(instance.store.getSnapshot().activeId).toBe(tabIdForSegments(second.segments))

    instance.actions.closeFile(tabIdForSegments(first.segments))
    expect(instance.store.getSnapshot().activeId).toBe(tabIdForSegments(second.segments))
    instance.actions.closeFile(tabIdForSegments(second.segments))
    expect(instance.store.getSnapshot().activeId).toBe(tabIdForSegments(third.segments))
    instance.actions.closeFile('missing')
    instance.actions.closeFile(tabIdForSegments(third.segments))
    expect(instance.store.getSnapshot()).toEqual({
      tabs: [],
      activeId: null,
      filesQuery: '',
      filesExpanded: [],
      filesLevels: {},
    })
  })

  it('keeps file viewing state in the session store', () => {
    const instance = createWorkbenchStore().create()
    instance.actions.setFilesQuery('readme')
    instance.actions.toggleFilesExpanded('root')
    instance.actions.setFilesLevel(['src'], 'loading')
    instance.actions.setFilesListing(['src'], {
      path: '/w/src',
      entries: [{ name: 'main.ts', type: 'file', size: 1, segments: ['src', 'main.ts'] }],
      truncated: false,
    })
    expect(instance.store.getSnapshot()).toMatchObject({
      filesQuery: 'readme',
      filesExpanded: ['root'],
      filesLevels: {
        [tabIdForSegments(['src'])]: {
          phase: 'ready',
          segments: ['src'],
          listing: { path: '/w/src' },
        },
      },
    })

    instance.actions.setFilesLevel(['src'], 'error')
    expect(instance.store.getSnapshot()).toMatchObject({
      filesLevels: {
        [tabIdForSegments(['src'])]: {
          phase: 'error',
          listing: { path: '/w/src' },
        },
      },
    })
  })
})
