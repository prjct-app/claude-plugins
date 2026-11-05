/**
 * The palette site's API, as plain data: the mod makes the requests itself
 * with $.http (calls on `$` stay in the hooks module). /palette login, sync,
 * logout, backup and backups reach the network, and the weekly backup does
 * while this Claude Code is connected; without a token nothing here is sent.
 * The token can read and write this person's palette library and nothing
 * else, and lives in a file only they can read.
 */
export const DEFAULT_SITE = 'https://palette.prjct.app'
export const CLIENT = 'claude-code'
const VERSION = '0.5.0'

export type Auth = { token: string; username?: string; site: string; connectedAt: string }
export type LinkStart = { code: string; poll: string; url: string; expiresAt: string }
export type LinkClaim = { status: 'pending' | 'expired' | 'invalid' } | { status: 'ok'; token: string; username?: string }
export type Request = { url: string; init: { method: string; headers: Record<string, string>; body?: string } }
/** One version of the library kept on the site. */
export type CloudVersion = { id: string; createdAt: string; client?: string; palettes: number; favorites: number }

const TOKEN = /^pit_[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const ROUTES = {
  link: '/api/pi/link',
  claim: '/api/pi/link/claim',
  library: '/api/pi/library',
  token: '/api/pi/token',
  backups: '/api/pi/backups',
} as const

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * The origin to talk to: the site, or PALETTE_SITE_URL when it is set. Tokens
 * only travel over https; plain http is allowed for localhost while developing.
 */
export function siteOrigin(override?: string): string {
  const url = new URL(override?.trim() || DEFAULT_SITE)
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new Error(`Refusing to send credentials to ${url.origin}: use https`)
  }
  return url.origin
}

/** The site as people read it: its host, no scheme. */
export const siteName = (site: string): string => site.replace(/^https?:\/\//, '')

export function request(site: string, path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Request {
  return {
    url: new URL(path, site).toString(),
    init: {
      method: opts.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        'user-agent': `palette/${VERSION} (${CLIENT})`,
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    },
  }
}

/** The response's JSON, or an ApiError with the site's own message. */
export function response<T>(res: { ok: boolean; status: number; text: string }): T {
  let data: unknown = {}
  try {
    data = res.text ? JSON.parse(res.text) : {}
  } catch {
    /* a non-JSON body: the status says enough */
  }
  if (!res.ok) {
    const error = (data as { error?: unknown }).error
    throw new ApiError(res.status, typeof error === 'string' ? error : `HTTP ${res.status}`)
  }
  return data as T
}

export const isUnauthorized = (error: unknown): boolean => error instanceof ApiError && error.status === 401
/** The site has no backups API (an older deployment). */
export const isNotFound = (error: unknown): boolean => error instanceof ApiError && error.status === 404

/** The saved login, when its token is well formed and was issued by `site`. */
export function parseAuth(text: string, site: string = DEFAULT_SITE): Auth | undefined {
  try {
    const data = JSON.parse(text) as Partial<Auth>
    if (typeof data.token !== 'string' || !TOKEN.test(data.token)) return undefined
    const issuer = typeof data.site === 'string' && data.site ? data.site.replace(/\/+$/, '') : DEFAULT_SITE
    if (issuer !== site) return undefined
    return { token: data.token, username: typeof data.username === 'string' ? data.username : undefined, site: issuer, connectedAt: data.connectedAt ?? '' }
  } catch {
    return undefined
  }
}

export const backupPath = (id: string): string => {
  if (!UUID.test(id)) throw new Error('bad backup id')
  return `${ROUTES.backups}/${id}`
}

/** The versions the site keeps, newest first, from untrusted data. */
export function parseBackups(data: unknown): CloudVersion[] {
  const list = (data as { backups?: unknown } | null)?.backups
  if (!Array.isArray(list)) return []
  const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return list.flatMap((b): CloudVersion[] => {
    if (!b || typeof b !== 'object') return []
    const r = b as Record<string, unknown>
    if (typeof r.id !== 'string' || !UUID.test(r.id) || typeof r.createdAt !== 'string') return []
    return [{
      id: r.id,
      createdAt: r.createdAt,
      ...(typeof r.client === 'string' ? { client: r.client.slice(0, 60) } : {}),
      palettes: count(r.palettes),
      favorites: count(r.favorites),
    }]
  })
}
