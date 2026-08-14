/**
 * Performance envelope: streaming fixtures must render through the coalesced
 * render loop, not once per event. Bounds are wall-clock on the xterm headless
 * emulator, which parses the same ANSI stream a real terminal would, so
 * production (raw writes) is strictly faster than the measured path.
 * @module tests/perf
 */

import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { createTuiTestHarness, disposeTuiTestHarness } from './harness.ts'
import { HeadlessTerminal } from './headless-terminal.ts'

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 25))

/** Append one full streaming turn: reasoning, an answer, and a tool call/result. */
function appendTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn, trigger: { kind: 'message', source: { kind: 'user' } } })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/chunk', { turn, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } })
  for (let i = 0; i < 30; i++) {
    session.append('assistant/chunk', { turn, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: `reasoning ${i} ` } })
  }
  session.append('assistant/chunk', {
    turn, step: 1,
    chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'reasoning complete' } },
  })
  for (let i = 0; i < 108; i++) {
    session.append('assistant/chunk', { turn, step: 1, chunk: { type: 'text-delta', index: 1, text: `answer ${i} ` } })
  }
  session.append('assistant/chunk', { turn, step: 1, chunk: { type: 'block-start', index: 2, blockType: 'tool-call' } })
  session.append('assistant/chunk', {
    turn, step: 1,
    chunk: { type: 'tool-call-delta', index: 2, id: `tool-${turn}` as never, name: 'shell', argumentsDelta: '{"cmd":"' },
  })
  session.append('assistant/chunk', {
    turn, step: 1,
    chunk: { type: 'tool-call-delta', index: 2, id: `tool-${turn}` as never, argumentsDelta: 'ls -la' },
  })
  session.append('assistant/chunk', {
    turn, step: 1,
    chunk: {
      type: 'block-end',
      index: 2,
      block: { type: 'tool-call', id: `tool-${turn}` as never, name: 'shell', arguments: '{"cmd":"ls -la"}' },
    },
  })
  session.append('tool/call', { turn, step: 1, callId: `tool-${turn}` as never, name: 'shell', arguments: '{"cmd":"ls -la"}' })
  session.append('tool/result', {
    turn, step: 1,
    message: createToolResultMessage({
      callId: `tool-${turn}` as never,
      content: [{ type: 'text', text: `command output ${turn}` }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('performance envelope', () => {
  it('renders a 300-event streaming fixture in under 100ms', async () => {
    const terminal = new HeadlessTerminal()
    const result = await createTuiTestHarness(terminal, vi.fn(), {
      config: { theme: { color: true } },
    })
    await tick()

    const framesBefore = terminal.frames
    const started = performance.now()
    appendTurn(result.session, 1)
    appendTurn(result.session, 2)
    // Every append must be visible in the final frame: the fixture renders the
    // answer text of both turns.
    await terminal.waitForFrame()
    const elapsed = performance.now() - started

    await disposeTuiTestHarness(result)
    expect(terminal.frames - framesBefore).toBeLessThanOrEqual(3)
    expect(elapsed).toBeLessThan(100)
    const view = await terminal.snapshot({ includeScrollback: true })
    expect(view).toContain('answer 1')
    expect(view).toContain('answer 2')
    expect(view).toContain('command output 1')
  })

  it('keeps long-session appends incremental and bounded', async () => {
    const terminal = new HeadlessTerminal()
    const result = await createTuiTestHarness(terminal, vi.fn(), {
      config: { theme: { color: true } },
    })
    await tick()

    // 20 full turns = 3000 session events, appended in one synchronous burst
    // exactly as a replayed persisted session would land.
    const appendStarted = performance.now()
    for (let turn = 1; turn <= 20; turn++) appendTurn(result.session, turn)
    const appendElapsed = performance.now() - appendStarted

    const framesBefore = terminal.frames
    const renderStarted = performance.now()
    appendTurn(result.session, 21)
    await terminal.waitForFrame()
    const incrementalRender = performance.now() - renderStarted

    await disposeTuiTestHarness(result)
    expect(appendElapsed).toBeLessThan(1_000)
    expect(terminal.frames - framesBefore).toBeLessThanOrEqual(2)
    expect(incrementalRender).toBeLessThan(250)
  })
})
