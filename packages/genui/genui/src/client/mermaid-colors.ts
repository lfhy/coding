/** Resolve host CSS colors before passing them to Mermaid's limited parser. */
export function readMermaidThemeColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  // 运行时 body 可能尚未解析（脚本先于 <body> 执行）而 DOM lib 标注为非空：
  // 按可空断言收窄后保留显式缺失检查，缺失走 fallback。
  const body = document.body as HTMLElement | null
  if (body === null) return fallback
  const value = getComputedStyle(body).getPropertyValue(name).trim()
  if (value === '') return fallback

  // Computed custom properties still contain calc(), unlike computed color.
  // A real color property also resolves currentColor and inherited variables.
  const probe = document.createElement('span')
  probe.style.setProperty('color', value, 'important')
  if (probe.style.color === '') return fallback
  probe.style.setProperty('display', 'none', 'important')
  body.appendChild(probe)
  let color: string
  try {
    color = getComputedStyle(probe).color
  } finally {
    probe.remove()
  }
  if (/^rgba?\([\d.,\s]+\)$/i.test(color)) return color

  // Modern colors such as oklch() and color-mix() may remain in those formats
  // after style resolution. Canvas converts them to the sRGB Mermaid accepts.
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d')
  if (context === null) return fallback
  context.fillStyle = '#010203'
  const initialFillStyle = context.fillStyle
  context.fillStyle = color
  if (context.fillStyle === initialFillStyle) return fallback
  try {
    context.fillRect(0, 0, 1, 1)
    // getImageData 的 1x1 像素必有四个分量；默认值仅为类型收窄兜底，运行时不触达。
    const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data
    return `rgba(${r}, ${g}, ${b}, ${a / 255})`
  } catch {
    return fallback
  }
}
