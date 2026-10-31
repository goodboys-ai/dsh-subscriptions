import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  modelEditorNotice,
  modelEditorState,
  modelListState,
  savedModelIds,
} from '../src/client/model-filter.js'
import { en, zh } from '../src/client/locales.js'

test('an empty provider is distinct from a query with no matches', () => {
  assert.equal(modelListState(0, 0), 'provider-empty')
  assert.equal(modelListState(3, 0), 'filter-empty')
  assert.equal(modelListState(3, 1), 'rows')
  assert.equal(modelListState(3, 3), 'rows')
})

test('saved visibility and speed ids remain editable and deduplicated', () => {
  assert.deepEqual(savedModelIds(['a', 'a'], undefined), ['a'])
  assert.deepEqual(savedModelIds(undefined, undefined), [])
  assert.deepEqual(
    savedModelIds(['shared'], { shared: 'standard', extra: 'fast' }),
    ['shared', 'extra'],
  )
  const saved = savedModelIds(undefined, { 'saved-codex': 'fast' })
  assert.equal(
    modelEditorState({
      discovered: 0,
      saved: saved.length,
      matched: saved.length,
      accounts: [],
    }).listState,
    'rows',
  )
  assert.equal(modelListState(1, 0), 'filter-empty')
})

test('the empty-provider notice follows account discovery evidence', () => {
  assert.equal(modelEditorNotice(undefined), 'noModels')
  assert.equal(modelEditorNotice([]), 'noAccount')
  assert.equal(
    modelEditorNotice([
      { key: 'a', label: 'A', models: [], unavailable: true },
    ]),
    'discoveryFailed',
  )
  assert.equal(
    modelEditorNotice([
      { key: 'a', label: 'A', models: [], unavailable: true },
      { key: 'b', label: 'B', models: [], unavailable: true },
    ]),
    'discoveryFailed',
  )
  assert.equal(
    modelEditorNotice([{ key: 'a', label: 'A', models: [] }]),
    'noModels',
  )
  assert.equal(
    modelEditorNotice([
      { key: 'a', label: 'A', models: [], unavailable: true },
      { key: 'b', label: 'B', models: [] },
    ]),
    'noModels',
  )
})

test('the combined decision counts saved rows before selecting a notice', () => {
  assert.deepEqual(
    modelEditorState({ discovered: 0, saved: 0, matched: 0, accounts: [] }),
    {
      listState: 'provider-empty',
      noticeKey: 'modelDefaultsNoAccount',
    },
  )
  assert.deepEqual(
    modelEditorState({ discovered: 0, saved: 2, matched: 2, accounts: [] }),
    { listState: 'rows', noticeKey: 'modelDefaultsNoAccount' },
  )
  assert.deepEqual(
    modelEditorState({
      discovered: 3,
      saved: 0,
      matched: 0,
      accounts: [{ key: 'a', label: 'A', models: [] }],
    }),
    { listState: 'filter-empty', noticeKey: 'modelDefaultsNoModels' },
  )
  assert.deepEqual(
    modelEditorState({
      discovered: 0,
      saved: 0,
      matched: 0,
      accounts: [{ key: 'a', label: 'A', models: [], unavailable: true }],
    }),
    {
      listState: 'provider-empty',
      noticeKey: 'modelDefaultsDiscoveryFailed',
    },
  )
})

test('every empty-state notice has distinct bilingual copy', () => {
  const keys = [
    'modelDefaultsNoModels',
    'modelDefaultsNoAccount',
    'modelDefaultsDiscoveryFailed',
  ] as const
  for (const key of keys) {
    assert.ok(en[key].length > 0, key)
    assert.ok(zh[key].length > 0, key)
    assert.match(zh[key], /[\u4e00-\u9fff]/, key)
  }
  assert.match(en.modelDefaultsNoAccount, /account/i)
  assert.match(en.modelDefaultsDiscoveryFailed, /refresh/i)
})
