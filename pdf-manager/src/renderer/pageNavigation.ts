export const PAGE_WHEEL_QUIET_MS = 250;
export const PAGE_WHEEL_COOLDOWN_MS = 350;
export const PAGE_WHEEL_THRESHOLD_PX = 80;
export const PAGE_WHEEL_EDGE_PX = 2;
export const PAGE_WHEEL_LINE_PX = 16;

export type PageTurn = -1 | 0 | 1;

export interface PageWheelInput {
  /** A monotonic timestamp, such as performance.now(). */
  now: number;
  deltaX: number;
  deltaY: number;
  /** DOM_DELTA_PIXEL (0), DOM_DELTA_LINE (1), or DOM_DELTA_PAGE (2). */
  deltaMode: number;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  ready: boolean;
  canPrevious: boolean;
  canNext: boolean;
}

/**
 * Recognizes deliberate wheel gestures that start at a page boundary. A gesture
 * used to scroll within a page stays native even after it reaches the boundary.
 */
export class WheelPageTurnGate {
  private lastEventAt: number | null = null;
  private lastWheelAt: number | null = null;
  private lastTurnAt: number | null = null;
  private direction: PageTurn = 0;
  private accumulated = 0;
  private eligible = false;
  private turnedGesture = false;
  private preventScroll = false;

  /**
   * Whether the latest consumed wheel event should have preventDefault() called.
   * This includes the turn itself and its remaining vertical momentum, so the
   * newly displayed page stays at its landing position. Read after consume().
   */
  get shouldPreventScroll(): boolean {
    return this.preventScroll;
  }

  /**
   * Suppress new turns from an interrupted gesture until it has been quiet again.
   * Preserve suppression of a turned gesture across render/layout restarts;
   * only actual wheel activity extends that gesture's scroll suppression.
   */
  reset(now: number): void {
    this.disarm();
    if (Number.isFinite(now) && now >= 0) this.lastEventAt = now;
  }

  consume(input: PageWheelInput): PageTurn {
    this.preventScroll = false;
    const { now } = input;
    if (!Number.isFinite(now) || now < 0) {
      this.disarm();
      return 0;
    }

    const elapsed = this.lastEventAt === null ? Infinity : now - this.lastEventAt;
    const wheelElapsed = this.lastWheelAt === null ? Infinity : now - this.lastWheelAt;
    this.lastEventAt = now;
    this.lastWheelAt = now;
    if (elapsed < 0 || wheelElapsed < 0) {
      this.disarm();
      return 0;
    }

    const direction = this.validDirection(input);
    if (wheelElapsed >= PAGE_WHEEL_QUIET_MS) this.turnedGesture = false;
    if (elapsed >= PAGE_WHEEL_QUIET_MS) {
      this.disarm();
      this.direction = direction;
      this.eligible = direction !== 0
        && input.ready
        && this.atBoundary(input, direction)
        && (this.lastTurnAt === null || now - this.lastTurnAt >= PAGE_WHEEL_COOLDOWN_MS);
    }

    if (this.turnedGesture) {
      this.preventScroll = direction !== 0;
      this.disarm();
      return 0;
    }

    // Invalidate the whole gesture if rendering interrupts it, its direction
    // changes, or it moves away from the boundary. Momentum cannot re-arm it.
    if (!this.eligible || direction === 0 || direction !== this.direction
      || !input.ready || !this.atBoundary(input, direction)) {
      this.disarm();
      return 0;
    }

    const unit = input.deltaMode === 1 ? PAGE_WHEEL_LINE_PX
      : input.deltaMode === 2 ? input.clientHeight : 1;
    // Saturate before multiplication so even very large finite input is safe.
    const distance = Math.min(Math.abs(input.deltaY), PAGE_WHEEL_THRESHOLD_PX / unit) * unit;
    this.accumulated = Math.min(PAGE_WHEEL_THRESHOLD_PX, this.accumulated + distance);
    if (this.accumulated < PAGE_WHEEL_THRESHOLD_PX) return 0;

    this.lastTurnAt = now;
    this.turnedGesture = true;
    this.preventScroll = true;
    this.disarm();
    return direction;
  }

  private disarm(): void {
    this.direction = 0;
    this.accumulated = 0;
    this.eligible = false;
  }

  private validDirection(input: PageWheelInput): PageTurn {
    if (!Number.isFinite(input.deltaX) || !Number.isFinite(input.deltaY)
      || input.deltaY === 0 || Math.abs(input.deltaX) >= Math.abs(input.deltaY)
      || ![0, 1, 2].includes(input.deltaMode)
      || input.ctrlKey || input.metaKey || input.altKey || input.shiftKey
      || !Number.isFinite(input.scrollTop) || !Number.isFinite(input.scrollHeight)
      || !Number.isFinite(input.clientHeight) || input.scrollHeight < 0 || input.clientHeight <= 0) {
      return 0;
    }
    return input.deltaY > 0 ? 1 : -1;
  }

  private atBoundary(input: PageWheelInput, direction: PageTurn): boolean {
    const maximum = Math.max(0, input.scrollHeight - input.clientHeight);
    if (direction === -1) return input.canPrevious && input.scrollTop <= PAGE_WHEEL_EDGE_PX;
    return input.canNext && input.scrollTop >= maximum - PAGE_WHEEL_EDGE_PX;
  }
}
