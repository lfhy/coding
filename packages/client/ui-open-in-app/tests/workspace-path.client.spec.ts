import { describe, expect, it } from 'vitest'
import { workspaceFileName, workspaceFileSegments } from '../src/client/workspace-path.ts'

describe('workspaceFileSegments', () => {
  it('maps relative paths to provider segments and keeps names readable', () => {
    expect(workspaceFileSegments('/workspace', 'src/a.ts')).toEqual(['src', 'a.ts'])
    expect(workspaceFileName('src/a.ts')).toBe('a.ts')
  })

  it('maps paths inside POSIX and Windows workspaces', () => {
    expect(workspaceFileSegments('/workspace/', '/workspace/src/a.ts')).toEqual(['src', 'a.ts'])
    expect(workspaceFileSegments('C:\\Work\\', 'c:\\work\\src\\a.ts')).toEqual(['src', 'a.ts'])
    expect(workspaceFileSegments('/', '/src/a.ts')).toEqual(['src', 'a.ts'])
  })

  it('rejects paths that cannot be safely represented as workspace segments', () => {
    for (const path of ['', '..', '../outside', '/outside/a.ts', '~/a.ts', 'src/../a.ts', 'src/with\0nul.ts']) {
      expect(workspaceFileSegments('/workspace', path), path).toBeUndefined()
    }
    expect(workspaceFileSegments(undefined, 'src/a.ts')).toBeUndefined()
    expect(workspaceFileSegments('C:\\Work', 'D:\\outside\\a.ts')).toBeUndefined()
    expect(workspaceFileSegments('/workspace', '/workspace2/a.ts')).toBeUndefined()
  })
})
