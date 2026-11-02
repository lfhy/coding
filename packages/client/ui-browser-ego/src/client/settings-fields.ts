/**
 * Agent 浏览器设置卡的字段目录：分组、控件类型、标签与合法区间。
 *
 * 目录同时供表单模型（把控件状态映射成写入）和卡片组件（渲染分组）读取，
 * 让新增字段只需要在目录与词典各补一处。
 */

import { booleanField, choiceField, numberField, textField, type CardFieldSpec, type NumberBounds } from './card-form.ts'
import type { BrowserEgoKey } from './locales.ts'
import { FFMPEG_ENCODERS } from './settings.ts'

/** 本卡编辑的全部字段名，构成封闭联合供投影与测试引用。 */
export const CARD_FIELD_KEYS = [
  'captureBackend', 'streamProfile',
  'cdpFps', 'cdpQuality', 'cdpMaxWidth',
  'ffmpegFps', 'ffmpegMaxWidth', 'ffmpegBitrateKbps', 'ffmpegEncoder',
  'headless', 'cursorName',
  'disableFrameRelay', 'residentExecutor', 'sessionScopedSpaces', 'idleTimeoutMin',
  'viewportWidth', 'viewportHeight', 'deviceScaleFactor',
  'chromePath', 'ffmpegPath', 'egoBin', 'githubMirror',
] as const

/** 本卡编辑的字段名。 */
export type CardFieldKey = (typeof CARD_FIELD_KEYS)[number]

/** 卡片支持的控件形态。 */
export type FieldKind = 'text' | 'number' | 'select' | 'toggle'

/** 枚举控件的一个选项；取值写回 Host，标签只来自词典。 */
export interface FieldOption {
  /** Host 接受的取值。 */
  value: string
  /** 选项文案的词典键。 */
  label: BrowserEgoKey
}

/** 一个设置字段的渲染与写入约定。 */
export interface FieldDescriptor {
  /** 设置节里的字段名。 */
  field: CardFieldKey
  /** 控件形态。 */
  kind: FieldKind
  /** 字段标签的词典键。 */
  label: BrowserEgoKey
  /** 字段说明的词典键。 */
  hint: BrowserEgoKey
  /** 数字字段的合法区间。 */
  bounds?: NumberBounds
  /** 枚举字段的选项。 */
  options?: readonly FieldOption[]
}

/** 一组字段的标题。 */
export interface FieldGroup {
  /** 分组标题的词典键。 */
  title: BrowserEgoKey
  /** 分组内的字段。 */
  fields: readonly FieldDescriptor[]
}

const BACKEND_OPTIONS: readonly FieldOption[] = [
  { value: 'auto', label: 'optionAuto' },
  { value: 'cdp', label: 'optionCdp' },
  { value: 'ffmpeg', label: 'optionFfmpeg' },
]

const PROFILE_OPTIONS: readonly FieldOption[] = [
  { value: 'low', label: 'profileLow' },
  { value: 'balanced', label: 'profileBalanced' },
  { value: 'high', label: 'profileHigh' },
]

const ENCODER_LABELS: Readonly<Record<(typeof FFMPEG_ENCODERS)[number], BrowserEgoKey>> = {
  auto: 'encoderAuto',
  software: 'encoderSoftware',
  h264_mf: 'encoderMediaFoundation',
  h264_nvenc: 'encoderNvidia',
  h264_qsv: 'encoderIntel',
  h264_amf: 'encoderAmd',
  h264_videotoolbox: 'encoderApple',
  h264_vaapi: 'encoderLinux',
}

const ENCODER_OPTIONS: readonly FieldOption[] = FFMPEG_ENCODERS.map(value => ({
  value, label: ENCODER_LABELS[value],
}))

/** 卡片呈现的分组与字段顺序。 */
export const FIELD_GROUPS: readonly FieldGroup[] = [
  {
    title: 'groupCapture',
    fields: [
      { field: 'captureBackend', kind: 'select', label: 'captureBackend', hint: 'captureBackendHint', options: BACKEND_OPTIONS },
      { field: 'streamProfile', kind: 'select', label: 'streamProfile', hint: 'streamProfileHint', options: PROFILE_OPTIONS },
    ],
  },
  {
    title: 'groupCdp',
    fields: [
      { field: 'cdpFps', kind: 'number', label: 'cdpFps', hint: 'cdpFpsHint', bounds: { min: 5, max: 30, integer: true } },
      { field: 'cdpQuality', kind: 'number', label: 'cdpQuality', hint: 'cdpQualityHint', bounds: { min: 1, max: 100, integer: true } },
      { field: 'cdpMaxWidth', kind: 'number', label: 'cdpMaxWidth', hint: 'cdpMaxWidthHint', bounds: { min: 320, max: 1920, integer: true } },
    ],
  },
  {
    title: 'groupVideo',
    fields: [
      { field: 'ffmpegFps', kind: 'number', label: 'ffmpegFps', hint: 'ffmpegFpsHint', bounds: { min: 5, max: 30, integer: true } },
      { field: 'ffmpegMaxWidth', kind: 'number', label: 'ffmpegMaxWidth', hint: 'ffmpegMaxWidthHint', bounds: { min: 320, max: 1920, integer: true } },
      { field: 'ffmpegBitrateKbps', kind: 'number', label: 'ffmpegBitrateKbps', hint: 'ffmpegBitrateKbpsHint', bounds: { min: 500, max: 20000, integer: true } },
      { field: 'ffmpegEncoder', kind: 'select', label: 'ffmpegEncoder', hint: 'ffmpegEncoderHint', options: ENCODER_OPTIONS },
    ],
  },
  {
    title: 'groupRuntime',
    fields: [
      { field: 'headless', kind: 'toggle', label: 'headless', hint: 'headlessHint' },
      { field: 'cursorName', kind: 'text', label: 'cursorName', hint: 'cursorNameHint' },
      { field: 'disableFrameRelay', kind: 'toggle', label: 'disableFrameRelay', hint: 'disableFrameRelayHint' },
      { field: 'residentExecutor', kind: 'toggle', label: 'residentExecutor', hint: 'residentExecutorHint' },
      { field: 'sessionScopedSpaces', kind: 'toggle', label: 'sessionScopedSpaces', hint: 'sessionScopedSpacesHint' },
      { field: 'idleTimeoutMin', kind: 'number', label: 'idleTimeoutMin', hint: 'idleTimeoutMinHint', bounds: { min: 0, max: 1440, integer: true } },
    ],
  },
  {
    title: 'groupViewport',
    fields: [
      { field: 'viewportWidth', kind: 'number', label: 'viewportWidth', hint: 'viewportWidthHint', bounds: { min: 0, max: 3840, integer: true } },
      { field: 'viewportHeight', kind: 'number', label: 'viewportHeight', hint: 'viewportHeightHint', bounds: { min: 0, max: 2160, integer: true } },
      { field: 'deviceScaleFactor', kind: 'number', label: 'deviceScaleFactor', hint: 'deviceScaleFactorHint', bounds: { min: 0, max: 4 } },
    ],
  },
  {
    title: 'groupPaths',
    fields: [
      { field: 'chromePath', kind: 'text', label: 'chromePath', hint: 'chromePathHint' },
      { field: 'ffmpegPath', kind: 'text', label: 'ffmpegPath', hint: 'ffmpegPathHint' },
      { field: 'egoBin', kind: 'text', label: 'egoBin', hint: 'egoBinHint' },
      { field: 'githubMirror', kind: 'text', label: 'githubMirror', hint: 'githubMirrorHint' },
    ],
  },
]

/** 扁平化后的字段目录；表单模型按它登记转换约定。 */
export const FIELD_DESCRIPTORS: readonly FieldDescriptor[] = FIELD_GROUPS.flatMap(group => group.fields)

/**
 * 把一个字段的控件形态映射成表单转换约定。
 * @param descriptor - 目录中的字段。
 * @returns 该字段的存储值/草稿转换。
 */
export function fieldSpec(descriptor: FieldDescriptor): CardFieldSpec {
  switch (descriptor.kind) {
    case 'text': return textField(descriptor.field)
    case 'number': return numberField(descriptor.field, descriptor.bounds)
    case 'select': return choiceField(descriptor.field, (descriptor.options ?? []).map(option => option.value))
    case 'toggle': return booleanField(descriptor.field)
  }
}

/** @returns 草稿是否选择了视频后端，用于提示它对 ffmpeg 的依赖。 */
export function needsVideoTool(text: string): boolean {
  return text === 'ffmpeg'
}
