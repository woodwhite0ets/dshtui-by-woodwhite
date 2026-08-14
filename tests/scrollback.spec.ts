/**
 * Scrollback viewport: PgUp/PgDn navigate into rendered history, any key
 * returns to the live bottom, streamed content stays out of view while
 * scrolled, and an inline question dialog brings the viewport back so the
 * question the agent is waiting on stays visible.
 */

import { describe, expect, it } from 'vitest'
import {
  appendAssistant,
  appendUser,
  createTuiTestHarness,
  disposeTuiTestHarness,
  type TuiHarness,
} from './harness.ts'
import { HeadlessTerminal } from './headless-terminal.ts'

type ScrollHarness = TuiHarness<HeadlessTerminal, (code: number) => void>

const PAGE_UP = '\x1b[5~'
const PAGE_DOWN = '\x1b[6~'
const HINT_TEXT = 'history · PgUp/PgDn'

/** Mount the TUI over a transcript long enough to overflow a 36-row viewport. */
async function setupScrolled(): Promise<ScrollHarness> {
  const terminal = new HeadlessTerminal(96, 36)
  const before = terminal.frames
  const harness = await createTuiTestHarness(terminal, () => {}, {
    cwd: '/workspace/project',
    config: {
      welcome: 'Snapshot agent ready.',
      theme: { color: true },
      title: 'DSH snapshot',
    },
    beforeMount(session) {
      for (let pair = 0; pair < 8; pair++) {
        appendUser(session, `question ${pair}`)
        appendAssistant(session, [{
          type: 'text',
          text: `answer ${pair} first\nanswer ${pair} second\nanswer ${pair} third\nanswer ${pair} fourth`,
        }])
      }
    },
  })
  await terminal.waitForFrame(before)
  return harness
}

async function dispose(harness: ScrollHarness): Promise<void> {
  await disposeTuiTestHarness(harness)
  await harness.terminal.dispose()
}

async function renderAfter(harness: ScrollHarness, action: () => void): Promise<void> {
  const before = harness.terminal.frames
  action()
  await harness.terminal.waitForFrame(before)
}

/** Page up repeatedly until the viewport clamps at the top of history. */
async function scrollToTop(harness: ScrollHarness): Promise<void> {
  await renderAfter(harness, () => {
    for (let page = 0; page < 4; page += 1) harness.terminal.send(PAGE_UP)
  })
}

/** Page down repeatedly until the viewport clamps at the live bottom. */
async function scrollToBottom(harness: ScrollHarness): Promise<void> {
  await renderAfter(harness, () => {
    for (let page = 0; page < 4; page += 1) harness.terminal.send(PAGE_DOWN)
  })
}

/** The viewport rows from a snapshot, without its header lines. */
function viewportRows(snapshot: string): string[] {
  const lines = snapshot.split('\n')
  const marker = lines.indexOf('viewport')
  return lines.slice(marker + 1, lines.length - 1)
}

/** Text rows only: each row also emits trailing `style` lines. */
function viewportTextRows(snapshot: string): string[] {
  return viewportRows(snapshot).filter(row => row.includes('| '))
}

function assertScrolled(snapshot: string): void {
  const rows = viewportTextRows(snapshot)
  expect(rows.join('\n'), 'viewport must show the hint line').toContain(HINT_TEXT)
  expect(rows.at(-1), 'hint must sit on the bottom viewport row').toContain(HINT_TEXT)
  expect(rows.join('\n'), 'older content must be visible').toContain('question 0')
  expect(rows.join('\n'), 'newest content must be off-screen').not.toContain('answer 7 fourth')
}

function assertPinned(snapshot: string): void {
  const rows = viewportTextRows(snapshot)
  expect(rows.join('\n'), 'hint must be gone at the live bottom').not.toContain(HINT_TEXT)
  expect(rows.join('\n'), 'newest content must be visible').toContain('answer 7 fourth')
}

describe('scrollback', () => {
  it('PgUp scrolls the viewport into history with the hint line at the bottom', async () => {
    const harness = await setupScrolled()
    await scrollToTop(harness)
    assertScrolled(await harness.terminal.snapshot())
    await dispose(harness)
  })

  it('PgDn pages back toward the live bottom and pins there', async () => {
    const harness = await setupScrolled()
    await scrollToTop(harness)
    assertScrolled(await harness.terminal.snapshot())
    await renderAfter(harness, () => harness.terminal.send(PAGE_DOWN))
    const moved = await harness.terminal.snapshot()
    const rows = viewportTextRows(moved)
    expect(rows.join('\n'), 'still scrolled: hint must remain').toContain(HINT_TEXT)
    expect(rows.join('\n'), 'top content must leave the window').not.toContain('question 0')
    expect(rows.join('\n'), 'newest content must stay off-screen').not.toContain('answer 7 fourth')
    await scrollToBottom(harness)
    assertPinned(await harness.terminal.snapshot())
    await dispose(harness)
  })

  it('PgDn at the live bottom is a no-op', async () => {
    const harness = await setupScrolled()
    const before = await harness.terminal.snapshot()
    await new Promise(resolve => setTimeout(resolve, 50))
    harness.terminal.send(PAGE_DOWN)
    await new Promise(resolve => setTimeout(resolve, 50))
    const after = await harness.terminal.snapshot()
    expect(after).toBe(before)
    await dispose(harness)
  })

  it('any key returns to the live bottom and still reaches the editor', async () => {
    const harness = await setupScrolled()
    await scrollToTop(harness)
    assertScrolled(await harness.terminal.snapshot())
    await renderAfter(harness, () => harness.terminal.send('x'))
    const pinned = await harness.terminal.snapshot()
    assertPinned(pinned)
    expect(viewportTextRows(pinned).join('\n'), 'the key must land in the editor').toContain('x')
    await dispose(harness)
  })

  it('streamed content stays out of view while scrolled', async () => {
    const harness = await setupScrolled()
    await scrollToTop(harness)
    const before = await harness.terminal.snapshot()
    assertScrolled(before)
    appendUser(harness.session, 'streamed question')
    appendAssistant(harness.session, [{ type: 'text', text: 'streamed answer\nline two' }])
    // The append guard skips the frame (nothing visible changes), so there is
    // no synchronized frame to await; give the guarded render time to run.
    await new Promise(resolve => setTimeout(resolve, 50))
    const after = await harness.terminal.snapshot()
    expect(after, 'viewport must not move while the user is reading').toBe(before)
    await dispose(harness)
  })

  it('an inline question dialog snaps the viewport back so it stays visible', async () => {
    const harness = await setupScrolled()
    await scrollToTop(harness)
    assertScrolled(await harness.terminal.snapshot())
    const controller = new AbortController()
    const beforeQuestion = harness.terminal.frames
    const answer = harness.ctx.userQuestions.ask({
      questions: [{
        id: 'confirm',
        header: 'Confirm',
        question: 'Continue with this change?',
        options: [{ label: 'Proceed', description: 'Apply the proposed change' }],
      }],
      signal: controller.signal,
    })
    const rejected = expect(answer).rejects.toMatchObject({ code: 'ASK_ABORTED' })
    await harness.terminal.waitForFrame(beforeQuestion)
    const snapped = await harness.terminal.snapshot()
    assertPinned(snapped)
    expect(viewportTextRows(snapped).join('\n'), 'the dialog must be visible').toContain('Continue with this change?')
    controller.abort()
    await rejected
    await dispose(harness)
  })
})
