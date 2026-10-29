import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PAGE_WHEEL_COOLDOWN_MS,
  PAGE_WHEEL_EDGE_PX,
  PAGE_WHEEL_LINE_PX,
  PAGE_WHEEL_QUIET_MS,
  PAGE_WHEEL_THRESHOLD_PX,
  WheelPageTurnGate,
  type PageWheelInput,
} from '../src/renderer/pageNavigation';

function wheel(now: number, patch: Partial<PageWheelInput> = {}): PageWheelInput {
  return {
    now, deltaX: 0, deltaY: PAGE_WHEEL_THRESHOLD_PX, deltaMode: 0,
    scrollTop: 600, scrollHeight: 1200, clientHeight: 600,
    ready: true, canPrevious: true, canNext: true, ...patch,
  };
}

test('turns forward only after deliberate movement at the bottom edge', () => {
  const gate = new WheelPageTurnGate();
  assert.equal(gate.consume(wheel(0, { deltaY: 20 })), 0);
  assert.equal(gate.consume(wheel(20, { deltaY: 30 })), 0);
  assert.equal(gate.consume(wheel(40, { deltaY: 30 })), 1);
  assert.equal(gate.consume(wheel(60)), 0, 'the remaining gesture must not skip another page');
});

test('scrolling to the edge never turns a page without a fresh gesture', () => {
  const gate = new WheelPageTurnGate();
  assert.equal(gate.consume(wheel(0, { scrollTop: 100 })), 0);
  assert.equal(gate.consume(wheel(100, { scrollTop: 500 })), 0);
  assert.equal(gate.consume(wheel(200)), 0);
  assert.equal(gate.consume(wheel(200 + PAGE_WHEEL_QUIET_MS - 1)), 0);
  assert.equal(gate.consume(wheel(200 + PAGE_WHEEL_QUIET_MS * 2 - 1)), 1);
});

test('a sustained stream of momentum cannot skip pages even after the cooldown expires', () => {
  const gate = new WheelPageTurnGate();
  assert.equal(gate.consume(wheel(0)), 1);
  for (let now = 100; now <= 1000; now += 100) assert.equal(gate.consume(wheel(now)), 0);
  assert.equal(gate.consume(wheel(1000 + PAGE_WHEEL_QUIET_MS)), 1);
});

test('a new gesture within the turn cooldown remains blocked for its full duration', () => {
  const gate = new WheelPageTurnGate();
  assert.equal(gate.consume(wheel(0)), 1);
  assert.equal(gate.consume(wheel(PAGE_WHEEL_QUIET_MS)), 0);
  assert.equal(gate.consume(wheel(PAGE_WHEEL_COOLDOWN_MS)), 0);
  assert.equal(gate.consume(wheel(PAGE_WHEEL_COOLDOWN_MS + PAGE_WHEEL_QUIET_MS)), 1);
});

test('wheel input during rendering cannot turn a page when rendering finishes', () => {
  const gate = new WheelPageTurnGate();
  assert.equal(gate.consume(wheel(0, { ready: false })), 0);
  assert.equal(gate.consume(wheel(100, { ready: false })), 0);
  assert.equal(gate.consume(wheel(200)), 0);
  assert.equal(gate.consume(wheel(200 + PAGE_WHEEL_QUIET_MS)), 1);

  const interrupted = new WheelPageTurnGate();
  assert.equal(interrupted.consume(wheel(0, { deltaY: 40 })), 0);
  assert.equal(interrupted.consume(wheel(20, { ready: false })), 0);
  assert.equal(interrupted.consume(wheel(40)), 0);
});

test('previous-page gestures require the top edge and respect document boundaries', () => {
  for (const canPrevious of [false, true]) {
    const gate = new WheelPageTurnGate();
    assert.equal(gate.consume(wheel(0, { deltaY: -100, scrollTop: 400, canPrevious })), 0);
    assert.equal(gate.consume(wheel(PAGE_WHEEL_QUIET_MS, {
      deltaY: -100, scrollTop: PAGE_WHEEL_EDGE_PX, canPrevious,
    })), canPrevious ? -1 : 0);
  }
  assert.equal(new WheelPageTurnGate().consume(wheel(0, { canNext: false })), 0);
  assert.equal(new WheelPageTurnGate().consume(wheel(0, { scrollTop: 600 - PAGE_WHEEL_EDGE_PX })), 1);
  assert.equal(new WheelPageTurnGate().consume(wheel(0, { scrollTop: 599 - PAGE_WHEEL_EDGE_PX })), 0);
});

test('a page that fits the viewport accepts either direction according to document position', () => {
  assert.equal(new WheelPageTurnGate().consume(wheel(0, { scrollTop: 0, scrollHeight: 600 })), 1);
  assert.equal(new WheelPageTurnGate().consume(wheel(0, { scrollTop: 0, scrollHeight: 600, deltaY: -100 })), -1);
});

test('line and page wheel units contribute equivalent deliberate movement', () => {
  const lines = new WheelPageTurnGate();
  assert.equal(lines.consume(wheel(0, { deltaMode: 1, deltaY: 2 })), 0);
  assert.equal(lines.consume(wheel(20, {
    deltaMode: 1, deltaY: PAGE_WHEEL_THRESHOLD_PX / PAGE_WHEEL_LINE_PX - 2,
  })), 1);
  const pages = new WheelPageTurnGate();
  assert.equal(pages.consume(wheel(0, { deltaMode: 2, deltaY: 0.1 })), 0);
  assert.equal(pages.consume(wheel(20, { deltaMode: 2, deltaY: 0.1 })), 1);
});

test('horizontal gestures, modifiers, and direction reversals cannot re-arm mid-gesture', () => {
  const interruptions: Partial<PageWheelInput>[] = [
    { deltaX: 100, deltaY: 80 }, { deltaX: 80, deltaY: 80 }, { deltaY: 0 },
    { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true },
    { deltaY: -80, scrollTop: 0 }, { scrollTop: 100 },
  ];
  for (const interruption of interruptions) {
    const gate = new WheelPageTurnGate();
    assert.equal(gate.consume(wheel(0, { deltaY: 40 })), 0);
    assert.equal(gate.consume(wheel(20, interruption)), 0, JSON.stringify(interruption));
    assert.equal(gate.consume(wheel(40)), 0, 'a continuation must remain blocked');
    assert.equal(gate.consume(wheel(40 + PAGE_WHEEL_QUIET_MS)), 1);
  }
  assert.equal(new WheelPageTurnGate().consume(wheel(0, { deltaX: 5 })), 1,
    'small trackpad drift should not block a predominantly vertical gesture');
});

test('reset after navigation or layout changes suppresses continuation but preserves cooldown', () => {
  const gate = new WheelPageTurnGate();
  assert.equal(gate.consume(wheel(0)), 1);
  gate.reset(10);
  assert.equal(gate.consume(wheel(20)), 0);
  assert.equal(gate.consume(wheel(20 + PAGE_WHEEL_QUIET_MS)), 0);
  assert.equal(gate.consume(wheel(20 + PAGE_WHEEL_QUIET_MS * 2)), 1);

  const layout = new WheelPageTurnGate();
  assert.equal(layout.consume(wheel(0, { deltaY: 40 })), 0);
  layout.reset(10);
  assert.equal(layout.consume(wheel(20)), 0);
  assert.equal(layout.consume(wheel(20 + PAGE_WHEEL_QUIET_MS)), 1,
    'a layout reset must not invent a successful-turn cooldown');
});

test('invalid inputs do not accumulate or cause turns and valid input can recover', () => {
  const invalid: Partial<PageWheelInput>[] = [
    { deltaX: NaN }, { deltaY: Infinity }, { deltaY: NaN }, { deltaMode: 3 },
    { scrollTop: NaN }, { scrollHeight: Infinity }, { scrollHeight: -1 },
    { clientHeight: 0 }, { clientHeight: -1 }, { clientHeight: NaN },
  ];
  for (const patch of invalid) {
    const gate = new WheelPageTurnGate();
    assert.equal(gate.consume(wheel(0, patch)), 0);
    assert.equal(gate.consume(wheel(20)), 0);
    assert.equal(gate.consume(wheel(20 + PAGE_WHEEL_QUIET_MS)), 1);
  }
  const clock = new WheelPageTurnGate();
  assert.equal(clock.consume(wheel(100, { deltaY: 40 })), 0);
  assert.equal(clock.consume(wheel(NaN)), 0);
  assert.equal(clock.consume(wheel(50)), 0);
  assert.equal(clock.consume(wheel(60)), 0);
  assert.equal(clock.consume(wheel(60 + PAGE_WHEEL_QUIET_MS)), 1);
  assert.equal(new WheelPageTurnGate().consume(wheel(0, { deltaY: Number.MAX_VALUE })), 1);
});

test('forward and reverse turns suppress momentum on the newly landed zoomed page', () => {
  for (const direction of [-1, 1] as const) {
    const gate = new WheelPageTurnGate();
    const deltaY = direction * PAGE_WHEEL_THRESHOLD_PX;
    assert.equal(gate.shouldPreventScroll, false);
    assert.equal(gate.consume(wheel(0, { deltaY, scrollTop: direction === 1 ? 600 : 0 })), direction);
    assert.equal(gate.shouldPreventScroll, true);

    const landing = { deltaY, scrollTop: direction === 1 ? 0 : 600 };
    for (const now of [20, 100, 200, 400, 600]) {
      assert.equal(gate.consume(wheel(now, landing)), 0);
      assert.equal(gate.shouldPreventScroll, true, 'momentum must preserve the landing position');
    }
    assert.equal(gate.consume(wheel(600 + PAGE_WHEEL_QUIET_MS, landing)), 0);
    assert.equal(gate.shouldPreventScroll, false, 'a fresh gesture must scroll within the landed page');
  }
});

test('render resets preserve turned-gesture suppression without extending wheel quiet time', () => {
  for (const direction of [-1, 1] as const) {
    const gate = new WheelPageTurnGate();
    const deltaY = direction * PAGE_WHEEL_THRESHOLD_PX;
    assert.equal(gate.consume(wheel(0, { deltaY, scrollTop: direction === 1 ? 600 : 0 })), direction);
    gate.reset(10);
    assert.equal(gate.consume(wheel(20, { deltaY, ready: false })), 0);
    assert.equal(gate.shouldPreventScroll, true, 'rendering must not release the turned gesture');
    gate.reset(100);
    assert.equal(gate.consume(wheel(120, { deltaY, scrollTop: 300 })), 0);
    assert.equal(gate.shouldPreventScroll, true, 'new geometry must not release the turned gesture');
    gate.reset(120 + PAGE_WHEEL_QUIET_MS - 10);
    assert.equal(gate.consume(wheel(120 + PAGE_WHEEL_QUIET_MS, { deltaY, scrollTop: 300 })), 0);
    assert.equal(gate.shouldPreventScroll, false, 'only wheel activity extends momentum suppression');
  }
});

test('turn suppression never captures modified, horizontal, or invalid wheel events', () => {
  const nativeEvents: Partial<PageWheelInput>[] = [
    { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true },
    { deltaX: 100 }, { deltaY: 0 }, { deltaY: NaN }, { deltaX: Infinity },
    { deltaMode: 3 }, { clientHeight: 0 }, { now: NaN },
  ];
  for (const nativeEvent of nativeEvents) {
    const gate = new WheelPageTurnGate();
    assert.equal(gate.consume(wheel(0)), 1);
    assert.equal(gate.consume(wheel(20, nativeEvent)), 0);
    assert.equal(gate.shouldPreventScroll, false);
    assert.equal(gate.consume(wheel(40, { scrollTop: 100 })), 0);
    assert.equal(gate.shouldPreventScroll, true, 'valid momentum in the turned gesture stays suppressed');
  }
});

test('gestures originating inside the page retain native scrolling through reset and the edge', () => {
  const gate = new WheelPageTurnGate();
  assert.equal(gate.consume(wheel(0, { scrollTop: 100 })), 0);
  assert.equal(gate.shouldPreventScroll, false);
  gate.reset(10);
  assert.equal(gate.consume(wheel(20)), 0);
  assert.equal(gate.shouldPreventScroll, false);
  assert.equal(gate.consume(wheel(20 + PAGE_WHEEL_QUIET_MS)), 1);
  assert.equal(gate.shouldPreventScroll, true);
});
