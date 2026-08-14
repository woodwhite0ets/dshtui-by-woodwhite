/**
 * Scrollback controller: PgUp/PgDn navigation into a pi-tui render's history.
 * The viewport pins to the live bottom until the user scrolls up; a hint line
 * composites at the window bottom while scrolled, and any key snaps back.
 * @module @woodwhite0ets/dsh-tui/scrollback
 */

import type { Component, OverlayHandle, TUI } from '@earendil-works/pi-tui'

/** The one line shown at the bottom of the viewport while scrolled. */
const HINT_TEXT = '↑ history · PgUp/PgDn · any key returns'

/** Minimal passive overlay painting the scrolled hint into the viewport. */
class ScrollHint implements Component {
  constructor(
    private readonly deps: ScrollbackDeps,
    private readonly line: string,
  ) {}

  render(width: number): string[] {
    if (this.line.length >= width) return [this.deps.dim(this.line.slice(0, Math.max(0, width)))]
    const padding = Math.floor((width - this.line.length) / 2)
    const right = width - this.line.length - padding
    return [this.deps.dim(`${' '.repeat(padding)}${this.line}${' '.repeat(right)}`)]
  }

  invalidate(): void {}
}

export interface ScrollbackDeps {
  /** The pi-tui instance whose viewport scrolls. */
  tui: TUI
  /** Current terminal row count; half of it is the page size. */
  viewportRows: () => number
  /** Dim tone for the hint line. */
  dim: (text: string) => string
  /** Escape text at the terminal display boundary. */
  display: (text: string) => string
}

export interface ScrollbackController {
  /** Whether the viewport is scrolled into history (offset above the bottom). */
  isScrolled(): boolean
  /** Scroll one page (half the viewport) toward older content. */
  pageUp(): void
  /** Scroll one page toward the live bottom; no-op at the bottom. */
  pageDown(): void
  /** Return to the live bottom; no-op when already there. */
  snapToBottom(): void
  /** Remove the hint overlay and release the scroll state. */
  dispose(): void
}

/**
 * Drive one pi-tui viewport's scroll offset and its scrolled hint overlay.
 * The offset lives in pi-tui (which clamps it to the rendered buffer each
 * frame); the controller reads it back, so a buffer shrink while scrolled
 * (e.g. a /clear) reconciles on the next key without stale local state. The
 * hint is a single overlay mounted for the controller's lifetime, gated by a
 * per-frame `visible` callback so it can never outlive the offset that shows
 * it.
 * @param deps - TUI, viewport, and display dependencies.
 * @returns The scrollback controller bound to `deps.tui`.
 */
export function createScrollbackController(deps: ScrollbackDeps): ScrollbackController {
  const pageSize = (): number => Math.max(1, Math.floor(deps.viewportRows() / 2))
  const hintLine = deps.display(HINT_TEXT)
  const hint: OverlayHandle = deps.tui.showOverlay(new ScrollHint(deps, hintLine), {
    width: '100%',
    row: '100%',
    anchor: 'bottom-center',
    nonCapturing: true,
    visible: () => deps.tui.getScrollOffset() > 0,
  })
  return {
    isScrolled: () => deps.tui.getScrollOffset() > 0,
    pageUp() {
      deps.tui.setScrollOffset(deps.tui.getScrollOffset() + pageSize())
    },
    pageDown() {
      deps.tui.setScrollOffset(deps.tui.getScrollOffset() - pageSize())
    },
    snapToBottom() {
      deps.tui.setScrollOffset(0)
    },
    dispose() {
      hint.hide()
    },
  }
}
