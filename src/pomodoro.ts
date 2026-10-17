/**
 * In-memory, data-only Pomodoro state. There are no timers, I/O, or device calls.
 * Every phase needs an explicit Start; completion never starts another phase.
 *
 * Integration: create one PomodoroTimer per server process, render view() on
 * GET, and pass { action, expectedRevision: view.revision } to action() on POST.
 * Both methods are synchronous. GET views are pure projections: an expired
 * running phase appears completed with revision + 1, without mutating state.
 * The next action reconciles that same completion before comparing revisions.
 * A stale request therefore cannot restart or reset a newer phase/session.
 */

export const POMODORO_FOCUS_SECONDS = 25 * 60;
export const POMODORO_BREAK_SECONDS = 5 * 60;
export type PomodoroPhase = 'focus' | 'break';
export type PomodoroStatus = 'idle' | 'running' | 'paused' | 'completed';
export type PomodoroAction = 'start' | 'pause' | 'resume' | 'reset';
export type PomodoroConfig = { focusSeconds?: number; breakSeconds?: number };
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
  breakDurationSeconds: number;
  /** Elapsed fraction, bounded to [0, 1]. */
  progress: number;
  revision: number;
  /** The phase following this one, started only by an explicit Start. */
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
function opposite(phase: PomodoroPhase): PomodoroPhase { return phase === 'focus' ? 'break' : 'focus'; }
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
  #monotonicClock: () => number;
  #wallClock: () => number;
  #phase: PomodoroPhase = 'focus';
  #status: PomodoroStatus = 'idle';
  #elapsedMs = 0;
  #runningSince: number | null = null;
  #revision = 0;
  #startedAt: string | null = null;
  #updatedAt: string | null = null;

  constructor(config: PomodoroConfig = {}, dependencies: PomodoroDependencies = {}) {
    this.#focusSeconds = duration(config.focusSeconds, POMODORO_FOCUS_SECONDS);
    this.#breakSeconds = duration(config.breakSeconds, POMODORO_BREAK_SECONDS);
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
    try {
      const now = this.#wallClock();
      return Number.isFinite(now) && Math.abs(now) <= 8_640_000_000_000_000
        ? new Date(now).toISOString() : null;
    } catch { return null; }
  }

  #duration(): number { return this.#phase === 'focus' ? this.#focusSeconds : this.#breakSeconds; }

  #elapsed(now: number): number {
    // Guard a faulty injected clock against negative elapsed time. Normal
    // monotonic time cannot regress when the system's wall clock is adjusted.
    const running = this.#runningSince === null ? 0 : Math.max(0, now - this.#runningSince);
    return Math.min(this.#duration() * 1_000, Math.max(0, this.#elapsedMs + running));
  }

  #project(now: number): PomodoroView {
    const durationSeconds = this.#duration();
    const elapsed = this.#elapsed(now);
    const expired = this.#status === 'running' && elapsed >= durationSeconds * 1_000;
    const status = expired ? 'completed' : this.#status;
    return {
      phase: this.#phase,
      status,
      remainingSeconds: Math.ceil((durationSeconds * 1_000 - elapsed) / 1_000),
      durationSeconds,
      focusDurationSeconds: this.#focusSeconds,
      breakDurationSeconds: this.#breakSeconds,
      progress: elapsed / (durationSeconds * 1_000),
      revision: this.#revision + (expired ? 1 : 0),
      nextPhase: opposite(this.#phase),
      availableActions: available(status),
      startedAt: this.#startedAt,
      updatedAt: this.#updatedAt,
    };
  }

  /** Read-only projection; no state writes, wall-clock reads, or background work. */
  view(): PomodoroView { return this.#project(this.#now()); }

  /** Compare-and-apply one action, returning the authoritative current view. */
  action(request: PomodoroActionRequest): PomodoroActionResult {
    const now = this.#now();
    // Completion is deterministic and is reconciled only on an action. Its
    // revision is identical to the revision already advertised by view().
    if (this.#status === 'running' && this.#elapsed(now) >= this.#duration() * 1_000) {
      this.#elapsedMs = this.#duration() * 1_000;
      this.#runningSince = null;
      this.#status = 'completed';
      this.#revision++;
      this.#updatedAt = this.#timestamp();
    }
    const result = (reason: PomodoroActionReason): PomodoroActionResult => ({
      ok: reason === 'applied', reason, message: MESSAGES[reason], view: this.#project(now),
    });
    if (!validRequest(request)) return result('invalid_request');
    if (request.expectedRevision !== this.#revision) return result('stale_revision');
    if (!available(this.#status).includes(request.action)) return result('invalid_action');

    const timestamp = this.#timestamp();
    switch (request.action) {
      case 'start':
        if (this.#status === 'completed') this.#phase = opposite(this.#phase);
        this.#elapsedMs = 0;
        this.#runningSince = now;
        this.#status = 'running';
        this.#startedAt = timestamp;
        break;
      case 'pause':
        this.#elapsedMs = this.#elapsed(now);
        this.#runningSince = null;
        this.#status = 'paused';
        break;
      case 'resume':
        this.#runningSince = now;
        this.#status = 'running';
        break;
      case 'reset':
        this.#phase = 'focus';
        this.#status = 'idle';
        this.#elapsedMs = 0;
        this.#runningSince = null;
        this.#startedAt = null;
        break;
    }
    this.#updatedAt = timestamp;
    this.#revision++;
    return result('applied');
  }
}
