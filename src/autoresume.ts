/**
 * Claude-Code-style automatic recovery: a bare `dsh --profile tui` launch
 * (no `--resume`) hands off into the current workspace's most recently
 * active non-empty session instead of minting a fresh empty one. A workspace
 * with no resumable candidate starts normally. The handoff child re-enters
 * through the same startup intake with `--resume=<id>`, where this plugin
 * sees `resume: true` and stays out of the way.
 * @module @woodwhite0ets/dsh-tui/autoresume
 */

import { stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import type {} from './startup.ts'
import { EMPTY_SESSION_MAX_BYTES } from './components/dialogs.ts'
import type { TuiResumeHost } from './runtime.ts'

export const name = 'tui-autoresume'
export const inject = ['tuiStartup']

/** Whether the plugin context's fiber has been disposed (uid is null once so). */
const disposed = (ctx: Context): boolean => ctx.fiber.uid === null

/** One persisted record's materialized artifact, when the backend can locate it. */
export interface AutoResumeInspect {
  /** Artifact size in bytes; `<= EMPTY_SESSION_MAX_BYTES` means an empty shell. */
  readonly size: number
  /** Last artifact write time in Unix epoch milliseconds. */
  readonly mtime: number
}

/** Minimal record shape recovery selects over; `R extends` keeps full records. */
export interface AutoResumeRecord {
  readonly live: boolean
  readonly header: {
    readonly id: SessionId
    readonly cwd?: string
    readonly createdAt: number
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
  }
}

/** Whether two absolute workspaces are the same path on this platform. */
const sameCwd = (a: string, b: string): boolean =>
  process.platform === 'win32'
    ? a.toLocaleLowerCase() === b.toLocaleLowerCase()
    : a === b

/**
 * Select the session a bare launch should auto-resume: the current
 * workspace's newest non-empty, non-subagent, non-live persisted session.
 * @param records - The listed corpus.
 * @param cwd - The workspace to scope recovery to.
 * @param inspect - Resolves one record's persisted artifact; `undefined` keeps
 *   the record out of recovery (no materialized artifact to resume from).
 * @returns The chosen record, or `undefined` when nothing is resumable here.
 */
export async function selectAutoResume<R extends AutoResumeRecord>(
  records: readonly R[],
  cwd: string,
  inspect: (record: R) => Promise<AutoResumeInspect | undefined>,
): Promise<R | undefined> {
  let newest: R | undefined
  let newestActivity = 0
  for (const record of records) {
    if (record.live) continue
    if (record.header.cwd === undefined || !sameCwd(record.header.cwd, cwd)) continue
    if (record.header.origin === 'subagent' || record.header.delegationDepth !== undefined) continue
    const artifact = await inspect(record)
    if (artifact === undefined || artifact.size <= EMPTY_SESSION_MAX_BYTES) continue
    if (artifact.mtime > newestActivity) {
      newest = record
      newestActivity = artifact.mtime
    }
  }
  return newest
}

/**
 * Resolve the current workspace's most recent resumable session and hand the
 * process over to it. Runs after every plugin has applied (the loader's tree
 * is settled, so persistence, query, and the resume host all exist), then the
 * handoff tears the app down and re-enters with `--resume`, so a bare launch
 * lands in the last conversation, not a new empty shell.
 * @param ctx - the plugin context.
 */
export async function autoResume(ctx: Context): Promise<void> {
  if (ctx.tuiStartup?.resume === true || ctx.tuiStartup?.new === true) return
  let query: SessionQueryEngine | undefined
  try {
    query = ctx.sessionQuery
  } catch {
    return
  }
  const persistence = ctx.get('sessionPersistence')
  const host: TuiResumeHost | undefined = ctx.get('tuiResumeHost')
  if (query === undefined || persistence === undefined || host === undefined) return
  let records
  try {
    records = await query.listSessions()
  } catch {
    return
  }
  if (disposed(ctx)) return
  const cwd = process.cwd()
  const candidate = await selectAutoResume(records, cwd, async record => {
    const location = persistence.locate(record.header)
    if (location === undefined) return undefined
    try {
      const info = await stat(location.path)
      return { size: info.size, mtime: info.mtimeMs }
    } catch {
      return undefined
    }
  })
  if (candidate === undefined || disposed(ctx)) return
  process.stderr.write(`dsh-tui: resuming last session ${candidate.header.id}\n`)
  await host.handoff(candidate.header.id, candidate.header.cwd ?? cwd)
}

export function apply(ctx: Context): void {
  // The loader tree settles after every entry has applied — the earliest
  // point the query/persistence services are guaranteed mounted. Fire the
  // recovery as a background task so this plugin's own apply never blocks
  // the load the await waits on.
  void (async () => {
    try {
      await ctx.loader.await()
    } catch {
      return
    }
    if (disposed(ctx)) return
    await autoResume(ctx)
  })()
}
