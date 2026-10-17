import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

const budget = 300 * 1024
// Compiled to lib-test/test/, so the repository root is two levels up, the way
// test/host-contract.spec.ts locates src/client.
const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'check-image-budget.mjs',
)

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-image-budget-'))
  const absoluteRoot = realpathSync(root)
  t.after(() => {
    // Only remove the exact temporary root created for this test.
    assert.equal(realpathSync(root), absoluteRoot)
    assert.equal(dirname(absoluteRoot), realpathSync(tmpdir()))
    rmSync(absoluteRoot, { recursive: true, force: true })
  })
  return root
}

function file(root: string, path: string, size: number) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  // The check measures bytes, not image content; no encoder is needed.
  writeFileSync(target, Buffer.alloc(size))
}

function check(root: string) {
  // Exercise the CLI because scripts/*.mjs are not part of the TS test build.
  const result = spawnSync(process.execPath, [script, '--dir', root], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.ifError(result.error)
  return result
}

test('a PR still exactly at 300 KiB passes', (t) => {
  const root = fixture(t)
  file(root, 'docs/assets/pr-27/dialog-after.png', budget)
  assert.equal(check(root).status, 0)
})

test('a PR still one byte over the budget fails and names the file', (t) => {
  const root = fixture(t)
  const path = 'docs/assets/pr-27/nested/dialog-after.png'
  file(root, path, budget + 1)
  const result = check(root)
  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes(path))
  assert.match(result.stderr, /307201 bytes.*exceeds 307200 bytes/)
})

for (const extension of ['gif', 'mp4', 'webm', 'mov']) {
  test(`a .${extension} recording in a PR directory fails`, (t) => {
    const root = fixture(t)
    const path = `docs/assets/pr-27/dialog.${extension}`
    file(root, path, 1)
    const result = check(root)
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes(path))
    assert.match(result.stderr, /1 bytes.*recordings are forbidden/)
  })
}

test('an oversized documentation bitmap outside PR assets is ignored', (t) => {
  const root = fixture(t)
  file(root, 'docs/images/screenshot.png', budget + 1)
  assert.equal(check(root).status, 0)
})

test('a missing scan root exits 2', (t) => {
  const root = fixture(t)
  const result = check(join(root, 'missing'))
  assert.equal(result.status, 2)
  assert.match(result.stderr, /the check did not run/)
})

test('a scan root that is a file exits 2', (t) => {
  const root = fixture(t)
  file(root, 'not-a-directory', 0)
  const result = check(join(root, 'not-a-directory'))
  assert.equal(result.status, 2)
  assert.match(result.stderr, /scan root is not a directory/)
})
