#!/usr/bin/env node
/**
 * verify-agent-notes.mjs — lint the Agent Note tree under .agents/notes/.
 *
 * A slimmed-down port of deepseek-harness's agent-note gates: structure and
 * required sections only. Deliberately not checked: bilingual counterparts,
 * frozen archives, and exact header line-number grammar — DSH-scale
 * machinery this repo does not need. The rules enforced here are the ones
 * stated in .agents/notes/AGENTS.md.
 *
 * Checks:
 *  - every note lives at {proposed,implemented,rejected,archived}/{class}/YYYY-MM-DD-topic.md
 *    with class in the closed set {provider, architecture, process, testing};
 *  - no centralized index file (the tree is the index);
 *  - no legacy decision-record homes (docs/rfc, docs/rfcs, docs/adr);
 *  - line 1 is `# Agent Note: <title>`;
 *  - the `Status:` line matches the note's lifecycle folder
 *    (rejected carries ` — <why, in one line>`, archived carries
 *    ` — <successor note link>`);
 *  - the first `##` section is `## Problem`;
 *  - `## Alternatives considered` is present (mandatory);
 *  - implemented notes also carry `## Decision` and `## Consequences`;
 *    proposed notes also carry `## Proposal`, `## Acceptance criteria`,
 *    `## Risks`.
 *
 * Exit 0 when the tree conforms, 1 with one line per violation otherwise.
 * Usage: node scripts/verify-agent-notes.mjs
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const notesRoot = join(repoRoot, '.agents', 'notes')

const LIFECYCLES = ['proposed', 'implemented', 'rejected', 'archived']
const CLASSES = ['provider', 'architecture', 'process', 'testing']
const DATE_FILE = /^\d{4}-\d{2}-\d{2}-.+\.md$/

const errors = []
const fail = (msg) => errors.push(msg)

/** Strip fenced code blocks: format tokens inside examples are not structure. */
function proseLines(text) {
  let inFence = false
  return text.split('\n').filter((line) => {
    if (line.startsWith('```')) {
      inFence = !inFence
      return false
    }
    return !inFence
  })
}

function checkNote(rel, lifecycle) {
  const lines = proseLines(readFileSync(join(notesRoot, rel), 'utf8'))

  if (!/^# Agent Note: \S/.test(lines[0] ?? '')) {
    fail(`${rel}: line 1 must be \`# Agent Note: <title>\``)
  }
  const statusLines = lines.filter((l) => l.startsWith('Status:'))
  const want =
    lifecycle === 'rejected' || lifecycle === 'archived'
      ? new RegExp(`^Status: ${lifecycle} — .+`)
      : new RegExp(`^Status: ${lifecycle}$`)
  if (statusLines.length !== 1 || !want.test(statusLines[0])) {
    fail(
      `${rel}: must carry exactly one \`Status:\` line matching its folder ` +
        `(\`${want.source.replace(/^\^|\$$/g, '')}\`)`,
    )
  }

  const h2s = lines.filter((l) => l.startsWith('## ')).map((l) => l.trimEnd())
  if (h2s[0] !== '## Problem') {
    fail(
      `${rel}: the first section must be \`## Problem\` (got ${JSON.stringify(h2s[0] ?? '<none>')})`,
    )
  }
  const required =
    lifecycle === 'implemented' || lifecycle === 'archived'
      ? ['## Decision', '## Consequences']
      : lifecycle === 'proposed'
        ? ['## Proposal', '## Acceptance criteria', '## Risks']
        : []
  for (const section of required) {
    if (!h2s.includes(section))
      fail(`${rel}: missing the required \`${section}\` section`)
  }
  if (!h2s.includes('## Alternatives considered')) {
    fail(`${rel}: missing the mandatory \`## Alternatives considered\` section`)
  }
}

// Legacy decision-record homes must stay unavailable so notes cannot
// silently escape the tree.
for (const legacy of ['docs/rfc', 'docs/rfcs', 'docs/adr']) {
  if (existsSync(join(repoRoot, legacy))) {
    fail(
      `legacy-path: ${legacy}/ is forbidden — put Agent Notes under .agents/notes/`,
    )
  }
}

if (!existsSync(notesRoot)) {
  console.log('verify-agent-notes: no .agents/notes/ tree, nothing to check.')
  process.exit(0)
}

let count = 0
for (const entry of readdirSync(notesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    if (entry.name !== 'AGENTS.md') {
      fail(
        `structure: ${entry.name} — only AGENTS.md may live directly under .agents/notes/`,
      )
    }
    continue
  }
  if (!LIFECYCLES.includes(entry.name)) {
    fail(
      `structure: ${entry.name}/ — unknown lifecycle folder (allowed: ${LIFECYCLES.join(', ')})`,
    )
    continue
  }
  const lifecycleDir = join(notesRoot, entry.name)
  const found = []
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        walk(join(dir, e.name), relPath)
      } else if (e.name.endsWith('.md')) {
        found.push(relPath)
      }
    }
  }
  walk(lifecycleDir, '')
  for (const relPath of found.sort()) {
    if (relPath === 'INDEX.md' || relPath.endsWith('/INDEX.md')) {
      fail(
        `structure: ${entry.name}/${relPath} — centralized index files are forbidden; the tree is the index`,
      )
      continue
    }
    const segs = relPath.split('/')
    const cls = segs[0]
    const base = segs[segs.length - 1]
    if (segs.length !== 2 || !CLASSES.includes(cls) || !DATE_FILE.test(base)) {
      fail(
        `structure: ${entry.name}/${relPath} — expected {lifecycle}/{class}/YYYY-MM-DD-topic.md ` +
          `(class in: ${CLASSES.join(', ')})`,
      )
      continue
    }
    checkNote(`${entry.name}/${relPath}`, entry.name)
    count++
  }
}

if (errors.length > 0) {
  console.error('verify-agent-notes: violations found:')
  for (const e of errors) console.error(`  ${e}`)
  process.exit(1)
}

console.log(
  `verify-agent-notes: ${count} Agent Note(s) checked, all conform to .agents/notes/AGENTS.md.`,
)
