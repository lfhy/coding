/** 仅固定 Chromium 边界；真实 Playwright 提供方负责导航校验、观测和会话生命周期。 */

import { appendFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'

interface FixtureBrowser {
  newContext(options: unknown): Promise<FixtureContext>
  close(): Promise<void>
}

interface FixtureContext {
  newPage(): Promise<FixturePage>
  on(event: string, listener: unknown): void
  close(): Promise<void>
}

interface FixturePage {
  goto(url: string, options: unknown): Promise<null>
  url(): string
  title(): Promise<string>
  on(event: string, listener: unknown): void
  evaluateHandle(): Promise<{
    getProperties(): Promise<Map<string, never>>
    dispose(): Promise<void>
  }>
  locator(selector: string): { evaluate(): Promise<string> }
  screenshot(): Promise<Buffer>
}

interface FixtureChromium {
  launch: (options?: unknown) => Promise<FixtureBrowser>
}

const fixtureUrl = 'http://127.0.0.1:59723/browser-unrestricted-network'
const fixtureTitle = 'Loopback browser fixture'
const fixtureText = 'Local network access verified'

function audit(event: unknown): Promise<void> {
  return appendFile('browser-adapter-calls.jsonl', JSON.stringify(event) + '\n')
}

function page(): FixturePage {
  let currentUrl = 'about:blank'
  return {
    async goto(url, options) {
      if (url !== fixtureUrl) throw new Error('Chromium fixture requires its fixed loopback navigation URL')
      await audit({ kind: 'goto', url, options })
      currentUrl = url
      return null
    },
    url: () => currentUrl,
    title: () => Promise.resolve(fixtureTitle),
    on() {},
    evaluateHandle: () => Promise.resolve({
      getProperties: () => Promise.resolve(new Map<string, never>()),
      dispose: () => Promise.resolve(),
    }),
    locator(selector) {
      if (selector !== 'body') throw new Error('Chromium fixture only provides page body text')
      return { evaluate: () => Promise.resolve(fixtureText) }
    },
    screenshot: () => Promise.resolve(Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=',
      'base64',
    )),
  }
}

/** 插件名。 */
export const name = 'browser-playwright-adapter-fixture'

/**
 * 在提供方挂载前替换其同一 Playwright 模块的 launch；卸载时恢复原方法。
 * @param ctx - 管理外部适配器替换寿命的上下文。
 * @returns 无返回值；不替换 browserUse 服务或提供方逻辑。
 */
export function apply(ctx: Context): void {
  const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-browser-playwright'))
  const { chromium } = require('playwright') as { chromium: FixtureChromium }
  ctx.effect(() => {
    const original = chromium.launch
    chromium.launch = async () => ({
      async newContext(options) {
        await audit({ kind: 'new-context', options })
        return { newPage: () => Promise.resolve(page()), on() {}, close: () => Promise.resolve() }
      },
      close: () => Promise.resolve(),
    })
    return () => { chromium.launch = original }
  }, 'browser-playwright: deterministic external Chromium adapter')
}
