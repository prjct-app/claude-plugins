import type { EngineInterface, Register } from 'claude-code'

import { CLIENT, isUnauthorized, parseAuth, request, response, ROUTES, SITE, type LinkClaim, type LinkStart } from './cloud'
import { mergePalettes, parseLibrary, type Library } from './library'
import { toClaudeTheme, type Palette } from './theme'

/**
 * The one theme file /palette rewrites, in the user's themes folder. Claude Code
 * only lets a plugin set the built-in presets, so the person picks "Palette" once
 * in /theme (stored as custom:palette) and /palette swaps the colors inside it.
 * Claude Code watches that folder, so every open session repaints: that is the
 * live preview too.
 */
const SLOT = 'palette'
const PANE = 'palette'
/** The person's own palettes and site login, in this folder of the Claude config folder. */
const DATA = 'palette'
/** Picker groups, as pi-palette names them. */
const GROUPS: [string, string][] = [
  ['own', 'Your palettes'],
  ['editor', 'New · editor classics'],
  ['photo', 'New · from photos'],
  ['original', 'Other themes'],
  ['community', 'Other themes'],
]
const HELP = '/palette [next | prev | random | fav [id] | <id> | import [file] | export [file] | login | sync | logout]'

type Row = { title: string } | { palette: Palette }

/** The picker's working state; the active palette and favorites live in $.store. */
const picker = { palettes: [] as Palette[], favorites: new Set<string>(), focused: '', committed: '', original: undefined as string | undefined, note: '' }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'palette',
      description: 'Pick a color theme from your palettes, with live preview',
      argumentHint: '[next|prev|random|fav|<id>|import|export|login|sync|logout]',
      immediate: true,
    })
    return next(e)
  })

  // Every answer goes to the pane, a toast or a dim log line: nothing here enters Claude's context.
  on('command.run', { command: 'palette' }, async ($, e) => {
    const palettes = await loadPalettes($)
    const favorites = new Set(((await $.store.get('favorites')) ?? []) as string[])
    const active = (await $.store.get('active')) as string | undefined
    const order = ordered(palettes, favorites)
    const [word = '', ...rest] = e.args.trim().split(/\s+/)
    const verb = word.toLowerCase()
    const arg = rest.join(' ')

    switch (verb) {
      case 'import': await importLibrary($, arg); return {}
      case 'export': await exportLibrary($, arg); return {}
      case 'login': await login($); return {}
      case 'sync': await sync($); return {}
      case 'logout': await logout($); return {}
    }

    if (!verb) {
      const slot = await slotPath($)
      Object.assign(picker, {
        palettes,
        favorites,
        committed: active ?? '',
        focused: palettes.some(p => p.id === active) ? active : order[0]?.id ?? '',
        original: (await $.fs.exists(slot)) ? await $.fs.read(slot) : undefined,
        note: '',
      })
      const opened = await $.ui.open({ id: PANE, title: 'Palette', focus: true, closeOnEscape: true, holdToasts: true, rows: 24, columns: 76 })
      if (!opened.isPlaced) $.ui.log(listing(order, favorites, active))
      return {}
    }

    if (verb === 'fav') {
      const id = arg.toLowerCase() || active
      const palette = palettes.find(p => p.id === id)
      if (!palette) {
        $.ui.toast(id ? `No palette "${id}"` : 'No active palette yet. Try /palette fav <id>')
        return {}
      }
      $.ui.toast(await toggleFavorite($, palette, favorites))
      return {}
    }

    const target =
      verb === 'next' ? step(order, active, 1)
      : verb === 'prev' ? step(order, active, -1)
      : verb === 'random' ? random(order, active)
      : palettes.find(p => p.id === verb)
    if (!target) {
      $.ui.toast(`No palette "${verb}". ${HELP}`, { timeoutMs: 6000 })
      return {}
    }
    await commit($, target)
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { palettes, favorites, focused } = picker
    const current = palettes.find(p => p.id === focused)
    const rows = grouped(palettes, favorites)
    const width = e.props.bodyColumns
    const isWide = width >= 64
    const listWidth = isWide ? Math.min(30, Math.max(22, Math.floor(width * 0.4))) : width
    // Draw a window of rows around the focused one, so the arrows always have a row to walk to.
    const room = Math.max(4, e.props.scroll.bodyRows - 4)
    const at = rows.findIndex(r => 'palette' in r && r.palette.id === focused)
    const from = Math.max(0, Math.min(at - Math.floor(room / 2), rows.length - room))

    const list = rows.slice(from, from + room).map(row => {
      if ('title' in row) return <Text dimColor>{`  ${row.title}`}</Text>
      const p = row.palette
      return (
        <Box key={`row:${p.id}`} flexDirection="row" gap={1}>
          <Button key={`p:${p.id}`} plain label={`${favorites.has(p.id) ? '★' : ' '} ${p.label}`} autoFocus={p.id === focused ? true : undefined} onPress={() => void choose($, p)} />
          <Text>{p.swatches.slice(0, 3).map((s, i) => <Text color={s.hex}>{i ? ' ■' : '■'}</Text>)}</Text>
        </Box>
      )
    })

    const details = current && (
      <Box flexDirection="column" width={width - listWidth - 3}>
        <Text bold>{current.label}</Text>
        <Text color={current.vars.success}>{current.id === picker.committed ? 'Active' : 'Live preview'}</Text>
        <Text dimColor>{`${favorites.has(current.id) ? '★ Favorite · ' : ''}${titleOf(current.group)}`}</Text>
        <Text> </Text>
        {current.swatches.map(s => (
          <Box key={`sw:${s.name}`} flexDirection="row" gap={1}>
            <Text color={s.hex}>██</Text>
            <Text>{s.name.padEnd(12)}</Text>
            <Text dimColor>{s.hex}</Text>
          </Box>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Text dimColor>{`${palettes.length} themes · ${favorites.size} favorites${current ? ` · ${current.label}` : ''}`}</Text>
        <Box flexDirection="row" gap={1}>
          <Box flexDirection="column" width={listWidth}>{list}</Box>
          {isWide && details}
        </Box>
        <Box flexDirection="row" gap={2}>
          <Button key="apply" plain hotkey="a" label="apply" onPress={() => void (current && choose($, current))} />
          <Button key="fav" plain hotkey="f" label="favorite" onPress={() => void (current && favoriteFocused($, current))} />
          <Button key="cancel" plain hotkey="q" label="cancel" onPress={() => void cancel($)} />
          <Text dimColor>{picker.note || '↑↓ preview · enter apply · esc cancel'}</Text>
        </Box>
      </Box>
    )
  })

  // Moving the ring onto a palette previews it.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const result = await next(e)
    const id = e.element?.startsWith('p:') ? e.element.slice(2) : undefined
    const palette = picker.palettes.find(p => p.id === id)
    if (palette && palette.id !== picker.focused) {
      picker.focused = palette.id
      picker.note = ''
      await writeSlot($, palette)
      $.ui.invalidate('ui.render')
    }
    return result
  })

  // Esc, or closing the pane by hand, puts back what was there before the preview.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'plugin') await revert($)
    return next(e)
  })
}

async function configDir($: EngineInterface): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
}

async function dataPath($: EngineInterface, file: string): Promise<string> {
  return `${await configDir($)}/${DATA}/${file}`
}

async function slotPath($: EngineInterface): Promise<string> {
  return `${await configDir($)}/themes/${SLOT}.json`
}

/** The bundled set plus the person's own library; a broken own library is reported, never fatal. */
async function loadPalettes($: EngineInterface): Promise<Palette[]> {
  const bundled = parseLibrary(await $.fs.read(`${$.plugin.root}/palettes.json`), false)?.palettes ?? []
  const path = await dataPath($, 'library.json')
  if (!(await $.fs.exists(path))) return bundled
  const own = parseLibrary(await $.fs.read(path), true)
  if (!own) $.ui.toast(`Your palette library could not be read: ${path}`, { timeoutMs: 8000 })
  return mergePalettes(bundled, own?.palettes ?? [])
}

/** Favorites first, then each group in picker order, as pi-palette cycles them. */
function ordered(palettes: Palette[], favorites: ReadonlySet<string>): Palette[] {
  return grouped(palettes, favorites).flatMap(r => ('palette' in r ? [r.palette] : []))
}

function grouped(palettes: Palette[], favorites: ReadonlySet<string>): Row[] {
  const rest = palettes.filter(p => !favorites.has(p.id))
  const sections: [string, Palette[]][] = [['Favorites', palettes.filter(p => favorites.has(p.id))]]
  for (const [group, title] of GROUPS) {
    const list = rest.filter(p => p.group === group)
    const same = sections.find(([t]) => t === title)
    if (same) same[1].push(...list)
    else sections.push([title, list])
  }
  return sections.filter(([, list]) => list.length).flatMap(([title, list]) => [{ title }, ...list.map(palette => ({ palette }))])
}

const titleOf = (group: string): string => GROUPS.find(([g]) => g === group)?.[1] ?? 'Other themes'

function step(order: Palette[], active: string | undefined, by: 1 | -1): Palette | undefined {
  const at = order.findIndex(p => p.id === active)
  if (at < 0) return by === 1 ? order[0] : order[order.length - 1]
  return order[(at + by + order.length) % order.length]
}

function random(order: Palette[], active: string | undefined): Palette | undefined {
  const others = order.filter(p => p.id !== active)
  return others[Math.floor(Math.random() * others.length)]
}

function listing(order: Palette[], favorites: ReadonlySet<string>, active: string | undefined): string {
  const lines = grouped(order, favorites).reduce<string[]>((out, row) => {
    if ('title' in row) out.push(`${row.title}:`)
    else out[out.length - 1] += ` ${row.palette.id === active ? `[${row.palette.id}]` : row.palette.id}`
    return out
  }, [])
  return [...lines, HELP].join('\n')
}

async function writeSlot($: EngineInterface, p: Palette): Promise<boolean> {
  const path = await slotPath($)
  // Claude Code only watches the folder if it existed at startup.
  const hadFolder = await $.fs.exists(path.slice(0, path.lastIndexOf('/')))
  await $.fs.write(path, `${JSON.stringify(toClaudeTheme(p, `Palette · ${p.label}`), null, '\t')}\n`)
  return hadFolder
}

/** Apply for good: write the slot, remember it, and say what's left to do. */
async function commit($: EngineInterface, p: Palette): Promise<void> {
  const hadFolder = await writeSlot($, p)
  await $.store.set('active', p.id)
  const { theme } = (await $.settings.read()) as { theme?: unknown }
  const hint = !hadFolder
    ? ' · restart Claude Code once, then pick "Palette" in /theme'
    : theme !== `custom:${SLOT}` ? ' · pick "Palette" in /theme once to see it' : ''
  $.ui.toast(`${p.label}${hint}`, hint ? { timeoutMs: 8000 } : undefined)
}

async function choose($: EngineInterface, p: Palette): Promise<void> {
  picker.focused = p.id
  picker.committed = p.id
  await commit($, p)
  await $.ui.close({ id: PANE })
}

/** Undo a preview: the slot as it was before the picker opened, else the active palette. */
async function revert($: EngineInterface): Promise<void> {
  if (picker.focused === picker.committed) return
  const active = picker.palettes.find(p => p.id === picker.committed)
  if (picker.original !== undefined) await $.fs.write(await slotPath($), picker.original)
  else if (active) await writeSlot($, active)
  picker.focused = picker.committed
}

async function cancel($: EngineInterface): Promise<void> {
  await revert($)
  await $.ui.close({ id: PANE })
}

async function toggleFavorite($: EngineInterface, p: Palette, favorites: Set<string>): Promise<string> {
  const isFavorite = favorites.delete(p.id)
  if (!isFavorite) favorites.add(p.id)
  await $.store.set('favorites', [...favorites])
  return isFavorite ? `${p.label} removed from favorites` : `★ ${p.label} added to favorites`
}

async function favoriteFocused($: EngineInterface, p: Palette): Promise<void> {
  picker.note = await toggleFavorite($, p, picker.favorites)
  $.ui.invalidate('ui.render')
}

/* ---------- the person's library: import a file, or sync with the site ---------- */

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function api<T>($: EngineInterface, path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  const { url, init } = request(path, opts)
  return response<T>(await $.http.fetch(url, init))
}

/** A file only this user can read, in a folder only they can open. */
async function writePrivate($: EngineInterface, path: string, text: string): Promise<void> {
  await $.process.run(['mkdir', '-p', '-m', '700', path.slice(0, path.lastIndexOf('/'))])
  await $.fs.write(path, text)
  await $.process.run(['chmod', '600', path])
}

async function readOwn($: EngineInterface): Promise<Palette[]> {
  const path = await dataPath($, 'library.json')
  return (await $.fs.exists(path)) ? parseLibrary(await $.fs.read(path), true)?.palettes ?? [] : []
}

/** Save palettes as the person's own, keep the favorites that exist, and apply `active` when it does. */
async function installLibrary($: EngineInterface, library: Library, note: string): Promise<void> {
  const palettes = library.palettes.map(({ group: _group, ...p }) => p)
  await writePrivate($, await dataPath($, 'library.json'), `${JSON.stringify({ format: 'pi-palette', version: 1, palettes }, null, '\t')}\n`)
  const all = await loadPalettes($)
  const known = new Set(all.map(p => p.id))
  await $.store.set('favorites', library.favorites.filter(id => known.has(id)))
  $.ui.toast(note, { timeoutMs: 6000 })
  const active = all.find(p => p.id === library.active)
  if (active) await commit($, active)
}

/** A pi-themes library replaces yours, after a yes; a single theme file (the site's download) is added to it. */
async function importLibrary($: EngineInterface, arg: string): Promise<void> {
  const home = (await $.env.get('HOME')) ?? ''
  const candidates = arg ? [arg.replace(/^~(?=$|\/)/, home)] : [`${home}/Downloads/library.json`, `${home}/Downloads/pi-palette.json`]
  let path: string | undefined
  for (const candidate of candidates) if (!path && (await $.fs.exists(candidate))) path = candidate
  if (!path) {
    $.ui.toast('No library found. Try /palette import ~/Downloads/library.json', { timeoutMs: 6000 })
    return
  }
  const text = await $.fs.read(path)
  const library = parseLibrary(text, true)
  if (!library || library.palettes.length === 0) {
    $.ui.toast(`Could not import ${path}: not a palette library or theme file`, { timeoutMs: 6000 })
    return
  }
  const isWholeLibrary = Array.isArray((JSON.parse(text) as { palettes?: unknown }).palettes)
  if (!isWholeLibrary) {
    const added = library.palettes[0]!
    const own = (await readOwn($)).filter(p => p.id !== added.id)
    const favorites = ((await $.store.get('favorites')) ?? []) as string[]
    await installLibrary($, { palettes: [...own, added], favorites, active: added.id }, `Added ${added.label} to your palettes`)
    return
  }
  let answer = ''
  try {
    answer = await $.ui.ask(`Import ${library.palettes.length} palettes and ${library.favorites.length} favorites from ${path}? This replaces your library and favorites.`, ['Import', 'Cancel'])
  } catch {
    /* dismissed, or nobody to ask */
  }
  if (answer !== 'Import') return
  await installLibrary($, library, `Imported ${library.palettes.length} palettes`)
}

/** Your palettes, favorites and the active palette in one file the site's library page takes back. */
async function exportLibrary($: EngineInterface, arg: string): Promise<void> {
  const home = (await $.env.get('HOME')) ?? ''
  const path = arg ? arg.replace(/^~(?=$|\/)/, home) : `${home}/Downloads/palette-export.json`
  const palettes = (await readOwn($)).map(({ group: _group, ...p }) => p)
  const favorites = ((await $.store.get('favorites')) ?? []) as string[]
  const active = (await $.store.get('active')) as string | undefined
  const library = { format: 'pi-palette', version: 1, exportedAt: new Date(await $.clock.now()).toISOString(), ...(active ? { active } : {}), favorites, palettes }
  try {
    await writePrivate($, path, `${JSON.stringify(library, null, '\t')}\n`)
    $.ui.toast(`Exported ${palettes.length} palettes and ${favorites.length} favorites to ${path}`, { timeoutMs: 8000 })
  } catch (error) {
    $.ui.toast(`Could not export: ${message(error)}`, { timeoutMs: 8000 })
  }
}

async function readAuth($: EngineInterface) {
  const path = await dataPath($, 'auth.json')
  return (await $.fs.exists(path)) ? parseAuth(await $.fs.read(path)) : undefined
}

async function forgetAuth($: EngineInterface): Promise<void> {
  await $.process.run(['rm', '-f', await dataPath($, 'auth.json')])
}

/** Cancels the login poll, when one is running. */
let stopLogin: (() => void) | undefined

async function login($: EngineInterface): Promise<void> {
  const existing = await readAuth($)
  if (existing) {
    $.ui.toast(`Already connected${existing.username ? ` as @${existing.username}` : ''}. /palette sync, or /palette logout`)
    return
  }
  let link: LinkStart
  try {
    link = await api<LinkStart>($, ROUTES.link, { method: 'POST', body: { client: CLIENT } })
  } catch (error) {
    $.ui.toast(`Could not reach ${SITE}: ${message(error)}`, { timeoutMs: 8000 })
    return
  }
  $.ui.status(`approve code ${link.code} at ${link.url}`)
  $.ui.toast(`Approve code ${link.code} at ${link.url} (signed in). Waiting…`, { timeoutMs: 15000 })
  // Best effort: the code and the URL are on screen either way.
  for (const opener of ['open', 'xdg-open']) {
    try {
      if ((await $.process.run([opener, link.url])).exitCode === 0) break
    } catch {
      /* not this platform's opener */
    }
  }

  stopLogin?.()
  const deadline = Date.parse(link.expiresAt) || (await $.clock.now()) + 10 * 60_000
  const done = (text: string) => {
    stopLogin?.()
    stopLogin = undefined
    $.ui.status(undefined)
    $.ui.toast(text, { timeoutMs: 8000 })
  }
  const timer = $.clock.every(3000, async () => {
    if ((await $.clock.now()) > deadline) return done('The login code expired. Run /palette login again.')
    try {
      const claim = await api<LinkClaim>($, ROUTES.claim, { method: 'POST', body: { poll: link.poll } })
      if (claim.status === 'ok') {
        const auth = { token: claim.token, username: claim.username, site: SITE, connectedAt: new Date(await $.clock.now()).toISOString() }
        await writePrivate($, await dataPath($, 'auth.json'), `${JSON.stringify(auth, null, '\t')}\n`)
        done(`Connected${claim.username ? ` as @${claim.username}` : ''}. Run /palette sync to bring your palettes.`)
      } else if (claim.status !== 'pending') done('The login code expired. Run /palette login again.')
    } catch {
      /* a network blip: keep waiting until the code expires */
    }
  })
  stopLogin = () => timer.cancel()
}

/** Send your palettes and favorites, then bring the site's library back; the active palette stays. */
async function sync($: EngineInterface): Promise<void> {
  const auth = await readAuth($)
  if (!auth) {
    $.ui.toast('Not connected. Run /palette login first, or /palette import a file.', { timeoutMs: 6000 })
    return
  }
  try {
    const favorites = ((await $.store.get('favorites')) ?? []) as string[]
    const palettes = (await readOwn($)).map(({ group: _group, ...p }) => p)
    const pushed = await api<{ saved: number }>($, ROUTES.library, { method: 'PUT', token: auth.token, body: { format: 'pi-palette', version: 1, favorites, palettes } })
    const remote = await api<unknown>($, ROUTES.library, { token: auth.token })
    const library = parseLibrary(JSON.stringify(remote), true) ?? { palettes: [], favorites: [] }
    const user = typeof (remote as { user?: unknown }).user === 'string' ? (remote as { user: string }).user : auth.username
    const active = (await $.store.get('active')) as string | undefined
    await installLibrary(
      $,
      { ...library, ...(active ? { active } : {}) },
      `Synced${user ? ` as @${user}` : ''}: ${library.palettes.length} palettes, ${library.favorites.length} favorites (${pushed.saved} sent)`,
    )
  } catch (error) {
    if (isUnauthorized(error)) {
      await forgetAuth($)
      $.ui.toast('This Claude Code was disconnected from the site. Run /palette login again.', { timeoutMs: 8000 })
      return
    }
    $.ui.toast(`Sync failed: ${message(error)}`, { timeoutMs: 8000 })
  }
}

async function logout($: EngineInterface): Promise<void> {
  stopLogin?.()
  stopLogin = undefined
  $.ui.status(undefined)
  const auth = await readAuth($)
  if (!auth) {
    $.ui.toast('Not connected.')
    return
  }
  try {
    await api($, ROUTES.token, { method: 'DELETE', token: auth.token })
  } catch {
    /* removed here either way; it can also be revoked on the site */
  }
  await forgetAuth($)
  $.ui.toast('Disconnected. Your palettes stay on this computer.')
}
