# palette

pi-palette's color themes for Claude Code. The plugin ships 53 themes for `/theme`, and `/palette` keeps your own up to date: it connects to your [palette.prjct.app](https://palette.prjct.app) account, syncs your library, imports and exports it, and keeps versioned backups.

You pick and preview a theme in `/theme`, Claude Code's own picker. `/palette` never applies one: Claude Code gives a plugin no way to select a custom theme (see [Why /theme applies](#why-theme-applies)).

## Load it

| You want | Run |
| --- | --- |
| Install it, in Claude Code | `/plugin install palette --marketplace prjct-app/claude-plugins` |
| Install it, in a terminal | `claude plugin marketplace add prjct-app/claude-plugins`, then `claude plugin install palette@prjct` |
| Update it | `claude plugin update palette@prjct`, then `/reload-plugins` |
| Try a clone in one session | `claude --plugin-dir ./themes` |

## Use it

`/theme` lists the 53 bundled themes as "from palette" and your own palettes as "custom", each with Claude Code's live preview.

`/palette` opens a panel with two sections. The arrows move, enter runs the highlighted row, and each action also has a key.

| Row | Key | Does |
| --- | --- | --- |
| Log in | `l` | Shows a short code in the panel and opens the approval page. Approve it there while signed in |
| Sync now | `s` | Sends your palettes and favorites, brings your site library back, and writes your palettes as themes for `/theme` |
| Log out | `l` | Revokes this Claude Code's token and removes it from this computer |
| Import a library file | `i` | A theme file downloaded from the site is added to your palettes. A whole `library.json` replaces your library and favorites, after a yes |
| Export your palettes | `e` | Writes your palettes and favorites to `~/Downloads/palette-export.json`, for the site's library page |
| Back up now | `b` | Saves a version of your library here, and on the site when connected |
| A backup | enter or `r`, twice | Restores that version. Your current library is saved as a version first, so a restore can be undone |

The same actions run from the prompt:

| Command | Does |
| --- | --- |
| `/palette` | Opens the panel |
| `/palette login`, `sync`, `logout` | The account actions |
| `/palette import [file]` | Default file: `~/Downloads/library.json` |
| `/palette export [file]` | Default file: `~/Downloads/palette-export.json` |
| `/palette backup` | Backs up now |
| `/palette backups` | Opens the panel on the newest backup |

Every answer is the panel, a toast or a log line, so none of it enters Claude's context. Commands run immediately, even mid-turn.

## Your own palettes

Your library is `~/.claude/palette/library.json`, in the pi-themes format (`format: "pi-palette"`). After a sync, an import or a restore, the plugin writes one theme file per palette of yours into `~/.claude/themes/`, where `/theme` lists it at once. It also checks those files at the start of each session, so they follow a plugin update.

- The plugin only rewrites and removes the theme files it wrote; the list is `~/.claude/palette/owned-themes.json`. A theme file of your own with the same name is left alone and wins.
- If `~/.claude/themes/` did not exist before, restart Claude Code once: it only watches a folder that exists at startup.
- Favorites come and go with a sync, and are kept in the plugin's `$.store`.

Pi and Codex keep their own library and login: the editors never share files.

## Backups

Once a week, checked when a session starts, the plugin saves a version of your library in `~/.claude/palette/backups/`. When this Claude Code is connected, the version also holds what the site had, and your library is sent to the site as a version there. Each side keeps the last 10, and a library identical to the newest version is not saved twice. Without an account it is all local.

## What reaches the network

Nothing, until you log in. The login, sync, logout and backup actions call the site, and so does the weekly backup while this Claude Code is connected. The token can read and write your palette library and nothing else. It is kept in `~/.claude/palette/auth.json`, readable only by you, and is only ever sent to the site that issued it.

| | Value |
| --- | --- |
| Library file | `~/.claude/palette/library.json`, `{ "format": "pi-palette", "version": 1, "palettes": [...] }` |
| Single theme | Pi's theme JSON (`{ name, vars, colors }`) is accepted as a palette of one |
| Login | `POST /api/pi/link` with `{ "client": "claude-code" }`, then `POST /api/pi/link/claim` with `{ poll }` every 3 s |
| Library API | `GET` and `PUT /api/pi/library`, `DELETE /api/pi/token`, with `Authorization: Bearer pit_…` |
| Backups API | `GET` and `POST /api/pi/backups`, `GET /api/pi/backups/<id>` |
| Another origin | `PALETTE_SITE_URL`, https only (http is allowed for localhost while developing) |
| Colors | `hooks/theme.ts` `toClaudeTheme()`: copy it to produce the same Claude Code theme on the site |

The routes are in one place, `ROUTES` in `hooks/cloud.ts`.

## Why /theme applies

Checked against Claude Code 2.1.318:

- `$.config.set({ key: "theme", value: "custom:<name>" })` is refused: the row only takes the built-in presets.
- Writing `"theme"` into `settings.json` is read by sessions that start afterwards; an open session does not repaint.
- `/theme` takes no argument: it always opens its picker.

So the plugin keeps the theme files current and leaves the choice to `/theme`. Earlier versions rewrote one file, `~/.claude/themes/palette.json`, that you had to select once in `/theme`. That file is no longer written; if it is still your theme, it keeps its last colors until you pick another.

## Rebuild the /theme files

`palettes.json` is pi-palette's data. `themes/*.json` is what `/theme` lists for the bundled set. To regenerate it:

```sh
node scripts/build-themes.mjs
```

Theme files whose palette is gone are deleted.

## How the colors map

Each palette's semantic vars become Claude Code theme tokens on the `dark` base (`light` if the canvas is bright):

| pi-palette | Claude Code |
| --- | --- |
| `accent` | `claude` (spinner, assistant label), usage meter, Claude label |
| `secondary` | `suggestion`, `permission`, `ide`, your label |
| `highlight` | `remember`, `autoAccept`, `merged` |
| `success` / `warning` / `error` | same, plus `fastMode` = warning |
| `border` / `muted` / `dim` | `promptBorder` / `inactive` / `subtle` |
| `successBg` / `errorBg` | diff backgrounds; dimmed and word variants are mixes |
| `surface` / `surfaceRaised` / `selected` | message backgrounds, hover, selection |
| `planTeal` or secondary+success mix | `planMode` |
| `colors.bashMode` → var, else `bash` | `bashBorder` |

**Limits:**
- `canvas` is only used as `inverseText`. Claude Code doesn't paint the terminal background, so set your terminal's own background to match.
- Subagent colors keep the base preset's.

## Develop

```sh
claude plugin validate --strict .
claude plugin test .
```

Files:
- `hooks/register.tsx`: the `/palette` mod and its panel.
- `hooks/theme.ts`: the palette → Claude Code color mapping, shared with the generator.
- `hooks/library.ts`: reads library files defensively.
- `hooks/cloud.ts`: the site's routes and responses, as plain data.
- `hooks/backup.ts`: the backup format and its rules, as plain data.
- `scripts/build-themes.mjs`: writes `themes/` for `/theme`.
- `tests/`: the mod's tests.
