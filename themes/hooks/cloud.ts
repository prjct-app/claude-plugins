/**
 * The pi-themes site's API, as plain data: the mod makes the requests itself
 * with $.http (calls on `$` stay in the hooks module). Only /palette login, sync
 * and logout reach the network. The token can read and write this person's
 * palette library and nothing else, and lives in a file only they can read.
 */
export const SITE = 'https://palette.prjct.app'
export const CLIENT = 'claude-code'
const VERSION = '0.4.0'

export type Auth = { token: string; username?: string; site: string; connectedAt: string }
export type LinkStart = { code: string; poll: string; url: string; expiresAt: string }
export type LinkClaim = { status: 'pending' | 'expired' | 'invalid' } | { status: 'ok'; token: string; username?: string }
export type Request = { url: string; init: { method: string; headers: Record<string, string>; body?: string } }

const TOKEN = /^pit_[0-9a-f]{64}$/

export const ROUTES = {
  link: '/api/pi/link',
  claim: '/api/pi/link/claim',
  library: '/api/pi/library',
  token: '/api/pi/token',
} as const

export class ApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function request(path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Request {
  return {
    url: new URL(path, SITE).toString(),
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

export function parseAuth(text: string): Auth | undefined {
  try {
    const data = JSON.parse(text) as Partial<Auth>
    if (typeof data.token !== 'string' || !TOKEN.test(data.token)) return undefined
    return { token: data.token, username: data.username, site: data.site ?? SITE, connectedAt: data.connectedAt ?? '' }
  } catch {
    return undefined
  }
}
