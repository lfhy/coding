// Web 复制控件共用剪贴板写入；反馈状态由各控件持有。

/**
 * 将原样文本写入剪贴板。异步 API 不可用或被宿主拒绝时尝试选区复制。
 * @param text - 要写入剪贴板的原样文本。
 * @returns 仅在宿主确认任一路径写入成功时返回 true。
 */
export async function writeClipboard(text: string): Promise<boolean> {
  /* oxlint-disable-next-line typescript/no-unnecessary-condition */
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // 某些宿主提供异步 API 却拒绝写入；继续尝试受用户手势允许的选区复制。
    }
  }
  /* oxlint-disable typescript/no-deprecated */
  const exec = typeof document.execCommand === 'function'
    ? document.execCommand.bind(document)
    : undefined
  if (exec === undefined) return false
  const el = document.createElement('textarea')
  el.value = text
  el.setAttribute('readonly', '')
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  document.body.appendChild(el)
  el.select()
  try {
    return exec('copy')
  } catch {
    return false
  } finally {
    el.remove()
  }
  /* oxlint-enable typescript/no-deprecated */
}
