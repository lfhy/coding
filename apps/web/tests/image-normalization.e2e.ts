// 真实 Web/Host 组装：浏览器按原字节提交大图，Host 持久化缩放后的图片，
// 历史页面再经授权附件接口读取归一化结果；模型由无凭据回放回答。
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type {} from '@deepseek-ai/dsh-session'
import {
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

const ANSWER = 'IMAGE_NORMALIZATION_ACK'
const REPLAY: ReplayOverrideDoc = Array.from({ length: 2 }, () => ({
  kind: 'chunks',
  chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: ANSWER },
    { type: 'block-end', index: 0, block: { type: 'text', text: ANSWER } },
    { type: 'usage', usage: { inputTokens: 256, outputTokens: 16 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ],
}))

interface PromptWire {
  method: string
  payload: { content?: Array<{ type: string; data?: string; name?: string }> }
}

/** 构造可解码的 3000px PNG，经真实粘贴或全屏拖放入口交给输入栏。 */
async function submitSourceImage(page: Page, name: string, entry: 'paste' | 'drop'): Promise<string> {
  return await page.evaluate(async ({ name, entry }) => {
    const canvas = document.createElement('canvas')
    canvas.width = 3000
    canvas.height = 1000
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('canvas context unavailable')
    context.fillStyle = entry === 'paste' ? '#123456' : '#654321'
    context.fillRect(0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (value === null) reject(new Error('PNG encode failed'))
        else resolve(value)
      }, 'image/png')
    })
    const file = new File([blob], name, { type: 'image/png' })
    const source = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => { reject(new Error('PNG read failed')) }
      reader.onload = () => {
        if (typeof reader.result !== 'string') reject(new Error('PNG data URL missing'))
        else resolve(reader.result.split(',')[1] ?? '')
      }
      reader.readAsDataURL(file)
    })
    const transfer = new DataTransfer()
    transfer.items.add(file)
    if (entry === 'paste') {
      const input = document.querySelector('textarea:enabled')
      if (input === null) throw new Error('composer missing')
      input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
    } else {
      document.body.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }))
      await new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) })
      document.body.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
    return source
  }, { name, entry })
}

describe.skipIf(webSnapshotMode() === 'record')('web e2e: Host image normalization after browser intake', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let replayDir: string
  let tripwire: ReturnType<typeof watchConsole>
  const requests: PromptWire[] = []
  const consoleErrors: string[] = []

  beforeAll(async () => {
    replayDir = await mkdtemp(join(tmpdir(), 'dsh-image-normalization-replay-'))
    const replayOverride = join(replayDir, 'replay.override.json')
    await writeFile(replayOverride, JSON.stringify(REPLAY))
    scaffold = await launchWebScaffold({
      replayFixture: join(replayDir, 'override-only.jsonl'),
      replayOverride,
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('request', (request) => {
      if (!request.url().endsWith('/api/session.prompt')) return
      requests.push(request.postDataJSON() as PromptWire)
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (replayDir !== undefined) {
      await rm(replayDir, { recursive: true, force: true })
        .catch((error: unknown) => failures.push(error))
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'image-normalization e2e cleanup failed')
  })

  it('sends untouched paste/drop bytes and reads both normalized history images', async () => {
    expect(new URL(page.url()).origin).toBe(scaffold.baseUrl)
    expect(await page.title()).toContain('Coding')
    expect(await page.locator('textarea:enabled').count()).toBeGreaterThan(0)
    expect(await page.locator('vite-error-overlay').count()).toBe(0)

    const seen: ImageAttachmentRef[] = []
    for (const entry of ['paste', 'drop'] as const) {
      const name = `${entry}-3000.png`
      const sourceBase64 = await submitSourceImage(page, name, entry)
      await page.locator('[role="group"][aria-label="Pending images"]')
        .getByRole('img', { name }).waitFor({ timeout: 10_000 })
      const composer = page.locator('textarea:enabled').last()
      const settled = scaffold.whenTurnSettled()
      await composer.fill(`Normalize ${entry} image`)
      await composer.press('Enter')
      const sessionId = await settled
      const prompt = requests.at(-1)
      expect(prompt?.method).toBe('session.prompt')
      expect(prompt?.payload.content?.find(part => part.type === 'image')).toEqual({
        type: 'image', mediaType: 'image/png', data: sourceBase64, name,
      })
      const session = scaffold.ctx.sessions.get(sessionId)
      const part = session?.events.flatMap(event => event.type === 'user/message' ? event.data.content : [])
        .find(block => block.type === 'image' && block.attachment.name === name)
      if (part?.type !== 'image') {
        throw new Error(`durable image reference missing: ${JSON.stringify(session?.events
          .filter(event => event.type === 'user/message')
          .map(event => event.data.content.map(block => block.type === 'image'
            ? { type: block.type, name: block.attachment.name }
            : { type: block.type })))}`)
      }
      const ref = part.attachment
      expect(ref).toMatchObject({ mediaType: 'image/png', name, width: 2000 })
      expect(ref.height).toBeLessThanOrEqual(2000)
      expect(ref.bytes).toBeLessThanOrEqual(3.5 * 1024 * 1024)
      expect(ref.bytes).not.toBe(Buffer.from(sourceBase64, 'base64').byteLength)
      const stored = await scaffold.ctx.attachments.readImage(ref)
      expect(stored.data.byteLength).toBe(ref.bytes)
      seen.push(ref)
      await expect.poll(() => page.locator('[data-align="end"] img').count(), { timeout: 15_000 })
        .toBe(seen.length)
    }

    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => page.locator('[data-align="end"] img').count(), { timeout: 20_000 })
      .toBe(2)
    await expect.poll(() => page.locator('[data-align="end"] img').evaluateAll(images =>
      images.every(image => (image as HTMLImageElement).naturalWidth === 2000)), { timeout: 15_000 })
      .toBe(true)
    const history = await page.locator('[data-align="end"] img').evaluateAll(images => images.map(image => ({
      alt: image.getAttribute('alt'),
      loadedWidth: (image as HTMLImageElement).naturalWidth,
    })))
    expect(history).toEqual([
      { alt: 'paste-3000.png', loadedWidth: 2000 },
      { alt: 'drop-3000.png', loadedWidth: 2000 },
    ])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    expect(consoleErrors).toEqual([])
    await page.screenshot({ path: '/tmp/dsh-image-normalization-history.png' })
  }, 90_000)
})
