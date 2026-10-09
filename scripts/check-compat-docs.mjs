#!/usr/bin/env node
/**
 * check-compat-docs.mjs — hold the four compatibility statements to one
 * derivation from dsh-versions.txt.
 *
 * The support window is stated in four places that a human edits by hand:
 * the peer range in package.json, the "tested with DSH" sentence in README.md,
 * the peers line above the table in docs/compatibility.md, and the table's own
 * version rows. A window edit that touches some of them and not others leaves
 * the docs contradicting the install gate, which users read before they file
 * an issue. This script derives the expected values from the single source of
 * truth and fails on any disagreement.
 *
 * It also holds the two places docs/compatibility.md names the plugin's own
 * version to package.json. A release that bumps package.json but not the prose
 * leaves the repository claiming a version it is not, and nothing else catches
 * it: the published tarball carries README.md only, so a drift here is invisible
 * to a user and survives until someone reads the file.
 *
 * The derivation is version-independent: it reads the window, not a host. CI
 * therefore runs it exactly once rather than in the per-version matrix.
 *
 * Usage:
 *   node scripts/check-compat-docs.mjs
 *
 * Exit 0 when all four agree, 1 when any disagrees (printing expected vs
 * actual), and 2 when a file cannot be read or a statement cannot be found, so
 * a renamed heading says "this check did not run" instead of passing silently.
 *
 * No third-party dependencies: node 24 built-ins only, so the check runs
 * before `pnpm install` in CI.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The statements that must agree, in the order they are reported. */
class SetupFailure extends Error {}

/**
 * The window: commented and blank lines dropped, oldest first.
 * @returns {string[]} the versions dsh-versions.txt lists.
 */
function readWindow() {
  let text
  try {
    text = readFileSync(join(root, 'dsh-versions.txt'), 'utf8')
  } catch {
    throw new SetupFailure('dsh-versions.txt is missing')
  }
  const versions = text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('#'))
  if (versions.length === 0) throw new SetupFailure('dsh-versions.txt lists no version')
  return versions
}

/**
 * The one bounded peer range the window implies: floor to the minor line
 * after the newest entry, excluding that line's prereleases.
 *
 * `nextMinor` is the newest entry's major with its minor incremented. The
 * `-0` suffix is load-bearing (see docs/compatibility.md): `<0.3.0` would
 * admit `0.3.0-rc.1`, while `<0.3.0-0` excludes the whole next minor line.
 *
 * @param {string[]} window - window versions, oldest first.
 * @returns {string} the peer range, e.g. `>=0.1.7-rc.2 <0.3.0-0`.
 */
function expectedPeerRange(window) {
  const newest = window[window.length - 1]
  const match = /^(\d+)\.(\d+)\./.exec(newest)
  if (match === null) throw new SetupFailure(`the newest window entry ${JSON.stringify(newest)} is not a version`)
  const nextMinor = `${match[1]}.${Number(match[2]) + 1}.0`
  return `>=${window[0]} <${nextMinor}-0`
}

/** Read one repo file, or fail the check as not-run. */
function read(rel) {
  try {
    return readFileSync(join(root, rel), 'utf8')
  } catch {
    throw new SetupFailure(`${rel} is missing`)
  }
}

/** Collapse prose to one line so a sentence can wrap across source lines. */
const unwrap = (text) => text.replace(/\s+/g, ' ')

/** Every backtick-quoted token in a string. */
const backticks = (text) => [...text.matchAll(/`([^`]+)`/g)].map(match => match[1])

const failures = []
const fail = (what, expected, actual) => {
  failures.push({ what, expected, actual })
}

/** Compare a list by exact contents, order-insensitively, for reporting. */
const sorted = (list) => [...list].sort()

// --- package.json: the six @deepseek-ai/dsh-* peers -------------------------

const peersOf = (pkg) => Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))

function checkPackagePeers(window, expectedRange) {
  let pkg
  try {
    pkg = JSON.parse(read('package.json'))
  } catch (error) {
    if (error instanceof SetupFailure) throw error
    throw new SetupFailure('package.json is not valid JSON')
  }
  const peers = peersOf(pkg)
  if (peers.length === 0) throw new SetupFailure('package.json declares no @deepseek-ai/dsh-* peer')
  for (const [name, range] of peers) {
    if (range !== expectedRange) fail(`package.json peer ${name}`, expectedRange, range)
  }
}

// --- README.md: the "tested with DSH" sentence and its peer range -----------

/**
 * The README sentence, e.g. "Current source is tested with DSH `a`, `b`, and
 * `c`." Returns the versions it lists and the range it names.
 *
 * The sentence ends at a period followed by whitespace: a bare `.` cannot
 * terminate it, because every version in the list contains one.
 */
function parseReadme(text) {
  const readme = unwrap(text)
  const sentence = /Current source is tested with DSH (.*?)\.(?=\s|$)/.exec(readme)
  if (sentence === null) throw new SetupFailure("README.md has no 'Current source is tested with DSH …' sentence")
  const listed = backticks(sentence[1]).filter(token => /^\d/.test(token))
  if (listed.length === 0) throw new SetupFailure('the README sentence names no version')
  // The peer range in README carries the comparison operators, so it is the
  // backticked token that starts with `>=`.
  const range = backticks(readme).find(token => token.startsWith('>='))
  if (range === undefined) throw new SetupFailure('README.md names no `>=… <…` peer range')
  return { listed, range }
}

function checkReadme(window, expectedRange) {
  const { listed, range } = parseReadme(read('README.md'))
  if (sorted(listed).join(' ') !== sorted(window).join(' ')) {
    fail('README.md tested-with versions', window.join(', '), listed.join(', '))
  }
  if (range !== expectedRange) fail('README.md peer range', expectedRange, range)
}

// --- docs/compatibility.md: the table rows and the peers sentence -----------

/** The version in the first column of each compatibility table row. */
function parseTableVersions(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const match = /^\|\s*`([^`]+)`\s*\|/.exec(line)
    if (match !== null) rows.push(match[1])
  }
  return rows
}

/** The peer range in the sentence above the table ("Current source version …, peers `…`"). */
function parsePeersSentence(text) {
  const match = /peers\s+`([^`]+)`/.exec(unwrap(text))
  if (match === null) throw new SetupFailure("docs/compatibility.md has no 'peers `…`' sentence")
  return match[1]
}

function checkCompatibilityDoc(window, expectedRange) {
  const text = read('docs/compatibility.md')
  const versions = parseTableVersions(text)
  if (versions.length === 0) throw new SetupFailure('docs/compatibility.md has no compatibility table rows')
  if (sorted(versions).join(' ') !== sorted(window).join(' ')) {
    fail('docs/compatibility.md table versions', window.join(', '), versions.join(', '))
  }
  const range = parsePeersSentence(text)
  if (range !== expectedRange) fail('docs/compatibility.md peers sentence', expectedRange, range)
}

// --- the plugin's own version, stated twice in docs/compatibility.md -------

/**
 * The two sentences that name the plugin version rather than the DSH window.
 * Both are matched by their shape so a reworded sentence reports "the check did
 * not run" instead of passing.
 * @returns {{ label: string, version: string }[]}
 */
function readStatedPluginVersions() {
  const text = read('docs/compatibility.md')
  const statements = [
    { label: 'docs/compatibility.md source target', pattern: /The source targets `([^`]+)`/ },
    { label: 'docs/compatibility.md current source version', pattern: /current source version `([^`]+)` supports/ },
  ]
  return statements.map(({ label, pattern }) => {
    const match = pattern.exec(text)
    if (match === null) throw new SetupFailure(`${label} is missing from docs/compatibility.md`)
    return { label, version: match[1] }
  })
}

/** The plugin version this repository's package.json declares. */
function readPluginVersion() {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    throw new SetupFailure('package.json is not valid JSON')
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new SetupFailure('package.json declares no version')
  }
  return manifest.version
}

/**
 * @param {string} expected the version package.json declares
 */
function checkStatedPluginVersions(expected) {
  for (const { label, version } of readStatedPluginVersions()) {
    if (version !== expected) fail(label, expected, version)
  }
}

// --- run --------------------------------------------------------------------

let window
let expectedRange
try {
  window = readWindow()
  expectedRange = expectedPeerRange(window)
  checkPackagePeers(window, expectedRange)
  checkReadme(window, expectedRange)
  checkCompatibilityDoc(window, expectedRange)
  checkStatedPluginVersions(readPluginVersion())
} catch (error) {
  if (error instanceof SetupFailure) {
    console.error(`check-compat-docs: ${error.message}; the check did not run`)
    process.exit(2)
  }
  throw error
}

if (failures.length > 0) {
  console.error('check-compat-docs: the compatibility statements disagree with dsh-versions.txt:')
  for (const { what, expected, actual } of failures) {
    console.error(`  ${what}`)
    console.error(`    expected: ${expected}`)
    console.error(`    actual:   ${actual}`)
  }
  console.error(`  window (dsh-versions.txt): ${window.join(', ')}`)
  process.exit(1)
}

console.log(`check-compat-docs: ok — window ${window.join(', ')}, peers ${expectedRange}, consistent across dsh-versions.txt, package.json, README.md, and docs/compatibility.md, and docs/compatibility.md names the plugin version package.json declares.`)
