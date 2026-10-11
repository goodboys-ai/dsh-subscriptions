/**
 * Unit tests for the durable Ollama Cloud settings store: validation,
 * override semantics (absent means "no override", not a default), atomic
 * 0600 persistence, and the failure modes that must not corrupt the file.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OllamaSettingsStore, validateOllamaSettings } from '../src/providers/ollama-settings.js'

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'ollama-settings-'))
  // Registered before the first assertion so a failure cannot strand the dir.
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

test('Ollama settings persist, drop unknown keys, and keep the file private', async (t) => {
  const dir = tempDir(t)
  const path = join(dir, 'settings.json')
  const store = new OllamaSettingsStore(path)
  // An absent field is "no override", so the effective value falls back to
  // the plugin config; it is never frozen into the document.
  assert.deepEqual(store.get(), {})
  assert.equal(store.models(), undefined)
  assert.equal(store.web(), undefined)
  assert.equal(store.baseURL(), undefined)
  assert.equal(store.apiKeyRef(), undefined)

  await store.set({
    models: [
      {
        id: 'glm-5.3:cloud',
        name: 'GLM-5.3 (cloud)',
        contextWindow: 1_000_000,
        thinking: true,
        efforts: ['low', 'high', 'max'],
        defaultEffort: 'max',
      },
      // A duplicate id keeps the first row, matching the Cursor store.
      { id: 'glm-5.3:cloud', name: 'duplicate' },
      { id: 'kimi-k3:cloud', vision: true },
    ],
    web: true,
    baseURL: 'https://ollama.com/api',
    apiKeyRef: 'MY_OLLAMA_KEY',
    // Unknown keys are dropped rather than persisted.
    extra: 'ignored',
  })

  const reloaded = new OllamaSettingsStore(path)
  assert.deepEqual(reloaded.models()?.map(model => model.id), ['glm-5.3:cloud', 'kimi-k3:cloud'])
  assert.equal(reloaded.models()?.[0]?.name, 'GLM-5.3 (cloud)')
  assert.equal(reloaded.models()?.[0]?.defaultEffort, 'max')
  assert.equal(reloaded.web(), true)
  assert.equal(reloaded.baseURL(), 'https://ollama.com/api')
  assert.equal(reloaded.apiKeyRef(), 'MY_OLLAMA_KEY')
  const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  assert.equal('extra' in written, false)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  // The atomic temp file is renamed away, never left beside the document.
  assert.deepEqual(readdirSync(dir), ['settings.json'])

  // Clearing every field restores the config/default fallback.
  await store.set({})
  assert.deepEqual(new OllamaSettingsStore(path).get(), {})
})

test('a rejected write leaves the stored document unchanged', async (t) => {
  const path = join(tempDir(t), 'settings.json')
  const store = new OllamaSettingsStore(path)
  await store.set({ models: [{ id: 'glm-5.3:cloud' }] })
  // Validation runs before the write is queued, so an invalid document
  // throws synchronously and never reaches the file.
  assert.throws(() => { void store.set({ models: [{ id: '' }] }) }, /id/)
  assert.deepEqual(store.get().models?.map(model => model.id), ['glm-5.3:cloud'])
  assert.equal((JSON.parse(readFileSync(path, 'utf8')) as { models: { id: string }[] }).models[0]?.id, 'glm-5.3:cloud')
})

test('a corrupt store file fails loudly instead of silently dropping settings', (t) => {
  const path = join(tempDir(t), 'settings.json')
  writeFileSync(path, '{not json')
  assert.throws(() => new OllamaSettingsStore(path), /Cannot read Ollama settings/)
})

test('validateOllamaSettings rejects unusable documents', () => {
  assert.throws(() => validateOllamaSettings(null), /object/)
  assert.throws(() => validateOllamaSettings([]), /object/)
  assert.throws(() => validateOllamaSettings({ models: 'all' }), /array/)
  assert.throws(() => validateOllamaSettings({ models: [null] }), /models\[0\]/)
  assert.throws(() => validateOllamaSettings({ models: [{ id: ' ' }] }), /id/)
  assert.throws(() => validateOllamaSettings({ models: [{ id: 'm', name: 7 }] }), /name/)
  assert.throws(() => validateOllamaSettings({ models: [{ id: 'm', contextWindow: 0 }] }), /contextWindow/)
  assert.throws(() => validateOllamaSettings({ models: [{ id: 'm', maxTokens: 1.5 }] }), /maxTokens/)
  assert.throws(() => validateOllamaSettings({ models: [{ id: 'm', vision: 'yes' }] }), /vision/)
  assert.throws(() => validateOllamaSettings({ models: [{ id: 'm', efforts: [] }] }), /efforts/)
  assert.throws(() => validateOllamaSettings({ models: [{ id: 'm', efforts: ['low', ''] }] }), /efforts entries/)
  assert.throws(
    () => validateOllamaSettings({ models: [{ id: 'm', efforts: ['low'], defaultEffort: 'high' }] }),
    /defaultEffort/,
  )
  assert.throws(() => validateOllamaSettings({ web: 'yes' }), /boolean/)
  assert.throws(() => validateOllamaSettings({ baseURL: 'not a url' }), /absolute URL/)
  assert.throws(() => validateOllamaSettings({ baseURL: 'ftp://ollama.com/api' }), /http or https/)
  assert.throws(() => validateOllamaSettings({ baseURL: 'https://user:pw@ollama.com/api' }), /credentials/)
  assert.throws(() => validateOllamaSettings({ baseURL: 'https://ollama.com/api?x=1' }), /query or fragment/)
  assert.throws(() => validateOllamaSettings({ baseURL: 'https://ollama.com/api#x' }), /query or fragment/)
  assert.throws(() => validateOllamaSettings({ apiKeyRef: 'A B' }), /whitespace/)
  assert.throws(() => validateOllamaSettings({ apiKeyRef: '' }), /apiKeyRef/)
  // A valid document round-trips with only its known keys.
  assert.deepEqual(
    validateOllamaSettings({ models: [{ id: 'm' }], baseURL: 'http://localhost:11434', extra: 1 }),
    { models: [{ id: 'm' }], baseURL: 'http://localhost:11434' },
  )
})
