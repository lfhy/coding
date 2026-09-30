/** 固定外部页面观测，不启动 Chromium；真实工具的调用另写入工作区供进程外核对。 */

import { appendFile } from 'node:fs/promises'
import BrowserUseService from '@deepseek-ai/dsh-browser'
import type {
  BrowserCapture, BrowserCommand, BrowserExpectedTarget, BrowserHumanCommand,
  BrowserSessionState, BrowserTabId,
} from '@deepseek-ai/dsh-browser'
import type { SessionId } from '@deepseek-ai/dsh-session'

const fixtureUrl = 'https://browser.example.invalid/full-access'

export default class BrowserFullAccessFixture extends BrowserUseService {
  async execute(sessionId: SessionId, command: BrowserCommand, signal: AbortSignal,
    expectedTarget?: BrowserExpectedTarget): Promise<BrowserCapture> {
    signal.throwIfAborted()
    if (command.kind !== 'navigate' || command.url !== fixtureUrl || expectedTarget?.kind !== 'none') {
      throw new Error('browser fixture requires its fixed navigation URL and an absent-session target')
    }
    await appendFile('browser-calls.jsonl', JSON.stringify({ sessionId, command, expectedTarget }) + '\n')
    return {
      observation: {
        tabId: 'full-access-fixture-tab' as BrowserTabId,
        generation: 'full-access-fixture-page', revision: 1, url: fixtureUrl,
        title: 'Full access browser fixture', snapshot: 'heading "Browser access verified"',
        viewport: { width: 800, height: 600 }, cursor: null,
      },
      png: null,
    }
  }

  state(): BrowserSessionState | undefined { return undefined }
  control(_sessionId: SessionId, _command: BrowserHumanCommand,
    _signal: AbortSignal): Promise<BrowserSessionState | undefined> {
    return Promise.reject(new Error('browser fixture does not implement human controls'))
  }
  latest(): BrowserCapture | undefined { return undefined }
  closeSession(): Promise<void> { return Promise.resolve() }
}
