import { parseLibrary, toFile, type LibraryFile } from './library.ts'

/**
 * Versioned backups of the person's palette library, as plain data: the mod
 * reads and writes the files itself (calls on `$` stay in the hooks module).
 * Once a week, or when they ask, the library on this computer is saved and,
 * when this Claude Code is connected, sent to the site too; what the site
 * holds is saved here as well. Each side keeps the last KEEP versions.
 * The file is pi-palette's own backup format.
 */
export const KEEP = 10
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000
/** A lock older than this was left by a session that died mid-backup. */
export const STALE_LOCK_MS = 10 * 60 * 1000

export type BackupReason = 'weekly' | 'manual' | 'connect' | 'restore'

/** One local version: the library on this computer and, when connected, what the site held. */
export type Version = {
  format: 'pi-palette-backup'
  version: 1
  createdAt: string
  reason: BackupReason
  hash: { local: string; cloud?: string }
  local: LibraryFile
  cloud?: LibraryFile
  user?: string
}

/** A version with the file it lives in. */
export type Saved = { file: string; version: Version }

export type BackupState = {
  /** The last run, done or skipped because nothing changed: the weekly clock. */
  checkedAt?: number
  /** The last time the site confirmed it holds the current library. */
  cloudAt?: number
  cloudCount?: number
  /** Why the cloud part of the last run failed; cleared when it works. */
  cloudError?: string
}

const REASONS = new Set<BackupReason>(['weekly', 'manual', 'connect', 'restore'])
export const FILE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/

export const WHY: Record<BackupReason, string> = {
  weekly: 'weekly check',
  manual: 'backed up by hand',
  connect: 'first backup after connecting',
  restore: 'saved before a restore',
}

/** JSON with sorted keys, so the same library always reads the same. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

/**
 * SHA-256 of a text, as hex. Written out so a backup is hashed in one step,
 * with nothing to wait for: the first 32 bits of the fractional parts of the
 * square roots (initial state) and cube roots (round constants) of the primes.
 */
export function sha256(text: string): string {
  const state: number[] = []
  const k: number[] = []
  const primes: number[] = []
  for (let candidate = 2; k.length < 64; candidate++) {
    if (primes.some(prime => candidate % prime === 0)) continue
    primes.push(candidate)
    if (state.length < 8) state.push((Math.sqrt(candidate) * 2 ** 32) | 0)
    k.push((Math.cbrt(candidate) * 2 ** 32) | 0)
  }
  const bytes = new TextEncoder().encode(text)
  const size = ((bytes.length + 9 + 63) >> 6) << 6
  const block = new Uint8Array(size)
  block.set(bytes)
  block[bytes.length] = 0x80
  const view = new DataView(block.buffer)
  view.setUint32(size - 8, Math.floor(bytes.length / 2 ** 29))
  view.setUint32(size - 4, (bytes.length << 3) >>> 0)
  const w = new Int32Array(64)
  for (let offset = 0; offset < size; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!, y = w[i - 2]!
      w[i] = (w[i - 16]! + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + w[i - 7]! + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10))) | 0
    }
    let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = state
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + k[i]! + w[i]!) | 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    ;[a, b, c, d, e, f, g, h].forEach((v, i) => { state[i] = (state[i]! + v) | 0 })
  }
  return state.map(v => (v >>> 0).toString(16).padStart(8, '0')).join('')
}

/** What a library holds, ignoring when it was exported. */
export function hashLibrary(library: LibraryFile): string {
  const { exportedAt: _ignored, ...content } = library
  return sha256(stable(content))
}

export function parseState(text: string): BackupState {
  try {
    const data = JSON.parse(text) as Record<string, unknown>
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    const state: BackupState = {}
    const checkedAt = num(data.checkedAt), cloudAt = num(data.cloudAt), cloudCount = num(data.cloudCount)
    if (checkedAt !== undefined) state.checkedAt = checkedAt
    if (cloudAt !== undefined) state.cloudAt = cloudAt
    if (cloudCount !== undefined) state.cloudCount = cloudCount
    if (typeof data.cloudError === 'string') state.cloudError = data.cloudError.slice(0, 200)
    return state
  } catch {
    return {}
  }
}

/** True when a week passed since the last run, or there was none. */
export function isDue(state: BackupState, now: number): boolean {
  return state.checkedAt === undefined || now - state.checkedAt >= WEEK_MS || state.checkedAt > now
}

/** A library from a backup, cleaned like any library from outside. */
function cleanLibrary(value: unknown): LibraryFile | undefined {
  const library = parseLibrary(JSON.stringify(value ?? null), true)
  return library ? toFile(library) : undefined
}

/** A version from untrusted text; undefined when it isn't one. The hashes are filled in by the reader. */
export function parseVersion(text: string): Version | undefined {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (!data || typeof data !== 'object' || data.format !== 'pi-palette-backup') return undefined
  const local = cleanLibrary(data.local)
  if (!local) return undefined
  const cloud = data.cloud ? cleanLibrary(data.cloud) : undefined
  return {
    format: 'pi-palette-backup',
    version: 1,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : '',
    reason: REASONS.has(data.reason as BackupReason) ? (data.reason as BackupReason) : 'weekly',
    hash: { local: '' },
    local,
    ...(cloud ? { cloud } : {}),
    ...(typeof data.user === 'string' ? { user: data.user.slice(0, 40) } : {}),
  }
}

const fileFor = (ms: number): string => `${new Date(ms).toISOString().replace(/[:.]/g, '-')}.json`
const timeOf = (file: string): number => Date.parse(file.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.json$/, 'T$1:$2:$3.$4Z'))

/** The file for a version saved now: after the newest, even within one millisecond or when the clock went back. */
export function nextFile(newest: string | undefined, now: number): string {
  const first = fileFor(now)
  return newest && first <= newest ? fileFor(timeOf(newest) + 1) : first
}

/** True when the newest version already holds this one: nothing to save. */
export function isSame(newest: Version | undefined, next: Version): boolean {
  if (!newest) return false
  // A run that could not reach the cloud keeps the cloud copy the newest version already has.
  return newest.hash.local === next.hash.local && (!next.hash.cloud || newest.hash.cloud === next.hash.cloud)
}

/** "in 5d", "in 3h", "now": when the weekly check runs next. */
export function nextCheck(state: BackupState, now: number): string {
  if (state.checkedAt === undefined) return 'now'
  const left = state.checkedAt + WEEK_MS - now
  if (left <= 0) return 'now'
  const hours = Math.ceil(left / 3_600_000)
  return hours < 48 ? `in ${hours}h` : `in ${Math.ceil(hours / 24)}d`
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function ago(then: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Oct 19, 14:48", in this computer's time. */
export function when(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso || '—'
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${two(date.getHours())}:${two(date.getMinutes())}`
}
