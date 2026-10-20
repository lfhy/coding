/** 未完成的 GenUI 围栏只显示居中加载提示，不暴露语言标签或半截 JSON。 */
import { useT } from './i18n/index.ts'
import css from './StreamingFence.module.css'

/**
 * 在围栏原位显示加载占位；解析、停止和失败的状态交接由 DOM 通道负责。
 * @returns 居中的本地化状态与支持减少动态效果的加载动画。
 */
export function StreamingFence() {
  const t = useT()
  return (
    <div className={css.block} data-genui-loading aria-busy="true">
      <span className={css.status} role="status">
        <span className={css.spinner} aria-hidden="true" />
        {t('block.streamingLabel')}
      </span>
    </div>
  )
}
