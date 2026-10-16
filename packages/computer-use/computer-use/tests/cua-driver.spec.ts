/**
 * cua-driver 后端的接线覆盖：用一个可执行的替身驱动替换真实 `cua-driver`，
 * 验证固定 argv 调用、外部回包的收窄、坐标换算、过期拒绝与缺失时的诊断。
 * 真实驱动的行为未在本机复测，见包 README 的已知限制。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { BackendActionRequest, BackendElement, BackendObservation } from '../src/backend.ts'
import { resolveConfig } from '../src/config.ts'
import { ComputerUseError } from '../src/errors.ts'
import { ComputerObservationId, type ComputerAppIdentity, type ComputerClickAction } from '../src/types.ts'
import { CuaDriverBackend, resolveDriverBin } from '../src/providers/cua-driver.ts'

/** 1x1 PNG；驱动回传的就是这种 base64。 */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARAAB/wD/AH8AAP8A/wB/AAAAAElFTkSuQmCC'

/** 替身驱动：把每个工具的固定回包写进 stdout，调用与参数记到 stderr 供断言读取。 */
const STUB_SOURCE = `#!/usr/bin/env node
const [, , subcommand, tool, payload] = process.argv
if (subcommand !== 'call') process.exit(2)
const args = JSON.parse(payload ?? '{}')
const { appendFileSync } = await import('node:fs')
const { dirname, join } = await import('node:path')
appendFileSync(join(dirname(process.argv[1]), 'calls.jsonl'), JSON.stringify({ tool, args }) + '\\n')
const answer = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0) }
switch (tool) {
  case 'list_apps':
    answer({ apps: [
      { pid: 4321, bundle_id: 'com.example.fixture', name: 'Fixture', active: true },
      { pid: 4322, bundle_id: 'com.example.other', name: 'Fixture', active: false },
    ] })
  case 'list_windows':
    answer({ windows: [
      { window_id: 77, pid: 4321, title: 'Fixture window', app_name: 'Fixture', z_index: 3, active: true, frame: { x: 100, y: 50, w: 400, h: 300 } },
    ] })
  case 'get_window_state':
    answer({
      elements: [
        { element_index: 0, element_token: 'tok-0', role: 'AXButton', label: '继续', enabled: true, frame: { x: 120, y: 70, w: 40, h: 20 } },
        { element_index: 1, element_token: 'tok-1', role: 'AXTextField', value: 'hello', frame: { x: 120, y: 100, w: 200, h: 20 } },
      ],
      screenshot_png_b64: args.include_screenshot ? '${PNG_BASE64}' : undefined,
      screenshot_width: 800,
      screenshot_height: 600,
      screenshot_mime_type: 'image/png',
    })
  case 'click':
    if (args.element_token === 'refusing_tool') answer({ effect: 'refused', code: 'password_field', reason: 'secure text field' })
    if (args.element_token === 'broken_tool') { process.stdout.write('not json'); process.exit(0) }
    if (args.element_token === 'failing_tool') { process.stderr.write('driver exploded'); process.exit(3) }
    answer({ ok: true })
  default:
    answer({ ok: true })
}
`

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** 建一个临时目录里的替身驱动，并返回可直接当 `bin` 用的路径。 */
async function stubDriver(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-cua-driver-'))
  const path = join(root, 'cua-driver')
  await writeFile(path, STUB_SOURCE)
  await chmod(path, 0o755)
  return path
}

async function backendWith(bin: string, config: Parameters<typeof resolveConfig>[0] = {}) {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  const resolved = resolveConfig({ provider: 'cua-driver', cuaDriver: { bin }, ...config })
  return { ctx, backend: new CuaDriverBackend(ctx, resolved) }
}

/** 组合一次坐标或元素点击请求；观察 id 由服务分配，这里按服务的方式补上。 */
function clickRequest(
  app: ComputerAppIdentity,
  observation: BackendObservation,
  action: Omit<ComputerClickAction, 'kind' | 'observationId'>,
  element?: BackendElement,
): BackendActionRequest {
  const click: ComputerClickAction = {
    kind: 'click',
    observationId: ComputerObservationId('cu-test-observation'),
    ...action,
  }
  return {
    app,
    expectedStateHash: observation.stateHash,
    interaction: resolveConfig({}).interaction,
    ...(observation.window === undefined ? {} : { window: observation.window }),
    ...(element === undefined ? {} : { element }),
    action: click,
  }
}

/** 读替身驱动记录的调用序列。 */
async function stubCalls(directory: string): Promise<Array<{ tool: string; args: Record<string, unknown> }>> {
  const text = await readFile(join(directory, 'calls.jsonl'), 'utf8')
  return text.trim().split('\n').filter(line => line.length > 0)
    .map(line => JSON.parse(line) as { tool: string; args: Record<string, unknown> })
}

function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(ComputerUseError)
  expect((error as ComputerUseError).code).toBe(code)
}

describe('resolveDriverBin', () => {
  it('prefers the configured path, then the environment, then the installer location', () => {
    expect(resolveDriverBin('/explicit/cua-driver', {}, '/home/u')).toBe('/explicit/cua-driver')
    expect(resolveDriverBin(undefined, { CUA_DRIVER_BIN: '/env/cua-driver' }, '/home/u')).toBe('/env/cua-driver')
    expect(resolveDriverBin('   ', {}, '/home/u')).toBe('/home/u/.cua-driver/packages/current/cua-driver')
  })
})

describe('CuaDriverBackend', () => {
  it('lists applications and resolves one exact selector', async () => {
    const { backend } = await backendWith(await stubDriver())
    const apps = await backend.listApps(new AbortController().signal)
    expect(apps).toMatchObject([
      { pid: 4321, bundleId: 'com.example.fixture', name: 'Fixture', frontmost: true, accessibility: 'not-determined' },
      { pid: 4322, bundleId: 'com.example.other', frontmost: false },
    ])
    await expect(backend.resolveApp({ bundleId: 'com.example.fixture' }, new AbortController().signal))
      .resolves.toEqual({ bundleId: 'com.example.fixture', pid: 4321, name: 'Fixture' })
    const ambiguous = await backend.resolveApp({ name: 'Fixture' }, new AbortController().signal)
      .catch((error: unknown) => error)
    expectCode(ambiguous, 'COMPUTER_TARGET_AMBIGUOUS')
    const missing = await backend.resolveApp({ bundleId: 'com.example.absent' }, new AbortController().signal)
      .catch((error: unknown) => error)
    expectCode(missing, 'COMPUTER_APP_NOT_FOUND')
  })

  it('maps a window observation, writes the screenshot, and keeps the window frame', async () => {
    const { backend } = await backendWith(await stubDriver())
    const screenshotPath = join(root as string, 'artifacts', 'shot.png')
    const observation = await backend.observe(
      { bundleId: 'com.example.fixture', pid: 4321, name: 'Fixture' },
      { screenshot: 'required', screenshotPath, maxNodes: 500, maxDepth: 14, maxTextBytes: 65536 },
      new AbortController().signal,
    )
    expect(observation).toMatchObject({
      app: { pid: 4321 },
      frontmost: true,
      window: { id: 77, title: 'Fixture window', frame: { x: 100, y: 50, width: 400, height: 300 } },
      screenshot: { path: screenshotPath, width: 800, height: 600 },
      truncated: false,
    })
    expect(observation.treeText).toContain('[0] AXButton "继续" @(140,80)')
    expect(observation.elements[1]).toMatchObject({ index: 1, role: 'AXTextField', value: 'hello', nativeIdentifier: 'tok-1' })
    await expect(readFile(screenshotPath)).resolves.toHaveLength(Buffer.from(PNG_BASE64, 'base64').byteLength)
  })

  it('sends element tokens for element actions and window-local pixels for coordinates', async () => {
    const { backend } = await backendWith(await stubDriver())
    const app = { bundleId: 'com.example.fixture', pid: 4321, name: 'Fixture' }
    const observation = await backend.observe(app, {
      screenshot: 'required',
      screenshotPath: join(root as string, 'shot.png'),
      maxNodes: 500,
      maxDepth: 14,
      maxTextBytes: 65536,
    }, new AbortController().signal)

    await expect(backend.act(
      clickRequest(app, observation, { elementIndex: 0, clickCount: 1, button: 'left' }, observation.elements[0]),
      new AbortController().signal,
    )).resolves.toMatchObject({
      channel: 'accessibility', pointerInput: true, pointerRouting: 'target-process', activation: 'not-requested',
    })

    // 截图 800px 宽、窗口 400pt 宽 → 模型给的栅格像素要除以 2 才是驱动的窗口本地像素。
    await backend.act(
      clickRequest(app, observation, { x: 100, y: 80, clickCount: 1, button: 'left' }),
      new AbortController().signal,
    )
    const calls = await stubCalls(root as string)
    expect(calls.at(-2)).toMatchObject({ tool: 'click', args: { pid: 4321, element_token: 'tok-0', count: 1, button: 'left' } })
    expect(calls.at(-1)).toMatchObject({ tool: 'click', args: { pid: 4321, window_id: 77, x: 50, y: 40 } })
  })

  it('refuses a coordinate action whose window changed since the observation', async () => {
    const { backend } = await backendWith(await stubDriver())
    const app = { bundleId: 'com.example.fixture', pid: 4321, name: 'Fixture' }
    const observation = await backend.observe(app, {
      screenshot: 'none', maxNodes: 500, maxDepth: 14, maxTextBytes: 65536,
    }, new AbortController().signal)
    const stale = await backend.act(
      { ...clickRequest(app, observation, { x: 10, y: 10, clickCount: 1, button: 'left' }), expectedStateHash: `${observation.stateHash}-moved` },
      new AbortController().signal,
    ).catch((error: unknown) => error)
    expectCode(stale, 'COMPUTER_STALE_OBSERVATION')
  })

  it('turns a driver refusal and a driver crash into stable failures', async () => {
    const { backend } = await backendWith(await stubDriver())
    const app = { bundleId: 'com.example.fixture', pid: 4321, name: 'Fixture' }
    const observation = await backend.observe(app, {
      screenshot: 'none', maxNodes: 500, maxDepth: 14, maxTextBytes: 65536,
    }, new AbortController().signal)
    const element = observation.elements[0]
    expect(element).toBeDefined()
    const actWith = (token: string) => backend.act(
      clickRequest(app, observation, { elementIndex: 0, clickCount: 1, button: 'left' }, { ...(element as BackendElement), nativeIdentifier: token }),
      new AbortController().signal,
    )

    const refused = await actWith('refusing_tool').catch((error: unknown) => error)
    expectCode(refused, 'COMPUTER_ACTION_BLOCKED')
    expect(String(refused)).toContain('secure text field')

    const broken = await actWith('broken_tool').catch((error: unknown) => error)
    expectCode(broken, 'COMPUTER_PROVIDER_FAILURE')
    expect(String(broken)).toContain('did not return JSON')

    const crashed = await actWith('failing_tool').catch((error: unknown) => error)
    expectCode(crashed, 'COMPUTER_PROVIDER_FAILURE')
    expect(String(crashed)).toContain('exit 3')
  })

  it('reports an actionable failure when the driver executable is absent', async () => {
    const { backend } = await backendWith('/nonexistent/cua-driver')
    const failure = await backend.listApps(new AbortController().signal).catch((error: unknown) => error)
    expectCode(failure, 'COMPUTER_PROVIDER_FAILURE')
  })
})

describe('cua-driver configuration', () => {
  it('hides the agent cursor by default and rejects an explicit visible request', () => {
    expect(resolveConfig({ provider: 'cua-driver' }).interaction.cursorVisualization).toBe('hidden')
    expect(resolveConfig({ provider: 'native' }).interaction.cursorVisualization).toBe('visible')
    expect(() => resolveConfig({ provider: 'cua-driver', interaction: { cursorVisualization: 'visible' } }))
      .toThrow(/no agent cursor overlay/u)
  })

  it('defaults the session name and keeps an explicit driver path', () => {
    const resolved = resolveConfig({ provider: 'cua-driver', cuaDriver: { bin: '/opt/cua-driver' } })
    expect(resolved.cuaDriver).toEqual({ bin: '/opt/cua-driver', session: 'dsh-computer-use' })
    expect(() => resolveConfig({ provider: 'cua-driver', cuaDriver: { session: '  ' } }))
      .toThrow(/session must be non-empty/u)
  })
})
