/** 模型要求的目标视口：以 CDP 设备度量固定页面布局尺寸，不改原生视图自身的尺寸。 */

import type { Tab } from './browser-guest-state.ts'

/**
 * 把标签页的 CSS 视口固定为模型给出的尺寸；后续命令沿同一调试器连接按顺序生效。
 * 已呈现的标签页保持面板尺寸的原生视图，页面按覆盖后的 CSS 尺寸布局并被裁切；
 * 模型点击与截图都使用这套 CSS 坐标，因此不能同时缩放视图（缩放会改变输入坐标系）。
 * @param tab - 要设置视口的 guest 标签页。
 * @param width - 目标 CSS 视口宽度，单位为像素。
 * @param height - 目标 CSS 视口高度，单位为像素。
 * @returns 覆盖指令发出后兑现；失败时调用方的操作失败，不保留半套状态。
 */
export async function emulateViewport(tab: Tab, width: number, height: number): Promise<void> {
  if (tab.emulated?.width === width && tab.emulated.height === height) return
  const debuggerApi = tab.view.webContents.debugger
  if (!debuggerApi.isAttached()) debuggerApi.attach('1.3')
  await debuggerApi.sendCommand('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 0, mobile: false,
  })
  tab.emulated = { width, height }
}

/**
 * 撤销设备度量覆盖，让页面回到原生视图尺寸的布局。
 * 工作台重新呈现或人工指定尺寸时调用；未覆盖过的标签页不做任何调试器操作。
 * @param tab - 要恢复的 guest 标签页。
 * @returns 无返回值；清理失败只影响下一次呈现的布局，不抛出。
 */
export function restoreViewport(tab: Tab): void {
  if (!tab.emulated) return
  delete tab.emulated
  const debuggerApi = tab.view.webContents.debugger
  if (!debuggerApi.isAttached()) return
  void Promise.resolve(debuggerApi.sendCommand('Emulation.clearDeviceMetricsOverride')).catch(() => {})
}
