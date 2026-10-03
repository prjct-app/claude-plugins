# palette

pi-palette's color themes for Claude Code: a picker with live preview, like pi-palette's, plus commands to switch, cycle and favorite from the prompt.

## Load it

| You want | Run |
| --- | --- |
| Install it, in Claude Code | `/plugin install palette --marketplace prjct-app/claude-plugins` |
| Install it, in a terminal | `claude plugin marketplace add prjct-app/claude-plugins`, then `claude plugin install palette@prjct` |
| Try a clone in one session | `claude --plugin-dir ./themes` |

## First use: one setup step

Claude Code doesn't let a plugin select a custom theme. So `/palette` keeps one theme file, `~/.claude/themes/palette.json`, and rewrites the colors inside it. You select that file once in `/theme`, and every switch after that repaints every open session.

1. `/palette tensor`: writes the slot file. If `~/.claude/themes/` didn't exist before, restart Claude Code once, because it only watches a folder that exists at startup.
2. `/theme`: pick **Palette · Tensor**. This stores `custom:palette` in your settings.
3. From then on:

| Command | Does |
| --- | --- |
| `/palette` | Opens the picker: ↑↓ previews live, enter or `a` applies, `f` toggles a favorite, esc or `q` cancels and puts the old theme back |
| `/palette <id>` | Applies that palette, e.g. `/palette nord` |
| `/palette next` / `prev` | Cycles favorites first, then editor, photo and original palettes |
| `/palette random` | Picks any palette but the active one |
| `/palette fav [id]` | Adds or removes a favorite (default: the active palette) |
| `/palette import [file]` | A theme file downloaded from the site is added to your palettes and applied. A whole `library.json` replaces your library and favorites, after a yes. Default file: `~/Downloads/library.json` |
| `/palette export [file]` | Writes your palettes, favorites and active palette to `~/Downloads/palette-export.json`, for the site's library page |
| `/palette login` | Connects this Claude Code to your palette.prjct.app account: shows a code, opens the approval page, and waits |
| `/palette sync` | Sends your palettes and favorites, then brings your site library back. The active palette stays |
| `/palette logout` | Revokes the token and removes it from this computer |

Every answer is the picker, a toast or a log line, so none of it enters Claude's context. Commands run immediately, even mid-turn. The active palette and favorites live in the plugin's `$.store`, which every session on the machine shares.

## Browse without the command

`/theme` also lists all 34 as plugin themes ("from palette"), with Claude Code's own live preview. Picking one there works without the mod. `/palette` won't change it, though, because it only rewrites the slot.

## Your own palettes

The picker reads the bundled `palettes.json` plus your library at `~/.claude/palette/library.json`. The login token is kept next to it in `auth.json`; both are readable only by you. Pi keeps its own library and login: the two never share files. That file uses the pi-themes format (`format: "pi-palette"`), or a single Pi theme file the site downloads. Own palettes come first, and one with a bundled id replaces it. Palettes are converted when you pick them, so nothing needs rebuilding.

## What the site relies on

palette.prjct.app serves Pi, Claude Code and later other editors. This plugin uses:

| | Value |
| --- | --- |
| Library file | `~/.claude/palette/library.json`, `{ "format": "pi-palette", "version": 1, "palettes": [...] }`. Favorites live in the plugin, not in this file |
| Single theme | Pi's theme JSON (`{ name, vars, colors }`) is accepted as a palette of one |
| Login | `POST /api/pi/link` with `{ "client": "claude-code" }`, then `POST /api/pi/link/claim` with `{ poll }` every 3 s |
| Library API | `GET` and `PUT /api/pi/library`, `DELETE /api/pi/token`, with `Authorization: Bearer pit_…` |
| Colors | `hooks/theme.ts` `toClaudeTheme()`: copy it to produce the same Claude Code theme on the site |

The routes are in one place, `ROUTES` in `hooks/cloud.ts`.

## Rebuild the /theme files

`palettes.json` is pi-palette's data, copied from `pi/local-extensions/pi-palettes`. `themes/*.json` is only what `/theme` lists. To regenerate it:

```sh
node scripts/build-themes.mjs                       # bundled set
node scripts/build-themes.mjs ~/Downloads/library.json   # plus a pi-themes library
```

An own palette with a bundled palette's id replaces it. Theme files whose palette is gone are deleted.

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
- `hooks/register.tsx`: the `/palette` mod and its picker.
- `hooks/theme.ts`: the palette → Claude Code color mapping, shared with the generator.
- `hooks/library.ts`: reads library files defensively.
- `hooks/cloud.ts`: the site's routes and responses, as plain data.
- `scripts/build-themes.mjs`: writes `themes/` for `/theme`.
- `tests/`: the mod's tests.
