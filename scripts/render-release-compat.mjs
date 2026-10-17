#!/usr/bin/env node
/**
 * render-release-compat.mjs — print the fixed DSH compatibility section for a
 * GitHub Release, derived mechanically from dsh-versions.txt and package.json.
 *
 * The release workflow (release.yml) embeds this section above the
 * auto-generated PR/commit notes so every release states the same support
 * contract docs/compatibility.md owns, without hand-editing. The derivation
 * mirrors scripts/check-compat-docs.mjs: the window comes from
 * dsh-versions.txt (comment lines, including the window-rule header, are
 * excluded) and the peer range from package.json, where every
 * `@deepseek-ai/dsh-*` peer carries the identical range — a disagreement
 * fails loudly instead of shipping a mixed statement.
 *
 * Usage:
 *   node scripts/render-release-compat.mjs [tag]
 *
 * tag defaults to `v<package.json version>`. Exit 1 on any derivation
 * failure; the section goes to stdout.
 *
 * No third-party dependencies: node built-ins only.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`render-release-compat: ${message}`)
  process.exit(1)
}

/** The window: commented and blank lines dropped, oldest first. */
function readWindow() {
  let text
  try {
    text = readFileSync(join(root, 'dsh-versions.txt'), 'utf8')
  } catch {
    fail('dsh-versions.txt is missing')
  }
  const versions = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
  if (versions.length === 0) fail('dsh-versions.txt lists no version')
  return versions
}

/** The shared peer range; every @deepseek-ai/dsh-* peer must carry it. */
function readPeerRange() {
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    fail('package.json is missing or not valid JSON')
  }
  const peers = Object.entries(pkg.peerDependencies ?? {}).filter(([name]) =>
    name.startsWith('@deepseek-ai/dsh-'),
  )
  if (peers.length === 0)
    fail('package.json declares no @deepseek-ai/dsh-* peer')
  const [first, range] = peers[0]
  for (const [name, other] of peers.slice(1)) {
    if (other !== range) {
      fail(`peer range mismatch: ${first} has ${range}, ${name} has ${other}`)
    }
  }
  return range
}

const window = readWindow()
const range = readPeerRange()

let pkgVersion = ''
let pkgName = ''
try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  pkgVersion = pkg.version
  pkgName = pkg.name
} catch {
  fail('package.json is missing or not valid JSON')
}
if (typeof pkgName !== 'string' || pkgName.length === 0)
  fail('package.json has no name')
const tag = process.argv[2] ?? `v${pkgVersion}`

const lines = [
  '## DSH compatibility',
  '',
  `- Tested with DSH: ${window.join(', ')}.`,
  `- Installable (peer range): \`${range}\`.`,
  `- Versions inside the range but outside the tested window install without the gate; use them at your own risk. Versions outside the range are rejected at install unless granted an exact exemption: \`dsh plugin --profile web allow-version ${pkgName}@<ver> --dsh-version <exact> --accept-risk\`.`,
  `- Install this release: \`dsh plugin --profile web add ${pkgName}@${pkgVersion}\` (or from source: \`dsh plugin --profile web add github:goodboys-ai/dsh-subscriptions#${tag}\`).`,
  '',
]

process.stdout.write(lines.join('\n'))
