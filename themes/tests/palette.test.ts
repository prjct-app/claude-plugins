import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { sha256 } from '../hooks/backup'

const pal = (id: string, label: string, group: string, accent: string) => ({
  id, label, group,
  vars: { canvas: '#101010', text: '#F0F0F0', accent, secondary: '#00AAFF', highlight: '#FF44AA', success: '#44DD88', warning: '#FFCC00', error: '#FF4455' },
})
const BUNDLED = { format: 'pi-palette', version: 1, palettes: [pal('tensor', 'Tensor', 'original', '#20D6FF'), pal('dracula', 'Dracula', 'editor', '#BD93F9'), pal('glacier', 'Glacier', 'photo', '#88CCEE')] }
const HOME = '/home/u'
const DATA = `${HOME}/.claude/palette`
const THEMES = `${HOME}/.claude/themes`
const OWN = `${DATA}/library.json`
const AUTH = `${DATA}/auth.json`
const OWNED = `${DATA}/owned-themes.json`
const STATE = `${DATA}/backup.json`
const BACKUPS = `${DATA}/backups`
const LOCK = `${DATA}/backup.lock`
const NOW = Date.parse('2026-11-05T12:00:00Z')
const PANE_PROPS = { title: 'Palette', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} }
const TOKEN = `pit_${'a'.repeat(64)}`
const SITE = 'https://palette.prjct.app'
const CONNECTED = { [AUTH]: JSON.stringify({ token: TOKEN, username: 'jlopezlira', site: SITE }) }

type Res = { status: number; text: string }
type World = {
  toasts: string[]; logs: string[]; files: Map<string, string>; store: Record<string, unknown>; opened: string[]; closed: string[]
  statuses: (string | undefined)[]; processes: string[][]; requests: { url: string; method: string; body?: unknown; auth?: string }[]
  clock: ReturnType<typeof mock.clock>
}

/**
 * The plugin's files and the user's ~/.claude in memory, its store where the
 * test can read it, a clock the test moves, and toasts, log lines and pane
 * opens captured.
 */
function world(
  on: On,
  opts: { store?: Record<string, unknown>; own?: unknown; files?: Record<string, string>; answer?: string; routes?: Record<string, Res | Res[]>; hasThemesDir?: boolean; isLocked?: boolean; isPlaced?: boolean; env?: Record<string, string> } = {},
): World {
  const w: World = { toasts: [], logs: [], files: new Map(Object.entries(opts.files ?? {})), store: { ...opts.store }, opened: [], closed: [], statuses: [], processes: [], requests: [], clock: mock.clock(on, { now: NOW }) }
  if (opts.own) w.files.set(OWN, JSON.stringify(opts.own))
  const isDir = (path: string): boolean => [...w.files.keys()].some(file => file.startsWith(`${path}/`))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  mock.env(on, { HOME, ...opts.env })
  on('store.get', ($, e) => ({ value: w.store[e.key] }))
  on('store.set', ($, e) => {
    w.store[e.key] = e.value
    return { value: undefined }
  })
  on('fs.read', ($, e) => ({ value: e.path.endsWith('/palettes.json') ? JSON.stringify(BUNDLED) : w.files.get(e.path) ?? '' }))
  on('fs.exists', ($, e) => ({ value: e.path === THEMES ? opts.hasThemesDir ?? true : w.files.has(e.path) || isDir(e.path) }))
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', ($, e) => ({
    value: [...w.files.keys()]
      .filter(file => file.startsWith(`${e.path}/`) && !file.slice(e.path.length + 1).includes('/'))
      .map(file => ({ name: file.slice(e.path.length + 1), kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })),
  }))
  // Only the backup lock is ever looked at: one a live session made just now.
  on('fs.stat', () => ({ value: { kind: 'dir' as const, size: 0, mtimeMs: NOW, isLink: false } }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    w.opened.push(e.id)
    return { value: opts.isPlaced === false ? { isPlaced: false, reason: 'no surface' } : { isPlaced: true } } as never
  })
  on('ui.close', ($, e) => {
    w.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.focus', () => ({}))
  on('ui.status', ($, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  // $.ui.ask is an AskUserQuestion tool call: answer its one question.
  on('tool.call', { tool: 'AskUserQuestion' }, ($, e) => ({
    result: { questions: e.questions, answers: { [e.questions[0]!.question]: opts.answer ?? 'Cancel' } },
  }) as never)
  on('process.run', ($, e) => {
    w.processes.push([...e.argv])
    if (e.argv[0] === 'rm') w.files.delete(e.argv[2] ?? '')
    const isHeldLock = e.argv[0] === 'mkdir' && e.argv[1] === LOCK && opts.isLocked
    return { value: { exitCode: isHeldLock ? 1 : 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // The site: each "METHOD path" answers its next canned response.
  on('http.fetch', ($, e) => {
    const method = e.init?.method ?? 'GET'
    const path = new URL(e.url).pathname
    w.requests.push({ url: e.url, method, body: e.init?.body ? JSON.parse(e.init.body) : undefined, auth: e.init?.headers?.authorization })
    const canned = opts.routes?.[`${method} ${path}`]
    const res = (Array.isArray(canned) ? canned.shift() : canned) ?? { status: 404, text: '{"error":"not found"}' }
    return { value: { status: res.status, ok: res.status < 400, headers: {}, text: res.text } }
  })
  return w
}

type Api = { command: { run: (a: { command: string; args: string }) => Promise<unknown> } }
const palette = ($: unknown, args: string) => ($ as Api).command.run({ command: 'palette', args })
const start = ($: { session: { start: (e: never) => Promise<unknown> } }) =>
  $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' } as never)
const ok = (body: unknown): Res => ({ status: 200, text: JSON.stringify(body) })
const json = (w: World, path: string) => JSON.parse(w.files.get(path) ?? 'null')
const versions = (w: World) => [...w.files.keys()].filter(file => file.startsWith(`${BACKUPS}/`)).sort()
const calls = (w: World) => w.requests.map(r => `${r.method} ${new URL(r.url).pathname}`)
/** The pane as it draws now. A redraw is the test's to ask for: nothing beneath the plugin repaints. */
const draw = ($: { ui: { mount: (a: never) => Promise<any> } }) =>
  $.ui.mount({ plugin: 'palette', surface: 'terminal', component: 'Pane', requestId: 'palette', props: PANE_PROPS } as never)

describe('commands', () => {
  test('a palette id no longer applies anything: themes are picked in /theme', async ($, on) => {
    const w = world(on)
    await start($)

    await palette($, 'nord')
    await palette($, 'next')

    expect(w.toasts[0]).toMatch(/Themes are picked in \/theme/)
    expect(w.files.size).toBe(0)
    expect(w.store).toEqual({})
  })
})

describe('pane', () => {
  test('not connected: the account offers a login, import and export, and a backup', async ($, on) => {
    const w = world(on)
    await start($)

    expect(await palette($, '')).toEqual({})
    expect(w.opened).toEqual(['palette'])
    expect(w.requests).toEqual([])

    const ui = await draw($)
    expect((await ui.find({ type: 'Text', text: /themes in \/theme/ }))?.text).toMatch(/^3 themes in \/theme · 0 favorites/)
    expect(await ui.find({ type: 'Button', text: 'Log in' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'Sync now' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', text: 'Import a library file' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'Export your palettes' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'Back up now' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Not connected/ })).toBeDefined()
  })

  test('connected: sync and log out, the account name, and the versions the site keeps', async ($, on) => {
    const backups = { backups: [{ id: '11111111-2222-3333-4444-555555555555', createdAt: '2026-11-01T10:00:00Z', client: 'claude-code', palettes: 2, favorites: 1 }, { id: 'nope', createdAt: 'x' }] }
    const w = world(on, { files: CONNECTED, own: { palettes: [pal('sunrise', 'Sunrise', 'community', '#FF8800')] }, routes: { 'GET /api/pi/backups': ok(backups) } })
    await start($)

    await palette($, '')
    await w.clock.advance(0)
    expect(w.requests[0]).toMatchObject({ method: 'GET', auth: `Bearer ${TOKEN}` })

    const ui = await draw($)
    expect((await ui.find({ type: 'Text', text: /themes in \/theme/ }))?.text).toMatch(/· 1 yours ·/)
    expect(await ui.find({ type: 'Button', text: 'Sync now' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'Log out' })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'Log in' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '@jlopezlira' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1\/10 cloud/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'cloud' })).toBeDefined()
  })

  test('an action run from the pane answers in the pane, not as a toast', async ($, on) => {
    const w = world(on)
    await start($)
    await palette($, '')

    const ui = await draw($)
    await ui.press({ key: 'act:export' } as never)
    expect(w.files.has(`${HOME}/Downloads/palette-export.json`)).toBe(true)
    expect(w.toasts).toEqual([])
    await ui.unmount()

    expect(await (await draw($)).find({ type: 'Text', text: /Exported 0 palettes and 0 favorites/ })).toBeDefined()
  })

  test('where no pane is drawn, the state is a log line', async ($, on) => {
    const w = world(on, { isPlaced: false })
    await start($)

    await palette($, '')
    expect(w.logs[0]).toMatch(/3 themes in \/theme/)
    expect(w.logs[0]).toMatch(/Account: Not connected/)
  })
})

describe('library', () => {
  test('a theme file from the site is added to your palettes and written for /theme', async ($, on) => {
    const download = { $schema: 'https://pi.dev/theme-schema.json', name: 'midnight', vars: pal('midnight', 'x', 'x', '#7744FF').vars }
    const w = world(on, { files: { [`${HOME}/Downloads/midnight.json`]: JSON.stringify(download) } })
    await start($)

    await palette($, 'import ~/Downloads/midnight.json')

    expect(json(w, OWN)).toMatchObject({ format: 'pi-palette', version: 1, palettes: [{ id: 'midnight' }] })
    expect(json(w, OWN).palettes[0].group).toBeUndefined()
    expect(w.processes).toContainEqual(['chmod', '600', OWN])
    expect(json(w, `${THEMES}/midnight.json`)).toMatchObject({ name: 'midnight', base: 'dark', overrides: { claude: '#7744FF' } })
    expect(json(w, OWNED)).toEqual(['midnight.json'])
    expect(w.toasts.at(-1)).toBe('Added midnight to your palettes · it is in /theme')
  })

  test('a whole library replaces yours only after a yes', async ($, on) => {
    const lib = { format: 'pi-palette', version: 1, favorites: ['sunrise', 'ghost'], palettes: [pal('sunrise', 'Sunrise', 'community', '#FF8800')] }
    const w = world(on, { files: { [`${HOME}/Downloads/library.json`]: JSON.stringify(lib) }, answer: 'Cancel' })
    await start($)

    await palette($, 'import')
    expect(w.files.has(OWN)).toBe(false)
    expect(w.files.has(`${THEMES}/sunrise.json`)).toBe(false)
  })

  test('import, confirmed: palettes saved, unknown favorites dropped, themes written', async ($, on) => {
    const lib = { format: 'pi-palette', version: 1, favorites: ['sunrise', 'ghost', 'dracula'], palettes: [pal('sunrise', 'Sunrise', 'community', '#FF8800'), pal('dusk', 'Dusk', 'community', '#8855FF')] }
    const w = world(on, { files: { [`${HOME}/Downloads/library.json`]: JSON.stringify(lib) }, answer: 'Import' })
    await start($)

    await palette($, 'import')
    expect(json(w, OWN).palettes.map((p: { id: string }) => p.id)).toEqual(['sunrise', 'dusk'])
    expect(w.store.favorites).toEqual(['sunrise', 'dracula'])
    expect(json(w, `${THEMES}/sunrise.json`).name).toBe('Sunrise')
    expect(json(w, OWNED)).toEqual(['dusk.json', 'sunrise.json'])
    expect(w.toasts.at(-1)).toBe('Imported 2 palettes · they are in /theme')
  })

  test('a themes folder created now needs one restart', async ($, on) => {
    const lib = { name: 'solo', vars: pal('solo', 'solo', 'x', '#ABCDEF').vars }
    const w = world(on, { hasThemesDir: false, files: { [`${HOME}/Downloads/solo.json`]: JSON.stringify(lib) } })
    await start($)

    await palette($, 'import ~/Downloads/solo.json')
    expect(w.toasts.at(-1)).toMatch(/restart Claude Code once, then find it in \/theme/)
  })

  test("a theme file of the person's own with the same name is left alone", async ($, on) => {
    const lib = { name: 'dracula', vars: pal('dracula', 'x', 'x', '#123456').vars }
    const w = world(on, { files: { [`${HOME}/Downloads/d.json`]: JSON.stringify(lib), [`${THEMES}/dracula.json`]: 'MINE' } })
    await start($)

    await palette($, 'import ~/Downloads/d.json')
    expect(w.files.get(`${THEMES}/dracula.json`)).toBe('MINE')
    expect(w.files.has(OWNED)).toBe(false)
    expect(w.toasts.at(-1)).toBe('Added dracula to your palettes · kept your own theme file for dracula')
  })

  test('a palette that left the library takes its theme file with it, and only that one', async ($, on) => {
    const lib = { format: 'pi-palette', version: 1, palettes: [pal('dusk', 'Dusk', 'community', '#8855FF')] }
    const w = world(on, {
      own: { palettes: [pal('sunrise', 'Sunrise', 'community', '#FF8800')] },
      files: { [`${HOME}/Downloads/library.json`]: JSON.stringify(lib), [`${THEMES}/sunrise.json`]: 'OLD', [`${THEMES}/palette.json`]: 'SLOT', [OWNED]: '["sunrise.json"]' },
      answer: 'Import',
    })
    await start($)

    await palette($, 'import')
    expect(w.files.has(`${THEMES}/sunrise.json`)).toBe(false)
    expect(w.files.get(`${THEMES}/palette.json`)).toBe('SLOT')
    expect(json(w, OWNED)).toEqual(['dusk.json'])
  })

  test('at startup the theme files catch up with the library', async ($, on) => {
    const w = world(on, { own: { palettes: [pal('sunrise', 'Sunrise', 'community', '#FF8800')] }, files: { [STATE]: JSON.stringify({ checkedAt: NOW }) } })
    await start($)
    expect(w.files.has(`${THEMES}/sunrise.json`)).toBe(false)

    await w.clock.advance(2000)
    expect(json(w, `${THEMES}/sunrise.json`).overrides.claude).toBe('#FF8800')
    expect(versions(w)).toEqual([])
    expect(w.toasts).toEqual([])
  })
})

describe('export', () => {
  test('writes your palettes and favorites to Downloads', async ($, on) => {
    const own = { format: 'pi-palette', version: 1, palettes: [pal('sunrise', 'Sunrise', 'community', '#FF8800')] }
    const w = world(on, { own, store: { favorites: ['sunrise', 'nord'] } })
    await start($)

    await palette($, 'export')
    const out = json(w, `${HOME}/Downloads/palette-export.json`)
    expect(out).toEqual({ format: 'pi-palette', version: 1, exportedAt: '2026-11-05T12:00:00.000Z', favorites: ['sunrise', 'nord'], palettes: [expect.objectContaining({ id: 'sunrise', label: 'Sunrise' })] })
    expect(out.palettes[0].group).toBeUndefined()
    expect(w.toasts.at(-1)).toMatch(/Exported 1 palettes and 2 favorites/)
  })
})

describe('site', () => {
  test('login sends the claude-code client, shows the code, keeps the token once approved, and backs up', async ($, on) => {
    const w = world(on, {
      files: { [STATE]: JSON.stringify({ checkedAt: NOW }) },
      routes: {
        'POST /api/pi/link': ok({ code: 'WXYZ-1234', poll: 'p1', url: 'https://labs.prjct.app/link?code=WXYZ-1234', expiresAt: '2026-11-05T12:10:00Z' }),
        'POST /api/pi/link/claim': [ok({ status: 'pending' }), ok({ status: 'ok', token: TOKEN, username: 'jlopezlira' })],
        'GET /api/pi/library': ok({ user: 'jlopezlira', palettes: [] }),
        'POST /api/pi/backups': ok({ id: 'x', count: 1 }),
      },
    })
    await start($)

    await palette($, 'login')
    expect(w.requests[0]).toEqual({ url: `${SITE}/api/pi/link`, method: 'POST', body: { client: 'claude-code' }, auth: undefined })
    expect(w.statuses[0]).toMatch(/WXYZ-1234/)
    expect(w.processes).toContainEqual(['open', 'https://labs.prjct.app/link?code=WXYZ-1234'])

    await w.clock.advance(3000)
    expect(w.files.has(AUTH)).toBe(false)
    await w.clock.advance(3000)
    expect(json(w, AUTH)).toMatchObject({ token: TOKEN, username: 'jlopezlira', site: SITE })
    expect(w.processes).toContainEqual(['chmod', '600', AUTH])
    expect(w.statuses.at(-1)).toBeUndefined()
    expect(w.toasts.at(-1)).toMatch(/Connected as @jlopezlira/)
    // The first cloud backup follows the login.
    expect(calls(w).slice(-2)).toEqual(['GET /api/pi/library', 'POST /api/pi/backups'])
    expect(versions(w)).toHaveLength(1)
  })

  test('a link that is not a web page is shown, never opened', async ($, on) => {
    const w = world(on, { routes: { 'POST /api/pi/link': ok({ code: 'WXYZ-1234', poll: 'p1', url: 'file:///etc/passwd', expiresAt: '2026-11-05T12:10:00Z' }) } })
    await start($)

    await palette($, 'login')
    expect(w.statuses[0]).toMatch(/WXYZ-1234/)
    expect(w.processes.some(argv => argv[0] === 'open' || argv[0] === 'xdg-open')).toBe(false)
  })

  test('sync sends yours, brings the site library back, and writes its themes', async ($, on) => {
    const remote = { user: 'jlopezlira', format: 'pi-palette', version: 1, favorites: ['sunrise'], palettes: [{ ...pal('sunrise', 'Sunrise', 'community', '#FF8800'), author: 'jlopezlira' }] }
    const w = world(on, {
      store: { favorites: ['dracula'] },
      files: CONNECTED,
      routes: { 'PUT /api/pi/library': ok({ saved: 0, liked: 1 }), 'GET /api/pi/library': ok(remote) },
    })
    await start($)

    await palette($, 'sync')
    expect(calls(w)).toEqual(['PUT /api/pi/library', 'GET /api/pi/library'])
    expect(w.requests[0]!.auth).toBe(`Bearer ${TOKEN}`)
    expect(w.requests[0]!.body).toEqual({ format: 'pi-palette', version: 1, favorites: ['dracula'], palettes: [] })
    expect(json(w, OWN).palettes[0]).toMatchObject({ id: 'sunrise', author: 'jlopezlira' })
    expect(w.store.favorites).toEqual(['sunrise'])
    expect(json(w, `${THEMES}/sunrise.json`).overrides.claude).toBe('#FF8800')
    expect(w.toasts).toContain('Synced as @jlopezlira: 1 palettes, 1 favorites (0 sent) · it is in /theme')
  })

  test('a revoked token forgets the login', async ($, on) => {
    const w = world(on, { files: CONNECTED, routes: { 'PUT /api/pi/library': { status: 401, text: '{"error":"revoked"}' } } })
    await start($)

    await palette($, 'sync')
    expect(w.files.has(AUTH)).toBe(false)
    expect(w.toasts.at(-1)).toMatch(/disconnected/)
  })

  test('a token another site issued is never sent', async ($, on) => {
    const w = world(on, { files: { [AUTH]: JSON.stringify({ token: TOKEN, site: 'https://elsewhere.example' }) } })
    await start($)

    await palette($, 'sync')
    expect(w.requests).toEqual([])
    expect(w.toasts.at(-1)).toMatch(/Not connected/)
  })

  test('PALETTE_SITE_URL must be https, or localhost', async ($, on) => {
    const w = world(on, { env: { PALETTE_SITE_URL: 'http://elsewhere.example' } })
    await start($)

    await palette($, 'login')
    expect(w.requests).toEqual([])
    expect(w.toasts.at(-1)).toMatch(/Refusing to send credentials/)
  })

  test('logout revokes the token and removes it here', async ($, on) => {
    const w = world(on, { files: CONNECTED, routes: { 'DELETE /api/pi/token': ok({ ok: true }) } })
    await start($)

    await palette($, 'logout')
    expect(w.requests[0]!.method).toBe('DELETE')
    expect(w.files.has(AUTH)).toBe(false)
    expect(w.toasts.at(-1)).toMatch(/Disconnected/)
  })
})

describe('backups', () => {
  const own = { palettes: [pal('sunrise', 'Sunrise', 'community', '#FF8800')] }

  test('not connected: a version is saved here, and the same library is not saved twice', async ($, on) => {
    const w = world(on, { own, store: { favorites: ['sunrise'] } })
    await start($)

    await palette($, 'backup')
    expect(versions(w)).toEqual([`${BACKUPS}/2026-11-05T12-00-00-000Z.json`])
    const version = json(w, versions(w)[0]!)
    expect(version).toMatchObject({ format: 'pi-palette-backup', version: 1, reason: 'manual', createdAt: '2026-11-05T12:00:00.000Z', local: { format: 'pi-palette', favorites: ['sunrise'], palettes: [{ id: 'sunrise' }] } })
    expect(version.hash.local).toMatch(/^[0-9a-f]{64}$/)
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(version.cloud).toBeUndefined()
    expect(json(w, STATE)).toEqual({ checkedAt: NOW })
    expect(w.requests).toEqual([])
    expect(w.toasts.at(-1)).toBe('Backed up: 1/10 versions here.')
    expect(w.processes).toContainEqual(['rmdir', LOCK])

    await w.clock.advance(60_000)
    await palette($, 'backup')
    expect(versions(w)).toHaveLength(1)
    expect(w.toasts.at(-1)).toBe('Nothing changed since the last backup (1/10 here).')
  })

  test('connected: what the site holds is saved here too, then this library is sent up', async ($, on) => {
    const remote = { user: 'jlopezlira', favorites: [], palettes: [pal('dusk', 'Dusk', 'community', '#8855FF')] }
    const w = world(on, { own, files: CONNECTED, routes: { 'GET /api/pi/library': ok(remote), 'POST /api/pi/backups': ok({ id: 'x', count: 3 }) } })
    await start($)

    await palette($, 'backup')
    expect(calls(w)).toEqual(['GET /api/pi/library', 'POST /api/pi/backups'])
    expect(w.requests[1]!.body).toMatchObject({ client: 'claude-code', library: { format: 'pi-palette', version: 1, palettes: [{ id: 'sunrise' }] } })
    const version = json(w, versions(w)[0]!)
    expect(version.cloud.palettes[0].id).toBe('dusk')
    expect(version.user).toBe('jlopezlira')
    expect(json(w, STATE)).toEqual({ checkedAt: NOW, cloudAt: NOW, cloudCount: 3 })
    expect(w.toasts.at(-1)).toBe('Backed up: 1/10 versions here, 3/10 on palette.prjct.app.')
  })

  test('a cloud failure is said, and the local version is still saved', async ($, on) => {
    const w = world(on, { own, files: CONNECTED, routes: { 'GET /api/pi/library': { status: 500, text: '{"error":"server error"}' } } })
    await start($)

    await palette($, 'backup')
    expect(versions(w)).toHaveLength(1)
    expect(json(w, STATE)).toEqual({ checkedAt: NOW, cloudError: 'server error' })
    expect(w.toasts.at(-1)).toBe('Backed up: 1/10 versions here, but the cloud copy failed: server error')
    expect(w.files.has(AUTH)).toBe(true)
  })

  test('the weekly backup runs by itself when a week has passed, and not before', async ($, on) => {
    const w = world(on, { own, files: { [STATE]: JSON.stringify({ checkedAt: NOW - 8 * 24 * 3_600_000 }) } })
    await start($)
    await w.clock.advance(2000)

    expect(versions(w)).toHaveLength(1)
    expect(json(w, versions(w)[0]!).reason).toBe('weekly')
    expect(json(w, STATE).checkedAt).toBe(NOW + 2000)
    expect(w.toasts).toEqual([])
  })

  test('only the last ten versions are kept', async ($, on) => {
    const old = (day: number) => `${BACKUPS}/2026-10-${String(day).padStart(2, '0')}T00-00-00-000Z.json`
    const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [old(i + 1), JSON.stringify({ format: 'pi-palette-backup', version: 1, createdAt: `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`, reason: 'weekly', local: { palettes: [pal(`p${i}`, 'P', 'x', '#111111')] } })]))
    const w = world(on, { own, files })
    await start($)

    await palette($, 'backup')
    expect(versions(w)).toHaveLength(10)
    expect(w.files.has(old(1))).toBe(false)
    expect(w.files.has(old(2))).toBe(true)
    expect(w.toasts.at(-1)).toBe('Backed up: 10/10 versions here.')
  })

  test('another session backing up right now is left to it', async ($, on) => {
    const w = world(on, { own, isLocked: true })
    await start($)

    await palette($, 'backup')
    expect(versions(w)).toEqual([])
    expect(w.toasts.at(-1)).toBe('Another Claude Code is backing up right now.')
  })

  test('restoring a version asks twice, saves the current library first, and writes the themes', async ($, on) => {
    const file = `${BACKUPS}/2026-10-19T19-48-06-033Z.json`
    const backup = { format: 'pi-palette-backup', version: 1, createdAt: '2026-10-19T19:48:06.033Z', reason: 'weekly', local: { favorites: ['dusk'], palettes: [pal('dusk', 'Dusk', 'community', '#8855FF')] } }
    const w = world(on, { own, files: { [file]: JSON.stringify(backup), [`${THEMES}/sunrise.json`]: 'OLD', [OWNED]: '["sunrise.json"]' } })
    await start($)
    await palette($, 'backups')

    const ui = await draw($)
    const key = 'bk:local:2026-10-19T19-48-06-033Z.json'
    await ui.press({ key } as never)
    expect(json(w, OWN).palettes[0].id).toBe('sunrise')
    await ui.press({ key } as never)

    expect(json(w, OWN).palettes.map((p: { id: string }) => p.id)).toEqual(['dusk'])
    expect(w.store.favorites).toEqual(['dusk'])
    expect(json(w, `${THEMES}/dusk.json`).overrides.claude).toBe('#8855FF')
    expect(w.files.has(`${THEMES}/sunrise.json`)).toBe(false)
    const saved = versions(w).map(path => json(w, path))
    expect(saved).toHaveLength(2)
    expect(saved.at(-1)).toMatchObject({ reason: 'restore', local: { palettes: [{ id: 'sunrise' }] } })
  })

  test('a cloud version is fetched and restored', async ($, on) => {
    const id = '11111111-2222-3333-4444-555555555555'
    const w = world(on, {
      own,
      files: CONNECTED,
      routes: {
        'GET /api/pi/backups': ok({ backups: [{ id, createdAt: '2026-11-01T10:00:00Z', palettes: 1, favorites: 0 }] }),
        [`GET /api/pi/backups/${id}`]: ok({ format: 'pi-palette', version: 1, favorites: [], palettes: [pal('dusk', 'Dusk', 'community', '#8855FF')] }),
      },
    })
    await start($)
    await palette($, '')
    await w.clock.advance(0)

    const ui = await draw($)
    await ui.press({ key: `bk:cloud:${id}` } as never)
    await ui.press({ key: `bk:cloud:${id}` } as never)
    expect(json(w, OWN).palettes.map((p: { id: string }) => p.id)).toEqual(['dusk'])
    expect(calls(w)).toContain(`GET /api/pi/backups/${id}`)
  })
})
