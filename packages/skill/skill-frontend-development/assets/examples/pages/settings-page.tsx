/**
 * Settings surface: a vertical child-tab rail on the left, one section at a time on the right.
 * "Change password" is a button that opens a dialog — a password form is never spread over the page.
 * Tabs and Dialog come from ../tabs and ../dialog; copy all three into the project's shared layer.
 */
import { useState } from 'react'
import { Tabs, type TabItem } from '../tabs/Tabs.tsx'
import { Dialog } from '../dialog/Dialog.tsx'
import styles from './settings-page.module.css'

export function SettingsPage() {
  const [section, setSection] = useState('model')
  const [changing, setChanging] = useState(false)

  const sections: TabItem[] = [
    {
      id: 'model',
      label: 'Model service',
      content: (
        <section className={styles.section}>
          <h2 className={styles.heading}>Model service</h2>
          <p className={styles.hint}>Endpoint, key, and the model this workspace uses by default.</p>
        </section>
      ),
    },
    {
      id: 'account',
      label: 'Account',
      content: (
        <section className={styles.section}>
          <h2 className={styles.heading}>Account</h2>
          <div className={styles.row}>
            <div>
              <div className={styles.rowTitle}>Password</div>
              <div className={styles.rowHint}>Last changed 3 months ago.</div>
            </div>
            <button type="button" className={styles.action} onClick={() => { setChanging(true) }}>
              Change password
            </button>
          </div>
        </section>
      ),
    },
  ]

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Settings</h1>
      </header>
      <Tabs items={sections} value={section} onChange={setSection} label="Settings sections" orientation="vertical" />
      <Dialog open={changing} title="Change password" onClose={() => { setChanging(false) }}>
        <ChangePasswordForm />
      </Dialog>
    </div>
  )
}

function ChangePasswordForm() {
  return (
    <form className={styles.form}>
      <label className={styles.field}>
        <span>Current password</span>
        <input type="password" autoComplete="current-password" />
      </label>
      <label className={styles.field}>
        <span>New password</span>
        <input type="password" autoComplete="new-password" />
      </label>
      <label className={styles.field}>
        <span>Confirm new password</span>
        <input type="password" autoComplete="new-password" />
      </label>
    </form>
  )
}
