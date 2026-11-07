import css from './ImageToolLoading.module.css'

/**
 * 图片工具的等待占位；仅在生成期间挂载，完成、失败或取消后由父组件移除。
 * @param props - 父组件提供的本地化状态文案；耗时和忙碌状态由父组件管理。
 * @returns 不表示百分比进度的状态文字与装饰性点阵。
 */
export function ImageToolLoading({ label }: { label: string }) {
  return <div className={css.root}>
    <div className={css.label} role="status">{label}</div>
    <div className={css.field} aria-hidden="true" />
  </div>
}
