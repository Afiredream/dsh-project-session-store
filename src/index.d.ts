/**
 * Project-local session storage for the DeepSeek Harness 2.x.
 * @module dsh-project-session-store
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type z from '@deepseek-ai/schemastery'

/** Plugin configuration; every field is optional at the composition layer. */
export interface ProjectSessionStoreConfig {
  /**
   * Central root: the legacy fallback location, the home of `_no-cwd`
   * sessions, and where the pointer index lives. Defaults to
   * `$DSH_HOME/sessions`, i.e. exactly what the stock row passes.
   */
  root?: string
  /** Directory inside each project that holds its session logs. Defaults to `.dsh/sessions`. */
  projectDirName?: string
  /** Physical artifact encoding; defaults to checksummed Zstandard frames. */
  compression?: 'zstd' | 'none'
  /** Move sessions already stored in the central root into their projects on startup. Defaults to true. */
  migrateLegacy?: boolean
  /** Attach index-known sessions to the matching workspace. Defaults to true. */
  reconcileWorkspaces?: boolean
}

/**
 * Project-local session persistence: a JSONL backend whose artifacts live in
 * the project each session belongs to.
 *
 * Load it as a composition row (default id `session-persistence-project-local`)
 * with the stock `session-persistence-jsonl` row disabled; it then provides
 * `ctx.sessionPersistence`.
 */
export declare class ProjectSessionPersistence extends JsonlSessionPersistence {
  /** Loader schema for the row's `config` block. */
  static Config: z<ProjectSessionStoreConfig>
  /** Backend label for diagnostics; the service key stays `sessionPersistence`. */
  name: string
  /** Project-internal session subdirectory, relative to the project root. */
  projectDirName: string
  /** Whether the startup pass may move central-root sessions into their projects. */
  migrateLegacy: boolean
  /** Whether index-known sessions are attached to workspaces. */
  reconcileWorkspaces: boolean
  /** Pointer index contents: session id -> project session root. */
  indexSessions: Map<SessionId, string>
  /** Physical artifact location per session id, remembered from the last lookup. */
  physicalLogs: Map<SessionId, string>
  /** Resolves once the one-time migration pass has finished. */
  migrationDone: Promise<void>

  /**
   * @param ctx - owning cordis context.
   * @param config - validated plugin configuration.
   */
  constructor(ctx: Context, config: ProjectSessionStoreConfig)

  /** Canonical filename of one generation for the configured encoding. */
  logFilename(version?: number): string
  /** The project-local session root of one project directory. */
  projectRootFor(cwd: string): string
  /** Recover the project directory from a session root. */
  projectDirOfRoot(root: string): string | undefined
  /** Session directory for one session under its project. */
  sessionDirFor(cwd: string | undefined, id: SessionId): string
  /** Pure project-local artifact path for one generation. */
  logPathFor(cwd: string | undefined, id: SessionId, version?: number): string
  /** Directory a session would occupy under the legacy central layout. */
  legacySessionDir(cwd: string | undefined, id: SessionId): string
  /** Pure legacy artifact path for one generation. */
  legacyLogPathFor(cwd: string | undefined, id: SessionId, version?: number): string
  /** Where one materialized session keeps growing. */
  writePathFor(meta: SessionHeader): string
  /** Rewrite a stored header's `cwd` to the project the artifact actually lives in. */
  localizeHeader(header: SessionHeader | undefined, sourcePath: string): SessionHeader | undefined
  /** Absolute path of the pointer index file. */
  indexPath(): string
  /** Load the index from disk once. */
  ensureIndexLoaded(): Promise<void>
  /** Record where one session actually lives. */
  registerSessionRoot(id: SessionId, root: string): void
  /** Forget one session's pointer. */
  clearSessionIndex(id: SessionId): void
  /** Write the index atomically, merging what is on disk first. */
  saveIndexNow(): Promise<void>
  /** Move every session the central root holds into its project directory. */
  runMigration(): Promise<void>
  /** Attach index-known sessions that no workspace accounts for. */
  reconcileWorkspaceMembership(): Promise<void>
}

export default ProjectSessionPersistence
