import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PomodoroTimer, POMODORO_FOCUS_SECONDS, POMODORO_BREAK_SECONDS,
  type PomodoroAction, type PomodoroActionRequest, type PomodoroConfig, type PomodoroView,
} from '../src/pomodoro.ts';

const WALL = Date.parse('2026-10-17T13:00:00.000Z');
function fixture(config: PomodoroConfig = {}) {
  let monotonic = 10_000;
  let wall = WALL;
  let wallReads = 0;
  const timer = new PomodoroTimer(config, {
    monotonicClock: () => monotonic,
    wallClock: () => { wallReads++; return wall; },
  });
  return {
    timer,
    advance: (milliseconds: number) => { monotonic += milliseconds; wall += milliseconds; },
    setMonotonic: (milliseconds: number) => { monotonic = milliseconds; },
    setWall: (milliseconds: number) => { wall = milliseconds; },
    wallReads: () => wallReads,
    act: (action: PomodoroAction) => timer.action({ action, expectedRevision: timer.view().revision }),
  };
}
function bounded(view: PomodoroView) {
  assert.ok(Number.isSafeInteger(view.remainingSeconds));
  assert.ok(view.remainingSeconds >= 0 && view.remainingSeconds <= view.durationSeconds);
  assert.ok(Number.isFinite(view.progress) && view.progress >= 0 && view.progress <= 1);
  assert.ok(Number.isSafeInteger(view.revision) && view.revision >= 0);
}

test('initial focus is idle for 25 minutes; construction and GET views never start it', () => {
  const f = fixture();
  assert.equal(POMODORO_FOCUS_SECONDS, 1_500);
  assert.equal(POMODORO_BREAK_SECONDS, 300);
  const initial = f.timer.view();
  assert.deepEqual(initial, {
    phase: 'focus', status: 'idle', remainingSeconds: 1_500, durationSeconds: 1_500,
    focusDurationSeconds: 1_500, breakDurationSeconds: 300, progress: 0, revision: 0,
    nextPhase: 'break', availableActions: ['start', 'reset'], startedAt: null, updatedAt: null,
  });
  f.advance(7 * 86_400_000);
  for (let i = 0; i < 100; i++) assert.deepEqual(f.timer.view(), initial);
  assert.equal(f.wallReads(), 0);
});

test('pause/resume preserves subsecond elapsed time and excludes paused time', () => {
  const f = fixture();
  const started = f.act('start');
  assert.equal(started.ok, true); assert.equal(started.view.revision, 1);
  assert.equal(started.view.startedAt, new Date(WALL).toISOString());
  assert.deepEqual(started.view.availableActions, ['pause', 'reset']);
  f.advance(90_250);
  const paused = f.act('pause');
  assert.equal(paused.view.status, 'paused'); assert.equal(paused.view.remainingSeconds, 1_410);
  assert.equal(paused.view.progress, 90_250 / 1_500_000);
  assert.deepEqual(paused.view.availableActions, ['resume', 'reset']);
  f.advance(3_600_000);
  assert.deepEqual(f.timer.view(), paused.view);
  const resumed = f.act('resume');
  assert.equal(resumed.view.status, 'running'); assert.equal(resumed.view.revision, 3);
  assert.equal(resumed.view.startedAt, started.view.startedAt);
  f.advance(750);
  assert.equal(f.timer.view().remainingSeconds, 1_409);
  assert.equal(f.timer.view().progress, 91_000 / 1_500_000);
});

test('25-minute focus completes exactly at zero and waits for a manual five-minute break', () => {
  const f = fixture(); f.act('start');
  f.advance(1_499_999);
  assert.equal(f.timer.view().status, 'running'); assert.equal(f.timer.view().remainingSeconds, 1);
  f.advance(1);
  const completed = f.timer.view();
  assert.equal(completed.status, 'completed'); assert.equal(completed.phase, 'focus');
  assert.equal(completed.remainingSeconds, 0); assert.equal(completed.progress, 1);
  assert.equal(completed.revision, 2);
  assert.deepEqual(completed.availableActions, ['start', 'reset']);
  const reads = f.wallReads();
  f.advance(86_400_000);
  for (let i = 0; i < 100; i++) assert.deepEqual(f.timer.view(), completed);
  assert.equal(f.wallReads(), reads);
  const startedBreak = f.timer.action({ action: 'start', expectedRevision: completed.revision });
  assert.equal(startedBreak.ok, true); assert.equal(startedBreak.view.revision, 3);
  assert.equal(startedBreak.view.phase, 'break'); assert.equal(startedBreak.view.durationSeconds, 300);
  assert.equal(startedBreak.view.remainingSeconds, 300); assert.equal(startedBreak.view.progress, 0);
  f.advance(299_999);
  assert.equal(f.timer.view().status, 'running'); assert.equal(f.timer.view().remainingSeconds, 1);
  f.advance(1);
  assert.equal(f.timer.view().status, 'completed'); assert.equal(f.timer.view().phase, 'break');
  f.advance(86_400_000);
  assert.equal(f.timer.view().phase, 'break'); assert.equal(f.timer.view().remainingSeconds, 0);
  const nextFocus = f.act('start');
  assert.equal(nextFocus.view.phase, 'focus'); assert.equal(nextFocus.view.status, 'running');
  assert.equal(nextFocus.view.remainingSeconds, 1_500); assert.equal(nextFocus.view.revision, 5);
});

test('expiry is reconciled on an action and an old pre-expiry revision cannot pause or reset it', () => {
  for (const action of ['pause', 'reset', 'start'] as const) {
    const f = fixture(); const running = f.act('start').view;
    f.advance(1_500_000);
    const rejected = f.timer.action({ action, expectedRevision: running.revision });
    assert.equal(rejected.ok, false); assert.equal(rejected.reason, 'stale_revision');
    assert.equal(rejected.view.status, 'completed'); assert.equal(rejected.view.phase, 'focus');
    assert.equal(rejected.view.revision, 2); assert.equal(rejected.view.remainingSeconds, 0);
    assert.deepEqual(f.timer.view(), rejected.view);
    assert.equal(f.timer.action({ action: 'start', expectedRevision: rejected.view.revision }).ok, true);
  }
});

test('reset returns every state and phase to idle focus with a fresh revision', () => {
  for (const state of ['idle', 'running', 'paused', 'completed', 'break'] as const) {
    const f = fixture();
    if (state !== 'idle') f.act('start');
    if (state === 'paused') { f.advance(10_000); f.act('pause'); }
    if (state === 'completed' || state === 'break') f.advance(1_500_000);
    if (state === 'break') f.act('start');
    const previous = f.timer.view(); const reset = f.act('reset');
    assert.equal(reset.ok, true); assert.equal(reset.view.phase, 'focus');
    assert.equal(reset.view.status, 'idle'); assert.equal(reset.view.remainingSeconds, 1_500);
    assert.equal(reset.view.progress, 0); assert.equal(reset.view.startedAt, null);
    assert.equal(reset.view.revision, previous.revision + 1);
    f.advance(86_400_000); assert.deepEqual(f.timer.view(), reset.view);
  }
});

test('invalid state transitions are safe and do not change the current revision', () => {
  for (const [state, actions] of [
    ['idle', ['pause', 'resume']], ['running', ['start', 'resume']],
    ['paused', ['start', 'pause']], ['completed', ['pause', 'resume']],
  ] as const) {
    const f = fixture();
    if (state !== 'idle') f.act('start');
    if (state === 'paused') f.act('pause');
    if (state === 'completed') {
      f.advance(1_500_000);
      // Reconcile once so this test compares stable metadata, too.
      f.act('pause');
    }
    const before = f.timer.view();
    for (const action of actions) {
      const rejected = f.act(action);
      assert.equal(rejected.ok, false); assert.equal(rejected.reason, 'invalid_action');
      assert.deepEqual(rejected.view, before);
    }
  }
});

test('malformed requests and revisions are rejected without echoing untrusted input', () => {
  const f = fixture(); const initial = f.timer.view();
  for (const request of [
    null, undefined, [], 'start', {}, { action: 'start' }, { expectedRevision: 0 },
    { action: '<script>secret</script>', expectedRevision: 0 },
    ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null].map(expectedRevision => ({ action: 'start', expectedRevision })),
    Object.create({ action: 'start', expectedRevision: 0 }),
  ]) {
    const rejected = f.timer.action(request as PomodoroActionRequest);
    assert.equal(rejected.ok, false); assert.equal(rejected.reason, 'invalid_request');
    assert.deepEqual(rejected.view, initial); assert.equal(JSON.stringify(rejected).includes('secret'), false);
  }
  assert.equal(f.timer.action({ action: 'start', expectedRevision: 1 }).reason, 'stale_revision');
  assert.deepEqual(f.timer.view(), initial);
});

test('duplicate requests and stale tabs cannot restart, extend, resume, or reset a newer phase', () => {
  const f = fixture();
  const start: PomodoroActionRequest = { action: 'start', expectedRevision: 0 };
  assert.equal(f.timer.action(start).ok, true);
  f.advance(10_000);
  assert.equal(f.timer.action(start).reason, 'stale_revision');
  assert.equal(f.timer.view().remainingSeconds, 1_490);
  const pause: PomodoroActionRequest = { action: 'pause', expectedRevision: f.timer.view().revision };
  assert.equal(f.timer.action(pause).ok, true);
  const resume: PomodoroActionRequest = { action: 'resume', expectedRevision: f.timer.view().revision };
  assert.equal(f.timer.action(resume).ok, true);
  assert.equal(f.timer.action(pause).reason, 'stale_revision');
  assert.equal(f.timer.action(resume).reason, 'stale_revision');
  const reset: PomodoroActionRequest = { action: 'reset', expectedRevision: f.timer.view().revision };
  assert.equal(f.timer.action(reset).ok, true);
  assert.equal(f.act('start').ok, true);
  f.advance(20_000);
  const newer = f.timer.view();
  assert.equal(f.timer.action(reset).reason, 'stale_revision');
  assert.equal(f.timer.action(start).reason, 'stale_revision');
  assert.deepEqual(f.timer.view(), newer);
  f.advance(1_480_000);
  const next: PomodoroActionRequest = { action: 'start', expectedRevision: f.timer.view().revision };
  assert.equal(f.timer.action(next).view.phase, 'break');
  f.advance(30_000);
  assert.equal(f.timer.action(next).reason, 'stale_revision');
  assert.equal(f.timer.view().phase, 'break'); assert.equal(f.timer.view().remainingSeconds, 270);
});

test('two tabs using the same revision accept exactly one action', () => {
  const f = fixture(); f.act('start');
  const revision = f.timer.view().revision;
  assert.equal(f.timer.action({ action: 'pause', expectedRevision: revision }).ok, true);
  assert.equal(f.timer.action({ action: 'reset', expectedRevision: revision }).reason, 'stale_revision');
  assert.equal(f.timer.view().status, 'paused');
});

test('wall-clock adjustments never affect elapsed time, pause, resume, or completion', () => {
  const f = fixture(); f.act('start');
  f.advance(10_000);
  const before = f.timer.view();
  f.setWall(WALL + 10 * 365 * 86_400_000); assert.deepEqual(f.timer.view(), before);
  f.setWall(WALL - 10 * 365 * 86_400_000); assert.deepEqual(f.timer.view(), before);
  const paused = f.act('pause');
  assert.equal(paused.view.remainingSeconds, 1_490);
  assert.equal(paused.view.updatedAt, new Date(WALL - 10 * 365 * 86_400_000).toISOString());
  f.advance(100_000); f.setWall(WALL);
  f.act('resume'); f.advance(1_490_000);
  assert.equal(f.timer.view().status, 'completed'); assert.equal(f.timer.view().remainingSeconds, 0);
});

test('bad wall-clock display metadata does not block controls or fabricate timestamps', () => {
  const f = fixture(); f.setWall(NaN);
  assert.equal(f.act('start').ok, true); assert.equal(f.timer.view().startedAt, null);
  f.advance(1_000); f.setWall(Infinity);
  assert.equal(f.act('pause').ok, true); assert.equal(f.timer.view().remainingSeconds, 1_499);
  assert.equal(f.timer.view().updatedAt, null);
  const throwing = new PomodoroTimer({}, { monotonicClock: () => 0, wallClock: () => { throw new Error('secret'); } });
  assert.equal(throwing.action({ action: 'start', expectedRevision: 0 }).ok, true);
  assert.equal(throwing.view().startedAt, null);
});

test('remaining seconds round up; all states stay bounded even far beyond expiry', () => {
  const f = fixture({ focusSeconds: 2, breakSeconds: 1 }); f.act('start');
  for (const [advance, remaining] of [[0.5, 2], [998.5, 2], [1, 1], [999.5, 1], [0.5, 0], [1e12, 0]]) {
    f.advance(advance); const view = f.timer.view(); bounded(view); assert.equal(view.remainingSeconds, remaining);
  }
  assert.equal(f.timer.view().progress, 1);
  assert.equal(f.act('start').view.remainingSeconds, 1);
  f.advance(1e12); bounded(f.timer.view()); assert.equal(f.timer.view().status, 'completed');
});

test('a regressed injected monotonic clock never produces negative elapsed or excess remaining', () => {
  const f = fixture(); f.act('start');
  f.setMonotonic(0); bounded(f.timer.view());
  assert.equal(f.timer.view().remainingSeconds, 1_500); assert.equal(f.timer.view().progress, 0);
  f.setMonotonic(20_000); f.act('pause');
  f.setMonotonic(30_000); f.act('resume');
  f.setMonotonic(0); bounded(f.timer.view());
  assert.equal(f.timer.view().remainingSeconds, 1_490);
});

test('invalid monotonic clocks fail safely without applying a state transition', () => {
  const f = fixture();
  for (const clock of [NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
    f.setMonotonic(clock);
    assert.throws(() => f.timer.view(), /^Error: Pomodoro monotonic clock is unavailable\.$/);
    assert.throws(() => f.timer.action({ action: 'start', expectedRevision: 0 }), /monotonic clock is unavailable/);
  }
  f.setMonotonic(10_000); assert.equal(f.timer.view().revision, 0); assert.equal(f.timer.view().status, 'idle');
  const throwing = new PomodoroTimer({}, { monotonicClock: () => { throw new Error('private clock details'); } });
  assert.throws(() => throwing.view(), /^Error: Pomodoro monotonic clock is unavailable\.$/);
});

test('duration config is strictly bounded and returned views do not mutate the machine', () => {
  for (const seconds of [0, -1, 0.5, NaN, Infinity, 86_401, '25']) {
    assert.throws(() => new PomodoroTimer({ focusSeconds: seconds as number }), /Pomodoro duration/);
    assert.throws(() => new PomodoroTimer({ breakSeconds: seconds as number }), /Pomodoro duration/);
  }
  const f = fixture({ focusSeconds: 60, breakSeconds: 30 });
  const view = f.timer.view(); view.phase = 'break'; view.revision = 99; view.availableActions.length = 0;
  const actual = f.timer.view();
  assert.equal(actual.phase, 'focus'); assert.equal(actual.revision, 0);
  assert.equal(actual.durationSeconds, 60); assert.equal(actual.breakDurationSeconds, 30);
  assert.deepEqual(actual.availableActions, ['start', 'reset']);
});
