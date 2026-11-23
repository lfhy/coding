/** 只替换隔离测试的模型服务；浏览器工具和附件仍由桌面 Host 执行。 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'

const loopback = '127.0.0.1'
const toolName = 'browser_screenshot'
const provider = 'native-screenshot-fixture'
const model = 'native-screenshot-model'
const credentialRef = 'NATIVE_SCREENSHOT_FIXTURE_KEY'
const maxRequestBytes = 16 * 1024 * 1024

async function readCompletionRequest(request) {
  let size = 0
  const chunks = []
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > maxRequestBytes) {
      request.resume()
      throw new Error('截图模型请求超过大小限制')
    }
    chunks.push(chunk)
  }
  let payload
  try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new Error('截图模型请求不是有效的 JSON') }
  assert.ok(payload?.model === model && payload.stream === true && Array.isArray(payload.messages),
    '截图模型请求必须使用本地流式模型和消息数组')
  return payload
}

function sendCompletion(response, delta, finishReason) {
  const header = { id: `chatcmpl-${randomUUID()}`, object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000), model }
  const frames = [
    { ...header, choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] },
    { ...header, choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ]
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  response.end(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n')
}

function hasPrompt(message, prompt) {
  if (message?.role !== 'user') return false
  return message.content === prompt || (Array.isArray(message.content)
    && message.content.some(block => block?.type === 'text' && block.text === prompt))
}

/** 宿主会重放待审批请求；只回送已由会话历史核对的本次截图审批。 */
async function approveScreenshot(page, expected) {
  return page.evaluate(async ({ origin, sessionId, approvalId, callId, toolName }) => {
    if (location.origin !== origin) return 'host-changed'
    const url = new URL('/api/events.mux', origin)
    url.protocol = 'ws:'
    const rpcId = await new Promise(resolve => {
      const socket = new WebSocket(url)
      let settled = false
      const timer = setTimeout(() => finish(null), 4_000)
      function finish(id) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.close()
        resolve(id)
      }
      socket.addEventListener('error', () => finish(null), { once: true })
      socket.addEventListener('close', () => finish(null), { once: true })
      socket.addEventListener('message', ({ data }) => {
        if (typeof data !== 'string') return
        let frame
        try { frame = JSON.parse(data) } catch { return }
        const payload = frame?.payload
        if (frame?.type === 'server-request' && frame.method === 'approval/requested'
          && typeof frame.rpcId === 'string' && frame.rpcId && payload?.type === 'approval/requested'
          && payload.sessionId === sessionId && payload.approvalId === approvalId
          && payload.callId === callId && payload.toolName === toolName) finish(frame.rpcId)
      })
    })
    if (!rpcId) return 'missing-approval'
    const response = await fetch(`${origin}/api/respond`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId,
        result: { ok: true, value: { sessionId, approvalId, outcome: 'allowed-once' } } }),
      signal: AbortSignal.timeout(4_000), redirect: 'error',
    })
    if (!response.ok) return 'approval-http-error'
    const receipt = await response.json()
    return receipt?.accepted === true ? 'accepted' : 'approval-rejected'
  }, expected)
}

/** 只摘取已知错误短语和代码，不回显工具结果中的路径、参数或上游正文。 */
function screenshotFailure(text) {
  const excerpt = typeof text === 'string' ? text.slice(0, 1024) : ''
  const known = [
    ...excerpt.matchAll(/Page\.captureScreenshot|DOM\.getBoxModel|Invalid parameters|Unable to capture screenshot|No node found|\bCDP\b|browser operation failed/gi),
    ...excerpt.matchAll(/approval (?:rejected|cancelled|unavailable|required)/gi),
    ...excerpt.matchAll(/output (?:file already exists|directory is unavailable|must remain inside the session workspace)|unexpected image path|image path changed|image is unavailable|read-only session|\b(?:EACCES|EPERM|ENOENT|ENOTDIR|EEXIST)\b/gi),
  ].map(match => match[0])
  return known.length ? `真实截图失败：${[...new Set(known)].join('；').slice(0, 160)}` : '真实截图失败（无可安全显示的已知错误）'
}

/**
 * 为父测试的回环服务器提供 SSE 分流，并通过已装配的 Host 运行截图回合。
 * @param {object} options 父测试提供的 `rpc(page, method, payload)` 和 `until(check, label, timeout)`。
 * @returns 父服务器使用的 `handleRequest`，以及顺序调用的 `prepare` 和 `capture`。
 */
export function createScreenshotToolFixture({ rpc, until }) {
  const placeholder = `native-screenshot-placeholder-${randomUUID()}`
  let hostPage
  let hostOrigin
  let active

  /**
   * 配置隔离 Host 的虚拟图片模型；父测试负责先监听服务器及随后清理设置和文件。
   * @param {object} options 父测试已监听 127.0.0.1 的 `server` 和该隔离 Host 的 `page`。
   * @returns 配置保存后结算；应在首次截图回合前调用一次。
   */
  async function prepare({ server, page }) {
    assert.ok(hostPage === undefined, '截图模型已经配置')
    const address = server.address()
    assert.ok(address?.address === loopback && address.port > 0, '截图模型服务器必须监听 127.0.0.1')
    const origin = new URL(page.url())
    assert.ok(origin.protocol === 'http:' && origin.hostname === loopback && origin.port && origin.port !== String(address.port),
      '截图 RPC 必须使用父测试已验证的独立回环 Host')
    await rpc(page, 'settings.update', { ns: 'llm-pi-ai', patch: { providers: {
      [provider]: { api: 'openai-completions', baseURL: `http://${loopback}:${address.port}`,
        apiKeyEnv: credentialRef, models: [{ id: model, input: ['text', 'image'] }] },
    } } })
    await rpc(page, 'credentials.set', { ref: credentialRef, value: placeholder })
    await rpc(page, 'settings.update', { ns: 'agent-default-model', patch: { provider, model } })
    hostOrigin = origin.origin
    hostPage = page
  }

  /**
   * 处理父服务器分流的 `/chat/completions` POST；不记录请求正文或鉴权头。
   * @param {import('node:http').IncomingMessage} request 回环请求。
   * @param {import('node:http').ServerResponse} response 由本方法结束的响应。
   * @returns 响应已提交或请求已拒绝。
   */
  async function handleRequest(request, response) {
    if (request.method !== 'POST' || request.url !== '/chat/completions' || request.socket.remoteAddress !== loopback) {
      response.writeHead(404).end()
      return
    }
    const capture = active
    if (capture) capture.requests++
    if (request.headers.authorization !== `Bearer ${placeholder}`) {
      if (capture) capture.failure ??= '鉴权未通过'
      response.writeHead(401).end()
      return
    }
    try {
      const { messages, tools } = await readCompletionRequest(request)
      if (!capture || !messages.some(message => hasPrompt(message, capture.prompt))) {
        // 非测试回合（例如会话命名）不能触发工具。
        sendCompletion(response, { content: '截图测试' }, 'stop')
      } else if (!capture.called) {
        assert.ok(Array.isArray(tools) && tools.some(tool => tool?.function?.name === toolName),
          '真实 Host 请求未提供 browser_screenshot')
        capture.called = true
        sendCompletion(response, { tool_calls: [{ index: 0, id: capture.id, type: 'function',
          function: { name: toolName, arguments: JSON.stringify(capture.args) } }] }, 'tool_calls')
      } else {
        assert.ok(!capture.finished && messages.some(message => message?.role === 'tool' && message.tool_call_id === capture.id),
          '截图模型只接受一次包含对应工具结果的后续请求')
        capture.finished = true
        sendCompletion(response, { content: '截图完成。' }, 'stop')
      }
    } catch (error) {
      if (capture) capture.failure ??= error instanceof assert.AssertionError
        ? error.message : '请求未符合截图模型协议'
      if (!response.headersSent) response.writeHead(400)
      response.end()
    }
  }

  /**
   * 对已挂载的测试页执行真实截图；调用方负责检查 PNG 像素、尺寸和页面事件。
   * @param {object} options `sessionId` 属于当前隔离 Host；可指定 `selector` 和工作区内不存在的 `path`。
   * @returns 回合结算后返回实际落盘路径、持久图片引用及工具的 JSON 结果；断言失败时拒绝。
   */
  async function capture({ sessionId, selector, path }) {
    assert.ok(hostPage !== undefined, '请先准备隔离截图模型')
    assert.ok(new URL(hostPage.url()).origin === hostOrigin, '截图 RPC 页面已离开隔离 Host')
    assert.ok(active === undefined, '截图回合必须顺序执行')
    const id = `call_${randomUUID().replaceAll('-', '')}`
    const run = { id, prompt: `为截图测试采集当前页面。${id}`, args: {
      ...selector === undefined ? {} : { selector }, ...path === undefined ? {} : { path },
    }, called: false, finished: false, requests: 0 }
    active = run
    const history = () => rpc(hostPage, 'session.history', { sessionId, maxMessages: 30 })
    const seenTypes = new Set()
    let sawToolCall = false
    let stage = '选择截图模型'
    try {
      // 已有会话优先沿用上次请求的模型；改全局默认值不会覆盖该选择。
      const { selected } = await rpc(hostPage, 'session.selectModel', { sessionId, provider, model })
      assert.ok(selected?.provider === provider && selected.model === model, '目标会话必须选中本地截图模型')
      stage = '读取截图前历史'
      const previous = (await history()).events.at(-1)?.event.seq ?? -1
      stage = '提交截图提示'
      const prompted = await rpc(hostPage, 'session.prompt', { sessionId, mode: 'queue',
        content: [{ type: 'text', text: run.prompt }] })
      assert.equal(prompted.accepted, true, 'Host 必须接纳截图提示')

      let events, turn
      let approved = false
      stage = '等待真实截图回合结算'
      await until(async () => {
        events = (await history()).events.map(({ event }) => event).filter(event => event.seq > previous)
        for (const event of events) seenTypes.add(event.type)
        const call = events.find(event => event.type === 'tool/call'
          && event.data.name === toolName && event.data.callId === run.id)
        sawToolCall ||= call !== undefined
        if (run.failure) throw new Error(run.failure)
        turn = events.find(event => event.type === 'turn/end')
        const ask = events.find(event => event.type === 'approval/asked'
          && event.data.toolName === toolName && event.data.callId === run.id
          && typeof event.data.id === 'string' && event.data.id)
        if (!turn && !approved && call && ask && ask.seq > call.seq && !events.some(event =>
          event.type === 'approval/decided' && event.data.id === ask.data.id)) {
          stage = '确认本次截图审批'
          if (call.data.arguments !== JSON.stringify(run.args)) {
            run.failure = '审批未发送：截图调用参数不符'
            throw new Error(run.failure)
          }
          const receipt = await approveScreenshot(hostPage, { origin: hostOrigin, sessionId,
            approvalId: ask.data.id, callId: run.id, toolName })
          if (receipt !== 'accepted') {
            run.failure = receipt === 'missing-approval' ? '未收到本次截图的待审批帧' : 'Host 未接纳本次截图审批'
            throw new Error(run.failure)
          }
          approved = true
          stage = '等待真实截图回合结算'
        }
        return turn !== undefined
      }, '等待真实截图回合结算', 60_000)
      if (run.failure) throw new Error(run.failure)

      stage = '验证截图结果'
      const calls = events.filter(event => event.type === 'tool/call' && event.seq < turn.seq)
      assert.ok(calls.length === 1 && calls[0].data.name === toolName && calls[0].data.callId === run.id,
        '回合必须只调用本次真实截图工具')
      assert.ok(calls[0].data.arguments === JSON.stringify(run.args), '工具调用必须使用指定的截图参数')
      const block = events.filter(event => event.type === 'tool/result' && event.seq < turn.seq)
        .flatMap(event => event.data.message.content)
        .find(content => content.type === 'tool-result' && content.toolCallId === calls[0].data.callId)
      assert.ok(block, '历史缺少本次截图工具结果')
      const text = block.content.find(content => content.type === 'text')?.text
      assert.ok(block.isError === false, screenshotFailure(text))
      let result
      try { result = JSON.parse(text) }
      catch { throw new Error('截图工具结果不是有效的 JSON') }
      assert.ok(result?.ok !== false && typeof result?.path === 'string' && isAbsolute(result.path),
        '截图工具必须返回已保存的绝对路径')
      const attachment = block.content.find(content => content.type === 'image')?.attachment
      assert.equal(attachment?.mediaType, 'image/png', '历史必须保留截图的 PNG 附件引用')
      assert.ok(typeof attachment.attachmentId === 'string' && attachment.attachmentId.length > 0,
        '截图附件必须有持久标识')
      assert.ok([attachment.bytes, attachment.width, attachment.height].every(value => Number.isSafeInteger(value) && value > 0),
        '截图附件必须包含有效的字节数与尺寸')
      assert.equal(turn.data.reason.kind, 'completed', '本地图片模型必须正常结束截图回合')
      assert.ok(run.finished, '本地图片模型必须接收工具结果并结束')
      return { path: result.path, attachment, result }
    } catch (error) {
      const detail = run.failure ?? (stage === '验证截图结果' && error instanceof assert.AssertionError ? error.message : '未完成')
      throw new Error(`${stage}：${detail}；事件=${[...seenTypes].join(',') || '无'}；模型请求=${run.requests}；`
        + `看到截图调用=${sawToolCall ? '是' : '否'}`)
    } finally {
      active = undefined
    }
  }

  return { prepare, handleRequest, capture }
}
