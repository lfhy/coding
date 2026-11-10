/**
 * Agent 浏览器设置命名空间与字段约定。
 *
 * Host 负责注册同名命名空间并解释这些值的含义；客户端只经 `settingsScope`
 * 写用户层，因此这里只声明字段的可选形状，不从 Host 包导入任何实现。
 */

/** Host 注册的设置命名空间；插件卡以它为 key 由设置命名空间派发。 */
export const EGO_SETTINGS_NS = 'ego-browser'

/** 画面采集后端的选择值；auto 由 Host 选择可用后端。 */
export const CAPTURE_BACKENDS = ['auto', 'cdp', 'ffmpeg'] as const
export type CaptureBackend = (typeof CAPTURE_BACKENDS)[number]

/** 画面质量档位。 */
export const STREAM_PROFILES = ['low', 'balanced', 'high'] as const
export type StreamProfile = (typeof STREAM_PROFILES)[number]

/** 视频后端的 H.264 编码器选择；具体可用性取决于 Host 所在平台。 */
export const FFMPEG_ENCODERS = [
  'auto', 'software', 'h264_mf', 'h264_nvenc', 'h264_qsv', 'h264_amf',
  'h264_videotoolbox', 'h264_vaapi',
] as const
export type FfmpegEncoder = (typeof FFMPEG_ENCODERS)[number]

/** 本包设置卡编辑的字段；未列出的 Host 字段不在此卡出现。 */
export interface EgoBrowserSettings {
  /** 画面采集后端。 */
  captureBackend?: CaptureBackend
  /** 画面质量档位。 */
  streamProfile?: StreamProfile
  /** CDP 单帧画面帧率。 */
  cdpFps?: number
  /** CDP 单帧画面质量。 */
  cdpQuality?: number
  /** CDP 单帧画面最大宽度。 */
  cdpMaxWidth?: number
  /** 视频画面帧率。 */
  ffmpegFps?: number
  /** 视频画面最大宽度。 */
  ffmpegMaxWidth?: number
  /** 视频目标码率（kbps）。 */
  ffmpegBitrateKbps?: number
  /** 视频后端编码器。 */
  ffmpegEncoder?: FfmpegEncoder
  /** 自定义视频工具路径；留空时由 Host 自动检测。 */
  ffmpegPath?: string
  /** 托管下载使用的镜像地址。 */
  githubMirror?: string
  /** 浏览器可执行文件路径；留空时由 Host 自动检测。 */
  chromePath?: string
  /** 无窗口运行：浏览器只出现在面板里，不会抢走前台焦点。 */
  headless?: boolean
  /** 页面光标旁的标签文字；留空时使用运行时默认值。 */
  cursorName?: string
  /** 关闭实时画面中继：工具仍可用，但面板不再接收画面。 */
  disableFrameRelay?: boolean
  /** Host 仍接受该字段，但 Coding 组装固定保留浏览器，因此设置卡不提供此项。 */
  idleTimeoutMin?: number
  /** 复用常驻执行进程。 */
  residentExecutor?: boolean
  /** 每个会话使用独立标签空间。 */
  sessionScopedSpaces?: boolean
  /** 固定页面视口宽度；0 表示使用窗口尺寸。 */
  viewportWidth?: number
  /** 固定页面视口高度；0 表示使用窗口尺寸。 */
  viewportHeight?: number
  /** 固定视口的设备像素比；0 表示浏览器默认。 */
  deviceScaleFactor?: number
  /** 运行脚本路径，供 Host 以 Node 执行。 */
  egoBin?: string
}

/** 面板需要的采集设置投影。 */
export interface EgoBrowserCapture {
  /** 当前生效的采集后端；非法或缺失值按 auto 处理，与 Host 归一化一致。 */
  readonly backend: CaptureBackend
}

/**
 * 把设置节里的采集后端归入封闭集合。
 * @param settings - 设置节的值；未服务到该命名空间时为 undefined。
 * @returns 可用于切换画面形态的后端；其他值一律按 auto 处理。
 */
export function captureBackendOf(settings: EgoBrowserSettings | undefined): CaptureBackend {
  const value = settings?.captureBackend
  return value !== undefined && (CAPTURE_BACKENDS as readonly string[]).includes(value) ? value : 'auto'
}

/**
 * @param settings - 设置节的值。
 * @returns 面板画面形态投影；每次设置变更后重新计算。
 */
export function captureOf(settings: EgoBrowserSettings | undefined): EgoBrowserCapture {
  return { backend: captureBackendOf(settings) }
}
