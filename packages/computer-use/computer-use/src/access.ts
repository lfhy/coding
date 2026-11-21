/**
 * 设置页可读的授权结论：只含跨进程传输的基本值，不引用宿主服务或本机路径。
 *
 * 这个模块没有任何导入，浏览器侧与 Host 侧共用同一份声明，因此两边不会因为
 * 分别维护副本而漂移。
 *
 * @module coding-computer-use/access
 */

/** 一项系统权限的观察结果。 */
export type ComputerPermissionState = 'granted' | 'denied' | 'not-determined' | 'unavailable'

/** 后端的运行形态。 */
export type ComputerBackendName = 'macos-ax' | 'cua-driver' | 'unsupported'

/** 设置页展示的授权与运行结论。 */
export interface ComputerUseAccessStatus {
  /** 设置里的开关。 */
  enabled: boolean
  /** 运行提供方的平台。 */
  platform: string
  /** 当前后端。 */
  provider: ComputerBackendName
  /** 最近一次检查是否判定后端就绪。 */
  ready: boolean
  /** 本机组件版本；外部驱动或未就绪时缺省。 */
  helperVersion?: string
  /** 辅助功能权限。 */
  accessibility: ComputerPermissionState
  /** 屏幕录制权限。 */
  screenRecording: ComputerPermissionState
  /** 最近一次失败的简短原因。 */
  lastError?: string
}
