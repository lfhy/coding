/** 设置外壳、通用导航和元数据维护操作的词典；功能行持有自身文案。 */

/** 简体中文词典，也是键集合的唯一来源。 */
export const zh = {
  'trigger': '设置',
  'title': '设置',
  'close': '返回',
  'openDocument': '打开配置文件',
  'openDocument.error': '无法打开配置文件',
  'general.nav': '通用设置',
  'metadata.title': '会话元数据',
  'metadata.description': '从会话日志重建列表元数据与投影缓存，跳过已加载的会话。不修改原始日志，也不能修复日志内容损坏。',
  'metadata.repair': '修复会话元数据',
  'metadata.loading': '正在重建会话元数据…',
  'metadata.result': '扫描完成：共 {total} 个，已重建 {rebuilt} 个，跳过已加载会话 {skipped} 个，失败 {failed} 个。',
  'metadata.failures': '以下会话未能重建，原始日志保持不变：',
  'metadata.error': '无法重建会话元数据：{reason}',
} satisfies Record<string, string>

/** settings 命名空间的键联合。 */
export type SettingsKey = keyof typeof zh

/** 英文词典，按中文键集合检查完整性。 */
export const en = {
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Back',
  'openDocument': 'Open configuration file',
  'openDocument.error': 'Could not open configuration file',
  'general.nav': 'General',
  'metadata.title': 'Session metadata',
  'metadata.description': 'Rebuild list metadata and projection caches from session logs, skipping loaded sessions. Original logs stay unchanged; corrupted log contents cannot be repaired.',
  'metadata.repair': 'Repair session metadata',
  'metadata.loading': 'Rebuilding session metadata…',
  'metadata.result': 'Scan complete: {total} total, {rebuilt} rebuilt, {skipped} loaded sessions skipped, {failed} failed.',
  'metadata.failures': 'These sessions could not be rebuilt; original logs are unchanged:',
  'metadata.error': 'Could not rebuild session metadata: {reason}',
} satisfies Record<SettingsKey, string>
