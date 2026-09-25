# dsh-plannotator

**English** | [Русский](README.ru.md)

<div align="center">

**Review a file, a folder or a web page in the Plannotator browser UI — the annotations come back to the agent as a normal message in the conversation.**

[![version](https://img.shields.io/badge/version-0.1.0-4176E6)](https://github.com/martyartem/dsh-plannotator/releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![tests](https://img.shields.io/badge/tests-47%20passing-3c9)](#development)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-dsh--plugin-4176E6)](https://github.com/deepseek-ai/deepseek-harness)

One **Review** button in the document preview · one `/plannotator` command · detached sessions, so
the turn never blocks · annotations steered back as a complete DSH `UserMessage`

</div>

---

## Why this plugin exists

Two things go wrong when a review is started from inside a DSH session.

| Problem | What it looks like | What this plugin does |
|---|---|---|
| **The call blocks** | Plannotator's review server waits for a human — minutes. A DSH bash call times out long before that, the process is pushed to the background, and killing it **loses the annotations with no record**. | Starts the session detached, answers with the URL immediately, and delivers the decision later through `agent.steer()`. |
| **The binary is invisible** | A DSH session runs with `/usr/bin:/bin:/usr/sbin:/sbin`, so a regular `~/.local/bin/plannotator` install is not on `PATH`. | Resolves the binary itself: config → `PLANNOTATOR_BIN` → `PATH` → well-known install locations. |

It also stamps `PLANNOTATOR_ORIGIN=dsh`, so reviews started here are attributed to this host rather
than to another agent's label.

## Features

| Surface | Where | What it does |
|---|---|---|
| **Review** button | Document preview header, right sidebar | Starts a review of the file on screen. A file Plannotator would refuse (PDF, image, Office, an exotic suffix) is reviewed as its **containing folder**, so the button is never a dead end. |
| `/plannotator <file\|folder\|url>` | Composer | The same review, started from the text box — and the agent's non-blocking entry point. |
| `/plannotator` | Composer | Reviews this session's workspace folder. |
| `/plannotate` | Composer | Alias. |
| Delivered annotations | Conversation | The decision record (`--json`) is steered back as a message, so the agent addresses the annotations in the same chat. |

That is the whole surface: **one** sidebar seat, **one** command, **two** HTTP routes, and no flags.
`gate`, `port`, `openBrowser` and the timeout are config values.

## Requirements

- **DeepSeek Harness** `>=0.1.0-rc.5` (declared in `package.json`).
- **Node** `>=20` for the host half. There are no runtime dependencies.
- The **Plannotator CLI** installed somewhere the plugin can find: plugin config, `PLANNOTATOR_BIN`,
  `PATH`, or one of `~/.local/bin`, `/usr/local/bin`, `/opt/homebrew/bin`, `~/.bun/bin`,
  `~/.cargo/bin`. Without it the plugin still loads and reports how to point it at the binary.

## Install

### From the Harness plugin manager

Open **Plugins** in the app and install this repository:

```text
https://github.com/martyartem/dsh-plannotator
```

Then restart the app. The npm package name is `plannotator-dsh`; the repository is
`dsh-plannotator`.

### From a checkout

Clone anywhere **outside** `~/.dsh`, and install it as a `link` so edits reach the profile:

```sh
git clone https://github.com/martyartem/dsh-plannotator ~/Projects/plannotator-dsh
```

Add it to your profile (`~/.dsh/profiles/<profile>/package.json`) and restart:

```json
{
  "dependencies": { "plannotator-dsh": "link:/Users/you/Projects/plannotator-dsh" },
  "dsh": { "profile": { "bundles": ["…", "plannotator-dsh"] } }
}
```

`scripts/uninstall.sh [profile] [--purge]` rolls that back.

## Configuration

Set values in your profile's patch layer (`cordis.patch.yml`) — the user patch layer survives DSH
upgrades:

```yaml
- id: plannotator-dsh
  name: plannotator-dsh
  config:
    gate: true
    timeoutMs: 1800000
```

| Key | Default | Meaning |
|---|---|---|
| `binary` | auto-detect | explicit path to the `plannotator` binary |
| `binaryFallbacks` | well-known list | extra candidate paths |
| `origin` | `dsh` | the `PLANNOTATOR_ORIGIN` every review is stamped with |
| `gate` | `false` | add an Approve button to every review |
| `openBrowser` | `true` | let Plannotator open the browser tab |
| `port` | random | fix the local review-server port |
| `timeoutMs` | `900000` | how long a review may stay open before it is stopped |
| `readyTimeoutMs` | `20000` | how long to wait for the local server to report readiness |
| `autoFollowup` | `true` | steer the annotations back into the conversation |
| `debug` | `false` | also write the plugin log to stderr |
| `dataDir` | `~/.dsh/storages/plannotator-dsh` | where `plannotator-dsh.log` lives |

## How it works

- **Host half** — `lib/index.js`: registers the command and the two routes, resolves the binary and
  the workspace, starts a detached Plannotator process, waits for its readiness file, then reads the
  decision record from its stdout and steers it into the session.
- **Browser half** — `lib/client.js`: hand-written in the host's module-loader format
  (`window.__ModuleLoader__.load`), so it needs **no bundler** and only `react` from the platform
  seed table. It contributes its seat through `ctx.slots.inject(seat, () => ctx.slots.register(…))`,
  the documented way to be independent of plugin start order.
- **HTTP routes** — the browser half never imports a host service:

  | Route | Purpose |
  |---|---|
  | `GET /plannotator/review?target=<path\|url>[&session=<id>]` | starts a detached review, answers `{ ok, url, label, gate }` |
  | `POST /plannotator/log` | forwards a client-side note into the plugin log |

- **Workspace resolution**, in order: the live agent's session directory → `DSH_WORKSPACE_DIR` /
  `DSH_CWD` → `ctx.workspaceRegistry` → the `cwd` in the session-log header → the newest session →
  the host process cwd.
- **Delivery contract** — the steered message is a complete DSH `UserMessage`: `id`, `role`,
  `content`, and a producer-owned `source.kind` of `plugin:plannotator-dsh`. The append path accepts a
  message without `id`, but the restore path then rejects the **whole session**
  (`session event at seq N lacks an identified message`) and the history stops loading. The plugin
  mints the id itself, and the offline suite asserts the message carries one.

## Compatibility

| Dependency | Range |
|---|---|
| DeepSeek Harness | `>=0.1.0-rc.5` |
| Node | `>=20`, built-ins only |
| Plannotator CLI | the documented contract: argv `annotate <target> --json`, the readiness file (`PLANNOTATOR_READY_FILE`), the stdout decision record, `PLANNOTATOR_ORIGIN`, `PLANNOTATOR_PORT` |

Nothing here imports a Harness package, so a host upgrade can break a *contract* but not the module
graph — and a broken contract shows up as a log line, not as a broken session.

## Troubleshooting

Everything is logged to `~/.dsh/storages/plannotator-dsh/plannotator-dsh.log`. After a DSH or
Plannotator upgrade, this is the whole check:

```sh
grep -E "loaded|apply:|registered|unavailable|steering failed" \
  ~/.dsh/storages/plannotator-dsh/plannotator-dsh.log | tail -12
```

| Line | Means |
|---|---|
| `loaded …; binary=…` | the host loaded the plugin and found the CLI |
| `registered /plannotator/review and /plannotator/log` | the HTTP routes are in place |
| `client[info]: document preview action registered` | the Review button's seat exists |
| `document preview action unavailable: …` | the seat was renamed or is gone |
| `steering failed: …` | the host rejected the delivered message |
| `session … timed out after …` | the review outlived `timeoutMs` and was stopped |

If the first line is missing, the plugin did not load at all — usually an injected service the host
renamed.

## Development

Nothing but Node is needed: no install step, no bundler, no booted profile.

```sh
npm test                      # both offline halves
node scripts/selftest.mjs     # host half: 35 checks — parsing, binary/workspace resolution, sessions, routes
node scripts/client-test.mjs  # browser half: 12 checks — bundle shape, the single seat, the cold-boot race
node scripts/live-test.mjs    # against the real Plannotator binary and its HTTP API
```

```
lib/
  index.js      host row: command, HTTP routes, agent targeting
  command.js    input → Plannotator argv
  review.js     detached session, readiness, decision, steering, timeout
  config.js     config defaults, log file, helpers
  binary.js     PATH-independent binary discovery
  workspace.js  which directory a relative target resolves against
  client.js     browser half: the document-preview Review seat
scripts/        offline suites, live smoke test, uninstall helper
```

## Notes and limits

- `annotate` accepts markdown, plain-text config/data files, HTML, URLs and folders. `.env` is
  refused by Plannotator itself.
- Git diffs, pull requests and the archive are deliberately **not** here: the Plannotator CLI covers
  them directly, and a slash command that blocks for minutes is exactly what this plugin exists to
  avoid.
- A review nobody finishes (process killed, machine asleep) yields no decision; the plugin says so
  instead of pretending the review was empty.
- The plugin never scrapes the browser UI: it uses the CLI's documented stdout contract and its
  readiness file only.

## License

[MIT](LICENSE)
