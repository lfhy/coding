import { describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { SettingsDescribeMirror } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { ModelsSettingsStore } from '../src/client/store.ts'
import { settingsSchema } from './settings-schema.client.ts'

const vision = {
  ns: 'vision-understanding',
  schema: JSON.parse(JSON.stringify(Schema.object({ provider: Schema.string(), model: Schema.string() }).toJSON())) as unknown,
  value: {}, user: {}, revision: 3, applies: 'live' as const, secrets: [],
}

function wire() {
  const namespace = structuredClone(vision)
  const mutate = vi.fn(async () => ({ result: { ok: true, value: {
    ...namespace, revision: 4, value: { provider: 'vision', model: 'image-1' }, user: { provider: 'vision', model: 'image-1' },
  } } }))
  const api = {
    llm: {
      providers: vi.fn(async () => ({ result: { ok: true, value: { providers: [
        { provider: 'vision', displayName: 'Vision', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'vision'], active: true },
        { provider: 'no-key', displayName: 'No key', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'no-key'], active: true },
      ] } } })),
      models: vi.fn(async () => ({ result: { ok: true, value: { groups: [
        { id: 'vision', name: 'Vision', models: [
          { id: 'image-1', name: 'Image 1', inputModalities: ['text', 'image'] },
          { id: 'unknown', name: 'Unknown' },
          { id: 'text', name: 'Text', inputModalities: ['text'] },
        ] },
        { id: 'no-key', name: 'No key', models: [{ id: 'image-2', name: 'Image 2', inputModalities: ['image'] }] },
      ], failures: [] } } })),
    },
    credentials: { describe: vi.fn(async () => ({ result: { ok: true, value: { credentials: {
      VISION_API_KEY: { configured: true, writable: true },
      NO_KEY_API_KEY: { configured: false, writable: true },
    } } } })) },
    settings: {
      describe: vi.fn(async () => ({ result: { ok: true, value: { writable: true, hasDocument: true, namespaces: [
        namespace,
        { ns: 'llm-pi-ai', schema: namespace.schema, value: { providers: {
          vision: { apiKeyEnv: 'VISION_API_KEY' }, 'no-key': { apiKeyEnv: 'NO_KEY_API_KEY' },
        } }, user: {}, revision: 0, applies: 'live', secrets: [] },
      ] } } })), mutate,
    },
  }
  return { api, mutate }
}

describe('vision-understanding settings', () => {
  it('offers only explicit image-capable models on usable configured routes, then writes a revision-fenced pair', async () => {
    const { api, mutate } = wire()
    const mirror = new SettingsDescribeMirror(api as never)
    const store = new ModelsSettingsStore(api as never, settingsSchema, mirror)
    await store.load()
    expect(store.store.getSnapshot().visionModels).toEqual([
      { provider: 'vision', providerName: 'Vision', model: 'image-1', modelName: 'Image 1' },
    ])
    expect(await store.setVisionTarget({ provider: 'vision', model: 'image-1' })).toBeUndefined()
    expect(mutate).toHaveBeenCalledWith({ ns: 'vision-understanding', expectedRevision: 3, ops: [
      { op: 'set', path: ['provider'], value: 'vision' },
      { op: 'set', path: ['model'], value: 'image-1' },
    ] })
    expect(store.store.getSnapshot().namespaces.get('vision-understanding')?.revision).toBe(4)
  })
})
