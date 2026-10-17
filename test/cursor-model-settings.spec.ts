import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CursorModelSettingsStore,
  validateCursorModelSettings,
} from '../src/providers/cursor-model-settings.js'

test('Cursor model visibility persists, validates input, and keeps its file private', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-model-settings-'))
  // Registered before the first assertion so a failure cannot strand the dir.
  t.after(() => {
    rmSync(dir, { recursive: true, force: true })
  })
  const path = join(dir, 'settings.json')
  const store = new CursorModelSettingsStore(path)
  assert.deepEqual(store.get(), {})
  await store.set({
    visibleModels: ['composer-2.5', 'composer-2.5', 'grok-code'],
  })
  assert.deepEqual(new CursorModelSettingsStore(path).get(), {
    visibleModels: ['composer-2.5', 'grok-code'],
  })
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).visibleModels.length, 2)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.throws(
    () => validateCursorModelSettings({ visibleModels: 'all' }),
    /array/,
  )
  assert.throws(() => store.set({ visibleModels: [null] }), /array/)
  assert.deepEqual(store.get().visibleModels, ['composer-2.5', 'grok-code'])
  await store.set({})
  assert.deepEqual(new CursorModelSettingsStore(path).get(), {})
})
