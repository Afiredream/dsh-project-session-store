[English](README.md) | [中文](README.zh.md)

# dsh-project-session-store

A **DSH (DeepSeek Harness) 2.x** plugin that keeps every project's session logs **inside the project directory** instead of centralising them under `~/.dsh/sessions`.

Out of the box DSH stores every session beneath one central root:

```
~/.dsh/sessions/<project-key>/<session-id>/session.v4.jsonl.zstd
```

With this plugin the session data travels with the project:

```
<project>/.dsh/sessions/<session-id>/session.v4.jsonl.zstd
```

Clone a repository, archive it, or move it to another machine — the conversation history comes along.

## What it does

| Concern | Behavior |
| --- | --- |
| Storage layout | `<cwd>/.dsh/sessions/<session-id>/session.v4.jsonl.zstd` — same format, same zstd frames, readable by any stock reader |
| Built-in backend | The `@deepseek-ai/dsh-session-persistence-jsonl` row is **disabled** in the composition tree; this plugin provides `ctx.sessionPersistence` |
| Legacy data | Sessions already under the central root are migrated **once** into their project (keyed by each log's header `cwd`) |
| Unmovable sessions | Sessions whose `cwd` is gone, sessions without a `cwd`, and unwritable project directories stay in the central root and remain readable/resumable |
| Lookup index | A pointer file `<central root>/index.json` maps `session-id -> project session root`; pointers only, never session data |
| Web UI | The sidebar still groups by project (project-local sessions plus any unmigrated leftovers) |
| No `cwd` sessions | Stay under `<central root>/_no-cwd/`, exactly like the stock backend |
| Cross-machine copy | A project directory (including `.dsh/sessions/`) copied to another machine is discovered, readable, and keeps appending to the **same physical file**; the exposed `cwd` is normalized to the real project directory on this machine |

## Requirements

- DSH `0.2.0-rc.2` or another release on the 2.x line
- Node.js ≥ 20

## Installation

```bash
# From a local checkout
dsh plugin --profile web add /absolute/path/dsh-project-session-store

# Or from npm, once published
dsh plugin --profile web add dsh-project-session-store
```

Because the package declares `dsh.bundle.patch`, `dsh plugin add` appends its name to that profile's `dsh.profile.bundles`; the composition row itself comes from the bundle's own `cordis.patch.yml`.

**Restart `dsh web`.** The composition tree is assembled at boot.

Verify the swap without starting anything:

```bash
dsh --profile web --dump-config | grep -A 2 session-persistence
# - id: session-persistence-jsonl
#   disabled: true
# - id: session-persistence-project-local
#   name: dsh-project-session-store
```

## Configuration

Every option is optional:

```yaml
- id: session-persistence-project-local
  name: dsh-project-session-store
  config:
    # Central root: legacy fallback + pointer index. Default: $DSH_HOME/sessions
    root: /your/custom/root
    # Directory inside each project. Default: .dsh/sessions
    projectDirName: .dsh/sessions
    # Physical encoding: 'zstd' (default) or 'none'
    compression: zstd
    # Move central-root sessions into their projects on startup. Default: true
    migrateLegacy: true
    # Attach index-known sessions to the matching workspace. Default: true
    reconcileWorkspaces: true
```

A patch layer **replaces** a row's whole `config` rather than merging into it, so a `config` block must be complete; write only `disabled` to leave an existing config untouched.

## How the 2.x adaptation works

DSH 2.x turned the JSONL backend into a generation-file store — one directory per session holding immutable `session.vN.jsonl[.zstd]` files — and added a cross-process `flock` write lease per session directory. Every path in that backend is derived from one private `root` field through module-private helpers, so relocation cannot be expressed as configuration. This plugin therefore subclasses the backend and overrides exactly the methods that turn a header into a path:

| Overridden | Why |
| --- | --- |
| `locate`, `assertStoredIdentity` | the artifact path a header implies |
| `materialize`, `materializePosix` | where a new session's directory appears |
| `appendLines`, `repair` | where a materialized session keeps growing (following the real file) |
| `acquireWriteLease`, `acquireLease` | which directory the write lock guards — placement must be decided **before** the lease, because acquiring it creates the directory |
| `findLog`, `listProjectDirs` | discovery across project roots |
| `readGenerationHeader`, `readStoredLog`, `decodeStoredLog`, `prepareStoredMigration` | normalization of the exposed `cwd` |

Everything else is inherited unchanged: zstd framing, format-version migration, torn-tail repair, durability barriers, and the handle state machine.

### Differences from the 1.x reference project

This plugin follows the approach of [`@yangzhe1991/dsh-project-session-store`](https://github.com/yangzhe1991/dsh-project-session-store) (built for DSH 1.x) and re-derives it for 2.x:

| Topic | 1.x reference | This implementation (2.x) |
| --- | --- | --- |
| Artifact | one file, `session.jsonl.zstd` | per-session directory + generation file `session.v4.jsonl.zstd` |
| Placement decision | derived inside `materialize` | moved into `acquireWriteLease` (the lease creates the directory, so it must be decided first) |
| Process exclusion | none | inherits the official `flock` lease, taken in the real directory |
| Migration unit | a single log file | the whole session directory (lock file included) |
| Discovery sources | pointer index + legacy scan | index + the **workspace registry** (`workspaceRegistry.list()`, synchronous, so it cannot deadlock boot) + legacy scan |
| `cwd` normalization | looked up through the index | derived from the **physical file path** (self-healing even without an index) and fed back into the index |
| Subagent/child migration | handled by hand | owned by the official generation layer; `currentPath` is directory-relative and therefore already correct |
| Build | TypeScript + esbuild into `lib/` | plain ESM source, **no build step** |
| Extra config | `packChunks`, `preparedSessionCacheSize`, `writeBatchMaxDelayMs` | those fields no longer exist in 2.x; replaced by `migrateLegacy` and `reconcileWorkspaces` |

## Migration and rollback

- **The one-time migration is best-effort and idempotent.** A failed session stays where it was with a warning, and the next boot retries; a session whose target already exists is skipped.
- **Rollback** from your profile's own `cordis.patch.yml` (the user layer is applied after every bundle layer, so it wins):

  ```yaml
  - id: session-persistence-project-local
    disabled: true
  - id: session-persistence-jsonl
    disabled: false
  ```

  Project-local sessions are then invisible to the stock backend (they are not under the central root); move them back by hand or keep using this plugin.

## Notes and caveats

- **Restart to activate.** The composition tree is assembled at boot.
- **The pointer index is irreplaceable-by-scan only for cross-project discovery.** Delete `index.json` and the next `list()` rebuilds the central-root part; project-local sessions re-register as their projects are visited (or through the workspace registry).
- **Dependency strategy.** The plugin installs no `@deepseek-ai/*` package itself: they are peer dependencies supplied by the harness installation (2.x resolves modules from an installation anchor plus the profile). This isolates it from mixed-install version skew. Official API changes are the only thing that requires a plugin update.
- **Version gate.** 2.x validates `@deepseek-ai/dsh*` peer ranges, so they are declared with an upper bound (`>=0.2.0-rc.2 <0.3.0`): a 0.3.x host fails loudly instead of misbehaving quietly.

## Development and tests

There is no build step; the source is the artifact.

```bash
# Let test/ resolve the host's @deepseek-ai/* packages
ln -s /path/to/dsh-install/node_modules/@deepseek-ai node_modules/@deepseek-ai

npm test        # same as: node --test test/
```

The suite drives the real `SessionPersistence` seam through a real cordis `Context` and covers: project-local placement, the `_no-cwd` fallback, the vanished-project fallback, read/resume, cross-project listing, duplicate-id refusal, the one-time central-root migration, discovery/read/resume of a copied session, segment-encoding parity with the stock layout, corrupt-index rebuild, and v1 index compatibility.

## License

MIT
