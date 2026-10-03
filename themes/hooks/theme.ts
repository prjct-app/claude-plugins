/**
 * pi-palette data → a Claude Code theme file ({ name, base, overrides }).
 *
 * Pure and dependency-free: the /palette mod converts at runtime with it, and
 * scripts/build-themes.mjs imports it to write the themes/ the plugin ships, so
 * both produce the same colors.
 */

export type Swatch = { name: string; hex: string }

export type Palette = {
  id: string
  label: string
  /** original | editor | photo | community, or own for the person's library. */
  group: string
  swatches: Swatch[]
  vars: Record<string, string>
  /** Pi role → var name, only the roles that differ from Pi's defaults. */
  colors?: Record<string, string>
  /** Pi's HTML export roles → var name. */
  export?: Record<string, string>
}

export type ClaudeTheme = { name: string; base: 'dark' | 'light'; overrides: Record<string, string> }

const HEX = /^#[0-9A-Fa-f]{6}$/

const rgb = (hex: string): number[] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
const toHex = (c: number[]): string =>
  `#${c.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase()
/** `t` of the way from `a` to `b`. */
export const mix = (a: string, b: string, t: number): string => {
  const to = rgb(b)
  return toHex(rgb(a).map((v, i) => v + ((to[i] ?? v) - v) * t))
}
const lighten = (a: string, t: number): string => mix(a, '#FFFFFF', t)
const luminance = (a: string): number => {
  const [r = 0, g = 0, b = 0] = rgb(a).map(v => v / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** A palette var by name, or a raw hex, or undefined. */
const pick = (vars: Record<string, string>, ref: string | undefined): string | undefined =>
  ref && HEX.test(ref) ? ref : ref && HEX.test(vars[ref] ?? '') ? vars[ref] : undefined

/** Claude Code tokens from the palette's semantic vars; optional vars fall back to mixes of the core eight. */
export function toClaudeTheme(p: Palette, name = p.label): ClaudeTheme {
  const v = p.vars
  const canvas = v.canvas!, text = v.text!, accent = v.accent!, secondary = v.secondary!
  const highlight = v.highlight!, success = v.success!, warning = v.warning!, error = v.error!
  const surface = v.surface ?? mix(canvas, text, 0.06)
  const surfaceRaised = v.surfaceRaised ?? mix(canvas, text, 0.12)
  const muted = v.muted ?? mix(text, canvas, 0.4)
  const dim = v.dim ?? mix(text, canvas, 0.6)
  const border = v.border ?? mix(text, canvas, 0.7)
  const borderMuted = v.borderMuted ?? mix(text, canvas, 0.82)
  const selected = v.selected ?? mix(canvas, accent, 0.3)
  const successBg = v.successBg ?? mix(canvas, success, 0.18)
  const errorBg = v.errorBg ?? mix(canvas, error, 0.18)
  const messageBg = pick(v, p.export?.userMessageBg) ?? surface
  const bash = pick(v, p.colors?.bashMode) ?? v.bash ?? v.bashPink ?? highlight
  const plan = v.planTeal ?? mix(secondary, success, 0.5)

  return {
    name,
    base: luminance(canvas) > 0.5 ? 'light' : 'dark',
    overrides: {
      claude: accent,
      claudeShimmer: lighten(accent, 0.35),
      text,
      inverseText: canvas,
      inactive: muted,
      inactiveShimmer: lighten(muted, 0.3),
      subtle: dim,
      suggestion: secondary,
      permission: secondary,
      permissionShimmer: lighten(secondary, 0.35),
      remember: highlight,
      success,
      error,
      warning,
      warningShimmer: lighten(warning, 0.35),
      merged: highlight,
      promptBorder: border,
      promptBorderShimmer: lighten(border, 0.35),
      planMode: plan,
      autoAccept: highlight,
      bashBorder: bash,
      ide: secondary,
      fastMode: warning,
      fastModeShimmer: lighten(warning, 0.35),
      diffAdded: successBg,
      diffRemoved: errorBg,
      diffAddedDimmed: mix(successBg, canvas, 0.5),
      diffRemovedDimmed: mix(errorBg, canvas, 0.5),
      diffAddedWord: mix(successBg, success, 0.35),
      diffRemovedWord: mix(errorBg, error, 0.35),
      userMessageBackground: messageBg,
      userMessageBackgroundHover: messageBg === surfaceRaised ? lighten(surfaceRaised, 0.05) : surfaceRaised,
      bashMessageBackgroundColor: messageBg,
      memoryBackgroundColor: messageBg,
      selectionBg: selected,
      rate_limit_fill: accent,
      rate_limit_empty: borderMuted,
      briefLabelYou: secondary,
      briefLabelClaude: accent,
    },
  }
}
