#!/usr/bin/env node
/**
 * Point this checkout's git hooks at .husky when it is the repository root.
 * A dependency install (node_modules) and a pack without .git skip the step.
 * `prepare` still builds the client bundle either way.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { sep } from 'node:path'

if (process.env.HUSKY === '0') process.exit(0)
if (process.cwd().split(sep).includes('node_modules')) process.exit(0)
if (!existsSync('.git')) process.exit(0)

const result = spawnSync(process.execPath, ['node_modules/husky/bin.js'], {
  stdio: 'inherit',
})
if (result.error) throw result.error
process.exitCode = result.status ?? 1
