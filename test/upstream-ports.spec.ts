import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const repo = process.cwd()
const fixtures = JSON.parse(readFileSync(join(repo, 'test/fixtures/upstream-ports/prose.json'), 'utf8')) as {
  sameStatus: { status: string; prose: string }[]
  mismatchedStatus: { status: string; prose: string }[]
  outsideStatusBullet: string
}

// Execute the real CLI in disposable local git repositories. No upstream or
// host-capability package is fetched; those integrations remain outside this fixture.
function withRepository(run: (root: string, baseline: string) => void) {
  const cache = join(repo, '.cache/tmp')
  mkdirSync(cache, { recursive: true })
  const root = mkdtempSync(join(cache, 'upstream-checker-'))
  try {
    git(root, 'init', '--quiet')
    git(root, 'config', 'user.name', 'Checker fixture')
    git(root, 'config', 'user.email', 'checker@example.invalid')
    git(root, 'commit', '--quiet', '--allow-empty', '-m', 'baseline')
    const baseline = git(root, 'rev-parse', 'HEAD')
    installChecker(root)
    run(root, baseline)
  } finally {
    // root is the exact mkdtemp result under this worktree, never an input path.
    assert.equal(resolve(root), root)
    assert.ok(root.startsWith(`${cache}/upstream-checker-`))
    rmSync(root, { recursive: true, force: true })
  }
}

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function installChecker(root: string) {
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'docs'), { recursive: true })
  copyFileSync(join(repo, 'scripts/check-upstream-ports.mjs'), join(root, 'scripts/check-upstream-ports.mjs'))
}

function ledger(root: string, baseline: string, status = 'ported', prose = fixtures.sameStatus[0]!.prose) {
  writeFileSync(join(root, 'docs/upstream-ports.json'), JSON.stringify({
    baseline: { sha: baseline },
    entries: [{
      upstream: 'deadbeef', subject: 'fixture', status, reason: 'Fixture decision',
      ...(status === 'ported' ? { forkCommits: [baseline] } : {}),
    }],
  }))
  // The checker also holds the prose to naming the baseline, so every fixture
  // prose carries it; the cases below are about the status bullets.
  writeFileSync(join(root, 'docs/upstream-sync.md'),
    `# Upstream sync\n\n## Sync point\n\n- **Baseline:** fixture \`${baseline}\`.\n${prose}\n## Other history\n`)
}

function checker(root: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/check-upstream-ports.mjs', ...args], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  })
  assert.ifError(result.error)
  return { code: result.status, output: result.stdout + result.stderr }
}

for (const fixture of fixtures.sameStatus) {
  test(`upstream checker accepts prose matching ${fixture.status}`, () => withRepository((root, baseline) => {
    ledger(root, baseline, fixture.status, fixture.prose)
    git(root, 'update-ref', 'refs/remotes/upstream/main', baseline)
    const result = checker(root, '--require-upstream')
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /remote enumeration ran/)
  }))
}

for (const [index, fixture] of fixtures.mismatchedStatus.entries()) {
  test(`upstream checker rejects mismatched status fixture ${index + 1}`, () => withRepository((root, baseline) => {
    ledger(root, baseline, fixture.status, fixture.prose)
    git(root, 'update-ref', 'refs/remotes/upstream/main', baseline)
    const result = checker(root, '--require-upstream')
    assert.equal(result.code, 1, result.output)
    // The kept implementation reports the mismatch from both directions: the
    // entry is missing from its own bullet, and the wrong bullet still names it.
    assert.match(result.output, /does not list deadbeef under .*for its ledger status/)
    assert.match(result.output, /lists deadbeef under .*but the ledger says/)
  }))
}

test('upstream checker does not count a SHA outside status bullets as a port', () => withRepository((root, baseline) => {
  ledger(root, baseline, 'ported', fixtures.outsideStatusBullet)
  const result = checker(root, '--local-only')
  assert.equal(result.code, 1, result.output)
  assert.match(result.output, /does not list deadbeef under .*for its ledger status "ported"/)
}))

test('missing upstream is explicit, required upstream exits 2, and local checks still run', () => withRepository((root, baseline) => {
  ledger(root, baseline)
  const optional = checker(root)
  assert.equal(optional.code, 0, optional.output)
  assert.match(optional.output, /remote enumeration cannot answer/)
  assert.doesNotMatch(optional.output, /: ok/)
  const required = checker(root, '--require-upstream')
  assert.equal(required.code, 2, required.output)
  assert.match(required.output, /local ledger checks ran \(ancestry ran\)/)
  assert.match(required.output, /SETUP FAILURE: cannot answer/)
  ledger(root, baseline, 'ported', fixtures.mismatchedStatus[0]!.prose)
  const driftAndSetup = checker(root, '--require-upstream')
  assert.equal(driftAndSetup.code, 2, driftAndSetup.output)
  assert.match(driftAndSetup.output, /lists deadbeef under "Open decisions"/)
}))

test('missing baseline cannot answer ancestry or enumeration, not a false finding', () => withRepository((root, baseline) => {
  ledger(root, 'a'.repeat(40))
  git(root, 'update-ref', 'refs/remotes/upstream/main', baseline)
  const optional = checker(root)
  assert.equal(optional.code, 0, optional.output)
  assert.match(optional.output, /local ancestry cannot answer/)
  assert.match(optional.output, /remote enumeration cannot answer/)
  const required = checker(root, '--require-upstream')
  assert.equal(required.code, 2, required.output)
  assert.doesNotMatch(required.output, /not an ancestor|unclassified upstream commit/)
}))

test('real shallow checkout cannot answer even when baseline and upstream ref exist', () => withRepository((root, baseline) => {
  git(root, 'commit', '--quiet', '--allow-empty', '-m', 'second commit')
  const shallowRoot = join(root, 'shallow')
  git(root, 'clone', '--quiet', '--depth=1', `file://${root}`, shallowRoot)
  assert.equal(git(shallowRoot, 'rev-parse', '--is-shallow-repository'), 'true')
  installChecker(shallowRoot)
  const tip = git(shallowRoot, 'rev-parse', 'HEAD')
  ledger(shallowRoot, tip)
  git(shallowRoot, 'update-ref', 'refs/remotes/upstream/main', tip)
  const optional = checker(shallowRoot)
  assert.equal(optional.code, 0, optional.output)
  assert.match(optional.output, /checkout is shallow/)
  assert.match(optional.output, /ancestry cannot answer/)
  assert.doesNotMatch(optional.output, /remote enumeration ran|not an ancestor/)
  const required = checker(shallowRoot, '--require-upstream')
  assert.equal(required.code, 2, required.output)
  assert.match(required.output, /SETUP FAILURE: cannot answer/)
  // A missing baseline in the same shallow clone must also remain unanswerable.
  ledger(shallowRoot, baseline)
  assert.equal(checker(shallowRoot, '--require-upstream').code, 2)
}))

test('successful enumeration reports the actual unclassified SHA with exit 1', () => withRepository((root, baseline) => {
  ledger(root, baseline)
  git(root, 'commit', '--quiet', '--allow-empty', '-m', 'unreviewed upstream change')
  const offending = git(root, 'rev-parse', 'HEAD')
  git(root, 'update-ref', 'refs/remotes/upstream/main', offending)
  const result = checker(root, '--require-upstream')
  assert.equal(result.code, 1, result.output)
  assert.ok(result.output.includes(`unclassified upstream commit ${offending.slice(0, 8)}: unreviewed upstream change`))
  assert.doesNotMatch(result.output, /SETUP FAILURE/)
}))

test('local-only never enumerates an available upstream and rejects require-upstream', () => withRepository((root, baseline) => {
  ledger(root, baseline)
  git(root, 'commit', '--quiet', '--allow-empty', '-m', 'unreviewed upstream change')
  git(root, 'update-ref', 'refs/remotes/upstream/main', 'HEAD')
  const result = checker(root, '--local-only')
  assert.equal(result.code, 0, result.output)
  assert.match(result.output, /remote enumeration not requested/)
  assert.equal(checker(root, '--local-only', '--require-upstream').code, 2)
}))
