/** 模拟 ego CLI 执行 Host 生成的脚本，固定同路径覆盖后的导航与截图顺序。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from 'coding-session/types'
import type { SubprocessSpawnSpec } from 'coding-subprocess'
import { afterEach, describe, expect, it } from 'vitest'
import EgoBrowserHost from '../src/index.ts'

type Tab = { targetId: string; url: string }
type Style = { id: string; textContent: string; remove(): void }
type Script = (taskSpaces: unknown, browser: unknown, ego: unknown, page: unknown, cdp: unknown,
  console: unknown) => Promise<void>
const AsyncFunction = (async function () {}).constructor as new (...args: string[]) => Script

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  if (root) await rm(root, { recursive: true, force: true })
  ctx = undefined
  root = undefined
})

async function fixture() {
  root = await mkdtemp(join(tmpdir(), 'coding-ego-capture-'))
  const first = SessionId('capture-session-one')
  const second = SessionId('capture-session-two')
  const spaces = new Map<string, Tab[]>()
  const navigations: string[] = []
  const screenshots: Array<{ targetId: string; html: string; cursorHidden: boolean }> = []
  const cursorStyles = new Map<string, Style>()
  const document = {
    createElement: (tag: string): Style => {
      if (tag !== 'style') throw new Error('unexpected element')
      return { id: '', textContent: '', remove() { cursorStyles.delete(this.id) } }
    },
    head: { appendChild: (style: Style) => { cursorStyles.set(style.id, style) } },
    getElementById: (id: string) => cursorStyles.get(id) ?? null,
  }
  let space = ''
  let active: Tab | undefined
  let html = ''
  let nextTarget = 0
  let loadSucceeds = true
  let screenshotFails = false
  ctx = new Context()
  ctx.provide('sessions', { get: (id: string) => [first, second].includes(SessionId(id)) ? { id } : undefined } as never)
  ctx.provide('subprocess', { spawn: (spec: SubprocessSpawnSpec) => {
    let stdout = ''
    const script = typeof spec.stdio.stdin === 'string' ? '' : spec.stdio.stdin.data
    const done = (async () => {
      try {
        const run = new AsyncFunction('taskSpaces', 'browser', 'ego', 'page', 'cdp', 'console', script)
        await run(
          { useOrCreate: async (name: string) => { space = name; if (!spaces.has(name)) spaces.set(name, []) } },
          { listTabs: async () => spaces.get(space) ?? [], switchTab: async (id: string) => {
            active = spaces.get(space)?.find(tab => tab.targetId === id)
            if (!active) throw new Error('unknown tab')
          } },
          { createTab: async (url: string) => {
            const tab = { targetId: `tab-${++nextTarget}`, url }
            spaces.get(space)!.push(tab)
            return tab
          } },
          { goto: async (url: string, options: { waitUntil: string }) => {
            if (options.waitUntil !== 'commit') throw new Error('navigation must wait for the new URL')
            navigations.push(url)
            html = await readFile(fileURLToPath(url), 'utf8')
            active!.url = url
          }, waitForURL: async (predicate: (url: URL) => boolean, options: { waitUntil: string }) =>
            loadSucceeds && options.waitUntil === 'load' && predicate(new URL(active!.url)),
          waitForTimeout: async () => {}, evaluate: async (fn: (id: string) => void, id: string) => {
            runInNewContext(`(${fn.toString()})(id)`, { document, id })
          }, screenshot: async ({ path }: { path: string }) => {
            const cursorHidden = [...cursorStyles.values()].some(style =>
              style.textContent.includes('#ego-agent-cursor-overlay { visibility: hidden !important }'))
            screenshots.push({ targetId: active!.targetId, html, cursorHidden })
            if (screenshotFails) throw new Error('screenshot failed')
            await writeFile(path, `PNG fixture: ${html}`)
          } },
          async () => {}, { log: (line: string) => { stdout += `${line}\n` } },
        )
        return { exitCode: 0 }
      } catch { return { exitCode: 1 } }
    })()
    return { done, collected: { stdout: { readFrom: () => ({ text: stdout }) } } }
  } } as never)
  await ctx.plugin(EgoBrowserHost).await()
  return { first, second, navigations, screenshots, spaces, cursorStyles,
    setLoadSucceeds: (value: boolean) => { loadSucceeds = value },
    setScreenshotFails: (value: boolean) => { screenshotFails = value } }
}

describe('会话页面截图', () => {
  it('同一路径覆盖后导航到新文档、复用本会话标签并正确编码文件路径', async () => {
    const browser = await fixture()
    const htmlPath = join(root!, 'slide 1 #2.html')
    const outPath = join(root!, 'slide.png')
    const capture = (sessionId = browser.first) => ctx!.egoBrowser.captureSessionPage({
      sessionId, htmlPath, outPath, width: 1280, height: 720,
    })
    await writeFile(htmlPath, '<main>first</main>')
    expect(await capture()).toBe(true)
    expect(await readFile(outPath, 'utf8')).toContain('first')
    await writeFile(htmlPath, '<main>second</main>')
    expect(await capture()).toBe(true)
    expect(await readFile(outPath, 'utf8')).toContain('second')
    expect(browser.screenshots.slice(0, 2).map(shot => shot.targetId)).toEqual(['tab-1', 'tab-1'])
    expect(browser.screenshots.every(shot => shot.cursorHidden)).toBe(true)
    expect(browser.cursorStyles.size).toBe(0)
    expect(browser.navigations[0]).not.toBe(browser.navigations[1])
    expect(browser.navigations.every(url => url.includes('slide%201%20%232.html?__dsh_capture='))).toBe(true)
    expect(await capture(browser.second)).toBe(true)
    expect(browser.screenshots[2]?.targetId).toBe('tab-2')
    expect([...browser.spaces.values()].map(tabs => tabs.length)).toEqual([1, 1])
  })

  it('新文档 URL 未确认加载时拒绝截图', async () => {
    const browser = await fixture()
    const htmlPath = join(root!, 'slide.html')
    const outPath = join(root!, 'slide.png')
    await writeFile(htmlPath, '<main>old</main>')
    expect(await ctx!.egoBrowser.captureSessionPage({
      sessionId: browser.first, htmlPath, outPath, width: 1280, height: 720,
    })).toBe(true)
    await writeFile(htmlPath, '<main>new</main>')
    browser.setLoadSucceeds(false)
    expect(await ctx!.egoBrowser.captureSessionPage({
      sessionId: browser.first, htmlPath, outPath, width: 1280, height: 720,
    })).toBe(false)
    expect(browser.screenshots).toHaveLength(1)
    expect(await readFile(outPath, 'utf8')).toContain('old')
  })

  it('截图失败也移除临时样式，保留页面光标显示', async () => {
    const browser = await fixture()
    const htmlPath = join(root!, 'slide.html')
    const outPath = join(root!, 'slide.png')
    await writeFile(htmlPath, '<main>slide</main>')
    browser.setScreenshotFails(true)
    expect(await ctx!.egoBrowser.captureSessionPage({
      sessionId: browser.first, htmlPath, outPath, width: 1280, height: 720,
    })).toBe(false)
    expect(browser.screenshots).toMatchObject([{ cursorHidden: true }])
    expect(browser.cursorStyles.size).toBe(0)
  })
})
