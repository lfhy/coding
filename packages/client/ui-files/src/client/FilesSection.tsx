import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from 'coding-client-ui-slots'
import type { ManagedFileRecord, ManagedFilesPage } from './wire.ts'
import css from './FilesSection.module.css'

/** 当前分区挂载期间的只读分页请求。 */
export interface FilesSectionInjected {
  /** 按 Host 返回的游标读取一页；调用者可在卸载时取消。 */
  list: (offset: number, limit: number, signal: AbortSignal) => Promise<ManagedFilesPage>
}

export type FilesSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'settings.files'> & InjectFace<FilesSectionInjected>

interface PageState {
  items: ManagedFileRecord[]
  total: number
  nextOffset?: number
  loading: boolean
  failed: boolean
}

interface PageRequest {
  offset: number
  attempt: number
  expectedTotal?: number
}

const PAGE_SIZE = 50

/** 分页重叠时保留首次出现的记录，避免重复行与 React key 冲突。 */
function uniqueFiles(items: ManagedFileRecord[]): ManagedFileRecord[] {
  const ids = new Set<string>()
  return items.filter((item) => {
    if (ids.has(item.id)) return false
    ids.add(item.id)
    return true
  })
}

/** 把文件大小转换为易扫读的数量；保留原始字节数供屏幕阅读器读取。 */
function formatSize(bytes: number, locale: string): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = bytes
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++ }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 }).format(size)} ${units[unit]}`
}

/** 呈现 Host 管理的全局文件列表；离开分区即取消尚未完成的请求。 */
export function FilesSection({ list, t }: FilesSectionProps) {
  const [request, setRequest] = useState<PageRequest>({ offset: 0, attempt: 0 })
  const [page, setPage] = useState<PageState>({ items: [], total: 0, loading: true, failed: false })
  useEffect(() => {
    const aborter = new AbortController()
    void list(request.offset, PAGE_SIZE, aborter.signal).then(
      (result) => {
        if (aborter.signal.aborted) return
        if (result.nextOffset !== undefined && result.nextOffset <= request.offset) {
          setPage(previous => ({ ...previous, loading: false, failed: true }))
          return
        }
        if (request.expectedTotal !== undefined && result.total !== request.expectedTotal) {
          setRequest({ offset: 0, attempt: request.attempt + 1 })
          return
        }
        setPage(previous => ({
          items: uniqueFiles(request.offset === 0 ? result.items : [...previous.items, ...result.items]),
          total: result.total, ...(result.nextOffset === undefined ? {} : { nextOffset: result.nextOffset }),
          loading: false, failed: false,
        }))
      },
      () => {
        if (!aborter.signal.aborted) setPage(previous => ({ ...previous, loading: false, failed: true }))
      },
    )
    return () => { aborter.abort() }
  }, [list, request])

  const locale = t('dateLocale')
  const dateFormatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
  const retry = () => {
    setPage(previous => ({ ...previous, loading: true, failed: false }))
    setRequest(previous => ({ ...previous, attempt: previous.attempt + 1 }))
  }
  const loadMore = () => {
    if (page.loading || page.nextOffset === undefined) return
    setPage(previous => ({ ...previous, loading: true, failed: false }))
    setRequest({ offset: page.nextOffset, attempt: 0, expectedTotal: page.total })
  }

  return (
    <section className={css.section} aria-labelledby="files-heading" aria-busy={page.loading}>
      <h2 id="files-heading" className={css.title}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      {page.items.length > 0 ? (
        <>
          <p className={css.count}>{page.total}{t('count')}</p>
          <div className={css.tableHeader} aria-hidden="true">
            <span>{t('name')}</span><span>{t('kind')}</span><span>{t('size')}</span><span>{t('date')}</span>
          </div>
          <ul className={css.list} aria-label={t('title')}>
            {page.items.map(file => (
              <li className={css.row} key={file.id}>
                <span className={css.fileName} title={file.name}><span className={css.screenReaderLabel}>{t('name')}: </span>{file.name}</span>
                <span className={css.cell}><span className={css.mobileLabel}>{t('kind')}: </span>{t(file.kind === 'upload' ? 'upload' : 'generatedImage')}</span>
                <span className={css.cell} aria-label={`${t('size')}: ${file.bytes} B`}><span className={css.mobileLabel}>{t('size')}: </span>{formatSize(file.bytes, locale)}</span>
                <time className={css.cell} dateTime={file.createdAt}><span className={css.mobileLabel}>{t('date')}: </span>{dateFormatter.format(new Date(file.createdAt))}</time>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {page.loading ? <p className={css.status} role="status">{t(page.items.length ? 'loadingMore' : 'loading')}</p> : null}
      {page.failed ? <div className={css.failure} role="alert"><p>{t('error')}</p><button type="button" onClick={retry}>{t('retry')}</button></div> : null}
      {!page.loading && !page.failed && page.items.length === 0 ? <p className={css.status}>{t('empty')}</p> : null}
      {!page.loading && !page.failed && page.nextOffset !== undefined ? (
        <button type="button" className={css.more} onClick={loadMore}>{t('loadMore')}</button>
      ) : null}
    </section>
  )
}
