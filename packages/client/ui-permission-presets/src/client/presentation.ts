/** 需要 GUI 显式风险确认的预设机器值。 */
export const FULL_ACCESS_PRESET = 'danger-full-access'

type PermissionPresetLabelKey = 'preset.readOnly' | 'preset.workspaceWrite' | 'preset.fullAccess' | 'preset.custom'
type PermissionPresetTranslate = (key: PermissionPresetLabelKey) => string

/** 内置预设的 locale 键；string 索引让未知 host 值保留显式回退路径。 */
const BUILTIN_PRESET_LABELS: Readonly<Record<string, {
  fallback: string
  key: PermissionPresetLabelKey
}>> = {
  'read-only': { fallback: 'Read Only', key: 'preset.readOnly' },
  'workspace-write': { fallback: 'Workspace Write', key: 'preset.workspaceWrite' },
  [FULL_ACCESS_PRESET]: { fallback: 'Full access', key: 'preset.fullAccess' },
  'custom': { fallback: 'Custom', key: 'preset.custom' },
}

/**
 * 把常规 kebab-case 预设名转换成用户可读的 Title Case。
 * @param name - host 提供的预设标签或键。
 * @returns 转换后的常规键；非 kebab 标签原样返回。
 */
export function displayPresetName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name
  return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/**
 * 把权限预设转换成展示标签。内置机器值使用 locale；host 显式提供的非标准名称原样
 * 保留；没有翻译函数的非 React 数据层继续得到稳定英文标签。
 * @param value - 预设机器值。
 * @param name - host 提供的预设名称。
 * @param t - 当前界面的可选翻译函数。
 * @returns 本地化的内置标签或 host 名称。
 */
export function displayPermissionPreset(value: string, name: string, t?: PermissionPresetTranslate): string {
  const builtin = BUILTIN_PRESET_LABELS[value]
  if (builtin !== undefined && (name === value || name === builtin.fallback)) {
    return t?.(builtin.key) ?? builtin.fallback
  }
  return displayPresetName(name)
}
