import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PomodoroTimer, POMODORO_FOCUS_SECONDS, POMODORO_BREAK_SECONDS, POMODORO_LONG_BREAK_SECONDS,
  type PomodoroAction, type PomodoroActionRequest, type PomodoroConfig, type PomodoroView,
} from '../src/pomodoro.ts';

const WALL = Date.parse('2026-10-17T13:00:00.000Z');
const FAST = { focusSeconds: 2, breakSeconds: 1, longBreakSeconds: 3 };
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
  assert.ok(Number.isSafeInteger(view.completedFocusSessions) && view.completedFocusSessions >= 0);
  assert.ok(Number.isInteger(view.focusSessionInCycle) && view.focusSessionInCycle >= 1 && view.focusSessionInCycle <= 4);
}
function reachBreak(f: ReturnType<typeof fixture>, session: number) {
  for (let i = 1; i <= session; i++) {
    assert.equal(f.act('start').ok, true);
    f.advance(f.timer.view().focusDurationSeconds * 1_000);
    if (i < session) f.advance(f.timer.view().durationSeconds * 1_000);
  }
  assert.equal(f.timer.view().phase, 'break');
}

test('initial focus is idle for 25 minutes with zero completed sessions; GET never starts it', () => {
  const f = fixture();
  assert.equal(POMODORO_FOCUS_SECONDS, 1_500);
  assert.equal(POMODORO_BREAK_SECONDS, 300);
  assert.equal(POMODORO_LONG_BREAK_SECONDS, 900);
  const initial = f.timer.view();
  assert.deepEqual(initial, {
    phase: 'focus', status: 'idle', remainingSeconds: 1_500, durationSeconds: 1_500,
    focusDurationSeconds: 1_500, breakDurationSeconds: 300, longBreakDurationSeconds: 900,
    completedFocusSessions: 0, focusSessionInCycle: 1, breakKind: null, progress: 0, revision: 0,
    nextPhase: 'break', availableActions: ['start', 'reset'], startedAt: null, updatedAt: null,
  });
  f.advance(7 * 86_400_000);
  for (let i = 0; i < 100; i++) assert.deepEqual(f.timer.view(), initial);
  assert.equal(f.wallReads(), 0);
});

test('focus pause/resume preserves subsecond elapsed time and excludes paused time', () => {
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

test('focus starts a five-minute break at its exact deadline and the next focus waits for Start', () => {
  const f = fixture(); const started = f.act('start').view;
  f.advance(1_499_999);
  assert.equal(f.timer.view().phase, 'focus'); assert.equal(f.timer.view().remainingSeconds, 1);
  assert.equal(f.timer.view().completedFocusSessions, 0);
  f.advance(1);
  const resting = f.timer.view();
  assert.equal(resting.status, 'running'); assert.equal(resting.phase, 'break');
  assert.equal(resting.breakKind, 'short'); assert.equal(resting.durationSeconds, 300);
  assert.equal(resting.remainingSeconds, 300); assert.equal(resting.progress, 0);
  assert.equal(resting.completedFocusSessions, 1); assert.equal(resting.focusSessionInCycle, 1);
  assert.equal(resting.revision, 2); assert.equal(resting.nextPhase, 'focus');
  assert.equal(resting.startedAt, new Date(WALL + 1_500_000).toISOString());
  assert.equal(resting.updatedAt, started.updatedAt);
  assert.deepEqual(resting.availableActions, ['pause', 'reset']);
  f.advance(299_999);
  assert.equal(f.timer.view().status, 'running'); assert.equal(f.timer.view().remainingSeconds, 1);
  f.advance(1);
  const completed = f.timer.view();
  assert.equal(completed.status, 'completed'); assert.equal(completed.phase, 'break');
  assert.equal(completed.remainingSeconds, 0); assert.equal(completed.progress, 1);
  assert.equal(completed.revision, 3); assert.equal(completed.completedFocusSessions, 1);
  assert.deepEqual(completed.availableActions, ['start', 'reset']);
  const reads = f.wallReads();
  f.advance(86_400_000);
  for (let i = 0; i < 100; i++) assert.deepEqual(f.timer.view(), completed);
  assert.equal(f.wallReads(), reads);
  const nextFocus = f.timer.action({ action: 'start', expectedRevision: completed.revision });
  assert.equal(nextFocus.ok, true); assert.equal(nextFocus.view.revision, 4);
  assert.equal(nextFocus.view.phase, 'focus'); assert.equal(nextFocus.view.status, 'running');
  assert.equal(nextFocus.view.remainingSeconds, 1_500); assert.equal(nextFocus.view.breakKind, null);
  assert.equal(nextFocus.view.completedFocusSessions, 1); assert.equal(nextFocus.view.focusSessionInCycle, 2);
});

test('late polling uses the actual focus deadline and consumes already elapsed break time', () => {
  const f = fixture(); const started = f.act('start').view;
  const reads = f.wallReads();
  f.advance(1_620_250);
  const view = f.timer.view();
  assert.equal(view.phase, 'break'); assert.equal(view.status, 'running');
  assert.equal(view.remainingSeconds, 180); assert.equal(view.progress, 120_250 / 300_000);
  assert.equal(view.revision, 2); assert.equal(view.completedFocusSessions, 1);
  assert.equal(view.startedAt, new Date(WALL + 1_500_000).toISOString());
  assert.equal(view.updatedAt, started.updatedAt); assert.equal(f.wallReads(), reads);
  const paused = f.act('pause');
  assert.equal(paused.ok, true); assert.equal(paused.view.progress, view.progress);
  assert.equal(paused.view.revision, 3); assert.equal(paused.view.completedFocusSessions, 1);
  f.advance(10 * 86_400_000);
  assert.deepEqual(f.timer.view(), paused.view);
  f.act('resume'); f.advance(179_749);
  assert.equal(f.timer.view().status, 'running'); assert.equal(f.timer.view().remainingSeconds, 1);
  f.advance(1);
  assert.equal(f.timer.view().status, 'completed'); assert.equal(f.timer.view().revision, 5);
});

test('one very late poll projects both completions once and never starts unattended focus', () => {
  const f = fixture(); f.act('start'); f.advance(365 * 86_400_000);
  const completed = f.timer.view(); bounded(completed);
  assert.equal(completed.phase, 'break'); assert.equal(completed.status, 'completed');
  assert.equal(completed.remainingSeconds, 0); assert.equal(completed.completedFocusSessions, 1);
  assert.equal(completed.revision, 3); assert.equal(completed.focusSessionInCycle, 1);
  for (let i = 0; i < 100; i++) assert.deepEqual(f.timer.view(), completed);
  const next = f.act('start');
  assert.equal(next.ok, true); assert.equal(next.view.phase, 'focus');
  assert.equal(next.view.remainingSeconds, 1_500); assert.equal(next.view.revision, 4);
  assert.equal(next.view.completedFocusSessions, 1); assert.equal(next.view.focusSessionInCycle, 2);
});

test('GET projections never commit transitions, counters, revisions, or display metadata', () => {
  const f = fixture(FAST); const started = f.act('start').view;
  const reads = f.wallReads();
  f.setMonotonic(12_500);
  assert.equal(f.timer.view().phase, 'break'); assert.equal(f.timer.view().completedFocusSessions, 1);
  f.setMonotonic(13_000);
  assert.equal(f.timer.view().status, 'completed'); assert.equal(f.timer.view().revision, 3);
  // A deliberately regressed test clock reveals whether GET wrote internal state.
  f.setMonotonic(10_000);
  assert.deepEqual(f.timer.view(), started); assert.equal(f.wallReads(), reads);
});

test('every fourth focus gets a 15-minute break and subsequent focuses stay manual', () => {
  const f = fixture();
  for (let session = 1; session <= 8; session++) {
    const started = f.act('start');
    assert.equal(started.ok, true); assert.equal(started.view.phase, 'focus');
    assert.equal(started.view.completedFocusSessions, session - 1);
    assert.equal(started.view.focusSessionInCycle, ((session - 1) % 4) + 1);
    assert.equal(started.view.breakKind, null);
    f.advance(1_499_999);
    assert.equal(f.timer.view().completedFocusSessions, session - 1);
    f.advance(1);
    const resting = f.timer.view();
    const duration = session % 4 === 0 ? 900 : 300;
    assert.equal(resting.phase, 'break'); assert.equal(resting.status, 'running');
    assert.equal(resting.durationSeconds, duration); assert.equal(resting.remainingSeconds, duration);
    assert.equal(resting.breakKind, session % 4 === 0 ? 'long' : 'short');
    assert.equal(resting.completedFocusSessions, session);
    assert.equal(resting.focusSessionInCycle, ((session - 1) % 4) + 1);
    assert.equal(resting.breakDurationSeconds, 300); assert.equal(resting.longBreakDurationSeconds, 900);
    f.advance(duration * 1_000 - 1);
    assert.equal(f.timer.view().status, 'running'); assert.equal(f.timer.view().remainingSeconds, 1);
    f.advance(1);
    const completed = f.timer.view();
    assert.equal(completed.status, 'completed'); assert.equal(completed.completedFocusSessions, session);
    f.advance(86_400_000); assert.deepEqual(f.timer.view(), completed);
  }
});

test('late long-break polling preserves the fourth-session duration and manual next focus', () => {
  const f = fixture(FAST); reachBreak(f, 4);
  f.advance(2_250);
  const late = f.timer.view();
  assert.equal(late.breakKind, 'long'); assert.equal(late.remainingSeconds, 1);
  assert.equal(late.progress, 0.75); assert.equal(late.completedFocusSessions, 4);
  f.advance(750);
  assert.equal(f.timer.view().status, 'completed'); assert.equal(f.timer.view().focusSessionInCycle, 4);
  f.advance(100_000); assert.equal(f.timer.view().completedFocusSessions, 4);
  const next = f.act('start').view;
  assert.equal(next.phase, 'focus'); assert.equal(next.focusSessionInCycle, 1);
  assert.equal(next.completedFocusSessions, 4); assert.equal(next.breakKind, null);
});

test('stale pre-focus-deadline requests cannot pause, reset, or restart the automatic break', () => {
  for (const action of ['pause', 'reset', 'start', 'resume'] as const) {
    const f = fixture(); const running = f.act('start').view;
    f.advance(1_500_000);
    const rejected = f.timer.action({ action, expectedRevision: running.revision });
    assert.equal(rejected.ok, false); assert.equal(rejected.reason, 'stale_revision');
    assert.equal(rejected.view.status, 'running'); assert.equal(rejected.view.phase, 'break');
    assert.equal(rejected.view.revision, 2); assert.equal(rejected.view.remainingSeconds, 300);
    assert.equal(rejected.view.completedFocusSessions, 1);
    assert.deepEqual(f.timer.view(), rejected.view);
    assert.equal(f.act('pause').ok, true);
  }
});

test('stale break-deadline requests cannot affect the completed break or following focus', () => {
  for (const action of ['pause', 'reset', 'start', 'resume'] as const) {
    const f = fixture(FAST); reachBreak(f, 1); const resting = f.timer.view();
    f.advance(1_000);
    const rejected = f.timer.action({ action, expectedRevision: resting.revision });
    assert.equal(rejected.reason, 'stale_revision'); assert.equal(rejected.view.status, 'completed');
    assert.equal(rejected.view.revision, 3); assert.equal(rejected.view.completedFocusSessions, 1);
    const next = f.act('start'); assert.equal(next.ok, true); assert.equal(next.view.revision, 4);
    assert.equal(f.timer.action({ action, expectedRevision: resting.revision }).reason, 'stale_revision');
    assert.equal(f.timer.view().phase, 'focus'); assert.equal(f.timer.view().completedFocusSessions, 1);
  }
});

test('repeated GETs and rejected or accepted actions count each focus exactly once', () => {
  const f = fixture(FAST); f.act('start'); f.advance(2_250);
  for (let i = 0; i < 20; i++) {
    assert.equal(f.timer.view().completedFocusSessions, 1);
    const rejected = f.timer.action({ action: 'reset', expectedRevision: 0 });
    assert.equal(rejected.reason, 'stale_revision'); assert.equal(rejected.view.revision, 2);
    assert.equal(rejected.view.completedFocusSessions, 1); assert.equal(rejected.view.remainingSeconds, 1);
  }
  assert.equal(f.act('start').reason, 'invalid_action');
  assert.equal(f.timer.action(null as unknown as PomodoroActionRequest).reason, 'invalid_request');
  assert.equal(f.act('pause').view.completedFocusSessions, 1);
  f.advance(1e6); assert.equal(f.act('resume').view.completedFocusSessions, 1);
  f.advance(750);
  assert.equal(f.act('pause').reason, 'invalid_action');
  for (let i = 0; i < 20; i++) assert.equal(f.timer.view().completedFocusSessions, 1);
  assert.equal(f.act('start').view.completedFocusSessions, 1);
  f.advance(2_000); assert.equal(f.timer.view().completedFocusSessions, 2);
});

test('paused focus deadlines shift correctly and both short and long breaks can pause/resume', () => {
  for (const session of [1, 4]) {
    const f = fixture(FAST);
    if (session > 1) { reachBreak(f, session - 1); f.advance(f.timer.view().durationSeconds * 1_000); }
    f.act('start'); f.advance(1_999.5);
    const pausedFocus = f.act('pause').view;
    assert.equal(pausedFocus.phase, 'focus'); assert.equal(pausedFocus.completedFocusSessions, session - 1);
    f.advance(1_000_000); assert.deepEqual(f.timer.view(), pausedFocus);
    f.act('resume'); f.advance(0.5);
    const resting = f.timer.view();
    assert.equal(resting.phase, 'break'); assert.equal(resting.progress, 0);
    assert.equal(resting.completedFocusSessions, session);
    const durationMs = resting.durationSeconds * 1_000;
    f.advance(durationMs - 0.5);
    const pausedBreak = f.act('pause').view;
    assert.equal(pausedBreak.phase, 'break'); assert.equal(pausedBreak.status, 'paused');
    assert.equal(pausedBreak.remainingSeconds, 1);
    f.advance(1_000_000); assert.deepEqual(f.timer.view(), pausedBreak);
    f.act('resume'); f.advance(0.5);
    assert.equal(f.timer.view().status, 'completed'); assert.equal(f.timer.view().remainingSeconds, 0);
    assert.equal(f.timer.view().completedFocusSessions, session);
  }
});

test('resumed focus starts its automatic break at the resumed deadline, not the first start', () => {
  const f = fixture(FAST); f.act('start'); f.advance(750); f.act('pause');
  f.advance(10_000); f.act('resume'); f.advance(1_500);
  const resting = f.timer.view();
  assert.equal(resting.phase, 'break'); assert.equal(resting.progress, 0.25);
  assert.equal(resting.startedAt, new Date(WALL + 12_000).toISOString());
  assert.equal(resting.completedFocusSessions, 1);
});

test('reset clears the session count and cycle from every focus and short/long break state', () => {
  for (const state of ['idle', 'running', 'paused', 'short-running', 'short-paused', 'short-completed', 'long-running', 'long-paused', 'long-completed', 'next-focus'] as const) {
    const f = fixture(FAST);
    if (state === 'running' || state === 'paused') f.act('start');
    if (state === 'paused') { f.advance(1_000); f.act('pause'); }
    if (state.includes('-') && state !== 'next-focus') {
      reachBreak(f, state.startsWith('long') ? 4 : 1);
      if (state.endsWith('paused')) f.act('pause');
      if (state.endsWith('completed')) f.advance(f.timer.view().durationSeconds * 1_000);
    }
    if (state === 'next-focus') { reachBreak(f, 4); f.advance(3_000); f.act('start'); }
    const previous = f.timer.view(); const reset = f.act('reset');
    assert.equal(reset.ok, true, state); assert.equal(reset.view.phase, 'focus');
    assert.equal(reset.view.status, 'idle'); assert.equal(reset.view.remainingSeconds, 2);
    assert.equal(reset.view.progress, 0); assert.equal(reset.view.startedAt, null);
    assert.equal(reset.view.completedFocusSessions, 0); assert.equal(reset.view.focusSessionInCycle, 1);
    assert.equal(reset.view.breakKind, null); assert.equal(reset.view.revision, previous.revision + 1);
    f.advance(86_400_000); assert.deepEqual(f.timer.view(), reset.view);
    f.act('start'); f.advance(2_000);
    assert.equal(f.timer.view().breakKind, 'short'); assert.equal(f.timer.view().completedFocusSessions, 1);
  }
});

test('a new server timer is idle with zero sessions regardless of the prior timer state', () => {
  const f = fixture(FAST); reachBreak(f, 4);
  assert.equal(f.timer.view().completedFocusSessions, 4); assert.equal(f.timer.view().breakKind, 'long');
  const restarted = fixture(FAST).timer.view();
  assert.equal(restarted.status, 'idle'); assert.equal(restarted.phase, 'focus');
  assert.equal(restarted.completedFocusSessions, 0); assert.equal(restarted.focusSessionInCycle, 1);
  assert.equal(restarted.revision, 0); assert.equal(restarted.breakKind, null);
});

test('invalid state transitions are safe and do not change the current revision', () => {
  for (const [state, actions] of [
    ['idle', ['pause', 'resume']], ['running', ['start', 'resume']],
    ['paused', ['start', 'pause']], ['break-running', ['start', 'resume']],
    ['break-paused', ['start', 'pause']], ['completed', ['pause', 'resume']],
  ] as const) {
    const f = fixture(FAST);
    if (state !== 'idle') f.act('start');
    if (state === 'paused') f.act('pause');
    if (state === 'break-running' || state === 'break-paused' || state === 'completed') f.advance(2_000);
    if (state === 'break-paused') f.act('pause');
    if (state === 'completed') f.advance(1_000);
    // Reconcile once so this test compares stable metadata, too.
    f.timer.action({ action: 'start', expectedRevision: 99 });
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
  f.advance(1_780_000);
  const next: PomodoroActionRequest = { action: 'start', expectedRevision: f.timer.view().revision };
  assert.equal(f.timer.action(next).view.phase, 'focus');
  f.advance(30_000);
  assert.equal(f.timer.action(next).reason, 'stale_revision');
  assert.equal(f.timer.view().phase, 'focus'); assert.equal(f.timer.view().remainingSeconds, 1_470);
  assert.equal(f.timer.view().completedFocusSessions, 1);
});

test('two tabs using the same revision accept exactly one action in focus or automatic break', () => {
  for (const phase of ['focus', 'break']) {
    const f = fixture(FAST); f.act('start');
    if (phase === 'break') f.advance(2_000);
    const revision = f.timer.view().revision;
    assert.equal(f.timer.action({ action: 'pause', expectedRevision: revision }).ok, true);
    assert.equal(f.timer.action({ action: 'reset', expectedRevision: revision }).reason, 'stale_revision');
    assert.equal(f.timer.view().status, 'paused'); assert.equal(f.timer.view().phase, phase);
  }
});

test('wall-clock jumps cannot affect focus, automatic break, pause/resume, or break completion', () => {
  const f = fixture(); f.act('start'); f.advance(10_000);
  const before = f.timer.view();
  f.setWall(WALL + 10 * 365 * 86_400_000); assert.deepEqual(f.timer.view(), before);
  f.setWall(WALL - 10 * 365 * 86_400_000); assert.deepEqual(f.timer.view(), before);
  const paused = f.act('pause');
  assert.equal(paused.view.remainingSeconds, 1_490);
  assert.equal(paused.view.updatedAt, new Date(WALL - 10 * 365 * 86_400_000).toISOString());
  f.advance(100_000); f.setWall(WALL);
  f.act('resume'); f.advance(1_490_000);
  const resting = f.timer.view();
  assert.equal(resting.status, 'running'); assert.equal(resting.phase, 'break');
  assert.equal(resting.remainingSeconds, 300); assert.equal(resting.completedFocusSessions, 1);
  f.setWall(WALL + 10 * 365 * 86_400_000); assert.deepEqual(f.timer.view(), resting);
  f.advance(125_000); f.setWall(WALL - 10 * 365 * 86_400_000);
  assert.equal(f.act('pause').view.remainingSeconds, 175);
  f.advance(1e9); f.setWall(WALL); f.act('resume'); f.advance(175_000);
  assert.equal(f.timer.view().status, 'completed'); assert.equal(f.timer.view().remainingSeconds, 0);
  assert.equal(f.timer.view().completedFocusSessions, 1);
});

test('bad wall-clock metadata cannot block controls or fabricate automatic-break timestamps', () => {
  for (const wall of [NaN, Infinity, 8_640_000_000_000_000]) {
    const f = fixture(FAST); f.setWall(wall);
    assert.equal(f.act('start').ok, true); f.advance(2_000);
    assert.equal(f.timer.view().phase, 'break'); assert.equal(f.timer.view().startedAt, null);
    assert.equal(f.act('pause').ok, true); assert.equal(f.timer.view().remainingSeconds, 1);
    assert.equal(f.timer.view().updatedAt, null);
  }
  let now = 0;
  const throwing = new PomodoroTimer(FAST, {
    monotonicClock: () => now, wallClock: () => { throw new Error('secret'); },
  });
  assert.equal(throwing.action({ action: 'start', expectedRevision: 0 }).ok, true);
  now = 2_500;
  assert.equal(throwing.view().startedAt, null); assert.equal(throwing.view().remainingSeconds, 1);
  assert.equal(throwing.action({ action: 'pause', expectedRevision: 2 }).ok, true);
});

test('remaining seconds round up and both phases stay bounded even far beyond expiry', () => {
  const f = fixture(FAST); f.act('start');
  for (const [advance, phase, remaining] of [
    [0.5, 'focus', 2], [998.5, 'focus', 2], [1, 'focus', 1], [999.5, 'focus', 1],
    [0.5, 'break', 1], [999.5, 'break', 1], [0.5, 'break', 0], [1e12, 'break', 0],
  ] as const) {
    f.advance(advance); const view = f.timer.view(); bounded(view);
    assert.equal(view.remainingSeconds, remaining); assert.equal(view.phase, phase);
  }
  assert.equal(f.timer.view().progress, 1); assert.equal(f.timer.view().completedFocusSessions, 1);
  assert.equal(f.act('start').view.remainingSeconds, 2);
  f.advance(1e12); bounded(f.timer.view()); assert.equal(f.timer.view().status, 'completed');
  assert.equal(f.timer.view().completedFocusSessions, 2);
});

test('a regressed injected monotonic clock never produces negative elapsed or excess remaining', () => {
  const f = fixture(); f.act('start');
  f.setMonotonic(0); bounded(f.timer.view());
  assert.equal(f.timer.view().remainingSeconds, 1_500); assert.equal(f.timer.view().progress, 0);
  f.setMonotonic(20_000); f.act('pause');
  f.setMonotonic(30_000); f.act('resume');
  f.setMonotonic(0); bounded(f.timer.view());
  assert.equal(f.timer.view().remainingSeconds, 1_490);
  f.setMonotonic(1_520_000); f.act('pause'); f.act('resume');
  f.setMonotonic(0); bounded(f.timer.view());
  assert.equal(f.timer.view().phase, 'break'); assert.equal(f.timer.view().completedFocusSessions, 1);
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

test('all duration configs are bounded and returned views do not mutate the timer or counters', () => {
  for (const seconds of [0, -1, 0.5, NaN, Infinity, 86_401, '25']) {
    for (const field of ['focusSeconds', 'breakSeconds', 'longBreakSeconds']) {
      assert.throws(() => new PomodoroTimer({ [field]: seconds }), /Pomodoro duration/);
    }
  }
  const f = fixture({ focusSeconds: 60, breakSeconds: 30, longBreakSeconds: 120 });
  const view = f.timer.view(); view.phase = 'break'; view.revision = 99; view.availableActions.length = 0;
  view.completedFocusSessions = 99; view.focusSessionInCycle = 4; view.breakKind = 'long';
  const actual = f.timer.view();
  assert.equal(actual.phase, 'focus'); assert.equal(actual.revision, 0);
  assert.equal(actual.completedFocusSessions, 0); assert.equal(actual.focusSessionInCycle, 1);
  assert.equal(actual.breakKind, null); assert.equal(actual.longBreakDurationSeconds, 120);
  assert.equal(actual.durationSeconds, 60); assert.equal(actual.breakDurationSeconds, 30);
  assert.deepEqual(actual.availableActions, ['start', 'reset']);
});
