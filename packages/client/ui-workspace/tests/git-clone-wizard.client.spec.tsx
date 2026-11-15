// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type {
  SessionListState, WorkspaceId, WorkspaceListState, WorkspaceView,
} from 'coding-client-runtime/client'
import { makeTranslate } from 'coding-client-test-runtime'
import { bindSnapshotSelector } from 'coding-client-test-runtime'
import { zh as commonZh } from 'coding-client-locale/src/locales/zh.ts'
import { GitCloneAuthRequired } from '../src/client/contract/slots.ts'
import type {
  DirectoryFlowOwnerProps, GitCloneOutcome, GitCloneRequestInput, WorkspacePickerProps,
} from '../src/client/contract/slots.ts'
import { zh } from '../src/client/locales.ts'
import { GitCloneWizard } from '../src/client/GitCloneWizard.tsx'
import { WorkspacePicker } from '../src/client/WorkspacePicker.tsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const t: WorkspacePickerProps['t'] = makeTranslate(zh, commonZh)

const CLONE_URL = 'https://github.com/acme/demo.git'

function workspace(id = 'clone-workspace', path = '/home/coding/demo'): WorkspaceView {
  return {
    workspaceId: id as WorkspaceId,
    path,
    title: 'demo',
    sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

const sessions: SessionListState = {
  ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
}

const workspaceState = (items: readonly WorkspaceView[]): WorkspaceListState => ({
  items, archivedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true,
  recentWorkspaceId: items[0]?.workspaceId,
})

function anchor(): { current: HTMLElement } {
  const element = document.createElement('button')
  element.getBoundingClientRect = () => ({
    top: 10, left: 20, width: 30, height: 40, right: 50, bottom: 50,
    x: 20, y: 10, toJSON: () => ({}),
  })
  return { current: element }
}

/** 目录流占位：本 spec 不驱动目录选择，只为满足选择器的 slot 参数。 */
function flowSlot() {
  const renderSlot = ((_name: string, owner: DirectoryFlowOwnerProps) => (
    owner.open ? <div data-testid="directory-flow" /> : null
  )) as never
  const useDirectoryFlow = bindSnapshotSelector({
    getSnapshot: () => true,
    subscribe: () => () => {},
  })
  return { renderSlot, useDirectoryFlow }
}

type CreateWorkspace = (input: { path: string; title?: string }) => Promise<WorkspaceView>
type CloneRepository = (input: GitCloneRequestInput) => Promise<GitCloneOutcome>
type ForgetCredentials = (ref: string) => Promise<void>

/** 直接挂载向导，用注入桩观察克隆与工作区调用。 */
function mountWizard(
  cloneRepository: CloneRepository,
  options: {
    createWorkspace?: CreateWorkspace
    forgetGitCredentials?: ForgetCredentials
  } = {},
) {
  const onClose = vi.fn()
  const onPick = vi.fn()
  const createWorkspace = options.createWorkspace ?? vi.fn(async () => workspace())
  const forgetGitCredentials = options.forgetGitCredentials ?? vi.fn(async () => {})
  render(
    <GitCloneWizard
      open
      onClose={onClose}
      onPick={onPick}
      t={t}
      createWorkspace={createWorkspace}
      cloneRepository={cloneRepository}
      forgetGitCredentials={forgetGitCredentials}
    />,
  )
  return { onClose, onPick, createWorkspace, forgetGitCredentials }
}

function fillTarget(url = CLONE_URL): void {
  fireEvent.change(screen.getByLabelText(t('picker.clone.field.url')), { target: { value: url } })
}

function submitClone(): void {
  fireEvent.click(screen.getByRole('button', { name: t('picker.clone.submit') }))
}

describe('Git clone wizard', () => {
  it('opens from the picker menu with the repository and save-path fields', () => {
    const onClose = vi.fn()
    const renderSlot = flowSlot()
    render(
      <WorkspacePicker
        open
        anchorRef={anchor()}
        useSessions={hook(sessions)}
        useWorkspaces={hook(workspaceState([]))}
        onPick={vi.fn()}
        onClose={onClose}
        createWorkspace={vi.fn()}
        startUnscopedSession={vi.fn(async () => {})}
        cloneRepository={vi.fn(async () => ({ path: '/home/coding/demo', branch: 'main', mechanism: 'cli' as const }))}
        forgetGitCredentials={vi.fn(async () => {})}
        useDirectoryFlow={renderSlot.useDirectoryFlow}
        renderSlot={renderSlot.renderSlot}
        t={t}
      />,
    )
    fireEvent.click(screen.getByRole('menuitem', { name: t('picker.clone.menu') }))
    // 菜单收起之后才展开向导，两者不会同时出现。
    expect(onClose).toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: t('picker.clone.title') })).toBeTruthy()
    expect(screen.getByLabelText(t('picker.clone.field.url'))).toBeTruthy()
    expect(screen.getByLabelText(t('picker.clone.field.path'))).toBeTruthy()
    expect(screen.getByRole('navigation', { name: t('picker.clone.steps.aria') })).toBeTruthy()
  })

  it('derives the save path from the URL until the operator edits it', () => {
    mountWizard(vi.fn<CloneRepository>(async () => ({ path: '/home/coding/demo', branch: 'main', mechanism: 'cli' })))
    const pathField = (): HTMLInputElement => screen.getByLabelText<HTMLInputElement>(t('picker.clone.field.path'))
    fillTarget()
    expect(pathField().value).toBe('~/demo')

    fireEvent.change(pathField(), { target: { value: '~/projects/mine' } })
    fillTarget('https://github.com/acme/other.git')
    expect(pathField().value).toBe('~/projects/mine')
  })

  it('passes only the fields the operator filled in', async () => {
    const cloneRepository = vi.fn<CloneRepository>(async () => ({
      path: '/home/coding/demo', branch: 'main', mechanism: 'cli',
    }))
    mountWizard(cloneRepository)
    fillTarget()
    submitClone()
    await waitFor(() => { expect(cloneRepository).toHaveBeenCalledOnce() })
    // 折叠的高级选项保持空值时，请求里不能出现 ref／depth／proxy／identity。
    expect(cloneRepository).toHaveBeenCalledWith({ url: CLONE_URL, path: '~/demo' })
  })

  it('rejects a non-positive depth without calling the host', () => {
    const cloneRepository = vi.fn<CloneRepository>(async () => ({
      path: '/home/coding/demo', branch: 'main', mechanism: 'cli',
    }))
    mountWizard(cloneRepository)
    fillTarget()
    fireEvent.click(screen.getByText(t('picker.clone.advanced')))
    fireEvent.change(screen.getByLabelText(t('picker.clone.field.depth')), { target: { value: '0' } })
    submitClone()
    expect(screen.getByRole('alert').textContent).toBe(t('picker.clone.error.depth'))
    expect(cloneRepository).not.toHaveBeenCalled()
  })

  it('registers the cloned path as a workspace and selects it', async () => {
    const pending = deferred<GitCloneOutcome>()
    const cloneRepository = vi.fn<CloneRepository>(() => pending.promise)
    const createWorkspace = vi.fn(async () => workspace())
    const b = mountWizard(cloneRepository, { createWorkspace })
    fillTarget()
    submitClone()
    // 克隆期间按钮禁用，界面停在进度步骤。
    await waitFor(() => { expect(cloneRepository).toHaveBeenCalledOnce() })
    expect(screen.getByText(t('picker.clone.progress.running'))).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: t('close') }).disabled).toBe(true)

    pending.resolve({ path: '/home/coding/demo', branch: 'main', mechanism: 'cli' })
    await waitFor(() => {
      expect(createWorkspace).toHaveBeenCalledWith({ path: '/home/coding/demo' })
      expect(b.onPick).toHaveBeenCalledWith('clone-workspace')
    })
    expect(b.onClose).toHaveBeenCalledOnce()
  })

  it('asks for credentials, clears a rejected saved ref, and retries with them', async () => {
    const ref = 'GIT_CREDENTIAL_GITHUB_ACME_PRIVATE'
    const cloneRepository = vi.fn<CloneRepository>()
      .mockRejectedValueOnce(new GitCloneAuthRequired('https://github.com/acme/private.git', ref))
      .mockResolvedValueOnce({ path: '/home/coding/private', branch: 'main', mechanism: 'cli' })
    const forgetGitCredentials = vi.fn<ForgetCredentials>(async () => {})
    const createWorkspace = vi.fn(async () => workspace('clone-private', '/home/coding/private'))
    const b = mountWizard(cloneRepository, { createWorkspace, forgetGitCredentials })
    fillTarget('https://github.com/acme/private.git')
    fireEvent.click(screen.getByText(t('picker.clone.advanced')))
    fireEvent.change(screen.getByLabelText(t('picker.clone.field.ref')), { target: { value: 'release' } })
    submitClone()

    const dialog = await screen.findByRole('dialog', { name: t('picker.clone.auth.title') })
    expect(within(dialog).getByText(t('picker.clone.auth.stale', { remote: 'https://github.com/acme/private.git' }))).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: t('picker.clone.auth.forget') }))
    await waitFor(() => { expect(forgetGitCredentials).toHaveBeenCalledWith(ref) })
    // 清除后仍留在弹窗内，被拒提示随之消失。
    expect(within(dialog).queryByRole('button', { name: t('picker.clone.auth.forget') })).toBeNull()

    fireEvent.change(within(dialog).getByLabelText(t('picker.clone.auth.username')), { target: { value: 'octocat' } })
    fireEvent.change(within(dialog).getByLabelText(t('picker.clone.auth.password')), { target: { value: 'token-only' } })
    fireEvent.click(within(dialog).getByRole('button', { name: t('picker.clone.auth.submit') }))

    await waitFor(() => {
      // 重试复用同一份地址与高级参数，只多带凭据。
      expect(cloneRepository).toHaveBeenLastCalledWith({
        url: 'https://github.com/acme/private.git',
        path: '~/private',
        ref: 'release',
        credentials: { username: 'octocat', password: 'token-only' },
      })
      expect(b.onPick).toHaveBeenCalledWith('clone-private')
    })
    expect(document.body.textContent).not.toContain('token-only')
  })

  it('keeps a host failure inside the wizard without losing the typed values', async () => {
    const cloneRepository = vi.fn<CloneRepository>(async () => {
      throw new Error('fatal: repository not found')
    })
    const b = mountWizard(cloneRepository)
    fillTarget()
    submitClone()
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('fatal: repository not found') })
    expect(b.onClose).not.toHaveBeenCalled()
    expect(b.createWorkspace).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: t('picker.clone.back') }))
    expect(screen.getByLabelText<HTMLInputElement>(t('picker.clone.field.url')).value).toBe(CLONE_URL)
    expect(screen.getByLabelText<HTMLInputElement>(t('picker.clone.field.path')).value).toBe('~/demo')
  })
})
