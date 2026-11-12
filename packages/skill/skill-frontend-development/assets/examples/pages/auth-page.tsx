/**
 * Authentication surface: sign in, sign up, first-run administrator, reset password.
 * One centered column of 360–480px. No marketing column beside it, no full-width form.
 */
import { useState, type FormEvent } from 'react'
import styles from './auth-page.module.css'

export interface AuthPageProps {
  readonly title: string
  readonly description: string
  readonly submitLabel: string
  readonly onSubmit: (values: { readonly username: string; readonly password: string }) => Promise<string | null>
  /** Secondary actions stay in the card: "Forgot password", "Use a sign-in code". */
  readonly footer?: React.ReactNode
}

export function AuthPage({ title, description, submitLabel, onSubmit, footer }: AuthPageProps) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setBusy(true)
    setError(await onSubmit({ username, password }))
    setBusy(false)
  }

  return (
    <main className={styles.page}>
      <form className={styles.card} onSubmit={(event) => { void submit(event) }} noValidate>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.description}>{description}</p>
        <label className={styles.field}>
          <span>Username</span>
          <input value={username} autoComplete="username" onChange={(event) => { setUsername(event.target.value) }} />
        </label>
        <label className={styles.field}>
          <span>Password</span>
          <input type="password" value={password} autoComplete="current-password"
            onChange={(event) => { setPassword(event.target.value) }} />
        </label>
        {error === null ? null : <p className={styles.error} role="alert">{error}</p>}
        <button type="submit" className={styles.submit} disabled={busy}>
          {busy ? 'Working…' : submitLabel}
        </button>
        {footer === undefined ? null : <div className={styles.footer}>{footer}</div>}
      </form>
    </main>
  )
}
