/** 原画廊灵感索引的浏览页：检索固定案例，选中后查看 Prompt 并带入工作台。 */
import { useMemo, useState } from 'react'
import { Button, Icon, IconSearchOutline16, IconSparkle16 } from 'coding-client-ui-primitives'
import { inspirationCases, type InspirationCase } from './inspiration.ts'
import type { ImageKey } from './locales.ts'
import css from './InspirationView.module.css'

interface InspirationViewProps {
  favorites: readonly string[]
  favoritesOnly?: boolean
  onFavorite: (id: string) => void
  onCopy: (prompt: string) => void
  onUse: (prompt: string) => void
  t: (key: ImageKey) => string
}

const CASES = inspirationCases()

/** 灵感卡与详情联动，全部案例仅保留元数据和原出处，不下载原图到应用包。 */
export function InspirationView({ favorites, favoritesOnly = false, onFavorite, onCopy, onUse, t }: InspirationViewProps) {
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('all')
  const [category, setCategory] = useState('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [limit, setLimit] = useState(48)
  const categories = useMemo(() => [...new Set(CASES.filter(item => source === 'all' || item.sourceId === source)
    .map(item => item.category))].filter(Boolean).sort(), [source])
  const shown = useMemo(() => CASES.filter((item) => {
    if (favoritesOnly && !favorites.includes(item.id)) return false
    if (source !== 'all' && item.sourceId !== source) return false
    if (category !== 'all' && item.category !== category) return false
    const phrase = query.trim().toLocaleLowerCase()
    return phrase === '' || `${item.title} ${item.prompt} ${item.category}`.toLocaleLowerCase().includes(phrase)
  }), [category, favorites, favoritesOnly, query, source])
  const selected = shown.find(item => item.id === selectedId) ?? shown[0]
  const pick = (item: InspirationCase) => { setSelectedId(item.id) }

  return <div className={css.root}>
    <div className={css.heading}><div><small>PROMPT INSPIRATION</small>
      <h2>{favoritesOnly ? t('favoritePrompts') : t('inspirationTitle')}</h2>
      <p>{t('inspirationHint')}</p></div>
    <span>{t('inspirationCount').replace('{count}', String(shown.length))}</span>
    </div>
    <div className={css.filters}>
      <label className={css.search}><IconSearchOutline16 size={16} />
        <span className={css.visuallyHidden}>{t('searchInspiration')}</span>
        <input value={query} onChange={(event) => { setQuery(event.target.value); setLimit(48) }}
          placeholder={t('searchInspiration')} />
      </label>
      <label>{t('sourceFilter')} <select value={source}
        onChange={(event) => { setSource(event.target.value); setCategory('all'); setLimit(48) }}>
        <option value="all">{t('allSources')}</option>
        <option value="awesome-gpt-image-2">GPT Image 2</option>
        <option value="handraw-style">{t('handdraw')}</option>
      </select></label>
      <label>{t('categoryFilter')} <select value={category} onChange={(event) => { setCategory(event.target.value); setLimit(48) }}>
        <option value="all">{t('allCategories')}</option>
        {categories.map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>
    </div>
    <div className={css.content}>
      <div className={css.list}>
        {shown.length === 0 && <div className={css.empty}><IconSparkle16 size={28} /><p>{t('noInspiration')}</p></div>}
        {shown.length > 0 && <ul className={css.grid}>{shown.slice(0, limit).map(item => <li key={item.id}>
          <button type="button" className={selected?.id === item.id ? css.selectedCard : css.card}
            aria-pressed={selected?.id === item.id} onClick={() => { pick(item) }}>
            <img src={item.imageUrl} alt={item.title} width={item.width} height={item.height}
              loading="lazy" decoding="async" />
            <span className={css.cardTitle}>{item.title}</span>
            <span className={css.cardCategory}>{item.category}</span>
          </button>
        </li>)}</ul>}
        {limit < shown.length && <Button size="sm" onClick={() => { setLimit(value => value + 48) }}>{t('loadMore')}</Button>}
      </div>
      {selected !== undefined && <aside className={css.details} aria-label={t('inspirationDetails')}>
        <img src={selected.imageUrl} alt={selected.title} width={selected.width} height={selected.height}
          decoding="async" />
        <div className={css.detailHeading}><h3>{selected.title}</h3>
          <button type="button" className={css.favorite} aria-pressed={favorites.includes(selected.id)}
            aria-label={favorites.includes(selected.id) ? t('removeFavorite') : t('addFavorite')}
            onClick={() => { onFavorite(selected.id) }}><Icon name="favorite" size={18} /></button>
        </div>
        <p className={css.source}>{selected.sourceLabel} · {selected.category}</p>
        <label htmlFor="image-inspiration-prompt">{t('fullPrompt')}</label>
        <textarea id="image-inspiration-prompt" readOnly value={selected.prompt} />
        <div className={css.actions}>
          <Button size="sm" onClick={() => { onCopy(selected.prompt) }}>{t('copyPrompt')}</Button>
          <Button variant="primary" size="sm" onClick={() => { onUse(selected.prompt) }}>{t('useInStudio')}</Button>
        </div>
        {selected.sourceUrl !== undefined && <a href={selected.sourceUrl} target="_blank" rel="noopener noreferrer">{t('viewSource')}</a>}
      </aside>}
    </div>
  </div>
}
