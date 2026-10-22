/**
 * 代理池自己的出站控制：池本身走直连、本地代理池还是自定义代理。
 *
 * 这是**池的出站**，与渠道级出站选择分开：模型渠道在各自设置里选择
 * 直连／内置代理池／自定义代理；选择「内置代理池」的渠道实际使用这里的规则——
 * `direct` 时回落直连，`pool` 时经本地入站，`custom` 时经这里配置的代理地址。
 *
 * 后台循环只在 `pool` 规则下运行：直连与自定义代理都不经过本地入站，池没有
 * 维护节点的必要。池停用时手动测试节点与手动刷新订阅仍然可用。
 *
 * @module coding-proxy-pool/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from 'coding-settings'

/** 池出站控制的设置命名空间；由代理池拥有，配置面只改写这一个分节。 */
export const PROXY_POOL_SETTINGS_NAMESPACE = settingsNamespace('proxy-pool')

/** 池出站规则：直连、经本地代理池或经自定义代理地址。 */
export type ProxyPoolMode = 'direct' | 'pool' | 'custom'

/** `proxy-pool` 设置分节的形状。 */
export interface ProxyPoolSettings {
  /** 池出站规则；缺省 `direct`，避免开箱即用地持续拉取公开订阅。 */
  mode: ProxyPoolMode
  /** `custom` 模式的 http(s) 代理地址；其余模式省略。 */
  customUrl?: string
}

/** 分节 schema：自定义模式必须有 http(s) 地址，在注册处拒绝坏值。 */
const PROXY_POOL_SCHEMA: z<ProxyPoolSettings> = z.object({
  mode: z.union([z.const('direct'), z.const('pool'), z.const('custom')]).default('direct'),
  customUrl: z.string(),
})

/**
 * 校验并归一化池出站设置。
 * @param value - 设置分节解析出的原始值。
 * @returns 生效的池出站规则；自定义模式缺少合法地址时抛出。
 */
export function resolvePoolOutbound(value: ProxyPoolSettings): ProxyPoolSettings {
  if (value.mode !== 'custom') return { mode: value.mode }
  if (value.customUrl === undefined || !/^https?:\/\//.test(value.customUrl)) {
    throw new Error('proxy-pool: custom outbound requires an http(s) proxy URL')
  }
  return { mode: 'custom', customUrl: value.customUrl }
}

/**
 * 安装池出站控制的设置分节，把生效规则的每次变化交给调用方。
 *
 * 没有设置提供方时回调不会被调用，池保持构造时的缺省规则（直连）；设置
 * 提供方晚到或卸载时，`installSettingsSection` 会以组合入口值重新通知。
 * @param ctx - 池所在上下文。
 * @param apply - 接收生效规则的同步回调；实现负责停启后台循环。
 */
export function installPoolOutbound(
  ctx: Context,
  apply: (outbound: ProxyPoolSettings) => void,
): void {
  let current: () => ProxyPoolSettings = () => ({ mode: 'direct' })
  installSettingsSection(ctx, PROXY_POOL_SETTINGS_NAMESPACE, PROXY_POOL_SCHEMA, { mode: 'direct' }, {
    setSource: (source) => { current = source },
    onChange: () => { apply(resolvePoolOutbound(current())) },
    validate: (value) => { resolvePoolOutbound(value) },
  })
}
