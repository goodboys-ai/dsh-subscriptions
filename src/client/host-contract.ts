/**
 * Everything the client half assumes about the DSH host that the compiler
 * cannot check.
 *
 * The client bundle reads host modules at runtime, not at build time. A
 * renamed icon export compiles against the old type declarations and then
 * renders `undefined`. A slot outlet the host stops rendering never mounts our
 * entry, so the page looks normal and the feature is just gone. A removed DOM
 * marker only breaks layout. None of these fail `tsc`, and a unit test with
 * a hand-made host cannot see them either.
 *
 * So each such assumption is listed here once, next to the host package that
 * owns it. `scripts/check-host-contract.mjs` downloads every supported DSH
 * version and checks that each entry appears in that version's published
 * code. The host E2E reads the same diagnostics entries to catch slot
 * crashes. The spec test/host-contract.spec.ts scans src/client and fails
 * when code starts relying on a literal host name that is missing here.
 *
 * This module has no imports, so plain Node scripts can import it directly.
 */

/** Prefix of the console warning the client logs when a host lacks a listed name. */
export const HOST_CONTRACT_MISS = 'dsh-subscriptions: host contract miss'

export const HOST_CONTRACT = {
  /**
   * Host modules the client bundle loads by specifier. The web shell serves
   * only the modules in its static module table (`staticModules` in
   * dsh-web-frontend), so each specifier the built lib/client.js loads must
   * be a key of that table.
   */
  moduleTable: '@deepseek-ai/dsh-web-frontend',

  /** Named runtime exports the client reads from a host module. */
  exports: {
    '@deepseek-ai/dsh-client-ui-primitives': ['useAnchoredPosition', 'useDismissOnOutsidePointer'],
  },

  /**
   * 16px glyphs read through hostIcon(). The host must export
   * `Icon<Name>Regular` (DSH 0.1.7 and later) or `Icon<Name>16` (earlier).
   */
  icons: {
    package: '@deepseek-ai/dsh-client-ui-primitives',
    names: ['Sparkle', 'DataOutline'],
  },

  /** Slots the client registers into, each with the package that renders its outlet. */
  slots: {
    'settings.section': '@deepseek-ai/dsh-client-ui-settings-general',
    'tool.call.toolview': '@deepseek-ai/dsh-client-ui-tool',
    'conversation.input.right': '@deepseek-ai/dsh-client-ui-conversation',
    'conversation.composer.dock': '@deepseek-ai/dsh-client-ui-conversation',
  },

  /**
   * Context services the client injects or reads, each with the package that
   * provides it (`ctx.provide("<name>")` or a cordis Service named `<name>`).
   * A service nobody provides leaves the plugin's apply() waiting forever,
   * with nothing in the console.
   */
  services: {
    commandUi: '@deepseek-ai/dsh-client-ui-commands',
    connection: '@deepseek-ai/dsh-client-connection',
    locale: '@deepseek-ai/dsh-client-locale',
    modelDirectories: '@deepseek-ai/dsh-client-ui-model-selection',
    slots: '@deepseek-ai/dsh-client-ui-renderer',
  },

  /** DOM attributes the client looks up in host-rendered markup. */
  markers: {
    /** The shipped StatsPills row; the usage badge renders into it as a third pill. */
    composerStats: { attribute: 'data-composer-stats', package: '@deepseek-ai/dsh-client-ui-chat' },
  },

  /**
   * What the slot renderer emits when an entry throws. It catches the error,
   * logs `crashLog`, and renders an element carrying `errorAttribute` in the
   * entry's place, so a crash never reaches the page's error handlers. The
   * host E2E watches for both.
   */
  diagnostics: {
    package: '@deepseek-ai/dsh-client-ui-renderer',
    crashLog: 'slot entry crashed in',
    errorAttribute: 'data-slot-error',
    slotAttribute: 'data-slot',
  },

  /** Design tokens the client styles with; the host theme must define each one. */
  tokens: {
    package: '@deepseek-ai/dsh-client-ui-theme',
    names: [
      '--dsw-alias-bg-layer-1',
      '--dsw-alias-bg-layer-2',
      '--dsw-alias-bg-layer-3',
      '--dsw-alias-bg-mask-1',
      '--dsw-alias-bg-skeleton',
      '--dsw-alias-border-l1',
      '--dsw-alias-border-l2',
      '--dsw-alias-border-l2-darkmode-thin',
      '--dsw-alias-border-l3',
      '--dsw-alias-border-l4',
      '--dsw-alias-brand-primary',
      '--dsw-alias-button-primary-fill',
      '--dsw-alias-button-primary-hover',
      '--dsw-alias-interactive-bg-active',
      '--dsw-alias-interactive-bg-hover',
      '--dsw-alias-interactive-bg-hover-solid',
      '--dsw-alias-label-dimmed',
      '--dsw-alias-label-primary',
      '--dsw-alias-label-primary-foreground',
      '--dsw-alias-label-secondary',
      '--dsw-alias-label-tertiary',
      '--dsw-alias-settings-card-fill',
      '--dsw-alias-settings-card-stroke',
      '--dsw-alias-state-business-primary',
      '--dsw-alias-state-error-primary',
      '--dsw-alias-state-success-primary',
      '--dsw-alias-state-warn-label',
      '--dsw-elevation-prominent',
      '--dsw-focus-ring-color',
      '--dsw-focus-ring-width',
      '--dsw-mask-blur',
      '--dsw-menu-backdrop-filter',
      '--dsw-radius-lg',
      '--dsw-radius-md',
      '--dsw-radius-panel',
      '--dsw-radius-sm',
      '--dsw-radius-xl',
      '--dsw-specific-menu',
    ],
  },
} as const

/** A glyph name listed in {@link HOST_CONTRACT}; hostIcon() accepts no other. */
export type HostIconName = (typeof HOST_CONTRACT.icons.names)[number]
