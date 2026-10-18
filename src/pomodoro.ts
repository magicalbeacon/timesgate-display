/**
 * In-memory, data-only Pomodoro state. There are no timers, I/O, or device calls.
 * Focus always starts manually. A finished focus automatically starts a short
 * break, or a long break after every fourth focus. A finished break waits.
 *
 * Integration: create one PomodoroTimer per server process, render view() on
 * GET, and pass { action, expectedRevision: view.revision } to action() on POST.
 * Both methods are synchronous. GET views are pure projections: transitions
 * advance the projected revision without mutating state. The next action
 * reconciles exactly those transitions before comparing revisions. Late polls
 * account for break time since the focus deadline, never start another focus,
 * and count each completed focus exactly once.
 */

export const POMODORO_FOCUS_SECONDS = 25 * 60;
export const POMODORO_BREAK_SECONDS = 5 * 60;
export const POMODORO_LONG_BREAK_SECONDS = 15 * 60;
export type PomodoroPhase = 'focus' | 'break';
export type PomodoroStatus = 'idle' | 'running' | 'paused' | 'completed';
export type PomodoroAction = 'start' | 'pause' | 'resume' | 'reset';
export type PomodoroBreakKind = 'short' | 'long';
export type PomodoroConfig = { focusSeconds?: number; breakSeconds?: number; longBreakSeconds?: number };
export type PomodoroDependencies = {
  /** Monotonic milliseconds, normally performance.now(). Never use Date.now(). */
  monotonicClock?: () => number;
  /** Unix milliseconds used only for display metadata; never elapsed time. */
  wallClock?: () => number;
};
export type PomodoroActionRequest = { action: PomodoroAction; expectedRevision: number };
export type PomodoroView = {
  phase: PomodoroPhase;
  status: PomodoroStatus;
  remainingSeconds: number;
  durationSeconds: number;
  focusDurationSeconds: number;
  /** The configured short-break duration, even during a long break. */
  breakDurationSeconds: number;
  longBreakDurationSeconds: number;
  /** Total completed focus sessions since reset (or process restart). */
  completedFocusSessions: number;
  /** 1–4 for the current focus or the focus associated with this break. */
  focusSessionInCycle: number;
  breakKind: PomodoroBreakKind | null;
  /** Elapsed fraction, bounded to [0, 1]. */
  progress: number;
  revision: number;
  /** Break starts automatically; the following focus requires Start. */
  nextPhase: PomodoroPhase;
  availableActions: PomodoroAction[];
  /** Wall-clock display metadata, never a countdown deadline. */
  startedAt: string | null;
  /** Last accepted action/reconciled completion; GET never changes this. */
  updatedAt: string | null;
};
export type PomodoroActionReason = 'applied' | 'invalid_request' | 'stale_revision' | 'invalid_action';
export type PomodoroActionResult = {
  ok: boolean;
  reason: PomodoroActionReason;
  /** Fixed, safe text. Never includes untrusted input or clock exception text. */
  message: string;
  view: PomodoroView;
};

type PomodoroState = {
  phase: PomodoroPhase;
  status: PomodoroStatus;
  elapsedMs: number;
  runningSince: number | null;
  /** Display-only wall-clock anchor paired with runningSince. */
  runningStartedAt: string | null;
  completedFocusSessions: number;
  revision: number;
  startedAt: string | null;
  updatedAt: string | null;
};

const MESSAGES: Record<PomodoroActionReason, string> = {
  applied: 'Pomodoro updated.',
  invalid_request: 'Provide a supported Pomodoro action and a non-negative integer revision.',
  stale_revision: 'The Pomodoro changed. Refresh its state before trying again.',
  invalid_action: 'That action is not available in the current Pomodoro state.',
};
const ACTIONS: readonly PomodoroAction[] = ['start', 'pause', 'resume', 'reset'];

function duration(value: number | undefined, fallback: number): number {
  const seconds = value ?? fallback;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86_400) {
    throw new Error('Pomodoro duration must be an integer from 1 to 86400 seconds.');
  }
  return seconds;
}
function timestamp(milliseconds: number): string | null {
  return Number.isFinite(milliseconds) && Math.abs(milliseconds) <= 8_640_000_000_000_000
    ? new Date(milliseconds).toISOString() : null;
}
function available(status: PomodoroStatus): PomodoroAction[] {
  if (status === 'running') return ['pause', 'reset'];
  if (status === 'paused') return ['resume', 'reset'];
  return ['start', 'reset'];
}
function validRequest(value: unknown): value is PomodoroActionRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return Object.hasOwn(request, 'action') && Object.hasOwn(request, 'expectedRevision')
    && typeof request.action === 'string' && ACTIONS.includes(request.action as PomodoroAction)
    && Number.isSafeInteger(request.expectedRevision) && (request.expectedRevision as number) >= 0;
}

export class PomodoroTimer {
  #focusSeconds: number;
  #breakSeconds: number;
  #longBreakSeconds: number;
  #monotonicClock: () => number;
  #wallClock: () => number;
  #state: PomodoroState = {
    phase: 'focus', status: 'idle', elapsedMs: 0, runningSince: null, runningStartedAt: null,
    completedFocusSessions: 0, revision: 0, startedAt: null, updatedAt: null,
  };

  constructor(config: PomodoroConfig = {}, dependencies: PomodoroDependencies = {}) {
    this.#focusSeconds = duration(config.focusSeconds, POMODORO_FOCUS_SECONDS);
    this.#breakSeconds = duration(config.breakSeconds, POMODORO_BREAK_SECONDS);
    this.#longBreakSeconds = duration(config.longBreakSeconds, POMODORO_LONG_BREAK_SECONDS);
    this.#monotonicClock = dependencies.monotonicClock ?? (() => performance.now());
    this.#wallClock = dependencies.wallClock ?? (() => Date.now());
  }

  #now(): number {
    let now: number;
    try { now = this.#monotonicClock(); }
    catch { throw new Error('Pomodoro monotonic clock is unavailable.'); }
    if (!Number.isFinite(now) || now < 0 || now > Number.MAX_SAFE_INTEGER) {
      throw new Error('Pomodoro monotonic clock is unavailable.');
    }
    return now;
  }

  #timestamp(): string | null {
    // A broken/adjusted wall clock must never stop or alter the countdown.
    try { return timestamp(this.#wallClock()); }
    catch { return null; }
  }

  #breakKind(state: PomodoroState): PomodoroBreakKind | null {
    if (state.phase === 'focus') return null;
    return state.completedFocusSessions % 4 === 0 ? 'long' : 'short';
  }

  #duration(state: PomodoroState): number {
    if (state.phase === 'focus') return this.#focusSeconds;
    return this.#breakKind(state) === 'long' ? this.#longBreakSeconds : this.#breakSeconds;
  }

  #elapsed(state: PomodoroState, now: number): number {
    // Guard a faulty injected clock against negative elapsed time. Normal
    // monotonic time cannot regress when the system's wall clock is adjusted.
    const running = state.runningSince === null ? 0 : Math.max(0, now - state.runningSince);
    return Math.min(this.#duration(state) * 1_000, Math.max(0, state.elapsedMs + running));
  }

  #projectState(now: number): PomodoroState {
    const state = { ...this.#state };
    if (state.status !== 'running') return state;

    if (state.phase === 'focus' && this.#elapsed(state, now) >= this.#focusSeconds * 1_000) {
      const remainingAtStart = this.#focusSeconds * 1_000 - state.elapsedMs;
      // Anchor the automatic break to the actual focus deadline, not this
      // poll/action. A focus may have been paused and resumed several times.
      const deadline = state.runningSince! + remainingAtStart;
      const startedAt = state.runningStartedAt === null ? null
        : timestamp(Date.parse(state.runningStartedAt) + remainingAtStart);
      state.phase = 'break';
      state.completedFocusSessions++;
      state.elapsedMs = 0;
      state.runningSince = deadline;
      state.runningStartedAt = startedAt;
      state.startedAt = startedAt;
      state.revision++;
    }

    // At most two transitions are possible: focus -> break -> completed break.
    // In particular, late polling can never start an unattended focus session.
    const durationMs = this.#duration(state) * 1_000;
    if (state.phase === 'break' && this.#elapsed(state, now) >= durationMs) {
      state.elapsedMs = durationMs;
      state.runningSince = null;
      state.runningStartedAt = null;
      state.status = 'completed';
      state.revision++;
    }
    return state;
  }

  #project(now: number): PomodoroView {
    const state = this.#projectState(now);
    const durationSeconds = this.#duration(state);
    const elapsed = this.#elapsed(state, now);
    return {
      phase: state.phase,
      status: state.status,
      remainingSeconds: Math.ceil((durationSeconds * 1_000 - elapsed) / 1_000),
      durationSeconds,
      focusDurationSeconds: this.#focusSeconds,
      breakDurationSeconds: this.#breakSeconds,
      longBreakDurationSeconds: this.#longBreakSeconds,
      completedFocusSessions: state.completedFocusSessions,
      focusSessionInCycle: ((state.completedFocusSessions - (state.phase === 'break' ? 1 : 0)) % 4) + 1,
      breakKind: this.#breakKind(state),
      progress: elapsed / (durationSeconds * 1_000),
      revision: state.revision,
      nextPhase: state.phase === 'focus' ? 'break' : 'focus',
      availableActions: available(state.status),
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
    };
  }

  /** Read-only projection; no state writes, wall-clock reads, or background work. */
  view(): PomodoroView { return this.#project(this.#now()); }

  /** Compare-and-apply one action, returning the authoritative current view. */
  action(request: PomodoroActionRequest): PomodoroActionResult {
    const now = this.#now();
    // Reconcile the same deterministic transitions/revision advertised by GET.
    // Even a stale action cannot count a focus twice or extend its break.
    const projected = this.#projectState(now);
    if (projected.revision !== this.#state.revision) {
      this.#state = projected;
      this.#state.updatedAt = this.#timestamp();
    }
    const result = (reason: PomodoroActionReason): PomodoroActionResult => ({
      ok: reason === 'applied', reason, message: MESSAGES[reason], view: this.#project(now),
    });
    if (!validRequest(request)) return result('invalid_request');
    if (request.expectedRevision !== this.#state.revision) return result('stale_revision');
    if (!available(this.#state.status).includes(request.action)) return result('invalid_action');

    const timestamp = this.#timestamp();
    const state = this.#state;
    switch (request.action) {
      case 'start':
        // The only manually started phase is focus, including after any break.
        state.phase = 'focus';
        state.elapsedMs = 0;
        state.runningSince = now;
        state.runningStartedAt = timestamp;
        state.status = 'running';
        state.startedAt = timestamp;
        break;
      case 'pause':
        state.elapsedMs = this.#elapsed(state, now);
        state.runningSince = null;
        state.runningStartedAt = null;
        state.status = 'paused';
        break;
      case 'resume':
        state.runningSince = now;
        state.runningStartedAt = timestamp;
        state.status = 'running';
        break;
      case 'reset':
        state.phase = 'focus';
        state.status = 'idle';
        state.elapsedMs = 0;
        state.runningSince = null;
        state.runningStartedAt = null;
        state.completedFocusSessions = 0;
        state.startedAt = null;
        break;
    }
    state.updatedAt = timestamp;
    state.revision++;
    return result('applied');
  }
}
