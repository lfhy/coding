/** 按原画廊的主区域结构呈现图库、工作台、灵感和收藏，数据仍以本会话 Host 目录为准。 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button, Icon, IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseOutline16,
  IconCopyOutline16, IconDownloadOutline16, IconPlusOutline16, IconRefreshOutline16, IconSearchOutline16,
  IconSparkle16, IconTrashOutline16, Toast, writeClipboard,
} from 'coding-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from 'coding-client-ui-slots'
import type { GalleryFace } from './gallery.ts'
import type { GalleryItem } from './wire.ts'
import type { createGalleryUiStore } from './gallery-ui-store.ts'
import { InspirationView } from './InspirationView.tsx'
import { copyImageBlob } from './image-clipboard.ts'
import { NS } from './locales.ts'
import { SelectMenu } from './SelectMenu.tsx'
import css from './GalleryView.module.css'

type Tab = 'studio' | 'inspiration' | 'gallery'
type Ratio = 'all' | 'square' | 'landscape' | 'portrait'
const FALLBACK_SIZES: Record<string, Record<string, string>> = {
  '1:1': { '1K': '1024x1024' }, '2:3': { '1K': '1024x1536' }, '3:2': { '1K': '1536x1024' },
}

/** 主内容画廊的框架派生 props。 */
export type GalleryViewProps = PropsRuntime<'shell.page'> & PropsLocale<typeof NS>
  & PropsStore<ReturnType<typeof createGalleryUiStore>> & InjectFace<GalleryFace>

function ratioOf(item: GalleryItem): Ratio {
  if (item.width === item.height) return 'square'
  return item.width > item.height ? 'landscape' : 'portrait'
}

function readableDate(time: number): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(time)
}

interface CardProps {
  item: GalleryItem
  src: string
  favorite: boolean
  selected: boolean
  managing: boolean
  t: GalleryViewProps['t']
  onPreview: () => void
  onFavorite: () => void
  onSelect: () => void
  onEdit: () => void
  onCopy: () => void
  onDownload: () => void
  onPlace: () => void
}

/** 原画廊的正方形缩略卡：悬停操作不遮挡底部模型、描述和时间。 */
function GalleryCard({ item, src, favorite, selected, managing, t, onPreview, onFavorite,
  onSelect, onEdit, onCopy, onDownload, onPlace }: CardProps) {
  return <li className={css.card} data-selected={selected || undefined}>
    <div className={css.cardMedia}>
      <button type="button" className={css.previewTrigger} onClick={managing ? onSelect : onPreview}
        aria-label={`${t('preview')}：${item.prompt || t('image')}`}>
        <img src={src} alt={item.prompt || t('image')} loading="lazy" />
      </button>
      {managing ? <button type="button" className={css.cardCheckbox} aria-pressed={selected}
        aria-label={`${t('selectImage')}：${item.prompt || t('image')}`} onClick={onSelect}>
        {selected ? '✓' : ''}
      </button> : <div className={css.cardTools}>
        <button type="button" title={t('preview')} aria-label={t('preview')} onClick={onPreview}><Icon name="model-vision" size={16} /></button>
        <button type="button" title={t('copyPrompt')} aria-label={t('copyPrompt')} onClick={onCopy}><IconCopyOutline16 size={16} /></button>
        <button type="button" title={t('download')} aria-label={t('download')} onClick={onDownload}><IconDownloadOutline16 size={16} /></button>
        <button type="button" title={t('edit')} aria-label={t('edit')} onClick={onEdit}><IconSparkle16 size={16} /></button>
        <button type="button" title={t('place')} aria-label={t('place')} onClick={onPlace}><Icon name="model-vision" size={16} /></button>
      </div>}
    </div>
    <div className={css.cardMeta}>
      <span className={css.modelBadge} title={item.model}>{item.model}</span>
      <span className={css.cardPrompt} title={item.prompt}>{item.prompt || t('image')}</span>
      <div className={css.cardFooter}>
        <span>{item.width}×{item.height} · {readableDate(item.createdAt)}</span>
        <button type="button" className={css.favorite} aria-pressed={favorite}
          aria-label={favorite ? t('removeFavorite') : t('addFavorite')} onClick={onFavorite}>
          <Icon name="favorite" size={16} />
        </button>
      </div>
    </div>
  </li>
}

/** 三个子页共用的主内容画廊；打开和关闭只改变页面视图，不生成模型轮次。 */
export function GalleryView({ sessionId, closePage, useGallery, useStore, actions,
  show, refresh, generate, importReference, place, url, t }: GalleryViewProps) {
  const state = useGallery(snapshot => snapshot)
  const favorites = useStore(snapshot => snapshot.favorites)
  const hidden = useStore(snapshot => snapshot.hidden)
  const inspirationFavorites = useStore(snapshot => snapshot.inspirationFavorites)
  const [tab, setTab] = useState<Tab>('studio')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [favoriteKind, setFavoriteKind] = useState<'images' | 'prompts'>('images')
  const [search, setSearch] = useState('')
  const [ratio, setRatio] = useState<Ratio>('all')
  const [oldestFirst, setOldestFirst] = useState(false)
  const [manage, setManage] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<'generate' | 'edit'>('generate')
  const [editing, setEditing] = useState<string[]>([])
  const [zoom, setZoom] = useState(100)
  const [studioImageId, setStudioImageId] = useState<string | null>(null)
  const [outputRatio, setOutputRatio] = useState('1:1')
  const [resolution, setResolution] = useState('1K')
  const [quality, setQuality] = useState('default')
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const [limit, setLimit] = useState(24)
  const [lightboxFocus, setLightboxFocus] = useState<HTMLElement | null>(null)
  const firstTabRef = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const announce = (message: string) => { setToast(previous => ({ id: (previous?.id ?? 0) + 1, text: message })) }

  useEffect(() => { show(true); return () => { show(false) } }, [show])
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    firstTabRef.current?.focus()
    return () => { if (previousFocus.current?.isConnected) previousFocus.current.focus() }
  }, [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || previewId !== null || confirmDelete) return
      if (document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"], [role="listbox"]')) return
      closePage()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [closePage, previewId, confirmDelete])
  useEffect(() => {
    if (previewId === null && lightboxFocus?.isConnected === true) lightboxFocus.focus()
  }, [previewId, lightboxFocus])
  useEffect(() => { setLimit(24); if (listRef.current !== null) listRef.current.scrollTop = 0 }, [tab, search, ratio, oldestFirst])
  useEffect(() => { if (state.lastResultId !== null) setStudioImageId(state.lastResultId) }, [state.lastResultId])

  const items = useMemo(() => state.items.filter(item => !hidden.includes(item.id)), [state.items, hidden])
  const visible = useMemo(() => items.filter((item) => {
    if (favoritesOnly && !favorites.includes(item.id)) return false
    if (ratio !== 'all' && ratioOf(item) !== ratio) return false
    const phrase = search.trim().toLocaleLowerCase()
    return phrase === '' || `${item.prompt} ${item.model}`.toLocaleLowerCase().includes(phrase)
  }).sort((left, right) => oldestFirst ? left.createdAt - right.createdAt : right.createdAt - left.createdAt),
  [items, favorites, favoritesOnly, ratio, search, oldestFirst])
  const currentPreview = visible.findIndex(item => item.id === previewId)
  const preview = currentPreview < 0 ? items.find(item => item.id === previewId) : visible[currentPreview]
  const canGenerate = state.state?.available === true && state.phase === 'ready'
  const sizes = state.state?.sizes && Object.keys(state.state.sizes).length > 0 ? state.state.sizes : FALLBACK_SIZES
  const ratios = Object.keys(sizes)
  const selectedRatio = ratios.includes(outputRatio) ? outputRatio : ratios[0] ?? '1:1'
  const tiers = sizes[selectedRatio] ?? FALLBACK_SIZES['1:1'] ?? {}
  const selectedResolution = Object.hasOwn(tiers, resolution) ? resolution : Object.keys(tiers)[0] ?? '1K'
  const selectedSize = tiers[selectedResolution]
  const maxReferences = state.state?.maxEditReferences ?? 1
  const studioItem = items.find(item => item.id === studioImageId)
  const select = (id: string) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const beginEdit = (item: GalleryItem) => {
    setMode('edit')
    setEditing([item.id])
    setPrompt(item.prompt)
    setTab('studio')
    setStudioImageId(item.id)
  }
  const copyPrompt = (item: GalleryItem) => {
    void writeClipboard(item.prompt).then((ok) => { announce(t(ok ? 'copiedPrompt' : 'copyFailed')) })
  }
  const download = (item: GalleryItem) => {
    const anchor = document.createElement('a')
    anchor.href = url(item.id)
    anchor.download = `image-${item.id}.${item.mediaType.split('/')[1] ?? 'png'}`
    document.body.appendChild(anchor)
    try { anchor.click() } finally { anchor.remove() }
  }
  const addToCanvas = (item: GalleryItem) => {
    void place(item.id).then((ok) => {
      announce(t(ok ? 'placed' : 'placeFailed'))
      if (ok) setTab('studio')
    })
  }
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const source = mode === 'edit' ? editing.length === 1 ? editing[0] : editing : undefined
    if (mode === 'edit' && editing.length === 0) return
    void generate(prompt, source, { ...(selectedSize === undefined ? {} : { size: selectedSize }),
      ...(quality === 'default' ? {} : { quality }) }).then((ok) => {
      if (ok) { announce(t('generated')) }
      else announce(t(source === undefined ? 'generateFailed' : 'editFailed'))
    })
  }
  const prepareRegeneration = (item: GalleryItem) => {
    setMode('generate')
    setPrompt(item.prompt)
    const found = Object.entries(sizes).flatMap(([ratio, tiers]) => Object.entries(tiers).map(([tier, size]) => ({ ratio, tier, size })))
      .find(entry => entry.size === (item.size ?? `${item.width}x${item.height}`))
    if (found !== undefined) { setOutputRatio(found.ratio); setResolution(found.tier) }
    setQuality(item.quality ?? 'default')
  }
  const copyImage = (item: GalleryItem) => {
    void (async () => {
      try {
        const response = await fetch(url(item.id))
        if (!response.ok) throw new Error('image unavailable')
        const blob = await response.blob()
        announce(t(await copyImageBlob(blob) ? 'copiedImage' : 'copyFailed'))
      } catch { announce(t('copyFailed')) }
    })()
  }
  const importFiles = (files: FileList | null) => {
    if (files === null || files.length === 0) return
    void (async () => {
      for (const file of Array.from(files).slice(0, Math.max(0, maxReferences - editing.length))) {
        const item = await importReference(file)
        if (item === undefined) { announce(t('importFailed')); return }
        setEditing(previous => [...previous, item.id])
        setMode('edit')
      }
      announce(t('imported'))
    })()
  }
  const card = (item: GalleryItem) => <GalleryCard key={item.id} item={item} src={url(item.id)}
    favorite={favorites.includes(item.id)} selected={selected.has(item.id)} managing={manage} t={t}
    onPreview={() => {
      setLightboxFocus(document.activeElement instanceof HTMLElement ? document.activeElement : null)
      setPreviewId(item.id)
    }}
    onFavorite={() => { actions.toggleFavorite(item.id) }}
    onSelect={() => { select(item.id) }} onEdit={() => { beginEdit(item) }} onCopy={() => { copyPrompt(item) }}
    onDownload={() => { download(item) }} onPlace={() => { addToCanvas(item) }} />

  return <main className={css.root} aria-label={t('gallery')} data-image-gallery-page="" data-session-id={sessionId} data-tab={tab}>
    <div className={css.tabsBar}>
      <nav className={css.tabs} role="tablist" aria-label={t('gallerySections')}>
        {(['studio', 'inspiration', 'gallery'] as const).map(key => <button key={key}
          ref={key === 'studio' ? firstTabRef : undefined} type="button" role="tab" aria-selected={tab === key}
          className={tab === key ? css.activeTab : css.tab}
          onClick={() => { setTab(key); setManage(false); setSelected(new Set()) }}>
          {t(key === 'studio' ? 'studioTab' : key === 'inspiration' ? 'inspirationTab' : 'galleryTab')}
        </button>)}
      </nav>
      <button type="button" className={css.tabBack} onClick={closePage} aria-label={t('backToChat')} title={t('backToChat')}>
        <IconChevronLeftOutline14 size={16} />
      </button>
    </div>
    {tab === 'gallery' && favoritesOnly && <div className={css.favoriteKinds} role="group" aria-label={t('favoritesTab')}>
      <button type="button" aria-pressed={favoriteKind === 'images'} onClick={() => { setFavoriteKind('images') }}>{t('favoriteImages')}</button>
      <button type="button" aria-pressed={favoriteKind === 'prompts'} onClick={() => { setFavoriteKind('prompts') }}>{t('favoritePrompts')}</button>
    </div>}
    {tab === 'gallery' && (!favoritesOnly || favoriteKind === 'images') && <>
      <div className={css.filters}>
        <label className={css.filterLabel}>{t('ratioFilter')}
          <select value={ratio} onChange={(event) => { setRatio(event.target.value as Ratio) }}>
            <option value="all">{t('allRatios')}</option><option value="square">1:1</option>
            <option value="landscape">{t('landscape')}</option><option value="portrait">{t('portrait')}</option>
          </select>
        </label>
        <label className={css.search}><IconSearchOutline16 size={16} />
          <span className={css.visuallyHidden}>{t('searchImages')}</span>
          <input value={search} onChange={(event) => { setSearch(event.target.value) }} placeholder={t('searchImages')} />
        </label>
        <label className={css.filterLabel}>{t('sortBy')}
          <select value={oldestFirst ? 'oldest' : 'newest'} onChange={(event) => { setOldestFirst(event.target.value === 'oldest') }}>
            <option value="newest">{t('newest')}</option><option value="oldest">{t('oldest')}</option>
          </select>
        </label>
        <button type="button" className={css.iconButton} aria-label={t('refresh')} title={t('refresh')} onClick={refresh}>
          <IconRefreshOutline16 size={16} />
        </button>
        <button type="button" className={favoritesOnly ? css.manageActive : css.manage} aria-pressed={favoritesOnly}
          onClick={() => { setFavoritesOnly(value => !value); setManage(false); setSelected(new Set()) }}>{t('favoritesTab')}</button>
        <button type="button" className={manage ? css.manageActive : css.manage} aria-pressed={manage}
          onClick={() => { setManage(value => !value); setSelected(new Set()) }}>{t('manage')}</button>
      </div>
      <div ref={listRef} className={css.list} onScroll={(event) => {
        const target = event.currentTarget
        if (target.scrollTop + target.clientHeight >= target.scrollHeight - 240 && limit < visible.length) {
          setLimit(Math.min(visible.length, limit + 24))
        }
      }}>
        <p className={css.count}>{t('imageCount').replace('{count}', String(visible.length))}</p>
        {state.phase === 'loading' && items.length === 0 && <p className={css.empty} role="status">{t('galleryLoading')}</p>}
        {state.phase === 'error' && <div className={css.empty} role="alert">{t('galleryUnavailable')} <Button size="sm" onClick={refresh}>{t('retry')}</Button></div>}
        {state.phase === 'ready' && visible.length === 0 && <div className={css.empty}>
          <Icon name="model-vision" size={32} /><h2>{t(favoritesOnly ? 'favoritesEmpty' : items.length === 0 ? 'galleryEmpty' : 'noMatches')}</h2>
          <p>{t(favoritesOnly ? 'favoritesHint' : 'galleryHint')}</p>
        </div>}
        {visible.length > 0 && <ul className={css.grid}>{visible.slice(0, limit).map(card)}</ul>}
      </div>
      {manage && selected.size > 0 && <div className={css.batchBar} role="toolbar" aria-label={t('batchActions')}>
        <span>{t('selectedCount').replace('{count}', String(selected.size))}</span>
        <Button size="sm" onClick={() => { actions.setFavorite([...selected], true); announce(t('favorited')) }}>{t('addFavorite')}</Button>
        <Button size="sm" onClick={() => { setConfirmDelete(true) }} icon={<IconTrashOutline16 size={16} />}>{t('hideSelected')}</Button>
      </div>}
    </>}
    {tab === 'studio' && <div className={css.studio}>
      <div className={css.recent}>
        <h2>{t('recentImages')}</h2>
        {items.length === 0 && <p>{t('galleryEmpty')}</p>}
        {items.slice().sort((a, b) => b.createdAt - a.createdAt).map(item => <button key={item.id} type="button"
          className={studioImageId === item.id ? css.recentSelected : css.recentItem}
          draggable onDragStart={(event) => { event.dataTransfer.setData('application/x-dsh-image-id', item.id) }}
          onClick={() => { setStudioImageId(item.id); setZoom(100) }}>
          <img src={url(item.id)} alt="" /><span>{item.prompt || t('image')}</span>
        </button>)}
      </div>
      <div className={css.studioCenter}>
        <div className={css.previewPane}>
          <div className={css.studioCanvas}>
            {state.generating ? <p className={css.studioEmpty} role="status"><IconSparkle16 size={28} />{t('generating')}</p>
              : studioItem === undefined ? <p className={css.studioEmpty}><Icon name="model-vision" size={32} />{t('studioHint')}</p>
                : <img className={css.previewImage} style={{ '--dsh-image-zoom': zoom / 100 } as React.CSSProperties}
                  src={url(studioItem.id)} alt={studioItem.prompt || t('image')} />}
          </div>
          <div className={css.previewControls}>
            <div className={css.zoomControls} role="group" aria-label={t('zoom')}>
              <button type="button" onClick={() => { setZoom(100) }}>{t('fitWindow')}</button>
              <button type="button" aria-label={t('zoomOut')} title={t('zoomOut')} onClick={() => { setZoom(value => Math.max(25, value - 25)) }}>−</button>
              <span>{zoom}%</span>
              <button type="button" aria-label={t('zoomIn')} title={t('zoomIn')} onClick={() => { setZoom(value => Math.min(500, value + 25)) }}>+</button>
            </div>
            <div className={css.toolbarActions}>
              {studioItem !== undefined && <button type="button" onClick={() => {
                setStudioImageId(null); setPrompt(''); setMode('generate'); setEditing([]); setZoom(100)
              }}><IconPlusOutline16 size={16} />{t('newGeneration')}</button>}
              <button type="button" aria-label={t('fullscreen')} title={t('fullscreen')}
                disabled={studioItem === undefined} onClick={() => {
                  setLightboxFocus(document.activeElement instanceof HTMLElement ? document.activeElement : null)
                  setPreviewId(studioItem?.id ?? null)
                }}><Icon name="model-vision" size={16} /></button>
            </div>
          </div>
        </div>
        {studioItem !== undefined && <div className={css.result}>
          <div className={css.resultStrip}><strong>{t('latestResult')}</strong><div>
            <button type="button" onClick={() => { beginEdit(studioItem) }}><IconSparkle16 size={15} />{t('continueEdit')}</button>
            <button type="button" onClick={() => { prepareRegeneration(studioItem) }}><IconRefreshOutline16 size={15} />{t('regenerate')}</button>
          </div></div>
          <div className={css.resultActions}>
            <p title={studioItem.prompt}>{studioItem.prompt || t('image')}</p>
            <div>
              <button type="button" aria-pressed={favorites.includes(studioItem.id)} onClick={() => { actions.toggleFavorite(studioItem.id) }}>
                <Icon name="favorite" size={15} />{t(favorites.includes(studioItem.id) ? 'removeFavorite' : 'addFavorite')}</button>
              <button type="button" onClick={() => { copyImage(studioItem) }}><IconCopyOutline16 size={15} />{t('copyImage')}</button>
              <button type="button" onClick={() => { download(studioItem) }}><IconDownloadOutline16 size={15} />{t('download')}</button>
              <button type="button" onClick={() => { setSelected(new Set([studioItem.id])); setConfirmDelete(true) }}>
                <IconTrashOutline16 size={15} />{t('hideSelected')}</button>
            </div>
          </div>
          <div className={css.resultMeta}>
            {readableDate(studioItem.createdAt)} · {studioItem.model} · {studioItem.width} × {studioItem.height}
          </div>
        </div>}
      </div>
      <form className={css.studioForm} onSubmit={submit}>
        <h2>{t('generationPanel')}</h2>
        <div className={css.studioMode} role="group" aria-label={t('creationMode')}>
          <button type="button" aria-pressed={mode === 'generate'} onClick={() => { setMode('generate') }}>{t('textToImage')}</button>
          <button type="button" aria-pressed={mode === 'edit'} onClick={() => { setMode('edit') }}>{t('imageToImage')}</button>
        </div>
        <p className={css.studioModel}>{t('configuredModel')}：{state.state?.model ?? t('noModel')}</p>
        {state.state?.available === false && <p role="status">{t('noService')}</p>}
        {mode === 'edit' && <div className={css.referenceArea}>
          <div className={css.referenceHeading}><span>{t('referenceImages')} ( {editing.length} / {maxReferences} )</span>
            {editing.length > 0 && <button type="button" onClick={() => { setEditing([]) }}>{t('clearReference')}</button>}
          </div>
          <div className={css.referenceRow} onDragOver={(event) => { event.preventDefault() }}
            onDrop={(event) => {
              event.preventDefault()
              const id = event.dataTransfer.getData('application/x-dsh-image-id')
              if (id && items.some(item => item.id === id)) {
                setEditing(previous => previous.includes(id) || previous.length >= maxReferences ? previous : [...previous, id])
              } else importFiles(event.dataTransfer.files)
            }}>
            {editing.map(id => <div className={css.referenceThumb} key={id}>
              <img src={url(id)} alt={t('referenceImage')} />
              <button type="button" aria-label={t('removeReference')} onClick={() => { setEditing(previous => previous.filter(value => value !== id)) }}>×</button>
            </div>)}
            {editing.length < maxReferences && <button type="button" className={css.addReference} disabled={state.uploading}
              onClick={() => { fileInput.current?.click() }}><IconPlusOutline16 size={16} />{t('addReference')}</button>
            }
            <input ref={fileInput} hidden type="file" multiple={maxReferences > 1} accept="image/png,image/jpeg,image/webp,image/gif"
              aria-label={t('chooseReference')} onChange={(event) => {
                importFiles(event.currentTarget.files); event.currentTarget.value = ''
              }} />
          </div>
          {state.uploading && <p role="status">{t('importing')}</p>}
          <p>{t('referenceHint')}</p>
        </div>}
        <label htmlFor="image-gen-prompt">{t('prompt')}</label>
        <textarea id="image-gen-prompt" value={prompt} placeholder={t('promptPlaceholder')}
          disabled={!canGenerate || state.generating} onChange={(event) => { setPrompt(event.target.value) }} />
        <div className={css.promptFooter}><button type="button" onClick={() => { setTab('inspiration') }}>{t('findInspiration')}</button>
          <button type="button" onClick={() => { setPrompt('') }}>{t('clearPrompt')}</button><span>{prompt.length}/4000</span></div>
        <div className={css.outputFields}>
          <div className={css.outputField}>
            <span>{t('outputRatio')}</span>
            <SelectMenu label={t('outputRatio')} value={selectedRatio}
              options={ratios.map(value => ({ id: value, label: `${value} ${value === '1:1' ? t('square') : value === '3:2' ? t('landscape') : value === '2:3' ? t('portrait') : ''}`.trim() }))}
              onChange={(value) => { setOutputRatio(value); setResolution('1K') }} />
          </div>
          <div className={css.outputField}>
            <span>{t('resolution')}</span>
            <SelectMenu label={t('resolution')} value={selectedResolution}
              options={Object.entries(tiers).map(([tier, size]) => ({ id: tier, label: `${tier} · ${size.replace('x', '×')}` }))}
              onChange={setResolution} />
          </div>
        </div>
        <div className={css.qualityField}>
          <span>{t('generationQuality')}</span>
          <SelectMenu label={t('generationQuality')} value={quality} options={[
            { id: 'default', label: t('providerDefault') },
            { id: 'auto', label: t('automatic') },
            { id: 'low', label: t('lowQuality') },
            { id: 'medium', label: t('mediumQuality') },
            { id: 'high', label: t('highQuality') },
          ]} onChange={setQuality} />
        </div>
        <button className={css.generateButton} type="submit"
          disabled={!canGenerate || state.generating || state.uploading || !prompt.trim() || prompt.length > 4000 || mode === 'edit' && editing.length === 0}>
          <IconSparkle16 size={16} />{t(state.generating ? 'generating' : 'startGeneration')}
        </button>
      </form>
    </div>}
    {(tab === 'inspiration' || tab === 'gallery' && favoritesOnly && favoriteKind === 'prompts') && <InspirationView
      favorites={inspirationFavorites} favoritesOnly={tab === 'gallery'}
      onFavorite={(id) => { actions.toggleInspirationFavorite(id) }}
      onCopy={(text) => {
        void writeClipboard(text).then((ok) => { announce(t(ok ? 'copiedPrompt' : 'copyFailed')) })
      }}
      onUse={(text) => { setPrompt(text); setEditing([]); setTab('studio') }} t={t} />}
    {preview !== undefined && createPortal(<div className={css.lightbox} role="dialog" aria-modal="true" aria-label={t('preview')}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setPreviewId(null)
        if (event.key === 'ArrowLeft' && currentPreview > 0) setPreviewId(visible[currentPreview - 1]?.id ?? null)
        if (event.key === 'ArrowRight' && currentPreview < visible.length - 1) setPreviewId(visible[currentPreview + 1]?.id ?? null)
      }}>
      <button type="button" autoFocus className={css.lightboxClose} aria-label={t('closePreview')} onClick={() => { setPreviewId(null) }}><IconCloseOutline16 size={16} /></button>
      <button type="button" className={css.lightboxArrow} disabled={currentPreview <= 0} aria-label={t('previousImage')}
        onClick={() => { setPreviewId(visible[currentPreview - 1]?.id ?? null) }}><IconChevronLeftOutline14 size={22} /></button>
      <img src={url(preview.id)} alt={preview.prompt || t('image')} />
      <button type="button" className={css.lightboxArrow} disabled={currentPreview >= visible.length - 1} aria-label={t('nextImage')}
        onClick={() => { setPreviewId(visible[currentPreview + 1]?.id ?? null) }}><IconChevronRightOutline14 size={22} /></button>
      <div className={css.lightboxCaption}><strong>{preview.model}</strong><p>{preview.prompt}</p>
        <div><Button size="sm" onClick={() => { copyPrompt(preview) }} icon={<IconCopyOutline16 size={16} />}>{t('copyPrompt')}</Button>
          <Button size="sm" onClick={() => { download(preview) }} icon={<IconDownloadOutline16 size={16} />}>{t('download')}</Button>
          <Button size="sm" onClick={() => { setPreviewId(null); beginEdit(preview) }}>{t('edit')}</Button></div>
      </div>
    </div>, document.body)}
    {confirmDelete && createPortal(<div className={css.dialogMask} role="dialog" aria-modal="true" aria-label={t('hideSelected')}>
      <div className={css.dialog}><h2>{t('hideSelected')}</h2><p>{t('hideNotice')}</p><div>
        <Button size="sm" onClick={() => { setConfirmDelete(false) }}>{t('cancel')}</Button>
        <Button variant="primary" size="sm" onClick={() => {
          actions.hide([...selected]); setSelected(new Set()); setManage(false); setConfirmDelete(false); announce(t('hidden'))
        }}>{t('confirm')}</Button>
      </div></div>
    </div>, document.body)}
    {toast !== null && <Toast key={toast.id} text={toast.text} onDone={() => { setToast(null) }} />}
  </main>
}
