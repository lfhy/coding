/**
 * proxyPool domain zod schemas (names derived from map keys:
 * proxyPoolDescribeValueSchema / proxyPoolImportLinksRequestSchema / …).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { ProxyGroupView, ProxyHealthView, ProxyNodeView } from './proxy-pool.ts'
import type { OutboundModeView } from './settings.ts'

/** OutboundModeView of proxyPool.describe / proxyPool.setOutbound. */
export const outboundModeViewSchema = z.object({
  mode: z.enum(['direct', 'pool', 'custom']),
  customUrl: z.string().optional(),
}) satisfies z.ZodType<Wire<OutboundModeView>>

/** ProxyNodeView row of proxyPool responses. */
export const proxyNodeViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  protocol: z.enum(['http', 'socks5', 'vless', 'vmess', 'hysteria2']),
  address: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  hasUsername: z.boolean(),
  hasSecret: z.boolean(),
}) satisfies z.ZodType<Wire<ProxyNodeView>>

/** ProxyHealthView row of proxyPool responses. */
export const proxyHealthViewSchema = z.object({
  nodeId: z.string().min(1),
  alive: z.boolean(),
  latencyMs: z.number().int().nonnegative().optional(),
  failure: z.string().optional(),
  checkedAt: z.number().int().nonnegative(),
}) satisfies z.ZodType<Wire<ProxyHealthView>>

/** ProxyGroupView row of proxyPool.describe. */
export const proxyGroupViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  strategy: z.enum(['fallback', 'url-test']),
  members: z.array(z.string().min(1)),
}) satisfies z.ZodType<Wire<ProxyGroupView>>

/** proxyPool.describe request payload. */
export const proxyPoolDescribeRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'proxyPool.describe'>>>

/** proxyPool.describe response value. */
export const proxyPoolDescribeValueSchema = z.object({
  nodes: z.array(proxyNodeViewSchema),
  groups: z.array(proxyGroupViewSchema),
  health: z.array(proxyHealthViewSchema),
  outbound: outboundModeViewSchema,
  frontendURL: z.string(),
}) satisfies z.ZodType<Wire<ResponseValue<'proxyPool.describe'>>>

/** proxyPool.importLinks request payload. */
export const proxyPoolImportLinksRequestSchema = z.object({
  text: z.string(),
}) satisfies z.ZodType<Wire<RequestPayload<'proxyPool.importLinks'>>>

/** proxyPool.importLinks response value. */
export const proxyPoolImportLinksValueSchema = z.object({
  imported: z.array(proxyNodeViewSchema),
  skipped: z.number().int().nonnegative(),
}) satisfies z.ZodType<Wire<ResponseValue<'proxyPool.importLinks'>>>

/** proxyPool.removeNode request payload. */
export const proxyPoolRemoveNodeRequestSchema = z.object({
  id: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'proxyPool.removeNode'>>>

/** proxyPool.removeNode response value. */
export const proxyPoolRemoveNodeValueSchema = z.object({
  removed: z.boolean(),
}) satisfies z.ZodType<Wire<ResponseValue<'proxyPool.removeNode'>>>

/** proxyPool.testNode request payload. */
export const proxyPoolTestNodeRequestSchema = z.object({
  id: z.string().min(1),
}) satisfies z.ZodType<Wire<RequestPayload<'proxyPool.testNode'>>>

/** proxyPool.testNode response value. */
export const proxyPoolTestNodeValueSchema = proxyHealthViewSchema.optional()
  .describe('one probe record; absent when the node no longer exists') satisfies z.ZodType<Wire<ResponseValue<'proxyPool.testNode'>>>

/** proxyPool.setOutbound request payload. */
export const proxyPoolSetOutboundRequestSchema = z.object({
  mode: outboundModeViewSchema,
}) satisfies z.ZodType<Wire<RequestPayload<'proxyPool.setOutbound'>>>

/** proxyPool.setOutbound response value. */
export const proxyPoolSetOutboundValueSchema = z.object({
  outbound: outboundModeViewSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'proxyPool.setOutbound'>>>
