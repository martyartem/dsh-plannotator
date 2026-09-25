# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-25

First release.

### Added

- **Review** action in the document-preview header; a file Plannotator would refuse is reviewed as
  its containing folder.
- `/plannotator <file|folder|url>` — one command, no flags — plus `/plannotate`.
- Detached review sessions: the command answers with the URL immediately and the decision is
  delivered later through `agent.steer()`.
- `GET /plannotator/review` and `POST /plannotator/log`, the only two routes the browser half needs.
- Binary discovery that does not depend on the session's minimal `PATH`.
- Workspace resolution from the agent session, the environment, the workspace registry, the
  session-log header, the newest session, or the host cwd.
- Offline suites for both halves (35 host checks, 12 browser checks) and a live smoke test.
- A `timeoutMs` budget with an honest "stopped after N" delivery when a review is abandoned.

### Notes

- The steered message is a complete DSH `UserMessage` (`id`, `role`, `content`, producer-owned
  `source.kind`). A message without `id` is accepted on append but makes the whole session
  unloadable on the next start, so the offline suite asserts the id is present.
- No runtime dependencies and no imports of Harness packages: the browser half is hand-written in the
  host's module-loader format and needs no bundler.

[0.1.0]: https://github.com/martyartem/dsh-plannotator/releases/tag/v0.1.0
