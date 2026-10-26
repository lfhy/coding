/**
 * `settings.theme` 命名空间字典：General 分区的外观行与主题外观页面共用。
 *
 * 中文键集是唯一事实源，英文表按它逐键对齐；带 `{name}` 的条目由翻译函数
 * 做占位符替换。
 */

/** 简体中文字典（键集事实源）。 */
export const zh = {
  'appearance.title': '外观',
  'appearance.light': '浅色',
  'appearance.dark': '深色',
  'appearance.system': '跟随系统',

  'page.title': '主题外观',
  'page.intro': '挑一套配色，再决定壁纸、强调色与材质。改动即时生效，随时可以还原。',
  'page.themes': '配色',
  'page.advanced': '高级外观',

  'filter.all': '全部',
  'filter.favorites': '收藏',
  'filter.imported': '导入',
  'search.label': '搜索主题',
  'search.placeholder': '搜索主题名称',
  'search.empty': '没有匹配的主题',
  'list.hint': '共 {count} 套配色',

  'scheme.light': '浅色',
  'scheme.dark': '深色',
  'scheme.auto': '跟随明暗',
  'card.current': '使用中',
  'action.favorite': '收藏',
  'action.unfavorite': '取消收藏',
  'action.random': '随机换一个',
  'action.reset': '还原默认',

  'wallpaper.title': '壁纸',
  'wallpaper.intro': '默认使用主题自带的弥散光，也可以换成渐变或自己的图片。',
  'wallpaper.mode.theme': '跟随主题',
  'wallpaper.mode.off': '关闭',
  'wallpaper.mode.gradient': '渐变',
  'wallpaper.mode.image': '图片',
  'wallpaper.gradient': '渐变样式',
  'wallpaper.opacity': '可见度',
  'wallpaper.blur': '模糊',
  'wallpaper.fit': '填充方式',
  'wallpaper.fit.cover': '裁剪填满',
  'wallpaper.fit.contain': '完整显示',
  'wallpaper.fit.tile': '平铺',
  'wallpaper.url': '图片链接',
  'wallpaper.urlPlaceholder': '粘贴图片地址，或选择本地图片',
  'wallpaper.upload': '选择本地图片',
  'wallpaper.tooLarge': '这张图片处理后仍然太大，换一张更小的试试。',
  'wallpaper.unreadable': '读不出这张图片，换一张格式常见的再试。',

  'accent.title': '强调色',
  'accent.intro': '覆盖按钮、选中态与焦点的品牌色，不改动主题本身。',
  'accent.follow': '跟随主题',
  'accent.custom': '自定义颜色',

  'glass.title': '玻璃与不透明度',
  'glass.material': '材质',
  'glass.material.standard': '标准',
  'glass.material.frosted': '磨砂',
  'glass.panelOpacity': '面板不透明度',
  'glass.hint': '降低不透明度会让下拉菜单、弹层与卡片透出背后的内容。',

  'pack.title': '主题包',
  'pack.intro': '把当前配色与外观设置导出成文件分享，或导入别人做的主题包。',
  'pack.export': '导出当前主题',
  'pack.import': '导入主题包',
  'pack.share': '复制分享链接',
  'pack.remove': '移除',
  'pack.empty': '还没有导入过主题包。',
  'pack.imported': '已导入',

  'toast.imported': '已导入「{name}」',
  'toast.exported': '已导出「{name}」',
  'toast.removed': '已移除「{name}」',
  'toast.shared': '分享链接已复制',
  'toast.shareFailed': '当前页面没有可复制的地址',
  'toast.importFailed': '无法导入：{reason}',
} satisfies Record<string, string>

/** `settings.theme` 的键类型。 */
export type ThemeKey = keyof typeof zh

/** 英文字典，按中文键集校验完整性。 */
export const en = {
  'appearance.title': 'Appearance',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.system': 'System',

  'page.title': 'Theme',
  'page.intro': 'Pick a palette, then tune the wallpaper, accent, and material. Changes apply immediately and can be reverted at any time.',
  'page.themes': 'Palettes',
  'page.advanced': 'Advanced appearance',

  'filter.all': 'All',
  'filter.favorites': 'Favorites',
  'filter.imported': 'Imported',
  'search.label': 'Search themes',
  'search.placeholder': 'Search theme names',
  'search.empty': 'No matching theme',
  'list.hint': '{count} palettes',

  'scheme.light': 'Light',
  'scheme.dark': 'Dark',
  'scheme.auto': 'Follows appearance',
  'card.current': 'In use',
  'action.favorite': 'Favorite',
  'action.unfavorite': 'Remove from favorites',
  'action.random': 'Surprise me',
  'action.reset': 'Reset to default',

  'wallpaper.title': 'Wallpaper',
  'wallpaper.intro': 'Themes ship with their own glow; you can switch to a gradient or your own image.',
  'wallpaper.mode.theme': 'Theme',
  'wallpaper.mode.off': 'Off',
  'wallpaper.mode.gradient': 'Gradient',
  'wallpaper.mode.image': 'Image',
  'wallpaper.gradient': 'Gradient',
  'wallpaper.opacity': 'Visibility',
  'wallpaper.blur': 'Blur',
  'wallpaper.fit': 'Fit',
  'wallpaper.fit.cover': 'Fill',
  'wallpaper.fit.contain': 'Fit',
  'wallpaper.fit.tile': 'Tile',
  'wallpaper.url': 'Image address',
  'wallpaper.urlPlaceholder': 'Paste an image address, or pick a local image',
  'wallpaper.upload': 'Choose a local image',
  'wallpaper.tooLarge': 'This image is still too large after processing — try a smaller one.',
  'wallpaper.unreadable': 'That image could not be read — try a common format.',

  'accent.title': 'Accent',
  'accent.intro': 'Overrides the brand color on buttons, selections, and focus. The theme itself stays untouched.',
  'accent.follow': 'Use theme color',
  'accent.custom': 'Custom color',

  'glass.title': 'Glass and opacity',
  'glass.material': 'Material',
  'glass.material.standard': 'Standard',
  'glass.material.frosted': 'Frosted',
  'glass.panelOpacity': 'Panel opacity',
  'glass.hint': 'Lower opacity lets menus, overlays, and cards show what is behind them.',

  'pack.title': 'Theme packs',
  'pack.intro': 'Export the current palette and appearance as a file to share, or import a pack from someone else.',
  'pack.export': 'Export current theme',
  'pack.import': 'Import theme pack',
  'pack.share': 'Copy share link',
  'pack.remove': 'Remove',
  'pack.empty': 'No theme packs imported yet.',
  'pack.imported': 'Imported',

  'toast.imported': 'Imported “{name}”',
  'toast.exported': 'Exported “{name}”',
  'toast.removed': 'Removed “{name}”',
  'toast.shared': 'Share link copied',
  'toast.shareFailed': 'This page has no address to share',
  'toast.importFailed': 'Could not import: {reason}',
} satisfies Record<ThemeKey, string>
