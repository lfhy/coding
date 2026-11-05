/** 画廊的逐会话浏览偏好：收藏与隐藏只影响当前浏览器，不改写会话图片事件。 */
import { defineStore, type EngineStoreHandle } from 'coding-client-runtime/client'

interface GalleryUiState {
  favorites: string[]
  hidden: string[]
  inspirationFavorites: string[]
}

type GalleryUiActions = {
  toggleFavorite: (draft: GalleryUiState, id: string) => void
  setFavorite: (draft: GalleryUiState, ids: readonly string[], favorite: boolean) => void
  hide: (draft: GalleryUiState, ids: readonly string[]) => void
  toggleInspirationFavorite: (draft: GalleryUiState, id: string) => void
}

/**
 * 浏览器本地的画廊选择不删除模型历史或附件；会话切换后由 store scope 保持隔离。
 * @returns 含收藏与隐藏操作的逐会话 store 定义。
 */
export function createGalleryUiStore(): EngineStoreHandle<GalleryUiState, GalleryUiActions> {
  return defineStore({
    init: (): GalleryUiState => ({ favorites: [], hidden: [], inspirationFavorites: [] }),
    persist: 'dsh.image-gallery.preferences',
    actions: {
      toggleFavorite: (draft, id) => {
        draft.favorites = draft.favorites.includes(id)
          ? draft.favorites.filter(value => value !== id)
          : [...draft.favorites, id]
      },
      setFavorite: (draft, ids, favorite) => {
        const next = new Set(draft.favorites)
        for (const id of ids) {
          if (favorite) next.add(id)
          else next.delete(id)
        }
        draft.favorites = [...next]
      },
      hide: (draft, ids) => {
        draft.hidden = [...new Set([...draft.hidden, ...ids])]
      },
      toggleInspirationFavorite: (draft, id) => {
        const existing = draft.inspirationFavorites
        draft.inspirationFavorites = existing.includes(id)
          ? existing.filter(value => value !== id)
          : [...existing, id]
      },
    },
  })
}
