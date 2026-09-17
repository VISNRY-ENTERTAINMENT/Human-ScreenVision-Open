import fs from 'fs/promises'
import path from 'path'
import { AuditLog } from './AuditLog'
import type { Page } from './Page'
import type { ActionRequest, ActionResult, Observation } from './types'

/**
 * A bounded, recorded, multi-step session.
 *
 * The primitives — observe, act, verify — are good at single steps and say nothing about a
 * sequence. That is precisely where computer-use agents fail. Short benchmark tasks are near
 * solved (~85% on OSWorld), while long-horizon ones sit at 20.6%, and the reported cause is
 * agents **stalling in partial-progress states**, with "more visible monitoring and
 * self-repair" named as the remedy. Both are properties of the environment: an agent cannot
 * notice a stall nobody reports, and cannot repair what nobody recorded.
 *
 * This project's own results point the same way. H12c-2 moved the same model on the same
 * tasks from 2/8 to 8/8 purely by scaling the step budget to the task and preloading context
 * — more than any change to candidate selection achieved.
 *
 * So an episode supplies three things a sequence needs and a step cannot have:
 *
 *  - **a budget**, so a run ends rather than wanders;
 *  - **stall detection**, because two actions in a row that changed nothing is a fact the
 *    environment knows on the step it happens and a screenshot never shows;
 *  - **a ledger** of every step's precondition, declared postcondition, observed effect and
 *    verdict — the trust artifact. The product story for local models was never "more
 *    accurate"; it was gates never breached, a record of every action, and knowing which 5%
 *    to review.
 */

/** One recorded step. */
export interface LedgerEntry {
  index: number
  at: string
  kind: 'action' | 'observation' | 'note'
  /** What was asked for. */
  request?: { do: string; ref?: string; selector?: string; target?: string; value?: string }
  /** Human-readable target description, as resolved. */
  target?: string
  /** Whether the element was actionable, and what blocked it if not. */
  precondition?: { met: boolean; reason?: string }
  /** What the caller declared should happen, before it happened. */
  declared?: Record<string, unknown>
  /** Per-expectation outcome. */
  expectations?: Array<{ expectation: string; met: boolean; detail: string }>
  /** Consequential effects the caller did not declare. */
  undeclared?: Array<{ kind: string; detail: string }>
  verdict?: ActionResult['verdict']
  summary?: string
  durationMs?: number
  /** For an observation step: how much was seen. */
  affordances?: number
  notices?: string[]
}

/** Why an episode stopped accepting steps. */
export type EpisodeStop = 'budget' | 'stalled' | 'closed' | null

export interface EpisodeOptions {
  /** What this episode is trying to achieve, recorded in the ledger. */
  goal: string
  /**
   * How many actions may be taken.
   *
   * Scaled to the task, not to a default: the single largest measured improvement in this
   * project's agentic work came from raising a step budget that was too small for the
   * repository it was pointed at.
   */
  maxSteps?: number
  /**
   * How many consecutive actions that change nothing before the episode declares a stall.
   *
   * Two is deliberate. One no-effect is ordinary — a mis-timed click, a control not ready.
   * Two in a row means the agent's model of the page is wrong, and continuing spends budget
   * on a misunderstanding.
   */
  stallAfter?: number
}

export class Episode {
  private entries: LedgerEntry[] = []
  private consecutiveNoEffect = 0
  private stopped: EpisodeStop = null
  private readonly startedAt = Date.now()
  private readonly auditLog: AuditLog

  /**
   * @param page - Page this episode drives
   * @param options - Goal, step budget and stall threshold
   */
  constructor(
    private page: Page,
    private options: EpisodeOptions
  ) {
    this.auditLog = new AuditLog({ goal: options.goal, startedAt: this.startedAt })
  }

  /** The goal this episode was opened with. */
  get goal(): string {
    return this.options.goal
  }

  /**
   * The tamper-evident audit log for this episode.
   *
   * The ledger is the working record; this is the same run made into an artifact a grader or a
   * reviewer can trust — hash-chained, and emitted as both machine-readable JSONL and a
   * human-readable rendering. Every `act`, `observe` and `note` is appended to it as it
   * happens, in the same order as the ledger.
   */
  get audit(): AuditLog {
    return this.auditLog
  }

  /** Actions taken so far (observations are not charged against the budget). */
  get stepsTaken(): number {
    return this.entries.filter((e) => e.kind === 'action').length
  }

  /** Actions remaining before the budget is exhausted. */
  get stepsRemaining(): number {
    return Math.max(0, (this.options.maxSteps ?? 20) - this.stepsTaken)
  }

  /** Why the episode stopped accepting steps, or null while it is still open. */
  get stoppedBecause(): EpisodeStop {
    return this.stopped
  }

  /** True when consecutive actions have changed nothing. */
  get stalled(): boolean {
    return this.stopped === 'stalled'
  }

  /** Every recorded step, oldest first. */
  get ledger(): readonly LedgerEntry[] {
    return this.entries
  }

  /**
   * Observe the page and record that it was observed.
   *
   * Observations are recorded but not charged against the budget: looking is not acting, and
   * an agent that must ration its looking will act on stale information instead.
   * @param options - Passed to {@link Page.observe}
   * @returns The observation
   */
  async observe(options?: Parameters<Page['observe']>[0]): Promise<Observation> {
    this.assertOpen('observe')
    const view = await this.page.observe(options)
    this.record({
      kind: 'observation',
      affordances: view.affordances.length,
      notices: view.notices,
      summary: `observed ${view.affordances.length} affordance(s)${
        view.truncated > 0 ? `, ${view.truncated} omitted` : ''
      }`,
    })
    this.auditLog.recordObservation(view)
    return view
  }

  /**
   * Take one action, recording everything about it.
   *
   * The budget and the stall check are applied **before** the action, so an episode that has
   * run out of room or lost the thread refuses rather than adds another wrong step to a
   * sequence that is already going nowhere.
   * @param request - The action, ideally with a declared `expect`
   * @returns The action result
   * @throws Error when the budget is exhausted or the episode has stalled
   */
  async act(request: ActionRequest): Promise<ActionResult> {
    this.assertOpen('act')
    if (this.stepsRemaining === 0) {
      this.stopped = 'budget'
      throw new Error(
        `episode "${this.options.goal}" has used its ${this.options.maxSteps ?? 20}-step budget. ` +
          `${this.progressLine()} Raise maxSteps if the task genuinely needs more room — a budget ` +
          `too small for the task is the commonest reason an agent fails one it could do.`
      )
    }

    const result = await this.page.act(request)
    this.record({
      kind: 'action',
      request: {
        do: request.do,
        ref: request.ref,
        selector: request.selector,
        target: request.target,
        value: request.value,
      },
      target: result.target.description,
      precondition: result.precondition,
      declared: request.expect as Record<string, unknown> | undefined,
      expectations: result.expectations,
      undeclared: result.undeclared,
      verdict: result.verdict,
      summary: result.summary,
      durationMs: result.durationMs,
    })
    this.auditLog.recordAction(request, result)

    // A single no-effect is ordinary. Two in a row means the agent's model of the page is
    // wrong, and every further step spends budget on the same misunderstanding.
    if (result.verdict === 'no-effect') {
      this.consecutiveNoEffect += 1
      if (this.consecutiveNoEffect >= (this.options.stallAfter ?? 2)) {
        this.stopped = 'stalled'
      }
    } else {
      this.consecutiveNoEffect = 0
    }
    return result
  }

  /**
   * Record something the caller wants in the ledger that is not an action.
   * @param text - The note
   */
  note(text: string): void {
    this.record({ kind: 'note', summary: text })
    this.auditLog.recordNote(text)
  }

  /**
   * A compact account of what has happened, for a model to read.
   *
   * Deliberately short and specific. An agent re-reading a transcript of its own turns learns
   * nothing it did not already believe; what it needs is the environment's verdict on each
   * step, especially the ones it thinks went well.
   * @returns Plain text
   */
  report(): string {
    const actions = this.entries.filter((e) => e.kind === 'action')
    const confirmed = actions.filter((a) => a.verdict === 'confirmed').length
    const sideEffects = actions.filter((a) => a.verdict === 'side-effects')
    const noEffect = actions.filter((a) => a.verdict === 'no-effect')
    const lines: string[] = [
      `goal: ${this.options.goal}`,
      `steps: ${actions.length} taken, ${this.stepsRemaining} remaining` +
        (this.stopped ? ` (stopped: ${this.stopped})` : ''),
      `confirmed: ${confirmed}, no-effect: ${noEffect.length}, side-effects: ${sideEffects.length}`,
    ]
    if (this.stopped === 'stalled') {
      lines.push(
        `STALLED: the last ${this.consecutiveNoEffect} actions changed nothing. The page is ` +
          `probably not in the state this episode assumes. Observe again before acting.`
      )
    }
    for (const s of sideEffects) {
      lines.push(`  side effect at step ${s.index}: ${(s.undeclared ?? []).map((u) => u.detail).join('; ')}`)
    }
    for (const a of actions) {
      lines.push(`  ${a.index}. [${a.verdict}] ${a.summary ?? ''}`)
    }
    return lines.join('\n')
  }

  /**
   * Write the ledger to disk as JSON.
   * @param destination - File path
   * @returns The absolute path written
   */
  async save(destination: string): Promise<string> {
    const resolved = path.resolve(destination)
    await fs.mkdir(path.dirname(resolved), { recursive: true }).catch(() => undefined)
    const body = {
      goal: this.options.goal,
      startedAt: new Date(this.startedAt).toISOString(),
      durationMs: Date.now() - this.startedAt,
      maxSteps: this.options.maxSteps ?? 20,
      stepsTaken: this.stepsTaken,
      stoppedBecause: this.stopped,
      entries: this.entries,
    }
    await fs.writeFile(resolved, JSON.stringify(body, null, 2), 'utf8')
    return resolved
  }

  /**
   * Write the tamper-evident audit log's two surfaces to disk.
   *
   * Given `runs/pay-invoice`, writes `runs/pay-invoice.jsonl` (one action per line, for a
   * grader) and `runs/pay-invoice.md` (the same facts, for a reviewer). Both carry the hash
   * chain, so either can be checked with {@link AuditLog.verify}.
   * @param basePath - Destination path without extension
   * @returns The two absolute paths written
   */
  async saveAudit(basePath: string): Promise<{ jsonl: string; markdown: string }> {
    return this.auditLog.save(basePath)
  }

  /** Close the episode; further steps are refused. */
  close(): void {
    if (this.stopped === null) this.stopped = 'closed'
  }

  /**
   * Refuse to continue an episode that has already ended.
   * @param what - The operation being attempted
   */
  private assertOpen(what: string): void {
    if (this.stopped === 'stalled') {
      throw new Error(
        `episode "${this.options.goal}" has stalled: ${this.consecutiveNoEffect} consecutive ` +
          `actions changed nothing, so the page is not in the state this episode assumes. ` +
          `${this.progressLine()} Observe again and open a new episode rather than spending the ` +
          `rest of the budget on the same misunderstanding.`
      )
    }
    if (this.stopped === 'budget') {
      throw new Error(`episode "${this.options.goal}" has used its step budget (${what}).`)
    }
    if (this.stopped === 'closed') {
      throw new Error(`episode "${this.options.goal}" is closed (${what}).`)
    }
  }

  /** One line naming what actually got done, for an error message. */
  private progressLine(): string {
    const actions = this.entries.filter((e) => e.kind === 'action')
    const confirmed = actions.filter((a) => a.verdict === 'confirmed').length
    return `${confirmed} of ${actions.length} action(s) were confirmed.`
  }

  /**
   * Append to the ledger.
   * @param entry - Everything but the index and timestamp
   */
  private record(entry: Omit<LedgerEntry, 'index' | 'at'>): void {
    this.entries.push({ index: this.entries.length + 1, at: new Date().toISOString(), ...entry })
  }
}
