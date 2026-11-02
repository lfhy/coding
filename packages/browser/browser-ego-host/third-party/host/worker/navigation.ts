import type { NavigationCommand } from '../../../src/navigation.ts'
import type { TargetSessions } from './capture-cdp.ts'

/** Dispatch navigation only on an already verified page target; no implicit target selection. */
export async function navigateTarget(sessions: Pick<TargetSessions, 'call'>, command: NavigationCommand): Promise<boolean> {
  const targetId = command.targetId
  if (!targetId) return false
  switch (command.action) {
    case 'navigate': {
      const result = await sessions.call(targetId, 'Page.navigate', { url: command.url }) as { errorText?: string }
      return !result.errorText
    }
    case 'reload':
      await sessions.call(targetId, 'Page.reload')
      return true
    case 'back':
    case 'forward': {
      const history = await sessions.call(targetId, 'Page.getNavigationHistory') as {
        currentIndex?: number
        entries?: Array<{ id: number }>
      }
      if (!Number.isSafeInteger(history.currentIndex) || !Array.isArray(history.entries)) return false
      const next = (history.currentIndex as number) + (command.action === 'back' ? -1 : 1)
      const entry = history.entries[next]
      if (!entry || !Number.isSafeInteger(entry.id)) return false
      await sessions.call(targetId, 'Page.navigateToHistoryEntry', { entryId: entry.id })
      return true
    }
  }
}
