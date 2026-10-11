import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adoptCandidates, contextLabel, moveModel, removeModel } from '../src/client/ollama-draft.js'
import type { OllamaCloudCandidate, OllamaModelDraft } from '../src/client/ollama-draft.js'

const candidates: readonly OllamaCloudCandidate[] = [
  {
    id: 'glm-5.3:cloud', rawId: 'glm-5.3', name: 'glm-5.3', vision: false, thinking: true,
    efforts: ['low', 'high'], defaultEffort: 'high',
  },
  {
    id: 'qwen3-vl:cloud', rawId: 'qwen3-vl', name: 'qwen3-vl', vision: true, thinking: false,
    contextWindow: 262_144, efforts: [],
  },
  { id: 'gpt-oss:cloud', rawId: 'gpt-oss', name: 'gpt-oss', vision: false, thinking: false, efforts: [] },
]

test('adoptCandidates appends the checked candidates in candidate order', () => {
  const current: OllamaModelDraft[] = [{ id: 'zeta:cloud', name: 'zeta' }]
  const models = adoptCandidates(current, candidates, ['gpt-oss:cloud', 'qwen3-vl:cloud'])
  assert.deepEqual(models, [
    { id: 'zeta:cloud', name: 'zeta' },
    { id: 'qwen3-vl:cloud', name: 'qwen3-vl', contextWindow: 262_144, vision: true },
    { id: 'gpt-oss:cloud', name: 'gpt-oss' },
  ])
  // The source list is untouched and rows already present keep their identity.
  assert.equal(current.length, 1)
  assert.equal(adoptCandidates(undefined, candidates, ['glm-5.3:cloud'])[0]?.id, 'glm-5.3:cloud')
})

test('adoptCandidates copies capabilities and efforts and omits absent optional fields', () => {
  const models = adoptCandidates(undefined, candidates, ['glm-5.3:cloud', 'gpt-oss:cloud'])
  // deepEqual (strict) compares own keys, so an explicit `undefined` would fail here.
  assert.deepEqual(models, [
    {
      id: 'glm-5.3:cloud', name: 'glm-5.3', thinking: true,
      efforts: ['low', 'high'], defaultEffort: 'high',
    },
    { id: 'gpt-oss:cloud', name: 'gpt-oss' },
  ])
  assert.deepEqual(Object.keys(models[1]), ['id', 'name'])
  assert.deepEqual(Object.keys(models[0]), ['id', 'name', 'thinking', 'efforts', 'defaultEffort'])
})

test('adoptCandidates dedupes ids already in the draft and never replaces their rows', () => {
  const current: OllamaModelDraft[] = [
    { id: 'qwen3-vl:cloud', name: 'kept', contextWindow: 4096 },
    { id: 'zeta:cloud' },
  ]
  const models = adoptCandidates(current, candidates, ['qwen3-vl:cloud', 'gpt-oss:cloud'])
  assert.deepEqual(models, [
    { id: 'qwen3-vl:cloud', name: 'kept', contextWindow: 4096 },
    { id: 'zeta:cloud' },
    { id: 'gpt-oss:cloud', name: 'gpt-oss' },
  ])
  assert.equal(models[0], current[0])
  assert.equal(adoptCandidates(current, candidates, []).length, 2)
})

test('moveModel swaps neighbours and ignores an unknown id or an out-of-range move', () => {
  const models: OllamaModelDraft[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(moveModel(models, 'b', -1), [{ id: 'b' }, { id: 'a' }, { id: 'c' }])
  assert.deepEqual(moveModel(models, 'b', 1), [{ id: 'a' }, { id: 'c' }, { id: 'b' }])
  assert.deepEqual(moveModel(models, 'a', -1), models)
  assert.deepEqual(moveModel(models, 'c', 1), models)
  assert.deepEqual(moveModel(models, 'missing', 1), models)
  assert.deepEqual(models, [{ id: 'a' }, { id: 'b' }, { id: 'c' }])
})

test('removeModel drops one id and keeps the rest in order', () => {
  const models: OllamaModelDraft[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  assert.deepEqual(removeModel(models, 'b'), [{ id: 'a' }, { id: 'c' }])
  assert.deepEqual(removeModel(models, 'missing'), models)
  assert.deepEqual(models.length, 3)
})

test('contextLabel formats millions, thousands, small windows, and unknown values', () => {
  assert.equal(contextLabel(undefined), undefined)
  assert.equal(contextLabel(1_000_000), '1M')
  assert.equal(contextLabel(2_000_000), '2M')
  assert.equal(contextLabel(262_144), '262K')
  assert.equal(contextLabel(128_000), '128K')
  assert.equal(contextLabel(512), '512')
})
