/**
 * Glyphs from the host's icon set that survive its renames. DSH 0.1.7
 * renamed the 16px glyphs from `Icon<Name>16` to `Icon<Name>Regular`. The
 * client reads host modules at runtime, so a named import of a glyph the
 * host no longer exports is `undefined`, and rendering it crashes the whole
 * slot (React error #130).
 *
 * A glyph name must be listed in HOST_CONTRACT.icons, which
 * scripts/check-host-contract.mjs checks against each supported DSH version.
 */
import type { ComponentType } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import { HOST_CONTRACT, HOST_CONTRACT_MISS } from './host-contract.js'
import type { HostIconName } from './host-contract.js'

/** A decorative glyph the host lacks renders nothing rather than crashing. */
const NoIcon: ComponentType<IconProps> = () => null

/**
 * Resolve one 16px glyph under either host naming.
 *
 * A glyph the host lacks renders nothing, and the lookup logs a
 * {@link HOST_CONTRACT_MISS} warning. The host E2E fails on that warning, so a
 * missing icon is reported instead of shipping as a blank space.
 * @param icons - the host primitives module (`import * as`), read by name.
 * @param name - the glyph name without prefix or size, e.g. `Sparkle`.
 * @returns the host's component, or one rendering nothing.
 */
export function hostIcon(
  icons: object,
  name: HostIconName,
): ComponentType<IconProps> {
  const exports = icons as Record<string, ComponentType<IconProps> | undefined>
  const icon = exports[`Icon${name}Regular`] ?? exports[`Icon${name}16`]
  if (icon !== undefined) return icon
  console.warn(
    `${HOST_CONTRACT_MISS}: ${HOST_CONTRACT.icons.package} exports neither Icon${name}Regular nor Icon${name}16`,
  )
  return NoIcon
}
