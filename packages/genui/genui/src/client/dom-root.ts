import { createRoot, type Root } from 'react-dom/client'

/** DOM 围栏的 React 根工厂，测试可注入失败；生产只使用 React 官方实现。 */
let rootFactory: (container: HTMLElement) => Root = createRoot

/**
 * 设置后续围栏使用的根工厂，已挂载的根不受影响。
 * @param factory - 接管插件容器的 React 根创建函数。
 * @returns 无返回值；测试结束应恢复 createRoot。
 */
export function setDomRootFactory(factory: (container: HTMLElement) => Root): void {
  rootFactory = factory
}

/**
 * 原子地创建根并提交首次内容；同步失败时释放已创建的根。
 * @param container - 插件持有的挂载容器，失败后由调用方移除。
 * @param render - 首次渲染操作。
 * @returns 已提交内容的根；工厂或渲染失败时重新抛出原始错误。
 */
export function mountDomRoot(container: HTMLElement, render: (root: Root) => void): Root {
  let root: Root | undefined
  try {
    root = rootFactory(container)
    render(root)
    return root
  } catch (error) {
    try { root?.unmount() } catch { /* 保留最初的挂载错误，DOM 由调用方恢复。 */ }
    throw error
  }
}
