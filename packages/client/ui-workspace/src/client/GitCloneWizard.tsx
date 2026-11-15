/** “打开仓库”向导：填写克隆参数、观察克隆结果，并在远端要求认证时弹出独立凭据窗口。 */
import { useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  Button, IconCloseOutline16, IconDataOutline16, Input, Modal, IconSettingsOutline16,
} from 'coding-client-ui-primitives'
import type { WorkspaceId, WorkspaceView } from 'coding-client-runtime/client'
import { GitCloneAuthRequired } from './contract/slots.ts'
import type { GitCloneOutcome, GitCloneRequestInput, WorkspacePickerProps } from './contract/slots.ts'
import remoteCss from './RemoteSshWizard.module.css'
import css from './GitCloneWizard.module.css'

type CloneStep = 'config' | 'progress'

/** 认证弹窗持有的远端；`credentialRef` 表示本机已有的一组凭据被拒绝。 */
type CloneAuthTarget = {
  url: string
  credentialRef?: string
}

/** 向导属性；所有动作都由选择器插件的注入面透传，组件自身不接触 Host。 */
export interface GitCloneWizardProps {
  /** 是否显示对话框。 */
  open: boolean
  /** 关闭对话框；克隆进行中时不会被调用。 */
  onClose: () => void
  /** 本地化翻译函数。 */
  t: WorkspacePickerProps['t']
  /** 把克隆出的目录注册为工作区；失败时错误留在本向导内。 */
  createWorkspace: (input: { path: string; title?: string }) => Promise<WorkspaceView>
  /** 执行克隆；需要认证时以 {@link GitCloneAuthRequired} 拒绝。 */
  cloneRepository: (input: GitCloneRequestInput) => Promise<GitCloneOutcome>
  /** 清除本机为该远端保存的凭据。 */
  forgetGitCredentials: (ref: string) => Promise<void>
  /** 选中新建的工作区。 */
  onPick: (workspaceId: WorkspaceId) => void
}

const cloneSteps = [
  { id: 'config', label: 'picker.clone.step.config', icon: IconSettingsOutline16 },
  { id: 'progress', label: 'picker.clone.step.progress', icon: IconDataOutline16 },
] as const

/** 把任意失败值转换为可显示文本；调用方保证它不会收到凭据对象。 */
function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * 从仓库地址推导默认保存路径：取最后一段并去掉 `.git`，空地址时返回空串。
 * 兼容 `https://host/owner/repo.git`、`git@host:owner/repo.git` 与本机路径。
 */
function defaultClonePath(url: string): string {
  const withoutQuery = url.trim().replace(/[?#].*$/u, '').replace(/[\\/]+$/u, '')
  const segment = withoutQuery.split(/[\\/]/u).filter(Boolean).at(-1) ?? ''
  const name = segment.replace(/\.git$/iu, '')
  return name === '' ? '' : `~/${name}`
}

/**
 * 打开仓库向导：先填写地址与高级选项，再在进度步骤等待克隆，成功后直接打开工作区。
 * @param props - 对话框控制、注入的克隆与工作区动作、本地化函数。
 * @returns 配置/进度两步对话框，以及独立于它的认证弹窗。
 */
export function GitCloneWizard({
  open, onClose, t, createWorkspace, cloneRepository, forgetGitCredentials, onPick,
}: GitCloneWizardProps) {
  const [step, setStep] = useState<CloneStep>('config')
  const [url, setUrl] = useState('')
  const [path, setPath] = useState('')
  const [pathTouched, setPathTouched] = useState(false)
  const [refName, setRefName] = useState('')
  const [depth, setDepth] = useState('')
  const [proxy, setProxy] = useState('')
  const [identityName, setIdentityName] = useState('')
  const [identityEmail, setIdentityEmail] = useState('')
  const [cloning, setCloning] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [auth, setAuth] = useState<CloneAuthTarget | null>(null)
  const [authError, setAuthError] = useState<string | undefined>()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  const formId = useId()
  // 每次开始克隆自增；外部关闭或重新提交后，旧结果不再改动界面。
  const attempt = useRef(0)
  // 认证重试必须复用同一份地址与高级参数，不能在弹窗里重新拼装表单状态。
  const pendingInput = useRef<GitCloneRequestInput | undefined>(undefined)

  useEffect(() => {
    if (open) return
    attempt.current++
    setStep('config')
    setUrl('')
    setPath('')
    setPathTouched(false)
    setRefName('')
    setDepth('')
    setProxy('')
    setIdentityName('')
    setIdentityEmail('')
    setCloning(false)
    setError(undefined)
    setAuth(null)
    setAuthError(undefined)
    setUsername('')
    setPassword('')
    setRemember(false)
    setForgetting(false)
    pendingInput.current = undefined
  }, [open])

  const closeAuth = (): void => {
    if (cloning || forgetting) return
    setAuth(null)
    setAuthError(undefined)
    setUsername('')
    setPassword('')
    setRemember(false)
  }

  const dismiss = (): void => {
    // 认证弹窗是独立一步：它打开时 Escape 不能连带关掉身后的向导。
    if (cloning || auth !== null) return
    onClose()
  }

  /**
   * 执行一次克隆并采用结果。`fromAuth` 表示这次请求由凭据弹窗发起，
   * 失败信息因此留在弹窗内，而不是向导的错误区。
   */
  const runClone = (request: GitCloneRequestInput, fromAuth: boolean): void => {
    const current = ++attempt.current
    setCloning(true)
    setStep('progress')
    setError(undefined)
    void (async () => {
      try {
        const outcome = await cloneRepository(request)
        if (current !== attempt.current) return
        const workspace = await createWorkspace({ path: outcome.path })
        if (current !== attempt.current) return
        setAuth(null)
        setAuthError(undefined)
        onPick(workspace.workspaceId)
        onClose()
      } catch (reason: unknown) {
        if (current !== attempt.current) return
        if (reason instanceof GitCloneAuthRequired) {
          setStep('config')
          setAuth({
            url: reason.url,
            ...(reason.credentialRef === undefined ? {} : { credentialRef: reason.credentialRef }),
          })
          setAuthError(fromAuth ? t('picker.clone.auth.error') : undefined)
          return
        }
        if (fromAuth) {
          setStep('config')
          setAuthError(errorText(reason))
          return
        }
        setError(errorText(reason))
      } finally {
        if (current === attempt.current) setCloning(false)
      }
    })()
  }

  const submitConfig = (): void => {
    if (cloning) return
    const nextUrl = url.trim()
    const nextPath = path.trim()
    if (nextUrl === '') {
      setError(t('picker.clone.error.url'))
      return
    }
    if (nextPath === '') {
      setError(t('picker.clone.error.path'))
      return
    }
    const depthText = depth.trim()
    let depthValue: number | undefined
    if (depthText !== '') {
      const parsed = Number(depthText)
      if (!/^\d+$/u.test(depthText) || parsed < 1) {
        setError(t('picker.clone.error.depth'))
        return
      }
      depthValue = parsed
    }
    const name = identityName.trim()
    const email = identityEmail.trim()
    const identity = { ...(name === '' ? {} : { name }), ...(email === '' ? {} : { email }) }
    const input: GitCloneRequestInput = {
      url: nextUrl,
      path: nextPath,
      ...(refName.trim() === '' ? {} : { ref: refName.trim() }),
      ...(depthValue === undefined ? {} : { depth: depthValue }),
      ...(proxy.trim() === '' ? {} : { proxy: proxy.trim() }),
      ...(Object.keys(identity).length === 0 ? {} : { identity }),
    }
    pendingInput.current = input
    runClone(input, false)
  }

  const retryWithCredentials = (): void => {
    const base = pendingInput.current
    if (auth === null || base === undefined || cloning || username === '' || password === '') return
    setAuthError(undefined)
    setPassword('')
    runClone({ ...base, credentials: { username, password, ...(remember ? { remember: true } : {}) } }, true)
  }

  /** 清除被拒绝的本机凭据：弹窗留在原位，用户可继续输入新的一组。 */
  const forgetCredentials = (ref: string): void => {
    if (forgetting || cloning) return
    setForgetting(true)
    setAuthError(undefined)
    void forgetGitCredentials(ref).then(() => {
      setAuth(current => (current === null ? current : { url: current.url }))
    }).catch((reason: unknown) => {
      setAuthError(errorText(reason))
    }).finally(() => { setForgetting(false) })
  }

  const busy = cloning || forgetting
  const canSubmit = url.trim() !== '' && path.trim() !== ''
  // 提前取出被拒凭据引用，回调里就不必再收窄可能为 null 的弹窗状态。
  const staleCredentialRef = auth?.credentialRef
  const currentStepIndex = cloneSteps.findIndex(item => item.id === step)
  const heading = step === 'config'
    ? { title: t('picker.clone.config.title'), description: t('picker.clone.config.description') }
    : { title: t('picker.clone.progress.title'), description: t('picker.clone.progress.description') }

  return (
    <>
      <Modal open={open} onClose={dismiss} title={t('picker.clone.title')} closeLabel={t('close')} headless className={remoteCss.dialog ?? ''}>
        <div className={remoteCss.shell}>
          <nav className={remoteCss.steps} aria-label={t('picker.clone.steps.aria')}>
            <div className={remoteCss.stepsTitle}>{t('picker.clone.title')}</div>
            <ol className={remoteCss.stepList}>
              {cloneSteps.map((item, index) => (
                <li
                  key={item.id}
                  className={clsx(remoteCss.step, index === currentStepIndex && remoteCss.stepActive)}
                  {...index === currentStepIndex ? { 'aria-current': 'step' as const } : {}}
                >
                  <item.icon className={remoteCss.stepIcon} size={16} />
                  <span className={remoteCss.stepTitle}>{t(item.label)}</span>
                </li>
              ))}
            </ol>
          </nav>
          <section className={remoteCss.content}>
            <button type="button" className={remoteCss.close} aria-label={t('close')} disabled={cloning} onClick={dismiss}><IconCloseOutline16 size={14} /></button>
            <header className={remoteCss.header}>
              <h2 className={remoteCss.title}>{heading.title}</h2>
              <p className={remoteCss.description}>{heading.description}</p>
            </header>
            <div className={remoteCss.body}>
              {step === 'config' && (
                <form id={formId} className={remoteCss.form} onSubmit={(event) => { event.preventDefault(); submitConfig() }}>
                  <div className={remoteCss.field}>
                    <label className={remoteCss.label} htmlFor="git-clone-url">{t('picker.clone.field.url')}</label>
                    <Input
                      id="git-clone-url"
                      className={remoteCss.input ?? ''}
                      autoFocus
                      autoComplete="off"
                      spellCheck={false}
                      value={url}
                      placeholder={t('picker.clone.placeholder.url')}
                      onChange={(event) => {
                        const next = event.target.value
                        setUrl(next)
                        // 用户手动改过保存路径后，地址推导不再覆盖它。
                        if (!pathTouched) setPath(defaultClonePath(next))
                      }}
                    />
                  </div>
                  <div className={remoteCss.field}>
                    <label className={remoteCss.label} htmlFor="git-clone-path">{t('picker.clone.field.path')}</label>
                    <Input
                      id="git-clone-path"
                      className={remoteCss.input ?? ''}
                      autoComplete="off"
                      spellCheck={false}
                      value={path}
                      placeholder={t('picker.clone.placeholder.path')}
                      onChange={(event) => {
                        setPathTouched(true)
                        setPath(event.target.value)
                      }}
                    />
                  </div>
                  <details className={css.advanced}>
                    <summary className={css.advancedSummary}>{t('picker.clone.advanced')}</summary>
                    <div className={css.advancedBody}>
                      <div className={remoteCss.field}>
                        <label className={remoteCss.label} htmlFor="git-clone-ref">{t('picker.clone.field.ref')}</label>
                        <Input
                          id="git-clone-ref"
                          className={remoteCss.input ?? ''}
                          autoComplete="off"
                          spellCheck={false}
                          value={refName}
                          placeholder={t('picker.clone.placeholder.ref')}
                          onChange={(event) => { setRefName(event.target.value) }}
                        />
                      </div>
                      <div className={remoteCss.field}>
                        <label className={remoteCss.label} htmlFor="git-clone-depth">{t('picker.clone.field.depth')}</label>
                        <Input
                          id="git-clone-depth"
                          className={remoteCss.input ?? ''}
                          inputMode="numeric"
                          autoComplete="off"
                          value={depth}
                          placeholder={t('picker.clone.placeholder.depth')}
                          onChange={(event) => { setDepth(event.target.value) }}
                        />
                      </div>
                      <div className={remoteCss.field}>
                        <label className={remoteCss.label} htmlFor="git-clone-proxy">{t('picker.clone.field.proxy')}</label>
                        <Input
                          id="git-clone-proxy"
                          className={remoteCss.input ?? ''}
                          autoComplete="off"
                          spellCheck={false}
                          value={proxy}
                          placeholder={t('picker.clone.placeholder.proxy')}
                          onChange={(event) => { setProxy(event.target.value) }}
                        />
                        <p className={css.hint}>{t('picker.clone.proxy.hint')}</p>
                      </div>
                      <div className={remoteCss.field}>
                        <label className={remoteCss.label} htmlFor="git-clone-identity-name">{t('picker.clone.field.identityName')}</label>
                        <Input
                          id="git-clone-identity-name"
                          className={remoteCss.input ?? ''}
                          autoComplete="off"
                          value={identityName}
                          onChange={(event) => { setIdentityName(event.target.value) }}
                        />
                      </div>
                      <div className={remoteCss.field}>
                        <label className={remoteCss.label} htmlFor="git-clone-identity-email">{t('picker.clone.field.identityEmail')}</label>
                        <Input
                          id="git-clone-identity-email"
                          className={remoteCss.input ?? ''}
                          autoComplete="off"
                          value={identityEmail}
                          onChange={(event) => { setIdentityEmail(event.target.value) }}
                        />
                        <p className={css.hint}>{t('picker.clone.identity.hint')}</p>
                      </div>
                    </div>
                  </details>
                  {error !== undefined && <div className={remoteCss.error} role="alert">{error}</div>}
                </form>
              )}
              {step === 'progress' && (
                <div className={remoteCss.progressList} aria-live="polite">
                  <div className={clsx(remoteCss.progressRow, error === undefined && remoteCss.progressCurrent)}>
                    <span className={remoteCss.progressDot} />
                    <span>{error === undefined ? t('picker.clone.progress.running') : t('picker.clone.progress.failed')}</span>
                  </div>
                  {error === undefined
                    // 只回显目标目录：地址可能内联凭据，不该再出现在正文里。
                    ? <div className={remoteCss.notice}>{path.trim()}</div>
                    : <div className={remoteCss.error} role="alert">{error}</div>}
                </div>
              )}
            </div>
            <footer className={remoteCss.footer}>
              {step === 'progress' && error !== undefined && (
                <Button variant="ghost" className={remoteCss.back} disabled={cloning} onClick={() => { setStep('config') }}>{t('picker.clone.back')}</Button>
              )}
              <div className={remoteCss.footerActions}>
                {step === 'config' && <Button variant="outline" disabled={cloning} onClick={dismiss}>{t('cancel')}</Button>}
                {step === 'config' && <Button variant="primary" type="submit" form={formId} disabled={cloning || !canSubmit}>{t('picker.clone.submit')}</Button>}
              </div>
            </footer>
          </section>
        </div>
      </Modal>
      <Modal
        open={auth !== null}
        trapFocus
        onClose={closeAuth}
        title={t('picker.clone.auth.title')}
        closeLabel={t('cancel')}
        description={t('picker.clone.auth.description', { remote: auth?.url ?? '' })}
        footer={(
          <div className={remoteCss.footerActions}>
            <Button variant="outline" disabled={busy} onClick={closeAuth}>{t('picker.clone.auth.cancel')}</Button>
            <Button variant="primary" disabled={busy || username === '' || password === ''} onClick={retryWithCredentials}>
              {cloning ? t('picker.clone.auth.running') : t('picker.clone.auth.submit')}
            </Button>
          </div>
        )}
      >
        <form className={css.authForm} onSubmit={(event) => { event.preventDefault(); retryWithCredentials() }}>
          <label className={css.authLabel} htmlFor="git-clone-auth-username">{t('picker.clone.auth.username')}</label>
          <Input
            id="git-clone-auth-username"
            className={remoteCss.input ?? ''}
            autoComplete="username"
            value={username}
            onChange={(event) => { setUsername(event.target.value) }}
          />
          <label className={css.authLabel} htmlFor="git-clone-auth-password">{t('picker.clone.auth.password')}</label>
          <Input
            id="git-clone-auth-password"
            className={remoteCss.input ?? ''}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => { setPassword(event.target.value) }}
          />
          <label className={remoteCss.remember}>
            <input type="checkbox" checked={remember} onChange={(event) => { setRemember(event.target.checked) }} />
            <span>{t('picker.clone.auth.remember')}</span>
          </label>
          {staleCredentialRef !== undefined && (
            <div className={css.authStale}>
              <p>{t('picker.clone.auth.stale', { remote: auth?.url ?? '' })}</p>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => { forgetCredentials(staleCredentialRef) }}
              >
                {forgetting ? t('picker.clone.auth.forgetting') : t('picker.clone.auth.forget')}
              </Button>
            </div>
          )}
          {authError !== undefined && <div className={remoteCss.error} role="alert">{authError}</div>}
        </form>
      </Modal>
    </>
  )
}
