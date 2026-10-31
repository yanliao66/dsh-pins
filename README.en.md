# dsh-pins

[![CI](https://github.com/yanliao66/dsh-pins/actions/workflows/ci.yml/badge.svg)](https://github.com/yanliao66/dsh-pins/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
**English** | [简体中文](README.md)

> Pin it once, and every later session remembers.

`dsh-pins` is a **cross-session shared pin board** for DeepSeek Harness. It removes a recurring
annoyance: every new session you restate the same preferences, conventions, and reminders
(reply in Chinese, run the tests first, don't touch that directory). Pins live on one board, and:

- **every request carries them** — a non-empty board is injected into the system prompt;
- **the Agent can read and maintain them** — the `memory_pins` tool (list / add / update / remove /
  toggle injection);
- **you see and edit them in the composer dock** — a collapsible panel in
  `conversation.composer.dock`, styled with the same tokens and layout as the host's todo panel.

The user and the Agent operate the same board, through the same validation and the same revision
counter.

## Anatomy

| Half | File | Responsibility |
|---|---|---|
| Host | `index.js` | activation: board persistence, `/api/dsh-pins/*` routes, the `memory_pins` tool, the system-prompt section |
| Host | `store.js` | pure data layer: validation, state transitions, prompt-block rendering (unit-testable without a host) |
| Client | `client.js` | the browser half: the dock panel, calling the same-origin API |
| Assets | `locale/*.json`, `icon.svg` | plugin-manager title, description, and icon |

The package is a **bundle**: `dsh.bundle.patch` points at `cordis.patch.yml`, which inserts one row;
`dsh.client.platform = web` has the host serve `client.js` as the browser module
`/plugins/dsh-pins/client.js`. One row mounts both halves.

## Data and limits

The board is a JSON document at `$DSH_HOME/dsh-pins/pins.json` (`$DSH_HOME` defaults to `~/.dsh`).
At most **24 pins**, each at most **400 characters**, tags at most **24 characters**; identical text
is never pinned twice. Writes are atomic (temp file + rename), and an unreadable document is moved to
`pins.json.corrupt-<timestamp>` and replaced by an empty board instead of failing the plugin.

Injection has a **2400-character budget**: pins are emitted in creation order until the budget is
spent, then one line reports how many were omitted. Turning injection off keeps the board and the
tool and only removes the prompt section.

## HTTP API (local only)

Every route passes a local trust fence: the socket address and `Host` must both be loopback, no
`cf-connecting-ip` / `x-forwarded-for`, no cross-site marker, and a same-origin `Origin` when one is
present. Anything else gets `403`. Responses are `{ ok, ... }`; failures add `{ ok:false, error, message }`.

| Method and path | Effect |
|---|---|
| `GET /api/dsh-pins/pins` | read the board (pins, settings, stats) |
| `POST /api/dsh-pins/pins` | `{ text, tag? }`; duplicate text answers `200` with `duplicate:true` |
| `PATCH /api/dsh-pins/pins` | `{ id, text?, tag? }` (`tag:null` clears the tag) |
| `DELETE /api/dsh-pins/pins?id=…` | remove one pin |
| `POST /api/dsh-pins/settings` | `{ inject: boolean }` |
| `GET /api/dsh-pins/health` | self-check: version, data file, revision, count |

## The `memory_pins` tool

| action | arguments | result |
|---|---|---|
| `list` | — | every pin with its id, text, and tag, plus the injection switch |
| `add` | `text`, `tag?` | the new pin (identical text returns the existing one) |
| `update` | `id`, `text?`, `tag?` | the updated pin |
| `remove` | `id` | the removed pin |
| `set_inject` | `inject` | the new injection state |

The tool description asks the model to pin durable preferences, conventions, and reminders only —
never transient task state, never pins the user did not ask for. The prompt section says the same:
the notes come from the user, they are standing context, and the current request wins when they
conflict.

## Install

```bash
git clone https://github.com/yanliao66/dsh-pins
```

In the DSH Web GUI open **Plugins → Add plugin** and enter the absolute path of that directory (or
the `dsh-pins-1.0.0.tgz` from [Releases](https://github.com/yanliao66/dsh-pins/releases)), then
enable it. The host records a `link:` dependency in the profile and appends `dsh-pins` to
`dsh.profile.bundles`; HMR recomposes the plugin tree without a restart. Remove it from the same
page; the data file stays, so reinstalling restores the pins.

Other profiles can install it from the CLI (the Desktop profile is managed by the app, so use the
UI there):

```bash
dsh plugin --profile web add link:/absolute/path/to/dsh-pins
```

> **Where it lives is where it is loaded from.** The profile records the directory path; moving or
> deleting an installed directory breaks the next start. Move it by removing the plugin and
> installing from the new path — the data file is unaffected.

## Design notes

- **Injection is a variable plus a section, not assembled text.** The section text is the fixed
  `{{memory_pins}}` and the variable renders the current board at each assembly. An empty board (or
  disabled injection) renders `''`, and empty sections are dropped — so an unused board costs
  **zero tokens**.
- **The panel and the tool share one `mutate()` write queue**, so concurrent writes never overwrite
  each other and the revision is monotonic. A transition that changes nothing returns the same state
  reference, so nothing is written to disk.
- **Styles use host theme tokens only** (`--dsw-alias-*`, `--dsw-radius-*`, `--dsw-specific-menu`,
  `--dsw-elevation-panel`) plus the composer's own `--dsh-composer-*` width contract, so light/dark
  switching, skins, and resizing follow the host. No literal colors.
- **The client half depends on no host Client package** — only `require('react')` and `fetch` — so a
  crash in this panel cannot take other slots with it.
- **No host-internal imports**: the host half imports nothing from `@deepseek-ai/*`; the tool
  definition is written as a raw JSON Schema definition.

## Self-check

```bash
node --check index.js && node --check client.js && node --check store.js
node --test
```

## License

MIT. The icon is original SVG artwork drawn for this plugin.
