/** 标记「编辑器存活」期间的宿主状态：Univer 的浮层挂在 body 下，预设样式要靠这个标记圈定作用域。 */

/** body 上的宿主类名；预设样式的 @scope 根之一。 */
export const HOST_CLASS = 'coding-office-host'

let holders = 0

/**
 * 标记当前文档里有存活的编辑器。Univer 的段落柄、块菜单和悬停说明都是 body 直属节点，
 * 预设样式用 `body.<HOST_CLASS> > *` 才能覆盖到它们及它们的后代。
 * @returns 释放函数；同一文档内按引用计数摘掉类名，可重复调用。
 */
export function markOfficeHost(): () => void {
  if (holders++ === 0) document.body.classList.add(HOST_CLASS)
  let released = false
  return () => {
    if (released) return
    released = true
    if (--holders === 0) document.body.classList.remove(HOST_CLASS)
  }
}
