/**
 * Project-local session storage for the DeepSeek Harness 2.x.
 *
 * The stock backend keeps every session under one central root
 * (`$DSH_HOME/sessions/<project-key>/<session-id>/session.vN.jsonl.zstd`).
 * This plugin replaces that row and stores each session inside the project it
 * belongs to instead:
 *
 * ```
 * <cwd>/.dsh/sessions/<session-id>/session.v4.jsonl.zstd
 * ```
 *
 * Clone a repository, archive it, or move it to another machine and the
 * conversation history travels with the project.
 *
 * ## How the 2.x adaptation works
 *
 * 2.x turned the JSONL backend into a generation-file store (immutable
 * `session.vN.jsonl[.zstd]` files inside one directory per session) with a
 * cross-process `flock` lease per session directory. Every path in that
 * backend is derived from a single private `root` field through module-private
 * helpers, so relocation cannot be expressed through configuration. This
 * plugin therefore subclasses the backend and overrides exactly the methods
 * that turn a header into a path, plus the discovery/migration surface:
 *
 * | Overridden | Why |
 * | --- | --- |
 * | `locate`, `assertStoredIdentity` | expected artifact path for a header |
 * | `materialize`, `materializePosix` | where a new session's directory appears |
 * | `appendLines`, `repair` | where a materialized session keeps growing |
 * | `acquireLease` | which directory the write lock guards |
 * | `rejectOppositeArtifact` | encoding check next to the log |
 * | `findLog`, `listProjectDirs` | discovery across project-local roots |
 * | `readGenerationHeader`, `readStoredLog` | `cwd` normalization for imports |
 *
 * Everything else — zstd framing, format-version migration, torn-tail repair,
 * durability barriers, the handle state machine — is inherited unchanged.
 *
 * @module dsh-project-session-store
 */

import { randomBytes } from 'node:crypto'
import { cp, link, mkdir, open, readFile, realpath, rename, rm, rmdir, stat, truncate, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import { sessionFormatLogFilename } from '@deepseek-ai/dsh-session-format'
import JsonlSessionPersistence, { JsonlCompressionSchema } from '@deepseek-ai/dsh-session-persistence-jsonl'
import z from '@deepseek-ai/schemastery'

/** Directory name inside each project that holds its session logs. */
const DEFAULT_PROJECT_DIR_NAME = '.dsh/sessions'
/** Project directory used for sessions created without a `cwd`. */
const NO_CWD_DIR_NAME = '_no-cwd'
/** Pointer index inside the central root: `session-id -> project session root`. */
const INDEX_FILE_NAME = 'index.json'
/** Index payload version written by this plugin (values are project session roots). */
const INDEX_VERSION = 2
/** Coalescing window for index writes. */
const INDEX_SAVE_DEBOUNCE_MS = 2_000
/** Delay before a best-effort workspace membership reconciliation pass. */
const WORKSPACE_RECONCILE_DELAY_MS = 3_000
/** Permission bits for directories this plugin creates (owner-only, like the stock backend). */
const DIR_MODE = 0o700

/**
 * Encode one arbitrary string into a single filesystem-safe path segment.
 *
 * Byte-for-byte identical to the stock backend's encoder: session directory
 * names must keep matching the layout the official tooling reads and writes.
 * @param raw - the value to encode; must be non-empty.
 * @returns the encoded segment.
 */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

/**
 * Build the readable directory key for a project path.
 *
 * Identical to the stock backend's key function; it is reproduced here because
 * the legacy central layout has to stay readable during migration.
 * @param cwd - the session's project directory.
 * @returns a single filesystem-safe project directory name.
 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * Physical filename suffix for one encoding.
 * @param compression - configured artifact encoding.
 * @returns `.zstd` for Zstandard, otherwise the empty string.
 */
function compressionSuffix(compression) {
  return compression === 'zstd' ? '.zstd' : ''
}

/**
 * Whether a filesystem error means "nothing there".
 * @param error - the caught value.
 * @returns true for `ENOENT`.
 */
function isENOENT(error) {
  return typeof error === 'object' && error !== null && error.code === 'ENOENT'
}

/**
 * Whether a path exists and is a directory (following symlinks).
 * @param path - the path to probe.
 * @returns true when the path is an existing directory.
 */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if (isENOENT(error)) return false
    throw error
  }
}

/**
 * Resolve a path to its canonical spelling, or `undefined` when it is absent.
 * @param path - the path to canonicalize.
 * @returns the canonical path, or undefined when it does not exist.
 */
async function realpathOrUndefined(path) {
  try {
    return await realpath(path)
  } catch (error) {
    if (isENOENT(error)) return undefined
    throw error
  }
}

/**
 * Whether a path sits inside a directory (or is that directory).
 * @param root - candidate ancestor directory.
 * @param path - candidate descendant path.
 * @returns true when `path` is at or below `root`.
 */
function isUnder(root, path) {
  if (path === root) return true
  return path.startsWith(root.endsWith('/') || root.endsWith('\\') ? root : `${root}/`) || path.startsWith(`${root}\\`)
}

/**
 * Move a whole directory, falling back to copy+delete across devices.
 * @param source - existing directory.
 * @param target - destination that must not already exist.
 */
async function moveDirDurable(source, target) {
  await mkdir(dirname(target), { recursive: true, mode: DIR_MODE })
  try {
    await rename(source, target)
    return
  } catch (error) {
    if (error.code !== 'EXDEV' && error.code !== 'EPERM') throw error
  }
  await cp(source, target, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true })
  await rm(source, { recursive: true, force: true })
}

/**
 * Remove a directory only when it is empty; every failure is ignored.
 * @param dir - candidate directory.
 */
async function rmDirIfEmpty(dir) {
  try {
    await rmdir(dir)
  } catch {
    // Not empty, absent, or not removable: the caller keeps the leftover.
  }
}

/**
 * Project-local session persistence for DSH 2.x.
 *
 * Load it as a composition row (default id `session-persistence-project-local`)
 * and disable the stock `session-persistence-jsonl` row; this service then
 * provides `ctx.sessionPersistence`.
 *
 * @augments JsonlSessionPersistence
 */
export class ProjectSessionPersistence extends JsonlSessionPersistence {
  /**
   * Loader schema: the stock `root`/`compression` pair plus this plugin's
   * placement and migration options.
   */
  static Config = z.object({
    /**
     * Central root: legacy fallback location, `_no-cwd` home, and the place
     * the pointer index lives. Defaults to `$DSH_HOME/sessions`, i.e. exactly
     * what the stock row passes.
     */
    root: z.string().required(false),
    /** Directory inside each project that holds its session logs. */
    projectDirName: z.string().default(DEFAULT_PROJECT_DIR_NAME),
    /** Physical encoding of the artifacts, forwarded to the stock backend. */
    compression: JsonlCompressionSchema,
    /** Move sessions already stored in the central root into their projects on startup. */
    migrateLegacy: z.boolean().default(true),
    /**
     * Best-effort attach of index-known sessions to the matching (or newly
     * created) workspace, so imported sessions group correctly in the Web UI.
     */
    reconcileWorkspaces: z.boolean().default(true),
  })

  /** Backend label for diagnostics; the service key stays `sessionPersistence`. */
  name = 'session-persistence-project-local'

  /** Project-internal session subdirectory, relative to the project root. */
  projectDirName

  /** Whether the startup pass may move central-root sessions into their projects. */
  migrateLegacy

  /** Whether index-known sessions are attached to workspaces. */
  reconcileWorkspaces

  /** Pointer index contents: session id -> project session root. */
  indexSessions = new Map()

  /** Lazily created promise that loads the index from disk exactly once. */
  indexReady

  /** Whether the in-memory index has unsaved changes. */
  indexDirty = false

  /** Pending debounced index save. */
  indexSaveTimer

  /** Ids removed from the index, kept so a disk merge cannot resurrect them. */
  indexDeletions = new Set()

  /** Serial chain that keeps concurrent index read-modify-write passes apart. */
  indexSaveChain = Promise.resolve()

  /** Startup migration barrier; every path-resolving entry point awaits it. */
  migrationDone

  /**
   * Physical artifact location per session id, remembered from the last lookup.
   * A session discovered anywhere keeps growing in place instead of splitting
   * between its real file and a path derived from its header.
   */
  physicalLogs = new Map()

  /**
   * Placement decided when a created session takes its write lease, consumed by
   * the materialization that follows. Taking the lease creates the directory,
   * so the "does this project still exist?" question has to be answered first.
   */
  materializeTargets = new Map()

  /** Pending debounced workspace reconciliation. */
  workspaceReconcileTimer

  /** Guards against overlapping reconciliation passes. */
  workspaceReconcileRunning = false

  /**
   * @param {object} ctx - owning cordis context.
   * @param {object} config - validated plugin configuration.
   */
  constructor(ctx, config) {
    const root = resolve(config.root ?? join(resolveDshHome(), 'sessions'))
    super(ctx, { root, compression: config.compression })
    this.projectDirName = config.projectDirName ?? DEFAULT_PROJECT_DIR_NAME
    this.migrateLegacy = config.migrateLegacy ?? true
    this.reconcileWorkspaces = config.reconcileWorkspaces ?? true
    this.migrationDone = this.runMigration()
    if (this.reconcileWorkspaces) this.scheduleWorkspaceReconcile()
    // Never let a rejected migration barrier surface as an unhandled rejection.
    this.migrationDone.catch(() => {})
  }

  /**
   * Emit one diagnostic line through the host logger when present.
   * @param message - text to log.
   */
  warn(message) {
    const logger = this.ctx?.logger
    if (typeof logger?.warn === 'function') logger.warn(`[${this.name}] ${message}`)
    else console.warn(`[${this.name}] ${message}`)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Path model
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Canonical filename of one generation for the configured encoding.
   * @param version - session format version.
   * @returns the generation filename.
   */
  logFilename(version = sessionFormatCatalog.currentVersion) {
    return `${sessionFormatLogFilename(version)}${compressionSuffix(this.compression)}`
  }

  /**
   * The project-local session root of one project directory.
   * @param cwd - absolute project directory.
   * @returns `<cwd>/<projectDirName>`.
   */
  projectRootFor(cwd) {
    return join(cwd, this.projectDirName)
  }

  /**
   * Recover the project directory from a session root.
   *
   * The configured suffix can span several segments (`.dsh/sessions`), so it is
   * stripped as a whole rather than one `dirname` at a time.
   * @param root - a project session root.
   * @returns the project directory, or undefined for an unexpected shape.
   */
  projectDirOfRoot(root) {
    for (const sep of ['/', '\\']) {
      const suffix = sep + this.projectDirName.replace(/[\\/]+/g, sep)
      if (root.endsWith(suffix)) return root.slice(0, root.length - suffix.length)
    }
    return undefined
  }

  /**
   * Session directory for one session under its project (or the central root
   * for sessions without a `cwd`).
   * @param cwd - the session's project directory, if any.
   * @param id - the session id.
   * @returns the absolute session directory.
   */
  sessionDirFor(cwd, id) {
    if (cwd === undefined) return join(this.root, NO_CWD_DIR_NAME, encodeSegment(id))
    return join(this.projectRootFor(cwd), encodeSegment(id))
  }

  /**
   * Pure project-local artifact path for one generation.
   * @param cwd - the session's project directory, if any.
   * @param id - the session id.
   * @param version - session format version; defaults to the current one.
   * @returns the absolute artifact path.
   */
  logPathFor(cwd, id, version = sessionFormatCatalog.currentVersion) {
    return join(this.sessionDirFor(cwd, id), this.logFilename(version))
  }

  /**
   * Directory a session would occupy under the legacy central layout.
   * @param cwd - the session's project directory, if any.
   * @param id - the session id.
   * @returns the absolute legacy session directory.
   */
  legacySessionDir(cwd, id) {
    if (cwd === undefined) return join(this.root, NO_CWD_DIR_NAME, encodeSegment(id))
    return join(this.root, projectKey(cwd), encodeSegment(id))
  }

  /**
   * Pure legacy artifact path for one generation.
   * @param cwd - the session's project directory, if any.
   * @param id - the session id.
   * @param version - session format version; defaults to the current one.
   * @returns the absolute legacy artifact path.
   */
  legacyLogPathFor(cwd, id, version = sessionFormatCatalog.currentVersion) {
    return join(this.legacySessionDir(cwd, id), this.logFilename(version))
  }

  /**
   * Where one materialized session keeps growing.
   *
   * Order: the physical location remembered from discovery, then the project
   * recorded in the pointer index, then the header's own `cwd`. Following the
   * physical location is what keeps an imported session from splitting.
   * @param meta - the session header.
   * @returns the artifact path to append to.
   */
  writePathFor(meta) {
    const physical = this.physicalLogs.get(meta.id)
    if (physical !== undefined) return physical
    const indexed = this.indexSessions.get(meta.id)
    if (indexed !== undefined) return join(indexed, encodeSegment(meta.id), this.logFilename())
    return this.logPathFor(meta.cwd, meta.id)
  }

  /**
   * Directory (and project root) a brand-new session materializes into.
   *
   * A `cwd` that no longer exists does not get recreated: such a session stays
   * in the central root, where it remains readable and resumable. The decision
   * must be taken before the write lease is acquired, because acquiring the
   * lease is what creates the session directory in the first place.
   * @param meta - the session header.
   * @returns the target session directory and the project root when project-local.
   */
  async materializeTargetFor(meta) {
    if (meta.cwd !== undefined && await isDirectory(meta.cwd)) {
      const projectRoot = this.projectRootFor(meta.cwd)
      return { dir: join(projectRoot, encodeSegment(meta.id)), projectRoot }
    }
    const bucket = meta.cwd === undefined ? NO_CWD_DIR_NAME : projectKey(meta.cwd)
    return { dir: join(this.root, bucket, encodeSegment(meta.id)), projectRoot: undefined }
  }

  /**
   * Rewrite a stored header's `cwd` to the project the artifact actually lives
   * in.
   *
   * A session copied from another machine carries the source machine's path,
   * which is unresolvable here. The project is derived from where the file
   * really sits, so the exposed header groups under the real directory and the
   * pointer index is healed on the way. Nothing on disk is rewritten, which
   * makes the step idempotent.
   * @param header - a stored header, possibly undefined.
   * @param sourcePath - the artifact the header was read from.
   * @returns the same header, or a copy with a normalized `cwd`.
   */
  localizeHeader(header, sourcePath) {
    if (header === undefined || header === null) return header
    // <project root>/<encoded session id>/<generation file>
    const projectRoot = dirname(dirname(sourcePath))
    if (isUnder(this.root, projectRoot)) return header
    const projectDir = this.projectDirOfRoot(projectRoot)
    if (projectDir === undefined) return header
    this.registerSessionRoot(header.id, projectRoot)
    if (header.cwd === projectDir) return header
    return { ...header, cwd: projectDir }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Overrides: artifact identity and location
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Refusal-diagnostics hook: the absolute target path for a header.
   * @param meta - the session header.
   * @returns the artifact kind and path.
   */
  locate(meta) {
    return { kind: 'jsonl', path: this.physicalLogs.get(meta.id) ?? this.logPathFor(meta.cwd, meta.id) }
  }

  /**
   * Acquire the session directory's kernel write lock.
   *
   * The stock default derives the directory from the central root; here the
   * default is the session's project-local directory, while an explicit
   * directory (a write-open of an existing artifact) is honored unchanged.
   * @param id - the session the lock guards.
   * @param cwd - header `cwd` used to derive the directory for a fresh session.
   * @param dir - the resolved directory of an existing artifact, when known.
   * @returns the held lock.
   */
  acquireLease(id, cwd, dir) {
    return super.acquireLease(id, cwd, dir ?? this.sessionDirFor(cwd, id))
  }

  /**
   * Take the write lease for a session that is about to materialize.
   *
   * The stock implementation locks the directory derived from the central root.
   * Here the destination is decided first — a project that still exists gets
   * the session, a vanished one leaves it in the central root — and the lock is
   * taken there. Acquiring the lease creates the directory, so this is the last
   * point at which "does the project exist?" can be answered honestly.
   * @param header - the stored header (its `cwd` derives the directory).
   * @returns the held lock.
   */
  async acquireWriteLease(header) {
    const target = await this.materializeTargetFor(header)
    const opposite = await this.findOppositeGenerationInDirectory(target.dir)
    if (opposite !== undefined) throw this.encodingMismatch(opposite)
    this.materializeTargets.set(header.id, target)
    return this.acquireLease(header.id, header.cwd, target.dir)
  }

  /**
   * Require that a stored artifact really is the session its header claims.
   *
   * Candidates cover the project-local path, the legacy central path, the
   * remembered physical location, and the indexed project — an imported
   * session whose header `cwd` points at another machine still validates.
   * @param path - the artifact that was read.
   * @param storedVersion - its format version, taken from the filename.
   * @param meta - the header read from it.
   * @param expectedId - the session id the caller asked for, when known.
   * @param signal - optional cancellation.
   */
  async assertStoredIdentity(path, storedVersion, meta, expectedId, signal) {
    signal?.throwIfAborted()
    if (expectedId !== undefined && meta.id !== expectedId) {
      throw new Error(`corrupt session log "${path}": requested id "${expectedId}" does not match header id "${meta.id}"`)
    }
    const candidates = []
    try {
      candidates.push(this.logPathFor(meta.cwd, meta.id, storedVersion))
      candidates.push(this.legacyLogPathFor(meta.cwd, meta.id, storedVersion))
    } catch {
      throw new Error(`corrupt session log "${path}": header id cannot name a storage path`)
    }
    const physical = this.physicalLogs.get(meta.id)
    if (physical !== undefined) candidates.push(physical)
    const indexed = this.indexSessions.get(meta.id)
    if (indexed !== undefined) candidates.push(join(indexed, encodeSegment(meta.id), this.logFilename(storedVersion)))
    for (const candidate of candidates) {
      signal?.throwIfAborted()
      if (path === candidate) return
      if (await this.sameFile(path, candidate, signal)) return
    }
    throw new Error(`corrupt session log "${path}": header id "${meta.id}" and cwd identify "${candidates[0]}"`)
  }

  /**
   * Reject a session directory that already holds the opposite encoding.
   * @param cwd - the session's project directory.
   * @param id - the session id.
   */
  async rejectOppositeArtifact(cwd, id) {
    const path = await this.findOppositeGenerationInDirectory(this.sessionDirFor(cwd, id))
    if (path !== undefined) throw this.encodingMismatch(path)
  }

  /** Normalize exposed headers of listed sessions (cross-machine imports). */
  async readGenerationHeader(selected, expectedId, signal) {
    return this.localizeHeader(await super.readGenerationHeader(selected, expectedId, signal), selected.sourcePath)
  }

  /** Normalize the exposed header of an opened session (cross-machine imports). */
  async readStoredLog(path, expectedId, signal) {
    const stored = await super.readStoredLog(path, expectedId, signal)
    const meta = this.localizeHeader(stored.meta, path)
    return meta === stored.meta ? stored : { ...stored, meta }
  }

  /**
   * Normalize the header of a decoded current generation.
   *
   * `open()` reaches a stored log through this method rather than through
   * `readStoredLog`, so both entry points have to be covered.
   * @param path - the artifact file.
   * @param expectedId - the requested session id.
   * @param buffer - the stable bytes read from the artifact.
   * @param revision - the artifact revision.
   * @param signal - optional cancellation.
   * @returns the decoded stored log with a normalized header.
   */
  async decodeStoredLog(path, expectedId, buffer, revision, signal) {
    const stored = await super.decodeStoredLog(path, expectedId, buffer, revision, signal)
    const meta = this.localizeHeader(stored.meta, path)
    return meta === stored.meta ? stored : { ...stored, meta }
  }

  /** Normalize the header of a historical generation awaiting publication. */
  async prepareStoredMigration(id, selected, signal) {
    const stored = await super.prepareStoredMigration(id, selected, signal)
    const meta = this.localizeHeader(stored.meta, selected.sourcePath)
    return meta === stored.meta ? stored : { ...stored, meta }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Overrides: write path
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Atomically write the header line plus the first batch into the session's
   * project directory.
   * @param meta - the session header.
   * @param inheritedEventCount - exact fork-inherited prefix length.
   * @param events - the first batch, in seq order.
   */
  async materialize(meta, inheritedEventCount, events) {
    await this.migrationDone
    const target = this.materializeTargets.get(meta.id) ?? await this.materializeTargetFor(meta)
    this.materializeTargets.delete(meta.id)
    const finalPath = join(target.dir, this.logFilename())
    const opposite = await this.findOppositeGenerationInDirectory(target.dir)
    if (opposite !== undefined) throw this.encodingMismatch(opposite)
    const content = await this.encodeMaterialization(meta, inheritedEventCount, events)
    if (process.platform === 'win32') await super.materializeWin32(dirname(target.dir), target.dir, finalPath, meta.id, content)
    else await this.materializePosix(dirname(target.dir), target.dir, finalPath, meta.id, content)
    this.physicalLogs.set(meta.id, finalPath)
    if (target.projectRoot !== undefined) this.registerSessionRoot(meta.id, target.projectRoot)
  }

  /**
   * POSIX durable publication beneath the project directory.
   *
   * Differs from the stock implementation only in which ancestors are made
   * durable: the project chain instead of the central root's.
   * @param project - the session's parent directory.
   * @param dir - the session directory to create.
   * @param finalPath - the generation file to publish.
   * @param id - the session id, for conflict messages.
   * @param content - encoded header plus first batch.
   */
  async materializePosix(project, dir, finalPath, id, content) {
    await mkdir(project, { recursive: true, mode: DIR_MODE })
    await this.syncDirPosix(dirname(project))
    await mkdir(dir, { recursive: true, mode: DIR_MODE })
    await this.syncDirPosix(project)
    await this.rejectExistingLog(finalPath, id)
    const tmp = await this.writeSyncedTempFile(finalPath, content)
    let linked = false
    try {
      await link(tmp, finalPath)
      linked = true
    } finally {
      if (!linked) await rm(tmp, { force: true }).catch(() => {})
    }
    await this.syncDirPosix(dir)
    await rm(tmp, { force: true }).catch(() => {})
  }

  /**
   * Append one event batch to the session's real artifact and fsync it.
   * @param meta - the session header.
   * @param events - the validated contiguous batch.
   */
  async appendLines(meta, events) {
    const content = await this.encodeEventBatch(events)
    const path = this.writePathFor(meta)
    const handle = await open(path, 'a')
    let closed = false
    const closeAppendHandle = async () => {
      if (closed) return
      closed = true
      await handle.close()
    }
    try {
      const { size: before } = await handle.stat()
      try {
        await handle.writeFile(content)
        await handle.sync()
      } catch (error) {
        try {
          await closeAppendHandle()
          await this.rollbackAppend(path, before)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `failed to roll back append to "${path}"`)
        }
        throw error
      }
    } finally {
      await closeAppendHandle()
    }
  }

  /**
   * Truncate a torn tail on the session's real artifact and fsync.
   * @param meta - the session header.
   * @param offset - byte offset to truncate to.
   */
  async repair(meta, offset) {
    const path = this.writePathFor(meta)
    await truncate(path, offset)
    const handle = await open(path, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Overrides: discovery
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Find the authoritative generation of one session across every known place.
   *
   * Lookup order is physical memory, the pointer index, every known project
   * root (index, workspaces, and the legacy central root's own directories).
   * Two distinct files for one id are an error unless one of them is a legacy
   * leftover, which the project-local copy supersedes.
   * @param id - the session id to locate.
   * @param signal - optional cancellation.
   * @returns the selected generation, or undefined when the session is absent.
   */
  async findLog(id, signal) {
    await this.migrationDone
    signal?.throwIfAborted()
    const matches = []
    const seenFiles = new Set()
    const consider = async (dir) => {
      if (dir === undefined) return
      signal?.throwIfAborted()
      const selected = await this.resolveGenerationInDirectory(dir, signal)
      if (selected === undefined) return
      const identity = await realpathOrUndefined(selected.sourcePath) ?? selected.sourcePath
      if (seenFiles.has(identity)) return
      seenFiles.add(identity)
      matches.push(selected)
    }
    const physical = this.physicalLogs.get(id)
    if (physical !== undefined) await consider(dirname(physical))
    const indexed = this.indexSessions.get(id)
    if (indexed !== undefined) await consider(join(indexed, encodeSegment(id)))
    for (const project of await this.listProjectDirs(signal)) {
      signal?.throwIfAborted()
      await this.rejectLegacyFlatArtifact(project, id, signal)
      const before = matches.length
      await consider(join(project, encodeSegment(id)))
      // A hit outside the central root heals the pointer index on the spot.
      if (matches.length > before && !isUnder(this.root, project)) this.registerSessionRoot(id, project)
    }
    if (matches.length > 1) {
      const projectLocal = matches.filter((match) => !isUnder(this.root, match.sourcePath))
      const preferred = projectLocal[0] ?? matches[0]
      for (const match of matches) {
        if (match === preferred) continue
        this.warn(`session ${id} exists in ${matches.length} locations; using ${preferred.sourcePath} and ignoring ${match.sourcePath}`)
      }
      matches.length = 0
      matches.push(preferred)
    }
    const found = matches[0]
    if (found !== undefined) this.physicalLogs.set(id, found.sourcePath)
    return found
  }

  /**
   * Every directory that may contain session directories.
   *
   * Union of the pointer index, the workspace registry's project directories,
   * and the legacy central root's own project directories (so unmigrated
   * leftovers stay visible). Non-existent roots are dropped.
   * @param signal - optional cancellation.
   * @returns existing project session root directories.
   */
  async listProjectDirs(signal) {
    await this.migrationDone
    signal?.throwIfAborted()
    const roots = new Set()
    for (const root of this.indexSessions.values()) roots.add(root)
    const registry = this.ctx?.get?.('workspaceRegistry')
    if (registry !== undefined && typeof registry.list === 'function') {
      try {
        for (const workspace of registry.list()) {
          if (typeof workspace?.path === 'string' && workspace.path.length > 0) roots.add(this.projectRootFor(workspace.path))
        }
      } catch (error) {
        this.warn(`workspace registry listing failed: ${String(error)}`)
      }
    }
    for (const legacy of await super.listProjectDirs(signal)) roots.add(legacy)
    const existing = []
    for (const root of roots) {
      signal?.throwIfAborted()
      if (await isDirectory(root)) existing.push(root)
    }
    return existing
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Pointer index
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Absolute path of the pointer index file.
   * @returns `<central root>/index.json`.
   */
  indexPath() {
    return join(this.root, INDEX_FILE_NAME)
  }

  /**
   * Parse an index payload.
   *
   * v1 stored a project directory per id (the shape a very early release of the
   * project-local layout wrote); v2 stores the project session root. Both are
   * accepted so an existing index keeps working after an upgrade.
   * @param text - file contents.
   * @returns the parsed map, or null when the payload is unusable.
   */
  parseIndexPayload(text) {
    const parsed = JSON.parse(text)
    if (parsed.version !== 1 && parsed.version !== 2) return null
    if (typeof parsed.sessions !== 'object' || parsed.sessions === null) return null
    const result = new Map()
    for (const [id, value] of Object.entries(parsed.sessions)) {
      if (typeof value !== 'string' || value.length === 0) continue
      result.set(id, parsed.version === 1 ? this.projectRootFor(value) : value)
    }
    return result
  }

  /**
   * Load the index from disk once; unreadable or malformed files degrade to an
   * empty index that the next save rebuilds.
   * @returns resolution once the load has been attempted.
   */
  ensureIndexLoaded() {
    this.indexReady ??= (async () => {
      let text
      try {
        text = await readFile(this.indexPath(), 'utf8')
      } catch (error) {
        if (!isENOENT(error)) this.warn(`cannot read session index ${this.indexPath()}: ${String(error)}`)
        return
      }
      try {
        const entries = this.parseIndexPayload(text)
        if (entries === null) {
          this.warn(`session index ${this.indexPath()} has an unexpected shape; rebuilding it`)
          return
        }
        for (const [id, root] of entries) this.indexSessions.set(id, root)
      } catch (error) {
        this.warn(`session index ${this.indexPath()} is not valid JSON; rebuilding it (${String(error)})`)
      }
    })()
    return this.indexReady
  }

  /** Schedule a coalesced index write. */
  scheduleIndexSave() {
    if (this.indexSaveTimer !== undefined) return
    this.indexSaveTimer = setTimeout(() => {
      this.indexSaveTimer = undefined
      void this.saveIndexNow().catch((error) => {
        this.warn(`cannot save session index: ${String(error)}`)
      })
    }, INDEX_SAVE_DEBOUNCE_MS)
    this.indexSaveTimer.unref?.()
  }

  /**
   * Record where one session actually lives.
   * @param id - the session id.
   * @param root - its project session root.
   */
  registerSessionRoot(id, root) {
    if (root === undefined || root.length === 0) return
    if (this.indexSessions.get(id) === root) return
    this.indexSessions.set(id, root)
    this.indexDirty = true
    this.scheduleIndexSave()
  }

  /**
   * Forget one session's pointer (its artifact is gone).
   * @param id - the session id.
   */
  clearSessionIndex(id) {
    if (!this.indexSessions.delete(id)) return
    this.indexDeletions.add(id)
    this.indexDirty = true
    this.scheduleIndexSave()
  }

  /**
   * Write the index atomically, merging whatever is on disk first so a second
   * process's entries survive. Writes are serialized within this process.
   * @returns resolution once the write finished.
   */
  saveIndexNow() {
    const task = this.indexSaveChain.then(() => this.saveIndexNowUnlocked())
    this.indexSaveChain = task.catch(() => undefined)
    return task
  }

  /** Actual index writer; only called through the serial chain. */
  async saveIndexNowUnlocked() {
    await this.ensureIndexLoaded()
    const sessions = {}
    try {
      const diskEntries = this.parseIndexPayload(await readFile(this.indexPath(), 'utf8'))
      if (diskEntries !== null) for (const [id, root] of diskEntries) sessions[id] = root
    } catch {
      // Absent or malformed: this process's view becomes the whole index.
    }
    for (const [id, root] of this.indexSessions) sessions[id] = root
    for (const id of this.indexDeletions) delete sessions[id]
    const payload = `${JSON.stringify({ version: INDEX_VERSION, sessions }, null, 2)}\n`
    await mkdir(this.root, { recursive: true, mode: DIR_MODE })
    const tmp = join(this.root, `.${INDEX_FILE_NAME}.${randomBytes(6).toString('hex')}.tmp`)
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(payload)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(tmp, this.indexPath())
      if (process.platform !== 'win32') await this.syncDirPosix(this.root)
    } catch (error) {
      await unlink(tmp).catch(() => undefined)
      throw error
    }
    this.indexDirty = false
    this.indexDeletions.clear()
  }

  // ───────────────────────────────────────────────────────────────────────────
  // One-time migration out of the central root
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Move every session the central root holds into its project directory.
   *
   * Best-effort and idempotent: a session whose `cwd` is gone, whose project
   * directory is unwritable, or whose target already exists stays where it is
   * and remains readable through the legacy fallback.
   * @returns resolution when the pass finished.
   */
  async runMigration() {
    try {
      await this.ensureIndexLoaded()
      if (!this.migrateLegacy) return
      let moved = 0
      for (const legacyProject of await super.listProjectDirs()) {
        let sessionDirs
        try {
          sessionDirs = await this.listSessionDirs(legacyProject)
        } catch (error) {
          this.warn(`migration: skipping ${legacyProject}: ${String(error)}`)
          continue
        }
        for (const sessionDir of sessionDirs) if (await this.migrateOne(sessionDir)) moved += 1
      }
      if (moved > 0 || this.indexDirty) {
        await this.saveIndexNow()
        if (moved > 0) this.warn(`migration: moved ${moved} session(s) into their project directories`)
      }
    } catch (error) {
      this.warn(`migration failed (sessions stay readable in ${this.root}): ${String(error)}`)
    }
  }

  /**
   * Migrate one central-root session directory.
   * @param sessionDirPath - the legacy session directory.
   * @returns whether a move happened.
   */
  async migrateOne(sessionDirPath) {
    const selected = await this.resolveGenerationInDirectory(sessionDirPath)
    if (selected === undefined) return false
    let header
    try {
      header = await this.readGenerationHeader(selected, undefined, undefined)
    } catch (error) {
      this.warn(`migration: cannot read ${selected.sourcePath}: ${String(error)}`)
      return false
    }
    if (header === undefined || header.cwd === undefined || header.cwd.length === 0) return false
    if (!await isDirectory(header.cwd)) {
      this.warn(`migration: project directory "${header.cwd}" is gone; keeping session ${header.id} in ${this.root}`)
      return false
    }
    const projectRoot = this.projectRootFor(header.cwd)
    const targetDir = join(projectRoot, encodeSegment(header.id))
    if (await this.exists(join(targetDir, this.logFilename(selected.sourceVersion)))) {
      this.registerSessionRoot(header.id, projectRoot)
      return false
    }
    try {
      await moveDirDurable(sessionDirPath, targetDir)
    } catch (error) {
      this.warn(`migration: cannot move session ${header.id} to ${targetDir}: ${String(error)}`)
      return false
    }
    if (process.platform !== 'win32') {
      await this.syncDirPosix(projectRoot).catch(() => undefined)
    }
    await rmDirIfEmpty(sessionDirPath)
    await rmDirIfEmpty(dirname(sessionDirPath))
    this.registerSessionRoot(header.id, projectRoot)
    return true
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Workspace grouping
  // ───────────────────────────────────────────────────────────────────────────

  /** Schedule one debounced workspace reconciliation pass. */
  scheduleWorkspaceReconcile() {
    if (this.workspaceReconcileTimer !== undefined) return
    this.workspaceReconcileTimer = setTimeout(() => {
      this.workspaceReconcileTimer = undefined
      void this.reconcileWorkspaceMembership().catch((error) => {
        this.warn(`workspace reconciliation failed: ${String(error)}`)
      })
    }, WORKSPACE_RECONCILE_DELAY_MS)
    this.workspaceReconcileTimer.unref?.()
  }

  /**
   * Attach index-known sessions that no workspace accounts for.
   *
   * Everything is derived from where the artifact actually sits, so a project
   * copied to another machine still groups under its real directory. The pass
   * is idempotent and silently skipped while the registry is unavailable.
   * @returns resolution when the pass finished.
   */
  async reconcileWorkspaceMembership() {
    if (this.workspaceReconcileRunning) return
    this.workspaceReconcileRunning = true
    try {
      await this.ensureIndexLoaded()
      const registry = this.ctx?.get?.('workspaceRegistry')
      if (registry === undefined || typeof registry.list !== 'function' || typeof registry.create !== 'function') return
      for (const [id, root] of [...this.indexSessions]) {
        const projectDir = this.projectDirOfRoot(root)
        if (projectDir === undefined) continue
        if (!await this.exists(join(root, encodeSegment(id), this.logFilename()))) {
          this.clearSessionIndex(id)
          continue
        }
        const canonical = await realpathOrUndefined(projectDir)
        if (canonical === undefined) continue
        let entity
        try {
          entity = registry.list().find((workspace) => workspace.path === canonical)
            ?? await registry.resolveByPath(canonical)
            ?? await registry.create(canonical, basename(canonical))
        } catch (error) {
          this.warn(`cannot resolve a workspace for ${projectDir}: ${String(error)}`)
          continue
        }
        if (entity === undefined || entity.sessionIds.includes(id)) continue
        try {
          await entity.attachSession(id)
          this.warn(`workspace: attached session ${id} to "${entity.title}"`)
        } catch (error) {
          this.warn(`cannot attach session ${id} to "${entity.title}": ${String(error)}`)
        }
      }
    } finally {
      this.workspaceReconcileRunning = false
    }
  }

  /**
   * List stored sessions, then opportunistically refresh workspace grouping.
   * @param options - optional cancellation.
   * @returns one snapshot per stored session.
   */
  async list(options) {
    const snapshots = await super.list(options)
    if (this.reconcileWorkspaces) this.scheduleWorkspaceReconcile()
    return snapshots
  }
}

export default ProjectSessionPersistence
