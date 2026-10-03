import type { Palette, Swatch } from './theme.ts'

/**
 * The library file pi-themes trades (`format: "pi-palette", version: 1`), read
 * defensively: anything malformed is dropped, never thrown. A single Pi theme
 * file ({ name, vars, colors }) is a library of one, as the site's download is.
 */
export type Library = { palettes: Palette[]; favorites: string[]; active?: string }

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/
const VAR = /^[A-Za-z][A-Za-z0-9]{0,31}$/
const CORE = ['canvas', 'text', 'accent', 'secondary', 'highlight', 'success', 'warning', 'error']
const BUNDLED_GROUPS = new Set(['original', 'editor', 'photo', 'community'])
const MAX_PALETTES = 500

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/** #RRGGBB, upper case; #RGB is expanded; anything else is undefined. */
export function normHex(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const s = value.trim()
  if (/^#[0-9A-Fa-f]{6}$/.test(s)) return s.toUpperCase()
  if (/^#[0-9A-Fa-f]{3}$/.test(s)) return `#${[...s.slice(1)].map(c => c + c).join('')}`.toUpperCase()
  return undefined
}

const refMap = (value: unknown): Record<string, string> | undefined => {
  if (!isObject(value)) return undefined
  const out = Object.fromEntries(Object.entries(value).filter(([k, v]) => VAR.test(k) && typeof v === 'string' && v.length <= 32)) as Record<string, string>
  return Object.keys(out).length ? out : undefined
}

/** One palette from untrusted data; `own` marks the person's library over the bundled set. */
export function cleanPalette(value: unknown, own: boolean): Palette | undefined {
  if (!isObject(value)) return undefined
  const id = String(value.id ?? '').toLowerCase()
  if (!ID.test(id) || !isObject(value.vars)) return undefined
  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(value.vars)) {
    const hex = normHex(v)
    if (hex && VAR.test(k)) vars[k] = hex
  }
  if (!CORE.every(k => vars[k])) return undefined
  const swatches: Swatch[] = Array.isArray(value.swatches)
    ? value.swatches.flatMap(s => (isObject(s) && typeof s.name === 'string' && normHex(s.hex) ? [{ name: s.name.slice(0, 24), hex: normHex(s.hex)! }] : [])).slice(0, 8)
    : []
  const group = typeof value.group === 'string' && BUNDLED_GROUPS.has(value.group) ? value.group : 'community'
  const colors = refMap(value.colors)
  const exported = refMap(value.export)
  return {
    id,
    label: String(value.label ?? id).slice(0, 40),
    group: own ? 'own' : group,
    swatches: swatches.length ? swatches : ['accent', 'secondary', 'highlight', 'success', 'warning'].map(name => ({ name, hex: vars[name]! })),
    vars,
    ...(colors ? { colors } : {}),
    ...(exported ? { export: exported } : {}),
  }
}

/** A library from untrusted text; undefined when it isn't one. */
export function parseLibrary(text: string, own: boolean): Library | undefined {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(data)) return undefined
  const list = Array.isArray(data.palettes)
    ? data.palettes
    : isObject(data.vars) && typeof data.name === 'string'
      ? [{ id: data.name, label: data.name, vars: data.vars, colors: data.colors, export: data.export }]
      : undefined
  if (!list) return undefined
  const palettes = list.slice(0, MAX_PALETTES).flatMap(p => cleanPalette(p, own) ?? [])
  const favorites = Array.isArray(data.favorites) ? data.favorites.filter((f): f is string => typeof f === 'string' && ID.test(f)) : []
  const active = typeof data.active === 'string' && ID.test(data.active) ? data.active : undefined
  return { palettes, favorites, ...(active ? { active } : {}) }
}

/** The bundled set, with the person's own palettes on top: an own palette replaces a bundled one with its id. */
export function mergePalettes(bundled: Palette[], own: Palette[]): Palette[] {
  const ownIds = new Set(own.map(p => p.id))
  return [...own, ...bundled.filter(p => !ownIds.has(p.id))]
}
