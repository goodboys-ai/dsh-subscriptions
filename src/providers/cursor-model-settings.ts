import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

/** Cursor currently has one credential, so only provider-wide model visibility is configurable. */
export interface CursorModelSettings {
  visibleModels?: string[]
}

export function validateCursorModelSettings(
  input: unknown,
): CursorModelSettings {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Cursor model settings must be an object')
  }
  const models = (input as Record<string, unknown>).visibleModels
  if (models === undefined) return {}
  if (
    !Array.isArray(models) ||
    models.some((id) => typeof id !== 'string' || !id.trim())
  ) {
    throw new Error('visibleModels must be an array of model ids')
  }
  return { visibleModels: [...new Set(models as string[])] }
}

/** Durable visibility preference; account tokens remain in DSH credentials. */
export class CursorModelSettingsStore {
  private current: CursorModelSettings = {}
  private writes: Promise<void> = Promise.resolve()

  constructor(
    readonly path = dshHomePath(
      'plugins',
      'subscriptions',
      'cursor-model-settings.json',
    ),
  ) {
    try {
      this.current = validateCursorModelSettings(
        JSON.parse(readFileSync(path, 'utf8')) as unknown,
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(`Cannot read Cursor model settings at ${path}`, {
          cause: error,
        })
    }
  }

  get(): CursorModelSettings {
    return structuredClone(this.current)
  }

  visibleModels(): readonly string[] | undefined {
    return this.current.visibleModels
  }

  set(input: unknown): Promise<void> {
    const validated = validateCursorModelSettings(input)
    const run = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(validated, null, 2), {
          mode: 0o600,
        })
        await rename(temporary, this.path)
      } finally {
        await rm(temporary, { force: true })
      }
      this.current = validated
    })
    this.writes = run.catch(() => undefined)
    return run
  }
}
