import type { EngineInterface, Register } from 'claude-code'

import { FILE, KEEP, STALE_LOCK_MS, WHY, ago, hashLibrary, isDue, isSame, nextCheck, nextFile, parseState, parseVersion, when, type BackupReason, type BackupState, type Saved, type Version } from './backup'
import { CLIENT, ROUTES, backupPath, isNotFound, isUnauthorized, parseAuth, parseBackups, request, response, siteName, siteOrigin, type Auth, type CloudVersion, type LinkClaim, type LinkStart } from './cloud'
import { parseLibrary, toFile, type Library, type LibraryFile } from './library'
import { toClaudeTheme, type Palette } from './theme'

/**
 * /palette keeps Claude Code's themes up to date; /theme picks and previews
 * them. The bundled palettes ship as the plugin's own themes. The person's
 * palettes (imported, synced, restored) are written as theme files into
 * Claude Code's themes folder, so /theme lists those too. Claude Code gives a
 * plugin no way to select a custom theme, so nothing here applies one.
 */
const PANE = 'palette'
/** The person's library, site login and backups, in this folder of the Claude config folder. */
const DATA = 'palette'
const HELP = '/palette [login | sync | logout | import [file] | export [file] | backup | backups]'
/** After the session is up: refresh the theme files and run the weekly backup when it is due. */
const STARTUP_DELAY_MS = 2000

type Row = { title: string; meta: string } | { id: string; label: string; meta?: string }
type Outcome = { text: string; isProblem: boolean }

/** What the pane draws from; filled when it opens and after every action. */
const pane = {
  isOpen: false,
  focused: 'act:login',
  note: '',
  confirm: '',
  isBusy: false,
  bundled: 0,
  own: [] as Palette[],
  favorites: 0,
  auth: undefined as Auth | undefined,
  site: '',
  state: {} as BackupState,
  versions: [] as Saved[],
  cloud: [] as CloudVersion[],
  cloudProblem: '',
  now: 0,
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'palette',
      description: 'Keep your color themes up to date: account sync, import, export and backups. Pick them in /theme',
      argumentHint: '[login|sync|logout|import|export|backup|backups]',
      immediate: true,
    })
    const started = await next(e)
    if (e.isInteractive) $.clock.after(STARTUP_DELAY_MS, () => void startup($))
    return started
  })

  // Every answer goes to the pane, a toast or a dim log line: nothing here enters Claude's context.
  on('command.run', { command: 'palette' }, async ($, e) => {
    const [word = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')
    switch (word.toLowerCase()) {
      case '': await openPane($, undefined); break
      case 'backups': await openPane($, 'backups'); break
      case 'import': await importLibrary($, arg); break
      case 'export': await exportLibrary($, arg); break
      case 'login': await login($); break
      case 'sync': await sync($); break
      case 'logout': await logout($); break
      case 'backup': await backupNow($); break
      default: $.ui.toast(`Themes are picked in /theme. ${HELP}`, { timeoutMs: 8000 })
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = e.props.bodyColumns
    const isWide = width >= 64
    const listWidth = isWide ? Math.min(34, Math.max(26, Math.floor(width * 0.45))) : width
    const rows = paneRows()
    const room = Math.max(4, e.props.scroll.bodyRows - 6)
    const at = Math.max(0, rows.findIndex(r => 'id' in r && r.id === pane.focused))
    // Draw a window of rows around the focused one, so the arrows always have a row to walk to.
    const from = Math.max(0, Math.min(at - Math.floor(room / 2), rows.length - room))

    const list = rows.slice(from, from + room).map(row => {
      if ('title' in row) {
        // A section title, with a line of air above every one but the first.
        return (
          <Box key={`title:${row.title}`} flexDirection="column">
            {row === rows[0] ? [] : <Text> </Text>}
            <Box flexDirection="row" gap={1}>
              <Text bold>{row.title}</Text>
              <Text dimColor>{row.meta}</Text>
            </Box>
          </Box>
        )
      }
      return (
        <Box key={`row:${row.id}`} flexDirection="row" gap={1}>
          <Text> </Text>
          <Button key={row.id} plain label={row.label} autoFocus={row.id === pane.focused ? true : undefined} onPress={() => void press($, row.id)} />
          <Text dimColor>{row.meta ?? ''}</Text>
        </Box>
      )
    })

    const isConnected = Boolean(pane.auth)
    const isBackup = pane.focused.startsWith('bk:')
    const hotkeys = [
      ...(isConnected ? [<Button key="sync" plain hotkey="s" label="sync" onPress={() => void press($, 'act:sync')} />] : []),
      <Button key="account" plain hotkey="l" label={isConnected ? 'log out' : 'log in'} onPress={() => void press($, isConnected ? 'act:logout' : 'act:login')} />,
      <Button key="import" plain hotkey="i" label="import" onPress={() => void press($, 'act:import')} />,
      <Button key="export" plain hotkey="e" label="export" onPress={() => void press($, 'act:export')} />,
      <Button key="backup" plain hotkey="b" label="back up" onPress={() => void press($, 'act:backup')} />,
      ...(isBackup ? [<Button key="restore" plain hotkey="r" label="restore" onPress={() => void press($, pane.focused)} />] : []),
      <Button key="close" plain hotkey="q" label="close" onPress={() => void closePane($)} />,
    ]
    const message = pane.confirm
      ? <Text color="warning">Press enter or r again to restore it · moving away cancels</Text>
      : pane.note
        ? <Text>{pane.note}</Text>
        : <Text dimColor>↑↓ select · enter run · esc close</Text>

    return (
      <Box flexDirection="column">
        <Text dimColor>{headline()}</Text>
        <Box flexDirection="row" gap={2}>
          <Box flexDirection="column" width={listWidth}>{list}</Box>
          {isWide ? <Box flexDirection="column" width={width - listWidth - 2}>{detail().map(line => (
            <Text bold={line.tone === 'bold' ? true : undefined} dimColor={line.tone === 'dim' ? true : undefined}>{line.text || ' '}</Text>
          ))}</Box> : <Text> </Text>}
        </Box>
        <Box flexDirection="row" gap={2}>{hotkeys}</Box>
        {message}
      </Box>
    )
  })

  // Moving the ring shows that row's details; it also cancels a restore that was waiting for its second press.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const result = await next(e)
    const id = e.element
    if (id && (id.startsWith('act:') || id.startsWith('bk:')) && id !== pane.focused) {
      pane.focused = id
      pane.confirm = ''
      $.ui.invalidate('ui.render')
    }
    return result
  })

  // The person's own close (Esc, the close mark). The plugin's own closes go through closePane: its hook is not run for them.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    pane.isOpen = false
    pane.confirm = ''
    return next(e)
  })
}

/* ---------- the pane ---------- */

function paneRows(): Row[] {
  const isConnected = Boolean(pane.auth)
  return [
    { title: 'Account', meta: isConnected ? `${pane.auth?.username ? `@${pane.auth.username}` : 'connected'}` : 'not connected' },
    ...(isConnected ? [{ id: 'act:sync', label: 'Sync now' }, { id: 'act:logout', label: 'Log out' }] : [{ id: 'act:login', label: 'Log in' }]),
    { id: 'act:import', label: 'Import a library file' },
    { id: 'act:export', label: 'Export your palettes' },
    { title: 'Backups', meta: `${pane.versions.length}/${KEEP} here${isConnected ? ` · ${pane.cloudProblem ? 'cloud ✕' : `${pane.cloud.length}/${KEEP} cloud`}` : ''}` },
    { id: 'act:backup', label: 'Back up now' },
    ...pane.versions.map(v => ({ id: `bk:local:${v.file}`, label: when(v.version.createdAt), meta: 'here' })),
    ...pane.cloud.map(v => ({ id: `bk:cloud:${v.id}`, label: when(v.createdAt), meta: 'cloud' })),
  ]
}

function headline(): string {
  const yours = pane.own.length ? ` · ${pane.own.length} yours` : ''
  return `${pane.bundled} themes in /theme${yours} · ${pane.favorites} favorites`
}

const accountLine = (): string =>
  pane.auth ? `${pane.auth.username ? `@${pane.auth.username}` : 'Connected'} on ${pane.site}` : 'Not connected: backups stay on this computer'

function backupsLine(): string {
  const parts = [`${pane.versions.length}/${KEEP} here`]
  if (pane.auth) parts.push(pane.cloudProblem ? `cloud: ${pane.cloudProblem}` : `${pane.cloud.length}/${KEEP} cloud`)
  parts.push(`next check ${nextCheck(pane.state, pane.now)}`)
  return parts.join(' · ')
}

const ACTION_HELP: Record<string, (site: string) => string> = {
  sync: site => `Sends your palettes and favorites to ${site}, brings your library back, and writes your palettes as themes for /theme.`,
  login: site => `Shows a short code and opens ${site}. Approve it there while signed in. From then on, backups also go to the cloud.`,
  logout: () => "Revokes this Claude Code's token. Your palettes, their themes and their backups stay on this computer.",
  import: () => 'A theme file from the site is added to your palettes. A whole library.json (default: ~/Downloads/library.json) replaces your library and favorites, after a yes.',
  export: () => 'Writes your palettes and favorites to ~/Downloads/palette-export.json, ready for the site.',
  backup: site => `Saves a version of your library here, and on ${site} when connected. Each side keeps the last ${KEEP}; one runs by itself every week.`,
}

type Line = { text: string; tone?: 'bold' | 'dim' }

/** The right side: what the focused row is, or does. */
function detail(): Line[] {
  const [kind, side, ...keyParts] = pane.focused.split(':')
  const key = keyParts.join(':')
  const restore: Line = { text: 'Enter or r, twice, restores it. Your current library is saved as a version first.', tone: 'dim' }
  if (kind === 'bk' && side === 'cloud') {
    const v = pane.cloud.find(x => x.id === key)
    if (!v) return [{ text: 'This backup is no longer listed.', tone: 'dim' }]
    return [
      { text: when(v.createdAt), tone: 'bold' },
      { text: `On ${pane.site}`, tone: 'dim' },
      { text: '' },
      { text: `Saved      ${ago(Date.parse(v.createdAt), pane.now)}` },
      { text: `From       ${v.client ?? '—'}` },
      { text: `Palettes   ${v.palettes}` },
      { text: `Favorites  ${v.favorites}` },
      { text: '' },
      restore,
    ]
  }
  if (kind === 'bk') {
    const v = pane.versions.find(x => x.file === key)?.version
    if (!v) return [{ text: 'This backup is no longer listed.', tone: 'dim' }]
    return [
      { text: when(v.createdAt), tone: 'bold' },
      { text: 'On this computer', tone: 'dim' },
      { text: '' },
      { text: `Saved      ${ago(Date.parse(v.createdAt), pane.now)}` },
      { text: `Why        ${WHY[v.reason]}` },
      { text: `Palettes   ${v.local.palettes.length}` },
      { text: `Favorites  ${v.local.favorites.length}` },
      { text: `Cloud      ${v.cloud ? `${v.cloud.palettes.length} palettes${v.user ? ` from @${v.user}` : ''}` : 'not connected then'}` },
      ...(v.local.palettes.length ? [{ text: '' }, { text: 'Your palettes', tone: 'bold' as const }, ...v.local.palettes.slice(0, 12).map(p => ({ text: `${p.label}  ${p.id}` }))] : []),
      { text: '' },
      restore,
    ]
  }
  const label = paneRows().find(r => 'id' in r && r.id === pane.focused)
  return [
    { text: label && 'label' in label ? label.label : 'Palette', tone: 'bold' },
    { text: '' },
    { text: ACTION_HELP[side ?? '']?.(pane.site) ?? '' },
    { text: '' },
    { text: 'Account', tone: 'bold' },
    { text: accountLine() },
    { text: '' },
    { text: 'Backups', tone: 'bold' },
    { text: backupsLine() },
    ...(pane.own.length ? [{ text: '' }, { text: 'Your palettes, in /theme', tone: 'bold' as const }, ...pane.own.slice(0, 12).map(p => ({ text: `${p.label}  ${p.id}` }))] : []),
  ]
}

/** Read what the pane shows from disk; the cloud list comes separately, and only when connected. */
async function refresh($: EngineInterface): Promise<void> {
  pane.now = await $.clock.now()
  pane.site = siteName(await site($))
  pane.auth = await readAuth($)
  pane.bundled = (await readBundled($)).length
  pane.own = await readOwn($)
  pane.favorites = (await readFavorites($)).length
  pane.state = await readState($)
  pane.versions = await readVersions($)
  if (!pane.auth) {
    pane.cloud = []
    pane.cloudProblem = ''
  }
  if (!paneRows().some(r => 'id' in r && r.id === pane.focused)) pane.focused = pane.auth ? 'act:sync' : 'act:login'
}

async function refreshCloud($: EngineInterface): Promise<void> {
  if (!pane.auth) return
  try {
    pane.cloud = parseBackups(await api<unknown>($, ROUTES.backups, { token: pane.auth.token }))
    pane.cloudProblem = ''
  } catch (error) {
    pane.cloudProblem = cloudProblem(error, pane.site)
  }
}

/** Redraw the pane with what is on disk now, when it is open. */
async function redraw($: EngineInterface, withCloud = false): Promise<void> {
  if (!pane.isOpen) return
  await refresh($)
  if (withCloud) await refreshCloud($)
  $.ui.invalidate('ui.render')
}

async function openPane($: EngineInterface, initial: 'backups' | undefined): Promise<void> {
  try {
    await refresh($)
  } catch (error) {
    $.ui.toast(`Palette: ${message(error)}`, { timeoutMs: 8000 })
    return
  }
  pane.note = ''
  pane.confirm = ''
  pane.focused = initial === 'backups' ? (pane.versions[0] ? `bk:local:${pane.versions[0].file}` : 'act:backup') : pane.auth ? 'act:sync' : 'act:login'
  pane.isOpen = true
  const opened = await $.ui.open({ id: PANE, title: 'Palette', focus: true, closeOnEscape: true, rows: 22, columns: 78 })
  if (!opened.isPlaced) {
    pane.isOpen = false
    $.ui.log([headline(), `Account: ${accountLine()}`, `Backups: ${backupsLine()}`, HELP].join('\n'))
    return
  }
  // The cloud list arrives after the pane is up: opening never waits on the network.
  if (pane.auth) void refreshCloud($).then(() => $.ui.invalidate('ui.render'))
}

async function closePane($: EngineInterface): Promise<void> {
  pane.isOpen = false
  pane.confirm = ''
  await $.ui.close({ id: PANE })
}

/** A row's action: Enter on it, its hotkey, or a click. */
async function press($: EngineInterface, id: string): Promise<void> {
  if (pane.isBusy) return
  if (id.startsWith('bk:')) {
    if (pane.confirm !== id) {
      pane.focused = id
      pane.confirm = id
      $.ui.invalidate('ui.render')
      return
    }
    pane.confirm = ''
    return busy($, 'Restoring…', () => restore($, id.slice(3)))
  }
  pane.confirm = ''
  switch (id) {
    case 'act:sync': return busy($, 'Syncing…', () => sync($))
    case 'act:login': return login($)
    case 'act:logout': return busy($, 'Disconnecting…', () => logout($))
    case 'act:export': return exportLibrary($, '')
    case 'act:backup': return busy($, 'Backing up…', () => backupNow($))
    case 'act:import':
      // The import may ask a question, and a dialog needs the keys the pane holds.
      await closePane($)
      return importLibrary($, '')
  }
}

/** Run one action at a time, saying so in the pane while it runs. */
async function busy($: EngineInterface, text: string, fn: () => Promise<void>): Promise<void> {
  pane.isBusy = true
  pane.note = text
  $.ui.invalidate('ui.render')
  try {
    await fn()
  } finally {
    pane.isBusy = false
  }
}

/** Say how something went: in the pane while it is open, as a toast otherwise. */
function say($: EngineInterface, text: string, timeoutMs = 8000): void {
  if (pane.isOpen) {
    pane.note = text
    $.ui.invalidate('ui.render')
  } else {
    $.ui.toast(text, { timeoutMs })
  }
}

/* ---------- files ---------- */

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function configDir($: EngineInterface): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${await $.env.get('HOME')}/.claude`
}

async function dataPath($: EngineInterface, file: string): Promise<string> {
  return `${await configDir($)}/${DATA}/${file}`
}

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : undefined
}

/** A file only this user can read, in a folder only they can open. */
async function writePrivate($: EngineInterface, path: string, text: string): Promise<void> {
  await $.process.run(['mkdir', '-p', '-m', '700', path.slice(0, path.lastIndexOf('/'))])
  await $.fs.write(path, text)
  await $.process.run(['chmod', '600', path])
}

async function readBundled($: EngineInterface): Promise<Palette[]> {
  return parseLibrary(String(await $.fs.read(`${$.plugin.root}/palettes.json`)), false)?.palettes ?? []
}

/** The person's own palettes; a library that cannot be read is said once and counts as empty. */
async function readOwn($: EngineInterface): Promise<Palette[]> {
  const path = await dataPath($, 'library.json')
  const text = await readText($, path)
  if (text === undefined) return []
  const library = parseLibrary(text, true)
  if (!library) $.ui.toast(`Your palette library could not be read: ${path}`, { timeoutMs: 8000 })
  return library?.palettes ?? []
}

async function readFavorites($: EngineInterface): Promise<string[]> {
  const stored = await $.store.get('favorites')
  return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []
}

/** The library as it is on this computer now. */
async function snapshot($: EngineInterface): Promise<LibraryFile> {
  return toFile({ palettes: await readOwn($), favorites: await readFavorites($) })
}

/**
 * Keep one theme file per palette of the person's in Claude Code's themes
 * folder, where /theme lists it: rewrite what changed, remove the files this
 * plugin wrote for palettes that are gone. A theme file of the person's own
 * with the same name is left alone and wins.
 */
async function syncThemes($: EngineInterface, own: Palette[]): Promise<{ count: number; kept: string[]; isNewFolder: boolean }> {
  const dir = `${await configDir($)}/themes`
  const ownedPath = await dataPath($, 'owned-themes.json')
  const owned = parseOwned(await readText($, ownedPath))
  if (!own.length && !owned.length) return { count: 0, kept: [], isNewFolder: false }
  // Claude Code only watches the folder if it existed at startup.
  const isNewFolder = !(await $.fs.exists(dir))
  const mine: string[] = []
  const kept: string[] = []
  for (const p of own) {
    const file = `${p.id}.json`
    const path = `${dir}/${file}`
    const text = `${JSON.stringify(toClaudeTheme(p), null, '\t')}\n`
    const current = await readText($, path)
    if (current !== undefined && current !== text && !owned.includes(file)) {
      kept.push(p.id)
      continue
    }
    if (current !== text) await $.fs.write(path, text)
    mine.push(file)
  }
  for (const file of owned) if (!mine.includes(file)) await $.process.run(['rm', '-f', `${dir}/${file}`])
  const next = [...mine].sort()
  if (JSON.stringify(next) !== JSON.stringify([...owned].sort())) await writePrivate($, ownedPath, `${JSON.stringify(next)}\n`)
  return { count: mine.length, kept, isNewFolder }
}

function parseOwned(text: string | undefined): string[] {
  try {
    const data: unknown = JSON.parse(text ?? '[]')
    return Array.isArray(data) ? data.filter((f): f is string => typeof f === 'string' && /^[a-z0-9][a-z0-9-]{0,47}\.json$/.test(f)) : []
  } catch {
    return []
  }
}

/** Save palettes as the person's own, keep the favorites that exist, and write their themes for /theme. */
async function installLibrary($: EngineInterface, library: Library, note: string): Promise<void> {
  const file = toFile({ palettes: library.palettes, favorites: [] })
  await writePrivate($, await dataPath($, 'library.json'), `${JSON.stringify({ format: file.format, version: file.version, palettes: file.palettes }, null, '\t')}\n`)
  const own = await readOwn($)
  const known = new Set([...(await readBundled($)), ...own].map(p => p.id))
  await $.store.set('favorites', library.favorites.filter(id => known.has(id)))
  const themes = await syncThemes($, own)
  const where = !themes.count
    ? ''
    : themes.isNewFolder
      ? ` · restart Claude Code once, then find ${themes.count === 1 ? 'it' : 'them'} in /theme`
      : ` · ${themes.count === 1 ? 'it is' : 'they are'} in /theme`
  const left = themes.kept.length ? ` · kept your own theme file for ${themes.kept.join(', ')}` : ''
  say($, `${note}${where}${left}`)
}

/* ---------- import and export ---------- */

/** A whole library replaces yours, after a yes; a single theme file (the site's download) is added to it. */
async function importLibrary($: EngineInterface, arg: string): Promise<void> {
  const home = (await $.env.get('HOME')) ?? ''
  const candidates = arg ? [arg.replace(/^~(?=$|\/)/, home)] : [`${home}/Downloads/library.json`, `${home}/Downloads/pi-palette.json`]
  let path: string | undefined
  for (const candidate of candidates) if (!path && (await $.fs.exists(candidate))) path = candidate
  if (!path) {
    say($, 'No library found. Try /palette import ~/Downloads/library.json')
    return
  }
  const text = String(await $.fs.read(path))
  const library = parseLibrary(text, true)
  if (!library || library.palettes.length === 0) {
    say($, `Could not import ${path}: not a palette library or theme file`)
    return
  }
  const isWholeLibrary = Array.isArray((JSON.parse(text) as { palettes?: unknown }).palettes)
  if (!isWholeLibrary) {
    const added = library.palettes[0]!
    const own = (await readOwn($)).filter(p => p.id !== added.id)
    await installLibrary($, { palettes: [...own, added], favorites: await readFavorites($) }, `Added ${added.label} to your palettes`)
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

/** Your palettes and favorites in one file the site's library page takes back. */
async function exportLibrary($: EngineInterface, arg: string): Promise<void> {
  const home = (await $.env.get('HOME')) ?? ''
  const path = arg ? arg.replace(/^~(?=$|\/)/, home) : `${home}/Downloads/palette-export.json`
  try {
    const library = { ...(await snapshot($)), exportedAt: new Date(await $.clock.now()).toISOString() }
    await writePrivate($, path, `${JSON.stringify(library, null, '\t')}\n`)
    say($, `Exported ${library.palettes.length} palettes and ${library.favorites.length} favorites to ${path}`)
  } catch (error) {
    say($, `Could not export: ${message(error)}`)
  }
}

/* ---------- the site: login, sync, logout ---------- */

/** The site's origin; PALETTE_SITE_URL points at another one (https, or http on localhost). */
async function site($: EngineInterface): Promise<string> {
  return siteOrigin(await $.env.get('PALETTE_SITE_URL'))
}

async function api<T>($: EngineInterface, path: string, opts: { method?: string; token?: string; body?: unknown } = {}): Promise<T> {
  const { url, init } = request(await site($), path, opts)
  return response<T>(await $.http.fetch(url, init))
}

/** The login kept here, when the site in use issued it. */
async function readAuth($: EngineInterface): Promise<Auth | undefined> {
  const text = await readText($, await dataPath($, 'auth.json'))
  return text === undefined ? undefined : parseAuth(text, await site($))
}

async function forgetAuth($: EngineInterface): Promise<void> {
  await $.process.run(['rm', '-f', await dataPath($, 'auth.json')])
}

/** Cloud errors in a few words. */
function cloudProblem(error: unknown, name: string): string {
  if (isNotFound(error)) return `${name} does not keep backups yet`
  if (isUnauthorized(error)) return 'this Claude Code was disconnected'
  return error instanceof Error && 'status' in error ? error.message : `could not reach ${name}`
}

/** Cancels the login poll, when one is running. */
let stopLogin: (() => void) | undefined

async function login($: EngineInterface): Promise<void> {
  let link: LinkStart
  let name = ''
  try {
    name = siteName(await site($))
    const existing = await readAuth($)
    if (existing) {
      say($, `Already connected${existing.username ? ` as @${existing.username}` : ''}. /palette sync, or /palette logout`)
      return
    }
    link = await api<LinkStart>($, ROUTES.link, { method: 'POST', body: { client: CLIENT } })
    if (typeof link.code !== 'string' || typeof link.poll !== 'string' || typeof link.url !== 'string') throw new Error('unexpected answer')
  } catch (error) {
    say($, `Could not reach ${name || 'the site'}: ${message(error)}`)
    return
  }
  $.ui.status(`approve code ${link.code} at ${link.url}`)
  say($, `Approve code ${link.code} at ${link.url} (signed in). Waiting…`, 15000)
  // Best effort, and only a web page: the code and the URL are on screen either way.
  if (/^https?:\/\//.test(link.url)) {
    for (const opener of ['open', 'xdg-open']) {
      try {
        if ((await $.process.run([opener, link.url])).exitCode === 0) break
      } catch {
        /* not this platform's opener */
      }
    }
  }

  stopLogin?.()
  const deadline = Date.parse(link.expiresAt) || (await $.clock.now()) + 10 * 60_000
  const done = (text: string): void => {
    stopLogin?.()
    stopLogin = undefined
    $.ui.status(undefined)
    say($, text)
  }
  const timer = $.clock.every(3000, async () => {
    if ((await $.clock.now()) > deadline) return done('The login code expired. Run /palette login again.')
    try {
      const claim = await api<LinkClaim>($, ROUTES.claim, { method: 'POST', body: { poll: link.poll } })
      if (claim.status === 'ok') {
        const auth = { token: claim.token, username: claim.username, site: await site($), connectedAt: new Date(await $.clock.now()).toISOString() }
        await writePrivate($, await dataPath($, 'auth.json'), `${JSON.stringify(auth, null, '\t')}\n`)
        done(`Connected${claim.username ? ` as @${claim.username}` : ''}. Sync now to bring your palettes.`)
        // The first cloud backup now, not at the next weekly check.
        const outcome = await backup($, 'connect')
        if (outcome.isProblem) say($, outcome.text)
        await redraw($, true)
      } else if (claim.status !== 'pending') done('The login code expired. Run /palette login again.')
    } catch {
      /* a network blip: keep waiting until the code expires */
    }
  })
  stopLogin = () => timer.cancel()
}

/** Send your palettes and favorites, then bring the site's library back and write its themes. */
async function sync($: EngineInterface): Promise<void> {
  try {
    const auth = await readAuth($)
    if (!auth) {
      say($, 'Not connected. Run /palette login first, or /palette import a file.')
      return
    }
    try {
      const pushed = await api<{ saved?: number }>($, ROUTES.library, { method: 'PUT', token: auth.token, body: await snapshot($) })
      const remote = await api<unknown>($, ROUTES.library, { token: auth.token })
      const library = parseLibrary(JSON.stringify(remote), true) ?? { palettes: [], favorites: [] }
      const user = typeof (remote as { user?: unknown }).user === 'string' ? (remote as { user: string }).user : auth.username
      await installLibrary($, library, `Synced${user ? ` as @${user}` : ''}: ${library.palettes.length} palettes, ${library.favorites.length} favorites (${pushed.saved ?? 0} sent)`)
    } catch (error) {
      if (!isUnauthorized(error)) throw error
      await forgetAuth($)
      say($, 'This Claude Code was disconnected from the site. Run /palette login again.')
    }
  } catch (error) {
    say($, `Sync failed: ${message(error)}`)
  }
  await redraw($, true)
}

async function logout($: EngineInterface): Promise<void> {
  stopLogin?.()
  stopLogin = undefined
  $.ui.status(undefined)
  try {
    const auth = await readAuth($)
    if (!auth) {
      say($, 'Not connected.')
      return
    }
    try {
      await api($, ROUTES.token, { method: 'DELETE', token: auth.token })
    } catch {
      /* removed here either way; it can also be revoked on the site */
    }
    await forgetAuth($)
    say($, 'Disconnected. Your palettes and their backups stay on this computer.')
  } catch (error) {
    say($, `Could not log out: ${message(error)}`)
  }
  await redraw($)
}

/* ---------- backups ---------- */

async function readState($: EngineInterface): Promise<BackupState> {
  return parseState((await readText($, await dataPath($, 'backup.json'))) ?? '')
}

/** Local versions, newest first. Unreadable files are skipped. */
async function readVersions($: EngineInterface): Promise<Saved[]> {
  const dir = await dataPath($, 'backups')
  if (!(await $.fs.exists(dir))) return []
  const names = (await $.fs.list(dir)).filter(entry => entry.kind === 'file' && FILE.test(entry.name)).map(entry => entry.name).sort().reverse()
  const out: Saved[] = []
  for (const file of names) {
    const version = parseVersion(String(await $.fs.read(`${dir}/${file}`)))
    if (!version) continue
    version.hash = { local: hashLibrary(version.local), ...(version.cloud ? { cloud: hashLibrary(version.cloud) } : {}) }
    out.push({ file, version })
  }
  return out
}

/** Save a version unless the newest one holds the same, and keep the newest KEEP. Returns how many there are. */
async function saveVersion($: EngineInterface, version: Version, now: number): Promise<{ isWritten: boolean; count: number }> {
  const dir = await dataPath($, 'backups')
  const versions = await readVersions($)
  if (isSame(versions[0]?.version, version)) return { isWritten: false, count: versions.length }
  await writePrivate($, `${dir}/${nextFile(versions[0]?.file, now)}`, `${JSON.stringify(version, null, '\t')}\n`)
  for (const old of versions.slice(KEEP - 1)) await $.process.run(['rm', '-f', `${dir}/${old.file}`])
  return { isWritten: true, count: Math.min(KEEP, versions.length + 1) }
}

/** Take the backup lock; false when another session holds it. A lock left by a session that died is taken over. */
async function lock($: EngineInterface): Promise<boolean> {
  const path = await dataPath($, 'backup.lock')
  await $.process.run(['mkdir', '-p', '-m', '700', path.slice(0, path.lastIndexOf('/'))])
  if ((await $.process.run(['mkdir', path])).exitCode === 0) return true
  const madeAt = await $.fs.stat(path).then(stat => stat.mtimeMs, () => undefined)
  if (madeAt !== undefined && (await $.clock.now()) - madeAt < STALE_LOCK_MS) return false
  await $.process.run(['rmdir', path])
  return (await $.process.run(['mkdir', path])).exitCode === 0
}

async function unlock($: EngineInterface): Promise<void> {
  await $.process.run(['rmdir', await dataPath($, 'backup.lock')])
}

const gate = { isRunning: false }

/** One backup run. Never throws: the outcome says what happened, in one line. */
async function backup($: EngineInterface, reason: BackupReason): Promise<Outcome> {
  if (gate.isRunning) return { text: 'A backup is already running.', isProblem: false }
  gate.isRunning = true
  try {
    if (!(await lock($))) return { text: 'Another Claude Code is backing up right now.', isProblem: false }
    try {
      return await runBackup($, reason)
    } finally {
      await unlock($)
    }
  } catch (error) {
    return { text: `Palette backup failed: ${message(error)}`, isProblem: true }
  } finally {
    gate.isRunning = false
  }
}

/**
 * Bring what the site holds, send this library up, and save a local version
 * of both. The local part always runs; a cloud failure is reported, not thrown.
 */
async function runBackup($: EngineInterface, reason: BackupReason): Promise<Outcome> {
  const now = await $.clock.now()
  const name = siteName(await site($))
  const auth = await readAuth($)
  const local = await snapshot($)
  const cloud = { library: undefined as LibraryFile | undefined, user: undefined as string | undefined, count: undefined as number | undefined, error: '', isUnauthorized: false }
  if (auth) {
    try {
      // Pull first: the copy saved here is the cloud as it was before this push.
      const remote = await api<unknown>($, ROUTES.library, { token: auth.token })
      const parsed = parseLibrary(JSON.stringify(remote), true)
      cloud.library = parsed ? toFile(parsed) : undefined
      const user = (remote as { user?: unknown }).user
      cloud.user = typeof user === 'string' ? user.slice(0, 40) : undefined
      cloud.count = (await api<{ count?: number }>($, ROUTES.backups, { method: 'POST', token: auth.token, body: { client: CLIENT, library: local } })).count ?? 0
    } catch (error) {
      cloud.error = cloudProblem(error, name)
      cloud.isUnauthorized = isUnauthorized(error)
    }
  }
  const version: Version = {
    format: 'pi-palette-backup',
    version: 1,
    createdAt: new Date(now).toISOString(),
    reason,
    hash: { local: hashLibrary(local), ...(cloud.library ? { cloud: hashLibrary(cloud.library) } : {}) },
    local,
    ...(cloud.library ? { cloud: cloud.library } : {}),
    ...(cloud.user ? { user: cloud.user } : {}),
  }
  const saved = await saveVersion($, version, now)
  const state: BackupState = { checkedAt: now }
  if (auth && cloud.count !== undefined) {
    state.cloudAt = now
    state.cloudCount = cloud.count
  } else if (auth) {
    const previous = await readState($)
    if (previous.cloudAt !== undefined) state.cloudAt = previous.cloudAt
    if (previous.cloudCount !== undefined) state.cloudCount = previous.cloudCount
    state.cloudError = cloud.error
  }
  await writePrivate($, await dataPath($, 'backup.json'), `${JSON.stringify(state, null, '\t')}\n`)

  const here = saved.isWritten ? `Backed up: ${saved.count}/${KEEP} versions here` : `Nothing changed since the last backup (${saved.count}/${KEEP} here)`
  if (cloud.isUnauthorized) {
    await forgetAuth($)
    return { text: `${here}. This Claude Code was disconnected from the site; run /palette login to back up to the cloud again.`, isProblem: true }
  }
  if (cloud.error) return { text: `${here}, but the cloud copy failed: ${cloud.error}`, isProblem: true }
  return { text: cloud.count !== undefined ? `${here}, ${cloud.count}/${KEEP} on ${name}.` : `${here}.`, isProblem: false }
}

async function backupNow($: EngineInterface): Promise<void> {
  const outcome = await backup($, 'manual')
  say($, outcome.text)
  await redraw($, true)
}

/** Replace the library with a backed-up version, after saving the current one. `id` is `local:<file>` or `cloud:<id>`. */
async function restore($: EngineInterface, id: string): Promise<void> {
  const at = id.indexOf(':')
  const side = id.slice(0, at)
  const key = id.slice(at + 1)
  try {
    const picked = { library: undefined as Library | undefined, label: '' }
    if (side === 'cloud') {
      const auth = await readAuth($)
      if (!auth) throw new Error('this Claude Code is not connected; run /palette login')
      picked.library = parseLibrary(JSON.stringify(await api<unknown>($, backupPath(key), { token: auth.token })), true)
      picked.label = 'the cloud backup'
    } else {
      const version = (await readVersions($)).find(v => v.file === key)?.version
      picked.library = version ? parseLibrary(JSON.stringify(version.local), true) : undefined
      picked.label = version ? `the backup from ${when(version.createdAt)}` : ''
    }
    if (!picked.library) throw new Error('that backup cannot be read')
    // So a restore can itself be undone. Local only; the weekly clock is not touched.
    const now = await $.clock.now()
    const current = await snapshot($)
    await saveVersion($, { format: 'pi-palette-backup', version: 1, createdAt: new Date(now).toISOString(), reason: 'restore', hash: { local: hashLibrary(current) }, local: current }, now)
    await installLibrary($, picked.library, `Restored ${picked.label}: ${picked.library.palettes.length} palettes, ${picked.library.favorites.length} favorites`)
  } catch (error) {
    say($, `Could not restore: ${isUnauthorized(error) ? 'this Claude Code was disconnected; run /palette login' : message(error)}`)
  }
  await redraw($, true)
}

/** Once per session, in the background: the theme files match the library, and the weekly backup runs when due. */
async function startup($: EngineInterface): Promise<void> {
  try {
    await syncThemes($, await readOwn($))
    if (!isDue(await readState($), await $.clock.now())) return
    const outcome = await backup($, 'weekly')
    if (outcome.isProblem) $.ui.toast(outcome.text, { timeoutMs: 8000 })
  } catch {
    /* nothing to say at startup: /palette shows the state */
  }
}
