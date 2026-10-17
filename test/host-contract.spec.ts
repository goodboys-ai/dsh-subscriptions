/**
 * src/client/host-contract.ts is only useful while it lists every runtime host
 * name the client uses. scripts/check-host-contract.mjs checks the listed
 * names against each DSH version, but it cannot see a name that was never
 * listed. This spec scans the client source for the host names it uses and
 * requires each one to be in the manifest. It also rejects a manifest entry
 * no code uses any more, so the manifest does not grow stale.
 *
 * The scan is textual, not a type-aware analysis. It reads string literals in
 * any quote style, and it covers these ways of reaching the host:
 * `slots.inject`, `ctx.get`/`scope.get`, `inject` lists, services read as
 * `ctx.<name>`, `var(--dsw-…)`, `[data-…]` attribute selectors, `hostIcon`,
 * and value imports from `@deepseek-ai/*`, named or namespace. A host name
 * built at runtime, or a new way of reaching the host, is invisible to it;
 * the last tests pin the forms it must catch, so a narrowed pattern fails.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { HOST_CONTRACT } from '../src/client/host-contract.js'

// Compiled to <outDir>/test/, two levels below the repository root.
const clientDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'client')
const sources = readdirSync(clientDir)
  .filter(file => /\.tsx?$/.test(file) && file !== 'host-contract.ts')
  .map(file => ({ file, code: stripComments(readFileSync(join(clientDir, file), 'utf8')) }))

/** Drop comments, so prose that names a host API is not read as a use of it. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
}

/** A string literal in any quote style; group `q` is the quote, `v` the text. */
const LITERAL = String.raw`(?<q>['"\`])(?<v>(?:(?!\k<q>)[^\\]|\\.)*)\k<q>`

/** Host names one pattern finds in `code`, from its `name` group. */
function namesIn(code: string, pattern: RegExp): Set<string> {
  const found = new Set<string>()
  for (const match of code.matchAll(pattern)) {
    const name = match.groups?.name
    if (name !== undefined) found.add(name)
  }
  return found
}

/** What each check scans for; exported to the scanner self-tests below. */
const SCANNERS = {
  slots: (code: string) => namesIn(code, new RegExp(String.raw`slots\.inject\(\s*(['"\`])(?<name>[^'"\`]+)\1`, 'g')),
  services: (code: string) => {
    const found = namesIn(code, new RegExp(String.raw`\b(?:ctx|scope)\.get\(\s*(['"\`])(?<name>[^'"\`]+)\1`, 'g'))
    const lists = [
      ...code.matchAll(/export const inject\s*=\s*\[([^\]]*)\]/g),
      ...code.matchAll(/\.inject\(\s*\[([^\]]*)\]/g),
    ]
    for (const [, list] of lists) {
      for (const name of namesIn(list as string, /(['"`])(?<name>[^'"`]+)\1/g)) found.add(name)
    }
    // Services the host merges into Context (`ctx.slots`, `ctx.locale`).
    // Context's own members are not host services. Only `ctx` is read this
    // way: the client also names DOM nodes `scope`.
    for (const name of namesIn(code, /\bctx\.(?<name>[A-Za-z_$][\w$]*)/g)) {
      if (!CONTEXT_MEMBERS.has(name)) found.add(name)
    }
    return found
  },
  tokens: (code: string) => namesIn(code, /var\(\s*(?<name>--dsw-[a-z0-9-]+)/g),
  markers: (code: string) => {
    const found = new Set<string>()
    for (const match of code.matchAll(new RegExp(LITERAL, 'g'))) {
      for (const name of namesIn(match.groups?.v ?? '', /\[\s*(?<name>data-[a-z0-9-]+)\s*[\]=~|^$*]/g)) found.add(name)
    }
    return found
  },
  icons: (code: string) => namesIn(code, new RegExp(String.raw`hostIcon\([^,]+,\s*(['"\`])(?<name>[^'"\`]+)\1`, 'g')),
  imports: (code: string) => {
    const found = new Set<string>()
    // The clause holds no quote, so one match never spans two statements.
    const statements = /^import\s+(?!type\b)([^'"`;]*?)\s+from\s+(['"])(@deepseek-ai\/[^'"]+)\2/gm
    for (const [, clause, , from] of code.matchAll(statements)) {
      const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause as string)
      if (namespace !== null) {
        // A namespace import is read member by member; hostIcon() reads by
        // a name the icons check covers, so only `ns.Member` counts here.
        const alias = namespace[1] as string
        for (const name of namesIn(code, new RegExp(String.raw`\b${alias}\.(?<name>[A-Za-z_$][\w$]*)`, 'g'))) {
          found.add(`${from} ${name}`)
        }
        for (const name of namesIn(code, new RegExp(String.raw`\b${alias}\[\s*(['"\`])(?<name>[^'"\`]+)\1`, 'g'))) {
          found.add(`${from} ${name}`)
        }
      }
      const named = /\{([^}]*)\}/.exec(clause as string)
      for (const part of (named?.[1] ?? '').split(',').map(item => item.trim()).filter(Boolean)) {
        if (!part.startsWith('type ')) found.add(`${from} ${part.split(/\s+as\s+/)[0]}`)
      }
    }
    return found
  },
}

/** Members every cordis Context has; `ctx.<one of these>` is not a host service. */
const CONTEXT_MEMBERS = new Set([
  'effect', 'emit', 'fiber', 'get', 'inject', 'on', 'plugin', 'provide', 'root', 'scope', 'set', 'using',
])

/** Distinct names one scanner finds across the client source. */
function used(scan: (code: string) => Set<string>): Set<string> {
  const found = new Set<string>()
  for (const { code } of sources) for (const name of scan(code)) found.add(name)
  return found
}

function assertSameNames(label: string, inCode: Set<string>, listed: Iterable<string>): void {
  const manifest = new Set(listed)
  const unlisted = [...inCode].filter(name => !manifest.has(name)).sort()
  const unused = [...manifest].filter(name => !inCode.has(name)).sort()
  assert.deepEqual(unlisted, [], `${label} used in src/client but missing from HOST_CONTRACT`)
  assert.deepEqual(unused, [], `${label} listed in HOST_CONTRACT but no longer used in src/client`)
}

test('the scan reads the client source', () => {
  assert.ok(sources.some(({ file }) => file === 'index.ts'), `no client source under ${clientDir}`)
})

test('every slot the client registers into is in the host contract', () => {
  assertSameNames('slots', used(SCANNERS.slots), Object.keys(HOST_CONTRACT.slots))
})

test('every context service the client injects or reads is in the host contract', () => {
  assertSameNames('services', used(SCANNERS.services), Object.keys(HOST_CONTRACT.services))
})

test('every theme token the client styles with is in the host contract', () => {
  assertSameNames('tokens', used(SCANNERS.tokens), HOST_CONTRACT.tokens.names)
})

/** Marker names read as `HOST_CONTRACT.markers.<id>.row` or `.dock`. */
function contractMarkerUses(code: string): Set<string> {
  const found = new Set<string>()
  for (const match of code.matchAll(/HOST_CONTRACT\.markers\.(?<key>[A-Za-z0-9_]+)\.(?<field>row|dock)/g)) {
    const marker = HOST_CONTRACT.markers[match.groups?.key as keyof typeof HOST_CONTRACT.markers]
    const attribute = marker?.[match.groups?.field as 'row' | 'dock']
    if (typeof attribute === 'string') found.add(attribute)
  }
  return found
}

test('every host DOM marker the client queries is in the host contract', () => {
  const inCode = used(SCANNERS.markers)
  for (const { code } of sources) for (const name of contractMarkerUses(code)) inCode.add(name)
  const listed = Object.values(HOST_CONTRACT.markers).flatMap(marker => [marker.row, marker.dock])
  assertSameNames('DOM markers', inCode, listed)
})

test('a host-contract marker field counts as a use of that attribute', () => {
  assert.deepEqual(
    [...contractMarkerUses('scope.querySelector(markerSelector(HOST_CONTRACT.markers.composerStats.row))')].sort(),
    ['data-composer-stats'],
  )
  assert.deepEqual([...contractMarkerUses('querySelector("[data-composer-stats]")')], [])
})

test('every host glyph and named host export the client reads is in the host contract', () => {
  assertSameNames('icons', used(SCANNERS.icons), HOST_CONTRACT.icons.names)
  const listed = Object.entries(HOST_CONTRACT.exports).flatMap(([from, names]) => names.map(name => `${from} ${name}`))
  assertSameNames('host imports', used(SCANNERS.imports), listed)
})

// The scanners must see each form below. A narrowed pattern would let a new
// host name through the checks above without a failure.
test('the scanners catch each quote style and access form', () => {
  const found = (scan: (code: string) => Set<string>, code: string) => [...scan(code)].sort()
  assert.deepEqual(found(SCANNERS.slots, `ctx.slots.inject("a.b", f); ctx.slots.inject(\`c.d\`, f)`), ['a.b', 'c.d'])
  assert.deepEqual(found(SCANNERS.services, `ctx.get("one"); scope.get(\`two\`); ctx.inject(["three"], f); ctx.four.x; ctx.effect(f)`),
    ['four', 'one', 'three', 'two'])
  assert.deepEqual(found(SCANNERS.markers, `q("[data-one]"); q('div[data-two="x"]'); const s = \`[data-three]\`; q(\`[\${a}]\`)`),
    ['data-one', 'data-three', 'data-two'])
  assert.deepEqual(found(SCANNERS.icons, `hostIcon(p, "One"); hostIcon(p, 'Two')`), ['One', 'Two'])
  assert.deepEqual(found(SCANNERS.imports, [
    "import * as p from '@deepseek-ai/pkg'",
    "import {\n  a,\n  b as c,\n  type T,\n} from \"@deepseek-ai/other\"",
    "import type { U } from '@deepseek-ai/types-only'",
    "import { useState } from 'react'",
    'p.Member; p["Indexed"]',
  ].join('\n')), [
    '@deepseek-ai/other a', '@deepseek-ai/other b', '@deepseek-ai/pkg Indexed', '@deepseek-ai/pkg Member',
  ])
})

test('comments are not read as host uses', () => {
  assert.deepEqual([...SCANNERS.markers(stripComments("// q('[data-in-comment]')\n/* ctx.get('x') */ const url = 'https://x'"))], [])
  assert.equal(stripComments("const url = 'https://x'"), "const url = 'https://x'")
})
