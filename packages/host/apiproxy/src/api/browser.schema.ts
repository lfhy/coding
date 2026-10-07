/** 人工浏览器 RPC 的严格输入及会话状态响应。 */
import { z } from 'zod'
import type { BrowserHumanTarget, BrowserObservation, BrowserTabId, BrowserTabSummary } from '@deepseek-ai/dsh-browser/types'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import { sessionIdSchema } from './sessions.schema.ts'

const tabIdSchema = z.uuid() as unknown as z.ZodType<BrowserTabId>

/** 与浏览器提供方共享的画布面积上界；防止宽高各自合法时仍分配过大的位图。 */
const MAX_VIEWPORT_PIXELS = 1_800_000

const browserViewportSchema = z.strictObject({
  width: z.number().int().min(200).max(1920),
  height: z.number().int().min(240).max(1400),
}).refine(({ width, height }) => width * height <= MAX_VIEWPORT_PIXELS, {
  message: 'browser viewport area exceeds the supported limit',
})

const safeUrlSchema = z.string().min(1).max(2048).refine((value) => {
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.hostname !== '' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}, { message: 'browser URL must be an absolute HTTP(S) URL without credentials' })

const humanTargetSchema = z.strictObject({
  browserGeneration: z.string().min(1).max(128), stateRevision: z.number().int().nonnegative(),
  tabId: tabIdSchema, generation: z.string().min(1).max(128), revision: z.number().int().positive(),
  viewport: browserViewportSchema,
}) satisfies z.ZodType<Wire<BrowserHumanTarget>>

const coordinateSchema = z.number().int().nonnegative().max(1920)

/** 所有分支与顶层对象均拒绝多余字段，避免工具参数混入人工入口。 */
export const browserControlRequestSchema = z.strictObject({
  sessionId: sessionIdSchema,
  command: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('ensure-tab') }),
    z.strictObject({ kind: z.literal('new-tab') }),
    z.strictObject({ kind: z.literal('open-url'), url: safeUrlSchema }),
    z.strictObject({ kind: z.literal('select-tab'), tabId: tabIdSchema }),
    z.strictObject({ kind: z.literal('close-tab'), tabId: tabIdSchema }),
    z.strictObject({ kind: z.literal('navigate'), url: safeUrlSchema }),
    z.strictObject({
      kind: z.literal('set-viewport'),
      width: z.number().int().min(200).max(1920),
      height: z.number().int().min(240).max(1400),
    }).refine(({ width, height }) => width * height <= MAX_VIEWPORT_PIXELS, {
      message: 'browser viewport area exceeds the supported limit',
    }),
    z.strictObject({ kind: z.literal('back') }),
    z.strictObject({ kind: z.literal('forward') }),
    z.strictObject({ kind: z.literal('reload') }),
    z.strictObject({ kind: z.literal('click'), target: humanTargetSchema, x: coordinateSchema, y: coordinateSchema }),
    z.strictObject({ kind: z.literal('scroll'), target: humanTargetSchema, x: coordinateSchema, y: coordinateSchema,
      direction: z.enum(['up', 'down']), pixels: z.number().int().min(1).max(2000) }),
    z.strictObject({ kind: z.literal('type'), target: humanTargetSchema, x: coordinateSchema, y: coordinateSchema,
      text: z.string().max(2000) }),
  ]),
}) satisfies z.ZodType<Wire<RequestPayload<'browser.control'>>>

const browserTabSummarySchema = z.strictObject({
  id: tabIdSchema,
  generation: z.string(),
  url: z.string(),
  title: z.string(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  loading: z.boolean().optional(),
}) satisfies z.ZodType<Wire<BrowserTabSummary>>

const browserObservationSchema = z.strictObject({
  tabId: tabIdSchema,
  generation: z.string(),
  revision: z.number().int().nonnegative(),
  url: z.string(),
  title: z.string(),
  snapshot: z.string(),
  viewport: browserViewportSchema,
  cursor: z.strictObject({
    x: z.number(), y: z.number(), kind: z.enum(['click', 'fill', 'scroll']), at: z.number(),
  }).nullable(),
}) satisfies z.ZodType<Wire<BrowserObservation>>

/** null 只表示最后一个标签页关闭，不表示未知会话。 */
export const browserControlValueSchema = z.strictObject({
  operationActive: z.boolean(),
  browserGeneration: z.string(),
  stateRevision: z.number().int().nonnegative(),
  viewport: browserViewportSchema,
  tabs: z.array(browserTabSummarySchema),
  activeTabId: tabIdSchema.nullable(),
  observation: browserObservationSchema.nullable(),
  hasFrame: z.boolean(),
}).nullable() satisfies z.ZodType<Wire<ResponseValue<'browser.control'>>>
