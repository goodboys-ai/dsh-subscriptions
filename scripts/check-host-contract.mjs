#!/usr/bin/env node
/**
 * Host contract check: every runtime assumption in src/client/host-contract.ts
 * against one DSH version's published packages.
 *
 * check-host-exports.mjs proves src/ type-checks against a version's
 * declarations. That misses what the client reads at runtime, like icon
 * names, slot outlets, DOM markers, cordis services, theme tokens, and the
 * shell's module table. A host that drops one of those still compiles
 * cleanly, and the plugin loses a feature without an error. This script
 * reads the shipped JavaScript of the owning package for each manifest
 * entry, so the check runs before a user ever sees the page.
 *
 * Usage:
 *   node scripts/check-host-contract.mjs --dsh 0.2.0-rc.2
 *   node scripts/check-host-contract.mjs --all      # every version in dsh-versions.txt
 *
 * The bundle check reads lib/client.js, so run `pnpm build` first.
 * Installs are cached per version under the OS temp dir.
 * Exit 0 when every entry holds for every requested version, 1 when an entry
 * or a host package is missing at one, and 2 on anything else: npm or the
 * file system failed, lib/client.js is missing, or a host build is in a
 * shape this check cannot read, so it says nothing about the host.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** Loaded by the entry point, so a missing or unreadable manifest exits 2. */
let HOST_CONTRACT

/** Every host package the manifest names. */
function contractPackages() {
  const names = new Set([
    HOST_CONTRACT.moduleTable,
    HOST_CONTRACT.icons.package,
    HOST_CONTRACT.diagnostics.package,
    HOST_CONTRACT.tokens.package,
    ...Object.keys(HOST_CONTRACT.exports),
    ...Object.values(HOST_CONTRACT.slots),
    ...Object.values(HOST_CONTRACT.services),
    ...Object.values(HOST_CONTRACT.markers).map((marker) => marker.package),
  ])
  return [...names].sort()
}

/** The check could not run. Every exception other than a finding exits 2. */
class SetupFailure extends Error {}

/** A host package in the manifest is not published at the checked version. */
class MissingHostPackage extends Error {}

/** Install the manifest's packages at one DSH version, without their dependencies. */
function installHost(version) {
  const dir = join(tmpdir(), 'dsh-host-contract', version)
  const packages = contractPackages()
  const marker = join(dir, '.installed')
  const wanted = `${version}\n${packages.join('\n')}\n`
  if (!existsSync(marker) || readFileSync(marker, 'utf8') !== wanted) {
    mkdirSync(dir, { recursive: true })
    console.log(
      `installing ${packages.length} host packages for DSH ${version} ...`,
    )
    // Only the published files are read, never executed, so dependencies are skipped.
    try {
      execFileSync(
        'npm',
        [
          'install',
          '--no-save',
          '--no-audit',
          '--no-fund',
          '--no-package-lock',
          '--ignore-scripts',
          '--omit=peer',
          '--legacy-peer-deps',
          '--prefix',
          dir,
          ...packages.map((name) => `${name}@${version}`),
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      )
    } catch (error) {
      const stderr = error.stderr?.toString() ?? ''
      process.stderr.write(stderr)
      // A package missing at this version is a finding about the host.
      // Anything else (network, registry) only means the check did not run.
      if (/\bcode (?:ETARGET|E404)\b/.test(stderr)) {
        throw new MissingHostPackage(
          `a host package in src/client/host-contract.ts is not published at DSH ${version}`,
        )
      }
      throw new SetupFailure(
        `npm could not install the host packages for DSH ${version}`,
      )
    }
    writeFileSync(marker, wanted)
  }
  return join(dir, 'node_modules')
}

/**
 * Concatenated shipped JavaScript of one package: every .js/.mjs/.cjs file
 * under lib/ or dist/, at any depth, so a host that moves its build into a
 * subdirectory still gets checked entry by entry.
 */
function shippedCode(modules, name) {
  const base = join(modules, name)
  const dirs = [join(base, 'lib'), join(base, 'dist')].filter(existsSync)
  let code = ''
  for (const dir of dirs) {
    for (const file of readdirSync(dir, { recursive: true })) {
      if (
        /\.[cm]?js$/.test(file) &&
        !file.split(/[\\/]/).includes('node_modules')
      ) {
        code += readFileSync(join(dir, file), 'utf8') + '\n'
      }
    }
  }
  if (code === '')
    throw new Error(`${name} ships no JavaScript under lib/ or dist/`)
  return code
}

/** Names in a package's final `export { … }` statement (rolldown/tsdown output). */
function namedExports(modules, name) {
  const entry = join(modules, name, 'lib', 'index.js')
  const source = readFileSync(entry, 'utf8')
  const statements = [...source.matchAll(/^export \{([^}]*)\};?$/gm)]
  if (statements.length === 0)
    throw new Error(
      `${name}/lib/index.js has no export { … } statement to read`,
    )
  const names = new Set()
  for (const [, list] of statements) {
    for (const item of list.split(',')) {
      const part = item.trim()
      if (part === '') continue
      names.add(part.split(/\s+as\s+/).at(-1))
    }
  }
  return names
}

/** Keys of the shell's static module table: `staticModules:<fn>()` returning an object literal. */
function staticModuleKeys(code) {
  const call = /staticModules:([A-Za-z_$][\w$]*)\(\)/.exec(code)
  if (call === null)
    throw new Error('dsh-web-frontend has no staticModules:<fn>() call')
  const body = new RegExp(
    `function ${call[1].replace(/\$/g, '\\$')}\\(\\)\\{return\\{([^}]*)\\}`,
  ).exec(code)
  if (body === null)
    throw new Error(`dsh-web-frontend: cannot read the body of ${call[1]}()`)
  return new Set(
    [...body[1].matchAll(/(?:"([^"]+)"|([A-Za-z_$][\w$]*)):/g)].map(
      (m) => m[1] ?? m[2],
    ),
  )
}

/**
 * Host module specifiers the built client bundle loads: `require(…)`,
 * `import(…)`, and static `import … from` in any quote style. The bundle
 * always loads at least the primitives module, so finding none means the
 * build format changed under this reader, and the check fails instead of
 * passing on an empty list.
 */
function bundleRequires() {
  const bundle = join(root, 'lib', 'client.js')
  if (!existsSync(bundle))
    throw new SetupFailure('lib/client.js is missing; run `pnpm build` first')
  const code = readFileSync(bundle, 'utf8')
  const patterns = [
    /\b(?:require|import)\(\s*(['"`])([^'"`]+)\1\s*\)/g,
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*(['"])([^'"]+)\1/g,
    /\bimport\s*(['"])([^'"]+)\1/g,
  ]
  const specifiers = new Set(
    patterns.flatMap((pattern) => [...code.matchAll(pattern)].map((m) => m[2])),
  )
  if (!specifiers.has(HOST_CONTRACT.icons.package)) {
    throw new SetupFailure(
      `lib/client.js: found no load of ${HOST_CONTRACT.icons.package}; the bundle format is not one this check reads`,
    )
  }
  return [...specifiers]
    .filter((specifier) => !specifier.startsWith('.'))
    .sort()
}

/** Check one DSH version. Returns the list of failures (empty when it holds). */
function checkVersion(version) {
  const failures = []
  const passes = []
  let modules
  try {
    modules = installHost(version)
  } catch (error) {
    if (!(error instanceof MissingHostPackage)) throw error
    return { passes, failures, missing: error.message }
  }
  const expect = (ok, label, detail) => {
    if (ok) passes.push(label)
    else failures.push(`${label}: ${detail}`)
  }
  const code = new Map()
  const codeOf = (name) => {
    if (!code.has(name)) code.set(name, shippedCode(modules, name))
    return code.get(name)
  }

  for (const [name, wanted] of Object.entries(HOST_CONTRACT.exports)) {
    const exported = namedExports(modules, name)
    for (const symbol of wanted) {
      expect(exported.has(symbol), `export ${name}.${symbol}`, 'not exported')
    }
  }

  const primitives = namedExports(modules, HOST_CONTRACT.icons.package)
  for (const icon of HOST_CONTRACT.icons.names) {
    expect(
      primitives.has(`Icon${icon}Regular`) || primitives.has(`Icon${icon}16`),
      `icon ${icon}`,
      `${HOST_CONTRACT.icons.package} exports neither Icon${icon}Regular nor Icon${icon}16`,
    )
  }

  for (const [slot, owner] of Object.entries(HOST_CONTRACT.slots)) {
    expect(
      codeOf(owner).includes(`renderSlot("${slot}"`),
      `slot ${slot}`,
      `${owner} no longer renders an outlet for it (renderSlot("${slot}", …)); entries registered there never mount`,
    )
  }

  for (const [service, owner] of Object.entries(HOST_CONTRACT.services)) {
    const source = codeOf(owner)
    expect(
      source.includes(`super(ctx, "${service}")`) ||
        source.includes(`ctx.provide("${service}"`),
      `service ${service}`,
      `${owner} neither provides nor declares a service named "${service}"`,
    )
  }

  // A marker lists the attribute spellings across host generations; one
  // host build renders exactly one spelling, so shipping any of them
  // satisfies the marker.
  for (const [key, marker] of Object.entries(HOST_CONTRACT.markers)) {
    expect(
      marker.attributes.some((attribute) =>
        codeOf(marker.package).includes(`"${attribute}"`),
      ),
      `marker ${key}`,
      `${marker.package} renders none of ${marker.attributes.join(', ')}`,
    )
  }

  const renderer = codeOf(HOST_CONTRACT.diagnostics.package)
  const { crashLog, errorAttribute, slotAttribute } = HOST_CONTRACT.diagnostics
  expect(
    renderer.includes(crashLog),
    'diagnostic crash log',
    `${HOST_CONTRACT.diagnostics.package} no longer logs "${crashLog}"; the host E2E cannot see slot crashes`,
  )
  expect(
    renderer.includes(`"${errorAttribute}"`),
    'diagnostic error attribute',
    `${HOST_CONTRACT.diagnostics.package} no longer renders ${errorAttribute}`,
  )
  expect(
    renderer.includes(`"${slotAttribute}"`),
    'diagnostic slot attribute',
    `${HOST_CONTRACT.diagnostics.package} no longer renders ${slotAttribute}`,
  )

  const theme = codeOf(HOST_CONTRACT.tokens.package)
  const undefinedTokens = HOST_CONTRACT.tokens.names.filter(
    (token) => !theme.includes(`${token}:`),
  )
  expect(
    undefinedTokens.length === 0,
    `tokens (${HOST_CONTRACT.tokens.names.length})`,
    `${HOST_CONTRACT.tokens.package} does not define ${undefinedTokens.join(', ')}; those styles fall back to nothing`,
  )

  const table = staticModuleKeys(codeOf(HOST_CONTRACT.moduleTable))
  for (const specifier of bundleRequires()) {
    expect(
      table.has(specifier),
      `bundle require ${specifier}`,
      `lib/client.js requires it but the shell's module table only serves ${[...table].join(', ')}`,
    )
  }

  return { passes, failures }
}

function main() {
  const args = process.argv.slice(2)
  let versions
  if (args.includes('--all')) {
    versions = readFileSync(join(root, 'dsh-versions.txt'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  } else {
    const i = args.indexOf('--dsh')
    if (i === -1 || !args[i + 1]) {
      console.error('usage: check-host-contract.mjs --dsh <version> | --all')
      process.exit(2)
    }
    versions = [args[i + 1]]
  }
  const broken = []
  for (const version of versions) {
    const { passes, failures, missing } = checkVersion(version)
    if (missing !== undefined) {
      broken.push(version)
      console.log(`DSH ${version}: FAIL — ${missing}`)
    } else if (failures.length === 0) {
      console.log(`DSH ${version}: ok (${passes.length} host contract entries)`)
    } else {
      broken.push(version)
      console.log(
        `DSH ${version}: FAIL (${failures.length} of ${passes.length + failures.length} host contract entries)`,
      )
      for (const failure of failures) console.log(`  - ${failure}`)
    }
  }
  if (broken.length > 0) {
    console.error(
      `\nsrc/client/host-contract.ts does not hold for DSH ${broken.join(', ')}`,
    )
    process.exit(1)
  }
}

/** Findings are returned, never thrown, so any exception means the check did not run. */
function setupExit(error) {
  console.error(
    `SETUP FAILURE: ${error instanceof Error ? error.message : String(error)}`,
  )
  if (!(error instanceof SetupFailure) && error instanceof Error)
    console.error(error.stack)
  process.exit(2)
}
process.on('uncaughtException', setupExit)
process.on('unhandledRejection', setupExit)

try {
  // Node strips the types from this dependency-free module; see its header.
  ;({ HOST_CONTRACT } = await import(join(root, 'src/client/host-contract.ts')))
  main()
} catch (error) {
  setupExit(error)
}
