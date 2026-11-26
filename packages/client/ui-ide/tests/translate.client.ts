/** 组件测试共用的本地化实现，只替换字符串与数字模板参数。 */
import { zh } from '../src/client/locales.ts'

export function translate(key: string, params?: Record<string, unknown>): string {
  const text = zh[key as keyof typeof zh]
  if (params === undefined) return text
  return text.replace(/\{(\w+)\}/gu, (_match, name: string) => {
    const value = params[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  })
}
