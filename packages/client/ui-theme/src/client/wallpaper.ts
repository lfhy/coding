/**
 * 壁纸的渐变预设与强调色色块。
 *
 * 渐变是纯 CSS `background` 值，不引用任何主题令牌——它们要在任何主题下都
 * 读得出来，因此自带中性底色；强调色色块覆盖常见的品牌色相，取色后仍由
 * 外观层按明暗方案派生 hover、弱底与可读文字色。
 */

/** 一个渐变壁纸预设。 */
export interface WallpaperGradient {
  /** 预设 id（设置里存这个值）。 */
  id: string
  /** 中文名。 */
  name: string
  /** 英文名。 */
  englishName: string
  /** CSS `background` 值。 */
  background: string
}

/** 六个渐变壁纸预设。 */
export const WALLPAPER_GRADIENTS: readonly WallpaperGradient[] = [
  {
    id: 'mist',
    name: '晨雾',
    englishName: 'Mist',
    background: 'radial-gradient(1200px 720px at 78% -12%, rgba(120, 141, 255, 0.35), transparent 64%),'
      + ' radial-gradient(900px 600px at 4% 108%, rgba(126, 214, 206, 0.28), transparent 58%),'
      + ' linear-gradient(160deg, #14161b 0%, #0e1014 60%, #12151a 100%)',
  },
  {
    id: 'dusk',
    name: '暮色',
    englishName: 'Dusk',
    background: 'radial-gradient(1000px 620px at 82% -8%, rgba(255, 138, 92, 0.34), transparent 62%),'
      + ' radial-gradient(820px 560px at 0% 100%, rgba(180, 92, 255, 0.26), transparent 60%),'
      + ' linear-gradient(155deg, #171017 0%, #101014 58%, #141019 100%)',
  },
  {
    id: 'forest',
    name: '林间',
    englishName: 'Forest',
    background: 'radial-gradient(1080px 700px at 70% -10%, rgba(88, 196, 148, 0.32), transparent 62%),'
      + ' radial-gradient(760px 520px at 0% 96%, rgba(58, 122, 96, 0.34), transparent 58%),'
      + ' linear-gradient(160deg, #101613 0%, #0c100e 60%, #111612 100%)',
  },
  {
    id: 'paper',
    name: '宣纸',
    englishName: 'Paper',
    background: 'radial-gradient(980px 640px at 78% -12%, rgba(255, 206, 101, 0.28), transparent 62%),'
      + ' radial-gradient(820px 560px at 2% 104%, rgba(240, 180, 196, 0.3), transparent 58%),'
      + ' linear-gradient(160deg, #fdfaf4 0%, #f6f1e7 58%, #fbf7ef 100%)',
  },
  {
    id: 'ink',
    name: '砚墨',
    englishName: 'Ink',
    background: 'radial-gradient(1100px 700px at 74% -14%, rgba(126, 160, 214, 0.24), transparent 64%),'
      + ' radial-gradient(900px 620px at 0% 108%, rgba(94, 106, 210, 0.22), transparent 58%),'
      + ' linear-gradient(165deg, #0d0f13 0%, #090a0d 60%, #0c0e12 100%)',
  },
  {
    id: 'sunset',
    name: '落日',
    englishName: 'Sunset',
    background: 'radial-gradient(1100px 680px at 80% -10%, rgba(255, 122, 122, 0.32), transparent 62%),'
      + ' radial-gradient(860px 600px at 0% 100%, rgba(255, 190, 92, 0.3), transparent 60%),'
      + ' linear-gradient(160deg, #1a1113 0%, #120d11 58%, #171013 100%)',
  },
]

/** 按 id 查找渐变预设。 */
export function findWallpaperGradient(id: string): WallpaperGradient | undefined {
  return WALLPAPER_GRADIENTS.find(gradient => gradient.id === id)
}

/** 一个强调色色块。 */
export interface AccentSwatch {
  /** 色值。 */
  color: string
  /** 中文名。 */
  name: string
}

/** 十二个常用强调色。 */
export const ACCENT_SWATCHES: readonly AccentSwatch[] = [
  { color: '#2f6fed', name: '深蓝' },
  { color: '#4c8dff', name: '天蓝' },
  { color: '#1fb6a6', name: '青绿' },
  { color: '#38b768', name: '草绿' },
  { color: '#b6a04a', name: '橄榄' },
  { color: '#f0a13c', name: '琥珀' },
  { color: '#ef6b52', name: '朱红' },
  { color: '#e0559a', name: '玫红' },
  { color: '#b25cf0', name: '紫罗兰' },
  { color: '#7f6cf5', name: '靛紫' },
  { color: '#8a94a6', name: '石墨' },
  { color: '#1b1f27', name: '墨黑' },
]

/** 本地图片处理后的最长边：再大的图对壁纸没有意义，只会撑大设置文档。 */
const MAX_IMAGE_DIMENSION = 2400

/** 压缩质量候选：依次尝试，取第一个体积达标的。 */
const QUALITY_STEPS = [0.82, 0.68, 0.52, 0.4] as const

/** 读取本地壁纸图片的结果。 */
export type WallpaperImageResult =
  | { ok: true; dataUrl: string }
  | { ok: false; reason: 'unreadable' | 'too-large' }

/**
 * 读取并压缩本地图片为 data URL。
 *
 * 壁纸随设置文档持久化，所以体积有硬上限：先按最长边缩放到 2400px，再按
 * 逐档降低的 JPEG 质量重试，全部超标就报 `too-large`，由页面提示换一张。
 * 失败不抛异常——调用方要能把原因展示成一句人话。
 * @param file - 用户选择的文件。
 * @param maxLength - data URL 字符数上限。
 * @returns 压缩后的 data URL 或失败原因。
 */
export async function readWallpaperImage(file: File, maxLength: number): Promise<WallpaperImageResult> {
  if (!file.type.startsWith('image/')) return { ok: false, reason: 'unreadable' }
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight))
    const width = Math.max(1, Math.round(image.naturalWidth * scale))
    const height = Math.max(1, Math.round(image.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (context === null) return { ok: false, reason: 'unreadable' }
    context.drawImage(image, 0, 0, width, height)
    for (const quality of QUALITY_STEPS) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality)
      if (dataUrl.length <= maxLength) return { ok: true, dataUrl }
    }
    return { ok: false, reason: 'too-large' }
  } catch {
    return { ok: false, reason: 'unreadable' }
  } finally {
    URL.revokeObjectURL(url)
  }
}
