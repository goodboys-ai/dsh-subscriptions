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

// Compiled to lib-test/test/, so the repository root is two levels up.
const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'check-markdown-tables.mjs',
)

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-md-tables-'))
  const absoluteRoot = realpathSync(root)
  t.after(() => {
    assert.equal(realpathSync(root), absoluteRoot)
    assert.equal(dirname(absoluteRoot), realpathSync(tmpdir()))
    rmSync(absoluteRoot, { recursive: true, force: true })
  })
  return root
}

function file(root: string, path: string, text: string) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
}

function check(root: string) {
  const result = spawnSync(process.execPath, [script, '--dir', root], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  assert.ifError(result.error)
  return result
}

/** A one-column table whose header row is exactly `width` characters. */
function table(width: number) {
  const cell = 'a'.repeat(width - 4)
  const row = `| ${cell} |`
  assert.equal(row.length, width)
  return `${row}\n| --- |\n| ok |\n`
}

test('a table row of 120 characters passes', (t) => {
  const root = fixture(t)
  file(root, 'docs/notes.md', table(120))
  assert.equal(check(root).status, 0)
})

test('a table row of 121 characters fails and names the line', (t) => {
  const root = fixture(t)
  file(root, 'docs/notes.md', table(121))
  const result = check(root)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /docs\/notes\.md:1: 121 characters/)
  assert.match(result.stderr, /exceeds 120/)
})

test('a wide pipe row inside a fence is not a table', (t) => {
  const root = fixture(t)
  file(root, 'docs/notes.md', '```\n' + table(121) + '```\n')
  assert.equal(check(root).status, 0)
})

test('a long prose line that mentions a pipe is not a table', (t) => {
  const root = fixture(t)
  file(root, 'README.md', `${'word '.repeat(40)}a | b continues past 120.\n`)
  assert.equal(check(root).status, 0)
})

test('the upstream README snapshots are not checked', (t) => {
  const root = fixture(t)
  file(root, 'docs/upstream-README.md', table(200))
  file(root, 'docs/upstream-README.zh.md', table(200))
  assert.equal(check(root).status, 0)
})

test('a missing scan root exits 2', (t) => {
  const root = fixture(t)
  const result = check(join(root, 'missing'))
  assert.equal(result.status, 2)
  assert.match(result.stderr, /the check did not run/)
})
