// Mutation testing (StrykerJS) for the highest-risk pure logic: the wire
// translators and the pool/rate-limit bookkeeping. The nightly workflow runs
// `pnpm test:mutation`; thresholds only color the report (break: null) until a
// baseline exists.
//
// The command runner mutates the TypeScript under src/, so every mutant run
// recompiles. `--noCheck` keeps emit going even when a type error exists
// elsewhere in the tree (tsc emits regardless; the flag only skips the
// checking time), and `--incremental` turns the steady-state compile into a
// ~1.5 s rebuild inside each sandbox. Mutations in dependencies of the listed
// specs still surface because the compiled output, not the source, is tested.
//
// The spec list covers the mutated modules directly (grep test/ for imports of
// them). Request-body builders are not mutated here: they live inside the
// provider adapters (codex.ts, grok.ts, copilot.ts, claude.ts), not in a
// separate module, and mutating those files would pull in the integration
// specs and multiply the runtime.

const SPECS = [
  'translate.spec.js',
  'sse.property.spec.js',
  'anthropic-messages.property.spec.js',
  'rate-limit.spec.js',
  'rate-limit.property.spec.js',
  'pool.spec.js',
  'pool-usage.spec.js',
  'request-body.spec.js',
  'usage.spec.js',
  'models.spec.js',
  'account-preferences.spec.js',
  'antigravity.spec.js',
  'copilot.spec.js',
]
  .map((name) => `lib-test-mutation/test/${name}`)
  .join(' ')

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  mutate: [
    'src/translate/anthropic.ts',
    'src/translate/responses.ts',
    'src/translate/sse.ts',
    'src/providers/rate-limit.ts',
    'src/providers/pool.ts',
    'src/providers/pool-usage.ts',
  ],
  testRunner: 'command',
  commandRunner: {
    command:
      'node_modules/.bin/tsc -p tsconfig.test.json --outDir lib-test-mutation --noCheck --incremental --tsBuildInfoFile lib-test-mutation/.tsbuildinfo' +
      ` && node --import ./test/hermetic.mjs --test ${SPECS}`,
  },
  coverageAnalysis: 'off',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation-report.json' },
  incremental: true,
  incrementalFile: 'reports/mutation/stryker-incremental.json',
  // Report only: no baseline exists yet, so a low score must not fail the job.
  thresholds: { high: 80, low: 60, break: null },
  // A mutant run is a compile plus ~1 s of node:test; the timeout only guards
  // against a mutant that hangs the parser (e.g. an infinite SSE loop).
  timeoutMS: 60000,
  ignorePatterns: [
    '.git',
    'node_modules',
    '.cache',
    '.stryker-tmp',
    'lib',
    // Build output of `pnpm test` and of the mutation command itself, plus
    // any lib-test-<name> directory a local run compiled to.
    'lib-test*',
    'reports',
    'screenshots.json',
  ],
}
