#!/usr/bin/env node
/**
 * check-upstream-ports.mjs — hold the upstream-port ledger to what the tree
 * actually contains.
 *
 * docs/upstream-ports.json records how every upstream commit since the
 * baseline was treated in this fork. A ledger that can quietly go stale is
 * worse than none: it looks like a decision record while proving nothing. The
 * failure modes this script exists to stop are concrete, not stylistic:
 *
 *   1. A commit that was never looked at is missing from the ledger. The most
 *      expensive case is a must-fix that nobody classified.
 *   2. A ledger row claims a fork commit that is not in our history, so the
 *      port cannot be reproduced or bisected.
 *   3. A decline has no reason, or points at evidence that does not exist.
 *   4. A decline rests on a host-capability claim, and the named host package
 *      contradicts it. This one exists because of a real mistake: eb42966 was
 *      declined here on the claim that no host consumes IMAGE_OFFLOAD_REQUIRED,
 *      while every supported host ships the executor that does. A claim about
 *      the host is only allowed if the script can re-check it against the
 *      published package.
 *   5. The recorded baseline is not a common ancestor, so the ledger describes
 *      a history this branch is not on.
 *   6. docs/upstream-sync.md disagrees with the ledger.
 *
 * Usage:
 *   node scripts/check-upstream-ports.mjs            # check the ledger
 *   node scripts/check-upstream-ports.mjs --upstream <ref>
 *
 * Exit 0 when every check passes, 1 on a finding (each printed), and 2 when a
 * check could not run — a missing file, an unresolvable ref, a host package
 * that is not in the contract cache — so a broken setup reads as "this did not
 * run" instead of a silent pass. Node 24 built-ins only: this runs before
 * `pnpm install` in CI, like check-compat-docs.mjs.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const LEDGER = join(root, 'docs/upstream-ports.json')
const PROSE = join(root, 'docs/upstream-sync.md')
/** Where check-host-contract.mjs keeps the published host packages. */
const HOST_CACHE = join(root, '.cache/tmp/dsh-host-contract')

class SetupFailure extends Error {}

/** @returns {string[]} git output lines. */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  } catch (error) {
    throw new SetupFailure(`git ${args.join(' ')} failed: ${error.message.split('\n')[0]}`)
  }
}

/**
 * Whether git exited zero. Several checks here ask a yes/no question whose
 * answer is the exit status, and `git merge-base --is-ancestor` deliberately
 * exits non-zero — so these must not be routed through {@link git}.
 */
function gitOk(args) {
  try {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Abbreviate the way the ledger records them. */
const short = sha => sha.slice(0, 8)

/**
 * The upstream commits the ledger must account for. Merge commits are skipped:
 * they introduce no work of their own, and listing nine of them as
 * "not-applicable" would bury the entries that carry a decision.
 */
function upstreamCommits(baseline, ref) {
  return git(['rev-list', '--no-merges', `${baseline}..${ref}`])
}

/** Load and shape-check the ledger. */
function loadLedger() {
  if (!existsSync(LEDGER)) throw new SetupFailure('docs/upstream-ports.json is missing')
  let data
  try {
    data = JSON.parse(readFileSync(LEDGER, 'utf8'))
  } catch (error) {
    throw new SetupFailure(`docs/upstream-ports.json does not parse: ${error.message}`)
  }
  for (const key of ['baseline', 'entries']) {
    if (data[key] === undefined) throw new SetupFailure(`the ledger has no "${key}"`)
  }
  if (!Array.isArray(data.entries)) throw new SetupFailure('"entries" must be an array')
  const seen = new Set()
  for (const entry of data.entries) {
    for (const key of ['upstream', 'subject', 'status', 'reason']) {
      if (entry[key] === undefined) throw new SetupFailure(`a ledger entry is missing "${key}": ${JSON.stringify(entry.upstream)}`)
    }
    if (seen.has(entry.upstream)) throw new SetupFailure(`upstream ${short(entry.upstream)} is listed twice`)
    seen.add(entry.upstream)
    if (!['ported', 'already-covered', 'declined', 'not-applicable', 'pending'].includes(entry.status)) {
      throw new SetupFailure(`${short(entry.upstream)} has unknown status "${entry.status}"`)
    }
  }
  return data
}

/**
 * Locate one published host package, reusing the cache check-host-contract.mjs
 * fills and fetching it when the claim names something outside our peer range
 * (dsh-base, for instance, which the plugin never installs but the host always
 * mounts). Claims about the host must be checkable by CI, which checks out this
 * repository alone.
 * @returns {string} the directory holding the extracted package.
 */
function hostPackageDir(name, version) {
  const dir = join(HOST_CACHE, version, 'node_modules', name)
  if (existsSync(join(dir, 'package.json'))) return dir
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-port-claim-'))
  try {
    execFileSync('npm', ['pack', `${name}@${version}`, '--silent', '--pack-destination', scratch], { stdio: 'ignore' })
    const tarball = readdirSync(scratch).find(file => file.endsWith('.tgz'))
    if (tarball === undefined) throw new Error('npm pack produced no tarball')
    execFileSync('tar', ['xzf', join(scratch, tarball), '-C', scratch, '--strip-components=1'], { stdio: 'ignore' })
    mkdirSync(dir, { recursive: true })
    cpSync(scratch, dir, { recursive: true })
    return dir
  } catch (error) {
    throw new SetupFailure(`${name}@${version} is not in the host cache and could not be fetched: ${error.message.split('\n')[0]}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Re-check a claim that the host lacks or has something. The package is fetched
 * on demand so the claim is verifiable in CI.
 * @returns {string|null} a finding, or null when the claim holds.
 */
function checkCapabilityClaim(entry) {
  const claim = entry.capabilityClaim
  if (claim === undefined) return null
  for (const key of ['package', 'symbol', 'versions']) {
    if (claim[key] === undefined) throw new SetupFailure(`${short(entry.upstream)}: capabilityClaim needs "${key}"`)
  }
  for (const version of claim.versions) {
    const packageDir = hostPackageDir(claim.package, version)
    if (!existsSync(join(packageDir, 'package.json'))) {
      throw new SetupFailure(`${short(entry.upstream)}: ${claim.package}@${version} could not be fetched for verification`)
    }
    // Grep the published sources, not one file: a claim may be answered by a
    // patch manifest or by runtime code, and which one moved between versions.
    const text = execFileSync('sh', ['-c', `cat ${JSON.stringify(packageDir)}/* 2>/dev/null || true`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    if (claim.expect === 'absent' && text.includes(claim.symbol)) {
      return `${short(entry.upstream)}: claims ${claim.symbol} is absent from ${claim.package}@${version}, but that package contains it`
    }
    if (claim.expect === 'present' && !text.includes(claim.symbol)) {
      return `${short(entry.upstream)}: claims ${claim.symbol} is present in ${claim.package}@${version}, but that package does not contain it`
    }
  }
  return null
}

/** Every way the ledger can be wrong, in one pass. */
function check() {
  const findings = []
  const ledger = loadLedger()
  const baseline = ledger.baseline.sha
  const upstreamRef = process.argv.includes('--upstream')
    ? process.argv[process.argv.indexOf('--upstream') + 1]
    : 'refs/remotes/upstream/main'
  const haveUpstream = gitOk(['cat-file', '-e', `${upstreamRef}^{commit}`])
  // CI checks out this repository alone, so the upstream ref is absent there by
  // design. The sync checks are the ones that need it, and a nightly lane
  // passes --require-upstream so they cannot silently stop running.
  const requireUpstream = process.argv.includes('--require-upstream')
  if (!haveUpstream) {
    if (requireUpstream) throw new SetupFailure(`upstream ref ${upstreamRef} is not available; fetch it first`)
    console.error('check-upstream-ports: no upstream ref here, skipping the sync checks (use --require-upstream to make that fatal)')
  }

  // CI checks out a single commit, so the baseline is usually absent there for
  // the same reason the upstream ref is. Anything that needs history is a sync
  // check, and they all report themselves rather than failing the gate.
  const haveBaseline = gitOk(['cat-file', '-e', `${baseline}^{commit}`])
  if (!haveBaseline && requireUpstream) {
    throw new SetupFailure(`baseline ${short(baseline)} is not in this repository; fetch full history`)
  }
  // A shallow clone has the tip and nothing else, so every ancestry question is
  // unanswerable rather than false. Say which checks were skipped instead of
  // reporting each old commit as fabricated.
  const shallow = git(['rev-parse', '--is-shallow-repository'])[0] === 'true'
  if (!haveBaseline || shallow) {
    console.error(`check-upstream-ports: ${shallow ? 'shallow' : 'incomplete'} history, skipping the ancestry and enumeration checks`)
  }

  if (haveUpstream && haveBaseline) {
    // 5. The baseline must be a common ancestor of us and the recorded upstream.
    if (!gitOk(['merge-base', '--is-ancestor', baseline, 'HEAD'])) {
      findings.push(`baseline ${short(baseline)} is not an ancestor of HEAD: the ledger describes history this branch is not on`)
    }
    if (!gitOk(['merge-base', '--is-ancestor', baseline, upstreamRef])) {
      findings.push(`baseline ${short(baseline)} is not an ancestor of ${upstreamRef}`)
    }
    // 1. Every upstream commit is classified exactly once.
    const listed = new Set(ledger.entries.map(entry => entry.upstream).concat(ledger.entries.map(entry => short(entry.upstream))))
    for (const sha of upstreamCommits(baseline, upstreamRef)) {
      if (!listed.has(sha) && !listed.has(short(sha))) {
        findings.push(`unclassified upstream commit ${short(sha)}: ${git(['log', '-1', '--format=%s', sha])[0] ?? ''}`)
      }
    }
  }

  const canCheckAncestry = !shallow && haveBaseline
  for (const entry of ledger.entries) {
    const id = short(entry.upstream)
    // 2. A port must point at commits that are really in our history.
    if (canCheckAncestry) {
      for (const forkCommit of entry.forkCommits ?? []) {
        if (!gitOk(['cat-file', '-e', `${forkCommit}^{commit}`])) {
          findings.push(`${id}: fork commit ${short(forkCommit)} is not in this repository`)
        } else if (!gitOk(['merge-base', '--is-ancestor', forkCommit, 'HEAD'])) {
          findings.push(`${id}: fork commit ${short(forkCommit)} is not an ancestor of HEAD`)
        }
      }
    }
    if (entry.status === 'ported' && (entry.forkCommits ?? []).length === 0) {
      findings.push(`${id}: marked ported but names no fork commit`)
    }
    // 3. Evidence has to exist.
    for (const [kind, path] of Object.entries(entry.evidence ?? {})) {
      if (!existsSync(join(root, path))) findings.push(`${id}: ${kind} evidence ${path} does not exist`)
    }
    if (entry.status === 'declined' && !entry.reason.trim()) {
      findings.push(`${id}: declined without a reason`)
    }
    // 4. A host-capability claim is re-checked against the published package.
    const claim = checkCapabilityClaim(entry)
    if (claim !== null) findings.push(claim)
    if (entry.capabilityClaim !== undefined && entry.evidence?.test === undefined && entry.status === 'declined') {
      findings.push(`${id}: a capability claim needs a test to back it`)
    }
  }

  // 6. The prose Sync point may not drift from the ledger.
  if (existsSync(PROSE)) {
    const prose = readFileSync(PROSE, 'utf8')
    const proseShas = new Set((prose.match(/\b[0-9a-f]{7,40}\b/g) ?? []).map(sha => sha.slice(0, 8)))
    for (const entry of ledger.entries) {
      if (entry.status === 'ported' && !proseShas.has(short(entry.upstream))) {
        findings.push(`docs/upstream-sync.md does not mention ported commit ${short(entry.upstream)}; the ledger and the prose have drifted`)
      }
    }
  } else {
    throw new SetupFailure('docs/upstream-sync.md is missing')
  }

  return findings
}

try {
  const findings = check()
  if (findings.length > 0) {
    console.error('check-upstream-ports: findings\n')
    for (const finding of findings) console.error(`  - ${finding}`)
    process.exit(1)
  }
  const ledger = loadLedger()
  const counts = ledger.entries.reduce((acc, entry) => ({ ...acc, [entry.status]: (acc[entry.status] ?? 0) + 1 }), {})
  console.log(`check-upstream-ports: ok — ${ledger.entries.length} commits classified (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')})`)
} catch (error) {
  console.error(`check-upstream-ports SETUP FAILURE: ${error.message}`)
  process.exit(2)
}