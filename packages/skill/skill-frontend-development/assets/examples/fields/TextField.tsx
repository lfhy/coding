/**
 * Text field primitive: one accessible control used by every form on the product.
 * Copy into the shared UI layer and point the tokens at the project's theme; pages must not
 * render a bare <input> on their own.
 */
import { useId, type InputHTMLAttributes, type ReactNode } from 'react'
import styles from './fields.module.css'

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  readonly label: string
  /** Validation message; render it next to the field and wire it with aria-describedby. */
  readonly error?: string
  /** Helper text shown when there is no error. */
  readonly hint?: ReactNode
  readonly trailing?: ReactNode
}

export function TextField({ label, error, hint, trailing, id, ...rest }: TextFieldProps) {
  const fallback = useId()
  const inputId = id ?? `field-${fallback}`
  const describedBy = error === undefined ? undefined : `${inputId}-message`
  return (
    <div className={styles.field} data-invalid={error === undefined ? undefined : 'true'}>
      <label className={styles.label} htmlFor={inputId}>{label}</label>
      <div className={styles.control}>
        <input id={inputId} className={styles.input} aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy} {...rest} />
        {trailing === undefined ? null : <span className={styles.trailing}>{trailing}</span>}
      </div>
      {error !== undefined ? <p className={styles.error} id={describedBy} role="alert">{error}</p>
        : hint === undefined ? null : <p className={styles.hint}>{hint}</p>}
    </div>
  )
}
