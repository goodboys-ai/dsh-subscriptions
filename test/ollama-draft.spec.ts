import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  adoptCandidates, contextLabel, effortOptions, moveModel, parseContextInput, removeModel, renameModel, setModelContext,
  setModelEffort, tickModel, tickModels, untickModel, untickModels,
} from '../src/client/ollama-draft.js'
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
      efforts: ['low', 'high'],
    },
    { id: 'gpt-oss:cloud', name: 'gpt-oss' },
  ])
  assert.deepEqual(Object.keys(models[1]), ['id', 'name'])
  // defaultEffort is absent: the store records only the user's explicit
  // choice, so the vendor default keeps flowing from discovery.
  assert.deepEqual(Object.keys(models[0]), ['id', 'name', 'thinking', 'efforts'])
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

test('renameModel trims, keeps text, and clears an emptied name', () => {
  const models: OllamaModelDraft[] = [{ id: 'glm-5.3:cloud', name: 'GLM-5.3' }]
  // Keypresses store the raw text: trimming on every change would eat the
  // space a middle word needs; the input commits the trim on blur.
  assert.deepEqual(renameModel(models, 'glm-5.3:cloud', '  GLM-5.3 官方  '), [
    { id: 'glm-5.3:cloud', name: '  GLM-5.3 官方  ' },
  ])
  // An emptied display name deletes the field so the store validator keeps
  // accepting the draft, and the wire id remains the fallback label.
  assert.deepEqual(renameModel(models, 'glm-5.3:cloud', ''), [{ id: 'glm-5.3:cloud' }])
  assert.deepEqual(renameModel(models, 'unknown', 'x'), models)
})

test('setModelEffort writes a choice and clears it back to vendor priority', () => {
  const models: OllamaModelDraft[] = [{ id: 'glm-5.3:cloud', defaultEffort: 'low' }]
  assert.deepEqual(setModelEffort(models, 'glm-5.3:cloud', 'max'), [
    { id: 'glm-5.3:cloud', defaultEffort: 'max' },
  ])
  // Clearing removes the store default so the resolver falls back to the
  // vendor or family default (adoption never stores one).
  assert.deepEqual(setModelEffort(models, 'glm-5.3:cloud', ''), [{ id: 'glm-5.3:cloud' }])
  assert.deepEqual(setModelEffort(models, 'unknown', 'max'), models)
})

test('adoptCandidates never copies the vendor default effort', () => {
  const candidate: OllamaCloudCandidate = {
    id: 'glm-5.3:cloud', rawId: 'glm-5.3', name: 'glm-5.3',
    vision: false, thinking: true,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'max',
  }
  // Efforts are kept for the selector; the default stays unset so the
  // store records only the user's explicit choice.
  assert.deepEqual(adoptCandidates([], [candidate], ['glm-5.3:cloud']), [{
    id: 'glm-5.3:cloud',
    name: 'glm-5.3',
    thinking: true,
    efforts: ['low', 'high', 'max'],
  }])
})

const glm: OllamaCloudCandidate = {
  id: 'glm-5.3:cloud', rawId: 'glm-5.3', name: 'glm-5.3', vision: false, thinking: true,
  efforts: ['low', 'high'], defaultEffort: 'high',
}

test('unticking stashes the whole row and ticking restores it, even with no candidates', () => {
  const kept: OllamaModelDraft[] = [
    { id: 'legacy', name: 'Custom', defaultEffort: 'low', efforts: ['low', 'high'], contextOverride: 4096, maxTokens: 9000 },
    { id: 'other' },
  ]
  const off = untickModel(kept, new Map(), 'legacy')
  assert.deepEqual(off.models, [{ id: 'other' }])
  assert.deepEqual(off.stash.get('legacy'), kept[0])
  const on = tickModel(off.models, off.stash, [], 'legacy')
  // Restored verbatim (name, default effort, override, maxTokens); it
  // re-enters at the end, and the stash entry is consumed.
  assert.deepEqual(on.models, [{ id: 'other' }, kept[0]])
  assert.equal(on.stash.has('legacy'), false)
  assert.deepEqual(kept.map(model => model.id), ['legacy', 'other'])
})

test('ticking an id unknown to both the stash and the candidates changes nothing', () => {
  assert.deepEqual(tickModel([{ id: 'a' }], new Map(), [], 'ghost').models, [{ id: 'a' }])
  assert.deepEqual(untickModel([{ id: 'a' }], new Map(), 'ghost').models, [{ id: 'a' }])
})

test('first ticking adopts from the candidates without copying the vendor default', () => {
  const state = tickModel([], new Map(), [glm], 'glm-5.3:cloud')
  assert.deepEqual(state.models, [{ id: 'glm-5.3:cloud', name: 'glm-5.3', thinking: true, efforts: ['low', 'high'] }])
})

test('batch tick and untick act only on the listed ids and keep hidden rows', () => {
  const models: OllamaModelDraft[] = [{ id: 'hidden', name: 'Keep' }, { id: 'x', name: 'X' }]
  const off = untickModels(models, new Map(), ['x', 'not-listed'])
  assert.deepEqual(off.models, [{ id: 'hidden', name: 'Keep' }])
  const on = tickModels(off.models, off.stash, [glm], ['x', 'glm-5.3:cloud', 'x'])
  assert.deepEqual(on.models.map(model => model.id), ['hidden', 'x', 'glm-5.3:cloud'])
  assert.equal(on.models[1]?.name, 'X')
})

test('effortOptions keeps the selector inside the row efforts the store validates', () => {
  const row: OllamaModelDraft = { id: 'a', efforts: ['low', 'max'] }
  // A stale snapshot may label ids but never add 'high'.
  const options = effortOptions(row, ['low', 'max'], [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }])
  assert.deepEqual(options.map(option => option.id), ['low', 'max'])
  assert.equal(options[0]?.name, 'Low')
  assert.equal(options[1]?.name, 'max')
  // Without row efforts the latest fetch decides, then the snapshot.
  assert.deepEqual(effortOptions({ id: 'a' }, ['low'], [{ id: 'high', name: 'High' }]).map(option => option.id), ['low'])
  assert.deepEqual(effortOptions({ id: 'a' }, undefined, [{ id: 'high', name: 'High' }]).map(option => option.id), ['high'])
})

test('effortOptions marks a saved default the list no longer offers as unavailable', () => {
  const options = effortOptions({ id: 'a', efforts: ['low'], defaultEffort: 'high' }, undefined, undefined)
  assert.deepEqual(options, [{ id: 'low', name: 'low' }, { id: 'high', name: 'high', unavailable: true }])
})

test('setModelContext writes, clears, and ignores unknown ids; parseContextInput gates the text', () => {
  const models: OllamaModelDraft[] = [{ id: 'a', contextOverride: 1000 }]
  assert.deepEqual(setModelContext(models, 'a', 2000), [{ id: 'a', contextOverride: 2000 }])
  assert.deepEqual(setModelContext(models, 'a', undefined), [{ id: 'a' }])
  assert.deepEqual(setModelContext(models, 'ghost', 5), models)
  assert.equal(parseContextInput(' 4096 '), 4096)
  assert.equal(parseContextInput(''), undefined)
  for (const bad of ['0', '-5', '1.5', 'abc', '1e3', '99999999999999999999']) assert.equal(parseContextInput(bad), null)
})
