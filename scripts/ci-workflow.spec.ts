import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

describe('personal CI workflow', () => {
  it('runs the credential-free client checks on hosted runners', () => {
    const workflow = loadWorkflow()

    expect(workflow.name).toBe('CI')
    expect(workflow.on).toMatchObject({
      push: { branches: ['master', 'main'] },
      pull_request: null,
      workflow_dispatch: null,
    })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.env).toMatchObject({
      NODE_VERSION: '24',
      DSH_TELEMETRY_DISABLED: '1',
    })
    expect(workflow.concurrency).toMatchObject({
      group: 'ci-${{ github.ref }}',
      'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
    })

    const jobs = workflow.jobs
    const checks = isRecord(jobs) ? jobs.checks : undefined
    if (!isRecord(checks) || !Array.isArray(checks.steps)) {
      throw new TypeError('CI workflow must define the checks job and its steps')
    }

    expect(checks['runs-on']).toBe('ubuntu-latest')
    expect(checks['timeout-minutes']).toBe(45)
    expect(checks.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ uses: 'actions/checkout@v4' }),
      expect.objectContaining({ uses: 'pnpm/action-setup@v4' }),
      expect.objectContaining({ uses: 'actions/setup-node@v4' }),
      expect.objectContaining({ run: 'pnpm install --frozen-lockfile' }),
      expect.objectContaining({ run: 'pnpm run typecheck' }),
      expect.objectContaining({ run: 'pnpm run lint' }),
      expect.objectContaining({ run: 'pnpm run test' }),
      expect.objectContaining({ run: 'pnpm run build' }),
    ]))
  })

  it('does not expose credentials or upstream runner assumptions', () => {
    const source = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')

    expect(source).not.toMatch(/secrets\.|DEEPSEEK_API_KEY|NPM_TOKEN|PYPI|self-hosted/i)
    expect(source).not.toMatch(/dsh-(?:ubuntu|windows)|vm-backup|wine/i)
  })
})

function loadWorkflow(): Record<string, unknown> {
  const parsed: unknown = yaml.load(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8'))
  if (!isRecord(parsed)) throw new TypeError('CI workflow must contain a mapping')
  return parsed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
