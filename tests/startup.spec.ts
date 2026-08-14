/**
 * resume-handoff host: Windows spawns an inheriting child because Node's
 * `process.execve` stub throws ERR_FEATURE_UNAVAILABLE_ON_PLATFORM there;
 * POSIX replaces the process in place.
 */

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { installResumeHost } from '../src/startup.ts'
import type { Context } from '@deepseek-ai/cordis'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const spawnMock = vi.mocked(spawn)

interface FakeContext {
  root: { fiber: { dispose: ReturnType<typeof vi.fn> } }
  provide: ReturnType<typeof vi.fn>
}

function fakeContext(): FakeContext {
  return {
    root: { fiber: { dispose: vi.fn().mockResolvedValue(undefined) } },
    provide: vi.fn(),
  }
}

function hostOf(ctx: FakeContext): (sessionId: string, cwd: string) => Promise<never> {
  const call = ctx.provide.mock.calls.find(([key]) => key === 'tuiResumeHost')
  if (call === undefined) throw new Error('tuiResumeHost was never provided')
  return call[1].handoff as (sessionId: string, cwd: string) => Promise<never>
}

describe('resume handoff host', () => {
  let platform: ReturnType<typeof vi.spyOn>
  let argv: ReturnType<typeof vi.spyOn>
  let chdir: ReturnType<typeof vi.spyOn>
  let execve: ReturnType<typeof vi.spyOn>
  let exitCode: number | undefined
  let stderr: ReturnType<typeof vi.spyOn>
  let ctx: FakeContext

  beforeEach(() => {
    platform = vi.spyOn(process, 'platform', 'get')
    argv = vi.spyOn(process, 'argv', 'get')
    chdir = vi.spyOn(process, 'chdir').mockImplementation(() => {})
    execve = vi.spyOn(process, 'execve').mockImplementation(() => { throw new Error('replaced') })
    vi.spyOn(process, 'exit').mockImplementation(((code) => { exitCode = code }) as never)
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    ctx = fakeContext()
    argv.mockReturnValue(['node', '/entry.js', '--profile', 'tui'])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    spawnMock.mockReset()
  })

  /** The exact child argv the handoff rebuilds, without argv[0]: spawn supplies it. */
  const expectedChildArgs = (session: string): string[] => [
    ...process.execArgv,
    '/entry.js',
    '--profile',
    'tui',
    `--resume=${session}`,
  ]

  /** The execve argv, which carries argv[0] as its first element. */
  const expectedExecveArgv = (session: string): string[] => [
    process.execPath,
    ...expectedChildArgs(session),
  ]

  it('spawns an inheriting child on Windows instead of execve', async () => {
    platform.mockReturnValue('win32')
    const child = new EventEmitter()
    spawnMock.mockReturnValue(child as never)
    installResumeHost(ctx as unknown as Context)
    const handoff = hostOf(ctx)

    const pending = handoff('sess-1', '/workspace')
    await vi.waitFor(() => expect(ctx.root.fiber.dispose).toHaveBeenCalled())
    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [file, target, options] = spawnMock.mock.calls[0] as [string, string[], { stdio: 'inherit'; env: NodeJS.ProcessEnv }]
    expect(file).toBe(process.execPath)
    expect(target).toEqual(expectedChildArgs('sess-1'))
    expect(options.stdio).toBe('inherit')
    // The parent hands over only once the child exits: console stays owned.
    expect(exitCode).toBeUndefined()
    child.emit('exit', 0)
    expect(exitCode).toBe(0)
  })

  it('propagates the child exit code to the parent', async () => {
    platform.mockReturnValue('win32')
    const child = new EventEmitter()
    spawnMock.mockReturnValue(child as never)
    installResumeHost(ctx as unknown as Context)
    const handoff = hostOf(ctx)
    const pending = handoff('sess-1', '/workspace')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('exit', 3)
    expect(exitCode).toBe(3)
  })

  it('reports a spawn failure after terminal release', async () => {
    platform.mockReturnValue('win32')
    const child = new EventEmitter()
    spawnMock.mockReturnValue(child as never)
    installResumeHost(ctx as unknown as Context)
    const handoff = hostOf(ctx)
    const pending = handoff('sess-1', '/workspace')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    child.emit('error', new Error('no such file'))
    await pending
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('resume handoff failed after terminal release'))
    expect(exitCode).toBe(1)
  })

  it('re-execs in place on POSIX through execve', async () => {
    platform.mockReturnValue('linux')
    execve.mockImplementation(() => {})
    installResumeHost(ctx as unknown as Context)
    const handoff = hostOf(ctx)
    const pending = handoff('sess-1', '/workspace')
    await vi.waitFor(() => expect(execve).toHaveBeenCalled())
    expect(execve).toHaveBeenCalledWith(process.execPath, expectedExecveArgv('sess-1'), process.env)
    // execve returning at all is unexpected: the host reports and exits.
    await pending
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('returned unexpectedly'))
    expect(exitCode).toBe(1)
  })

  it('never calls execve on the Windows spawn path', async () => {
    platform.mockReturnValue('win32')
    const child = new EventEmitter()
    spawnMock.mockReturnValue(child as never)
    installResumeHost(ctx as unknown as Context)
    const handoff = hostOf(ctx)
    const pending = handoff('sess-1', '/workspace')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    expect(execve).not.toHaveBeenCalled()
    child.emit('exit', 0)
    expect(exitCode).toBe(0)
  })

  it('rejects before teardown when the target directory is unreachable', async () => {
    platform.mockReturnValue('win32')
    chdir.mockImplementation(() => { throw new Error('ENOENT') })
    installResumeHost(ctx as unknown as Context)
    const handoff = hostOf(ctx)
    await expect(handoff('sess-1', '/missing')).rejects.toThrow('cannot enter workspace')
    expect(ctx.root.fiber.dispose).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('omits every --resume occurrence when rebuilding the launcher args', async () => {
    platform.mockReturnValue('win32')
    argv.mockReturnValue(['node', '/entry.js', '--profile', 'tui', '--resume', 'old-session', '--resume=stale'])
    const child = new EventEmitter()
    spawnMock.mockReturnValue(child as never)
    installResumeHost(ctx as unknown as Context)
    const handoff = hostOf(ctx)
    const pending = handoff('sess-1', '/workspace')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    expect(spawnMock.mock.calls[0][1]).toEqual(expectedChildArgs('sess-1'))
    child.emit('exit', 0)
    expect(exitCode).toBe(0)
  })

  it('re-enters with --new instead of --resume when handed no session id', async () => {
    platform.mockReturnValue('win32')
    argv.mockReturnValue(['node', '/entry.js', '--profile', 'tui'])
    const child = new EventEmitter()
    spawnMock.mockReturnValue(child as never)
    installResumeHost(ctx as unknown as Context)
    const handoff = hostOf(ctx)
    const pending = handoff(undefined, '/workspace')
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    expect(spawnMock.mock.calls[0][1]).toEqual([
      ...process.execArgv,
      '/entry.js',
      '--profile',
      'tui',
      '--new',
    ])
    child.emit('exit', 0)
    expect(exitCode).toBe(0)
  })

  it('skips the host entirely when no entry is known', async () => {
    argv.mockReturnValue(['node'])
    installResumeHost(ctx as unknown as Context)
    expect(ctx.provide).not.toHaveBeenCalledWith('tuiResumeHost', expect.anything())
  })
})
