/**
 * Shared Toast: one provider at the app root, one polite live region for the whole product.
 * Pages call `useToast().show('...')` for a transient success or failure; persistent errors stay inline.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import styles from './Toast.module.css'

type Tone = 'success' | 'error' | 'info'

interface ToastItem {
  readonly id: number
  readonly tone: Tone
  readonly message: string
}

interface ToastApi {
  readonly show: (message: string, tone?: Tone) => void
}

const ToastContext = createContext<ToastApi | null>(null)
const TTL: Record<Tone, number> = { success: 2400, info: 3200, error: 5200 }

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [items, setItems] = useState<readonly ToastItem[]>([])

  const show = useCallback((message: string, tone: Tone = 'info') => {
    const id = Date.now() + Math.random()
    setItems(current => [...current, { id, tone, message }])
    window.setTimeout(() => {
      setItems(current => current.filter(item => item.id !== id))
    }, TTL[tone])
  }, [])

  const api = useMemo<ToastApi>(() => ({ show }), [show])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.stack} role="status" aria-live="polite" aria-atomic="false">
        {items.map(item => (
          <div key={item.id} className={styles.toast} data-tone={item.tone}>
            {item.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (api === null) throw new Error('useToast must be used inside ToastProvider')
  return api
}
