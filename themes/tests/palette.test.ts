import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const pal = (id: string, label: string, group: string, accent: string) => ({
  id, label, group,
  vars: { canvas: '#101010', text: '#F0F0F0', accent, secondary: '#00AAFF', highlight: '#FF44AA', success: '#44DD88', warning: '#FFCC00', error: '#FF4455' },
})
const BUNDLED = { format: 'pi-palette', version: 1, palettes: [pal('tensor', 'Tensor', 'original', '#20D6FF'), pal('dracula', 'Dracula', 'editor', '#BD93F9'), pal('glacier', 'Glacier', 'photo', '#88CCEE')] }
const HOME = '/home/u'
const SLOT = `${HOME}/.claude/themes/palette.json`
const OWN = `${HOME}/.claude/palette/library.json`
const PANE_PROPS = { title: 'Palette', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} }

type Res = { status: number; text: string }
type World = {
  toasts: string[]; logs: string[]; files: Map<string, string>; store: Record<string, unknown>; opened: string[]; closed: string[]
  statuses: (string | undefined)[]; processes: string[][]; requests: { url: string; method: string; body?: unknown; auth?: string }[]
}

/**
 * The plugin's files and the user's ~/.claude in memory, its store where the
 * test can read it, and toasts, log lines and pane opens captured.
 */
function world(
  on: On,
  opts: { theme?: string; hasThemesDir?: boolean; store?: Record<string, unknown>; own?: unknown; slot?: string; files?: Record<string, string>; answer?: string; routes?: Record<string, Res | Res[]> } = {},
): World {
  const w: World = { toasts: [], logs: [], files: new Map(Object.entries(opts.files ?? {})), store: { ...opts.store }, opened: [], closed: [], statuses: [], processes: [], requests: [] }
  if (opts.own) w.files.set(OWN, JSON.stringify(opts.own))
  if (opts.slot) w.files.set(SLOT, opts.slot)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  mock.env(on, { HOME })
  on('store.get', ($, e) => ({ value: w.store[e.key] }))
  on('store.set', ($, e) => {
    w.store[e.key] = e.value
    return { value: undefined }
  })
  on('fs.read', ($, e) => ({ value: e.path.endsWith('/palettes.json') ? JSON.stringify(BUNDLED) : w.files.get(e.path) ?? '' }))
  on('fs.exists', ($, e) => ({ value: e.path === `${HOME}/.claude/themes` ? opts.hasThemesDir ?? true : w.files.has(e.path) }))
  on('fs.write', ($, e) => {
    w.files.set(e.path, e.text)
    return { value: undefined }
  })
  on('settings.read', () => ({ value: opts.theme ? { theme: opts.theme } : {} }))
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
    return { value: { isPlaced: true } }
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
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
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
const slot = (w: World) => JSON.parse(w.files.get(SLOT) ?? '{}')

describe('commands', () => {
  test('next converts the first palette into the slot theme and says to pick it once', async ($, on) => {
    const w = world(on, { theme: 'dark' })
    await start($)

    await palette($, 'next')

    // Order: favorites, own, editor, photo, others.
    expect(slot(w).name).toBe('Palette · Dracula')
    expect(slot(w).overrides.claude).toBe('#BD93F9')
    expect(w.store.active).toBe('dracula')
    expect(w.toasts[0]).toMatch(/Dracula · pick "Palette" in \/theme once/)
  })

  test('favorites lead the cycle, and next/prev wrap around it', async ($, on) => {
    const w = world(on, { theme: 'custom:palette', store: { active: 'dracula' } })
    await start($)

    await palette($, 'fav tensor')
    expect(w.store.favorites).toEqual(['tensor'])

    await palette($, 'prev') // tensor, dracula, glacier: before dracula is tensor
    expect(w.store.active).toBe('tensor')
    await palette($, 'prev') // wraps to the end
    expect(w.store.active).toBe('glacier')
    expect(w.toasts.at(-1)).toBe('Glacier')
  })

  test('an id applies that palette; an unknown one writes nothing', async ($, on) => {
    const w = world(on, { theme: 'custom:palette' })
    await start($)

    await palette($, 'nope')
    expect(w.files.has(SLOT)).toBe(false)
    expect(w.toasts[0]).toMatch(/No palette "nope"/)

    await palette($, 'glacier')
    expect(w.store.active).toBe('glacier')
  })

  test('random never repeats the active palette', async ($, on) => {
    const w = world(on, { theme: 'custom:palette', store: { active: 'tensor' } })
    await start($)

    for (let i = 0; i < 10; i++) {
      const before = w.store.active
      await palette($, 'random')
      expect(w.store.active).not.toBe(before)
    }
  })

  test('a themes folder created now needs one restart', async ($, on) => {
    const w = world(on, { hasThemesDir: false })
    await start($)

    await palette($, 'tensor')
    expect(w.toasts[0]).toMatch(/restart Claude Code once/)
  })

  test('own palettes from the library come first and replace a bundled id', async ($, on) => {
    const own = { format: 'pi-palette', version: 1, palettes: [pal('sunrise', 'Sunrise', 'community', '#FF8800'), pal('tensor', 'My Tensor', 'original', '#123456')] }
    const w = world(on, { theme: 'custom:palette', own })
    await start($)

    await palette($, 'next')
    expect(w.store.active).toBe('sunrise')
    await palette($, 'tensor')
    expect(slot(w).overrides.claude).toBe('#123456')
  })

  test('a single Pi theme file counts as a library of one', async ($, on) => {
    const own = { name: 'solo', vars: pal('solo', 'solo', 'x', '#ABCDEF').vars }
    const w = world(on, { theme: 'custom:palette', own })
    await start($)

    await palette($, 'solo')
    expect(slot(w).overrides.claude).toBe('#ABCDEF')
  })
})

describe('picker', () => {
  test('opens a pane grouped like pi-palette, with the active palette focused', async ($, on) => {
    const w = world(on, { store: { active: 'glacier', favorites: ['tensor'] } })
    await start($)

    expect(await palette($, '')).toEqual({})
    expect(w.opened).toEqual(['palette'])

    const ui = await $.ui.mount({ plugin: 'palette', surface: 'terminal', component: 'Pane', requestId: 'palette', props: PANE_PROPS } as never)
    expect(await ui.find({ type: 'Text', text: /Favorites/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /New · from photos/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /★ Tensor/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Active' })).toBeDefined()
  })

  test('moving the ring previews; cancel puts the old slot back', async ($, on) => {
    const w = world(on, { theme: 'custom:palette', store: { active: 'tensor' }, slot: 'OLD' })
    await start($)
    await palette($, '')

    const ui = await $.ui.mount({ plugin: 'palette', surface: 'terminal', component: 'Pane', requestId: 'palette', props: PANE_PROPS } as never)
    await $.ui.focus({ component: 'Pane', requestId: 'palette', element: 'p:dracula', key: 'p:dracula', origin: { kind: 'person' } } as never)
    expect(slot(w).name).toBe('Palette · Dracula')
    expect(w.store.active).toBe('tensor')

    // q, as in pi-palette; Esc runs the same revert from ui.close.
    await ui.press({ key: 'cancel' } as never)
    expect(w.files.get(SLOT)).toBe('OLD')
    expect(w.closed).toContain('palette')
  })

  test('Enter on a palette applies it and closes the pane', async ($, on) => {
    const w = world(on, { theme: 'custom:palette', store: { active: 'tensor' } })
    await start($)
    await palette($, '')

    const ui = await $.ui.mount({ plugin: 'palette', surface: 'terminal', component: 'Pane', requestId: 'palette', props: PANE_PROPS } as never)
    await ui.press({ key: 'p:glacier' } as never)
    expect(w.store.active).toBe('glacier')
    expect(slot(w).name).toBe('Palette · Glacier')
    expect(w.closed).toContain('palette')
  })

  test('f toggles the focused palette as a favorite', async ($, on) => {
    const w = world(on, { store: { active: 'dracula' } })
    await start($)
    await palette($, '')

    const ui = await $.ui.mount({ plugin: 'palette', surface: 'terminal', component: 'Pane', requestId: 'palette', props: PANE_PROPS } as never)
    await ui.press({ key: 'fav' } as never)
    expect(w.store.favorites).toEqual(['dracula'])
  })
})

const TOKEN = `pit_${'a'.repeat(64)}`
const AUTH = `${HOME}/.claude/palette/auth.json`
const ok = (body: unknown): Res => ({ status: 200, text: JSON.stringify(body) })

describe('library', () => {
  test('a theme file from the site is added to your palettes and applied', async ($, on) => {
    const download = { $schema: 'https://pi.dev/theme-schema.json', name: 'midnight', vars: pal('midnight', 'x', 'x', '#7744FF').vars }
    const w = world(on, { theme: 'custom:palette', files: { [`${HOME}/Downloads/midnight.json`]: JSON.stringify(download) } })
    await start($)

    await palette($, 'import ~/Downloads/midnight.json')

    const library = JSON.parse(w.files.get(OWN) ?? '{}')
    expect(library.format).toBe('pi-palette')
    expect(library.palettes.map((p: { id: string }) => p.id)).toEqual(['midnight'])
    expect(w.store.active).toBe('midnight')
    expect(slot(w).overrides.claude).toBe('#7744FF')
    expect(w.processes).toContainEqual(['chmod', '600', OWN])
  })

  test('a whole library replaces yours only after a yes', async ($, on) => {
    const lib = { format: 'pi-palette', version: 1, favorites: ['sunrise', 'ghost'], palettes: [pal('sunrise', 'Sunrise', 'community', '#FF8800')] }
    const files = { [`${HOME}/Downloads/library.json`]: JSON.stringify(lib) }
    const no = world(on, { files, answer: 'Cancel' })
    await start($)
    await palette($, 'import')
    expect(no.files.has(OWN)).toBe(false)
  })

  test('import, confirmed: palettes saved, unknown favorites dropped', async ($, on) => {
    const lib = { format: 'pi-palette', version: 1, favorites: ['sunrise', 'ghost'], palettes: [pal('sunrise', 'Sunrise', 'community', '#FF8800')] }
    const w = world(on, { files: { [`${HOME}/Downloads/library.json`]: JSON.stringify(lib) }, answer: 'Import' })
    await start($)

    await palette($, 'import')
    expect(JSON.parse(w.files.get(OWN) ?? '{}').palettes[0].id).toBe('sunrise')
    expect(w.store.favorites).toEqual(['sunrise'])
    expect(w.toasts).toContain('Imported 1 palettes')
  })
})

describe('export', () => {
  test('writes your palettes, favorites and active palette to Downloads', async ($, on) => {
    mock.clock(on, { now: Date.parse('2026-10-03T00:00:00Z') })
    const own = { format: 'pi-palette', version: 1, palettes: [pal('sunrise', 'Sunrise', 'community', '#FF8800')] }
    const w = world(on, { own, store: { active: 'sunrise', favorites: ['sunrise', 'nord'] } })
    await start($)

    await palette($, 'export')
    const out = JSON.parse(w.files.get(`${HOME}/Downloads/palette-export.json`) ?? '{}')
    expect(out).toEqual({ format: 'pi-palette', version: 1, exportedAt: '2026-10-03T00:00:00.000Z', active: 'sunrise', favorites: ['sunrise', 'nord'], palettes: [expect.objectContaining({ id: 'sunrise', label: 'Sunrise' })] })
    expect(out.palettes[0].group).toBeUndefined()
    expect(w.toasts.at(-1)).toMatch(/Exported 1 palettes and 2 favorites/)
  })
})

describe('site', () => {
  test('login sends the claude-code client, shows the code, and keeps the token once approved', async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-03T00:00:00Z') })
    const w = world(on, {
      routes: {
        'POST /api/pi/link': ok({ code: 'WXYZ-1234', poll: 'p1', url: 'https://palette.prjct.app/link/WXYZ-1234', expiresAt: '2026-10-03T00:10:00Z' }),
        'POST /api/pi/link/claim': [ok({ status: 'pending' }), ok({ status: 'ok', token: TOKEN, username: 'jlopezlira' })],
      },
    })
    await start($)

    await palette($, 'login')
    expect(w.requests[0]).toEqual({ url: 'https://palette.prjct.app/api/pi/link', method: 'POST', body: { client: 'claude-code' }, auth: undefined })
    expect(w.statuses[0]).toMatch(/WXYZ-1234/)
    expect(w.processes).toContainEqual(['open', 'https://palette.prjct.app/link/WXYZ-1234'])

    await clock.advance(3000)
    expect(w.files.has(AUTH)).toBe(false)
    await clock.advance(3000)
    expect(JSON.parse(w.files.get(AUTH) ?? '{}').token).toBe(TOKEN)
    expect(w.processes).toContainEqual(['chmod', '600', AUTH])
    expect(w.statuses.at(-1)).toBeUndefined()
    expect(w.toasts.at(-1)).toMatch(/Connected as @jlopezlira/)
  })

  test('sync sends yours, brings the site library back, and keeps the active palette', async ($, on) => {
    const remote = { user: 'jlopezlira', format: 'pi-palette', version: 1, favorites: ['sunrise'], palettes: [pal('sunrise', 'Sunrise', 'community', '#FF8800')] }
    const w = world(on, {
      theme: 'custom:palette',
      store: { active: 'tensor', favorites: ['dracula'] },
      files: { [AUTH]: JSON.stringify({ token: TOKEN, site: 'https://palette.prjct.app' }) },
      routes: { 'PUT /api/pi/library': ok({ saved: 0, liked: 1 }), 'GET /api/pi/library': ok(remote) },
    })
    await start($)

    await palette($, 'sync')
    expect(w.requests.map(r => `${r.method} ${new URL(r.url).pathname}`)).toEqual(['PUT /api/pi/library', 'GET /api/pi/library'])
    expect(w.requests[0]!.auth).toBe(`Bearer ${TOKEN}`)
    expect(w.requests[0]!.body).toEqual({ format: 'pi-palette', version: 1, favorites: ['dracula'], palettes: [] })
    expect(JSON.parse(w.files.get(OWN) ?? '{}').palettes[0].id).toBe('sunrise')
    expect(w.store.favorites).toEqual(['sunrise'])
    expect(w.store.active).toBe('tensor')
    expect(w.toasts).toContain('Synced as @jlopezlira: 1 palettes, 1 favorites (0 sent)')
  })

  test('a revoked token forgets the login', async ($, on) => {
    const w = world(on, {
      files: { [AUTH]: JSON.stringify({ token: TOKEN }) },
      routes: { 'PUT /api/pi/library': { status: 401, text: '{"error":"revoked"}' } },
    })
    await start($)

    await palette($, 'sync')
    expect(w.files.has(AUTH)).toBe(false)
    expect(w.toasts.at(-1)).toMatch(/disconnected/)
  })

  test('logout revokes the token and removes it here', async ($, on) => {
    const w = world(on, { files: { [AUTH]: JSON.stringify({ token: TOKEN }) }, routes: { 'DELETE /api/pi/token': ok({ ok: true }) } })
    await start($)

    await palette($, 'logout')
    expect(w.requests[0]!.method).toBe('DELETE')
    expect(w.files.has(AUTH)).toBe(false)
    expect(w.toasts.at(-1)).toMatch(/Disconnected/)
  })
})
