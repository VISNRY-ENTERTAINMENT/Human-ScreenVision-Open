import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import type { ActionRequest, ActionResult, Observation } from './types'

/**
 * An append-only, tamper-evident journal of what a run actually did.
 *
 * The episode ledger already records every step; this is the artifact that makes that record
 * *trustable*. Two properties turn a log into a ledger the harness can score against without a
 * human in the loop:
 *
 *  - **two surfaces, one set of facts.** {@link toJSONL} emits one action per line with a
 *    stable schema, for a grader to parse; {@link toMarkdown} renders the identical facts for
 *    a person to review. Neither is a summary of the other — they are the same entries.
 *  - **a hash chain.** Each entry carries the hash of the entry before it, so a deleted,
 *    reordered or edited step breaks the chain and {@link verify} points at where. A log an
 *    agent could quietly rewrite to hide a step it took is not evidence of anything; this one
 *    cannot lose a step silently.
 *
 * This is the UI-episode analogue of the harness's program transcript: a checkable record of a
 * multi-step task, produced by the environment rather than narrated by the agent. The verdict
 * on each action was proven against a postcondition declared before the action ran, so a
 * grader reads verdicts, not opinions.
 */

/** The schema tag written into every entry, so a reader can refuse a shape it does not know. */
export const AUDIT_SCHEMA_VERSION = 'sv-audit-1'

/** The prev-hash of the first entry: a chain has to start somewhere nameable. */
const GENESIS_HASH = '0'.repeat(64)

/** The measured cost of a step. Duration plus the change-size the library measures anyway. */
export interface AuditCost {
  durationMs: number
  mutations: number
  requests: number
  writeRequests: number
}

/** What the caller asked for, before it happened. */
export interface AuditIntent {
  do: string
  ref?: string
  target?: string
  selector?: string
  value?: string
  expect?: Record<string, unknown>
  confirmed?: boolean
}

/** What actually, measurably changed. A compaction of {@link ActionResult.effects}. */
export interface AuditEffects {
  urlChanged: { from: string; to: string } | null
  titleChanged: { from: string; to: string } | null
  mutations: number
  requests: string[]
  writeRequests: Array<{ method: string; url: string }>
  consoleErrors: string[]
  valueSet: { expected: string; actual: string; matched: boolean } | null
}

/** The declared-vs-undeclared reconciliation, the heart of what makes a verdict trustable. */
export interface AuditReconciliation {
  /** What the caller declared should happen, or null when nothing was declared. */
  declared: Record<string, unknown> | null
  /** Consequential effects the caller did not declare. */
  undeclared: Array<{ kind: string; detail: string }>
  /** True when a declaration was made, it held, and nothing undeclared happened. */
  clean: boolean
}

/** One recorded step, self-describing and chained to the one before it. */
export interface AuditEntry {
  schema: string
  index: number
  at: string
  kind: 'action' | 'observation' | 'note'
  intent?: AuditIntent
  resolvedTarget?: {
    description: string
    selector: string
    ref?: string
    nodeId?: number
    frameId?: string
  }
  precondition?: { met: boolean; reason?: string }
  inert?: { likely: boolean; reason: string } | null
  verdict?: ActionResult['verdict']
  effects?: AuditEffects
  expectations?: Array<{ expectation: string; met: boolean; detail: string }>
  reconciliation?: AuditReconciliation
  cost?: AuditCost
  /** Pointer to the evidence screenshot on disk, when one was captured. */
  evidence?: { path: string } | null
  summary?: string
  /** Observation-only: how much was seen. */
  affordances?: number
  notices?: string[]
  /** Free text for a note. */
  text?: string
  /** Hash of the previous entry ({@link GENESIS_HASH} for the first). */
  prevHash: string
  /** Hash of this entry's content together with prevHash. */
  hash: string
}

/** The outcome of checking a chain. */
export interface AuditVerification {
  ok: boolean
  entries: number
  /** 1-based index of the first entry that failed, or null when the chain is intact. */
  brokenAt: number | null
  reason: string | null
}

/** What to stamp on the log's header. */
export interface AuditLogOptions {
  goal: string
  startedAt?: number
}

/**
 * Stable, sorted JSON so the same content always hashes to the same digest regardless of key
 * insertion order. Arrays keep their order (it is meaningful); object keys are sorted.
 * @param value - Any JSON-serialisable value
 * @returns Canonical JSON text
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`
}

/**
 * The digest of an entry, computed over everything except the `hash` field itself.
 * @param entry - The entry, with `prevHash` set and `hash` absent or ignored
 * @returns A 64-char hex sha256
 */
function digest(entry: Omit<AuditEntry, 'hash'>): string {
  const { ...rest } = entry as AuditEntry
  delete (rest as Partial<AuditEntry>).hash
  return crypto.createHash('sha256').update(canonicalize(rest)).digest('hex')
}

export class AuditLog {
  private readonly items: AuditEntry[] = []
  private readonly goal: string
  private readonly startedAt: number

  /**
   * @param options - Goal and optional start time for the header
   */
  constructor(options: AuditLogOptions) {
    this.goal = options.goal
    this.startedAt = options.startedAt ?? Date.now()
  }

  /** Every entry, oldest first. */
  get entries(): readonly AuditEntry[] {
    return this.items
  }

  /** The hash at the tip of the chain, or the genesis hash when empty. Anchor for {@link verify}. */
  get head(): string {
    return this.items.length === 0 ? GENESIS_HASH : this.items[this.items.length - 1].hash
  }

  /** How many entries have been recorded. */
  get length(): number {
    return this.items.length
  }

  /**
   * Record one action and everything proven about it.
   * @param request - What was asked
   * @param result - What the environment observed
   * @returns The appended entry
   */
  recordAction(request: ActionRequest, result: ActionResult): AuditEntry {
    const declared = (request.expect as Record<string, unknown> | undefined) ?? null
    const clean = declared !== null && result.verdict === 'confirmed' && result.undeclared.length === 0
    return this.append({
      kind: 'action',
      intent: {
        do: request.do,
        ref: request.ref,
        target: request.target,
        selector: request.selector,
        value: request.value,
        expect: declared ?? undefined,
        confirmed: request.confirmed,
      },
      resolvedTarget: {
        description: result.target.description,
        selector: result.target.resolvedSelector,
        ref: result.target.ref,
        nodeId: result.target.nodeId,
        frameId: result.target.frameId,
      },
      precondition: result.precondition,
      inert: result.inert,
      verdict: result.verdict,
      effects: {
        urlChanged: result.effects.urlChanged,
        titleChanged: result.effects.titleChanged,
        mutations: result.effects.mutations.total,
        requests: result.effects.requests,
        writeRequests: result.effects.writeRequests,
        consoleErrors: result.effects.consoleErrors,
        valueSet: result.effects.valueSet,
      },
      expectations: result.expectations,
      reconciliation: { declared, undeclared: result.undeclared, clean },
      cost: {
        durationMs: result.durationMs,
        mutations: result.effects.mutations.total,
        requests: result.effects.requests.length,
        writeRequests: result.effects.writeRequests.length,
      },
      evidence: result.evidence?.path ? { path: result.evidence.path } : null,
      summary: result.summary,
    })
  }

  /**
   * Record that the page was observed.
   * @param view - The observation
   * @returns The appended entry
   */
  recordObservation(view: Observation): AuditEntry {
    return this.append({
      kind: 'observation',
      affordances: view.affordances.length,
      notices: view.notices,
      summary: `observed ${view.affordances.length} affordance(s)${
        view.truncated > 0 ? `, ${view.truncated} omitted` : ''
      }`,
    })
  }

  /**
   * Record a free-text note in line with the actions.
   * @param text - The note
   * @returns The appended entry
   */
  recordNote(text: string): AuditEntry {
    return this.append({ kind: 'note', text, summary: text })
  }

  /**
   * Verify the chain: every entry's stored hash matches its content, and every link points at
   * the entry before it. Optionally anchor the tip against a hash recorded elsewhere, which is
   * what defeats a wholesale re-forge of the log.
   * @param expectedHead - A previously trusted value of {@link head}
   * @returns Whether the chain is intact and, if not, where it broke
   */
  verify(expectedHead?: string): AuditVerification {
    let prev = GENESIS_HASH
    for (let i = 0; i < this.items.length; i++) {
      const e = this.items[i]
      if (e.index !== i + 1) {
        return { ok: false, entries: this.items.length, brokenAt: i + 1, reason: `index is ${e.index}, expected ${i + 1}` }
      }
      if (e.prevHash !== prev) {
        return { ok: false, entries: this.items.length, brokenAt: e.index, reason: 'prevHash does not match the entry before it (a step was inserted, removed or reordered)' }
      }
      if (digest(e) !== e.hash) {
        return { ok: false, entries: this.items.length, brokenAt: e.index, reason: 'content hash does not match (this entry was edited)' }
      }
      prev = e.hash
    }
    if (expectedHead !== undefined && this.head !== expectedHead) {
      return { ok: false, entries: this.items.length, brokenAt: this.items.length, reason: 'head does not match the expected anchor (the whole log may have been re-forged)' }
    }
    return { ok: true, entries: this.items.length, brokenAt: null, reason: null }
  }

  /**
   * The machine surface: one JSON entry per line, plus a leading header line. A grader reads
   * this; every value it needs to score a UI episode is here without parsing prose.
   * @returns Newline-delimited JSON
   */
  toJSONL(): string {
    const header = {
      schema: AUDIT_SCHEMA_VERSION,
      kind: 'header',
      goal: this.goal,
      startedAt: new Date(this.startedAt).toISOString(),
      entries: this.items.length,
      head: this.head,
    }
    return [JSON.stringify(header), ...this.items.map((e) => JSON.stringify(e))].join('\n') + '\n'
  }

  /**
   * The human surface: the same entries, rendered to read. Not a summary — every fact in the
   * JSONL is here, laid out for a reviewer deciding whether a run can be trusted.
   * @returns Markdown
   */
  toMarkdown(): string {
    const v = this.verify()
    const mark: Record<string, string> = {
      confirmed: 'OK',
      'no-effect': 'NO-EFFECT',
      'side-effects': 'SIDE-EFFECTS',
      unexpected: 'UNEXPECTED',
      blocked: 'BLOCKED',
    }
    const lines: string[] = [
      `# Audit log — ${this.goal}`,
      '',
      `- schema: \`${AUDIT_SCHEMA_VERSION}\``,
      `- started: ${new Date(this.startedAt).toISOString()}`,
      `- entries: ${this.items.length}`,
      `- chain head: \`${this.head.slice(0, 16)}…\``,
      `- integrity: ${v.ok ? 'VERIFIED — the chain is intact' : `BROKEN at entry ${v.brokenAt} (${v.reason})`}`,
      '',
    ]
    for (const e of this.items) {
      if (e.kind === 'note') {
        lines.push(`## ${e.index}. note — ${e.at}`, '', `> ${e.text ?? ''}`, '')
        continue
      }
      if (e.kind === 'observation') {
        lines.push(`## ${e.index}. observation — ${e.at}`, '', `${e.summary ?? ''}`, '')
        if (e.notices && e.notices.length) lines.push(`- notices: ${e.notices.join('; ')}`, '')
        lines.push(`- entry hash: \`${e.hash.slice(0, 16)}…\``, '')
        continue
      }
      const verdict = e.verdict ? `[${mark[e.verdict] ?? e.verdict}]` : ''
      lines.push(`## ${e.index}. ${e.intent?.do ?? 'action'} ${verdict} — ${e.at}`, '')
      lines.push(`- intent: ${describeIntent(e.intent)}`)
      if (e.resolvedTarget) lines.push(`- resolved target: ${e.resolvedTarget.description} (\`${e.resolvedTarget.selector}\`)`)
      if (e.precondition) lines.push(`- precondition: ${e.precondition.met ? 'met' : `NOT met — ${e.precondition.reason ?? 'unknown'}`}`)
      if (e.verdict) lines.push(`- verdict: **${e.verdict}**`)
      if (e.expectations && e.expectations.length) {
        lines.push('- expectations:')
        for (const x of e.expectations) lines.push(`  - ${x.met ? 'held' : 'FAILED'}: ${x.expectation} (${x.detail})`)
      }
      lines.push(`- effects: ${describeEffects(e.effects)}`)
      if (e.reconciliation) {
        const r = e.reconciliation
        if (r.declared === null) lines.push('- reconciliation: nothing was declared, so undeclared effects were not tracked')
        else if (r.undeclared.length === 0) lines.push('- reconciliation: clean — what was declared held and nothing undeclared happened')
        else lines.push(`- reconciliation: UNDECLARED — ${r.undeclared.map((u) => `${u.kind}: ${u.detail}`).join('; ')}`)
      }
      if (e.cost) lines.push(`- cost: ${e.cost.durationMs}ms, ${e.cost.mutations} mutation(s), ${e.cost.requests} request(s)`)
      if (e.evidence?.path) lines.push(`- evidence: ${e.evidence.path}`)
      if (e.summary) lines.push(`- summary: ${e.summary}`)
      lines.push(`- entry hash: \`${e.hash.slice(0, 16)}…\` (prev \`${e.prevHash.slice(0, 16)}…\`)`)
      lines.push('')
    }
    return lines.join('\n')
  }

  /**
   * Write both surfaces to disk. Given `runs/pay`, writes `runs/pay.jsonl` and `runs/pay.md`.
   * @param basePath - Path without extension
   * @returns The two absolute paths written
   */
  async save(basePath: string): Promise<{ jsonl: string; markdown: string }> {
    const resolved = path.resolve(basePath)
    await fs.mkdir(path.dirname(resolved), { recursive: true }).catch(() => undefined)
    const jsonl = `${resolved}.jsonl`
    const markdown = `${resolved}.md`
    await fs.writeFile(jsonl, this.toJSONL(), 'utf8')
    await fs.writeFile(markdown, this.toMarkdown(), 'utf8')
    return { jsonl, markdown }
  }

  /**
   * Build a log from actions already performed on a page, for a caller who drove `page.act`
   * directly rather than through an episode. The chain is computed as the entries are added,
   * so the result verifies exactly like one built live.
   * @param goal - What the run was for
   * @param actions - The results, in order
   * @returns A populated, verifiable log
   */
  static fromActions(goal: string, actions: ActionResult[]): AuditLog {
    const log = new AuditLog({ goal })
    for (const r of actions) {
      // reconstruct the request shape the result implies; the declared expectation is not on
      // the result, so it is recorded as unknown-but-present when undeclared effects exist
      log.recordAction({ do: r.action as ActionRequest['do'], ref: r.target.ref, selector: r.target.resolvedSelector }, r)
    }
    return log
  }

  /**
   * Append an entry, sealing it with the chain hash. Private: entries are only ever added, in
   * order, through the typed record methods.
   * @param partial - Everything but index, timestamp, schema and the hash fields
   * @returns The sealed entry
   */
  private append(partial: Omit<AuditEntry, 'index' | 'at' | 'schema' | 'prevHash' | 'hash'>): AuditEntry {
    const prevHash = this.head
    const withoutHash: Omit<AuditEntry, 'hash'> = {
      schema: AUDIT_SCHEMA_VERSION,
      index: this.items.length + 1,
      at: new Date().toISOString(),
      prevHash,
      ...partial,
    }
    const entry: AuditEntry = { ...withoutHash, hash: digest(withoutHash) }
    this.items.push(entry)
    return entry
  }
}

/**
 * One-line rendering of an intent for the human surface.
 * @param intent - The recorded intent
 * @returns Readable text
 */
function describeIntent(intent: AuditIntent | undefined): string {
  if (!intent) return '(none)'
  const addr = intent.ref
    ? `ref ${intent.ref}`
    : intent.target
      ? `“${intent.target}”`
      : intent.selector
        ? `\`${intent.selector}\``
        : '(no target)'
  const value = intent.value !== undefined ? ` = ${JSON.stringify(intent.value)}` : ''
  const expect = intent.expect ? `, expecting ${JSON.stringify(intent.expect)}` : ''
  const conf = intent.confirmed ? ' [confirmed]' : ''
  return `${intent.do} ${addr}${value}${expect}${conf}`
}

/**
 * One-line rendering of measured effects for the human surface.
 * @param e - The recorded effects
 * @returns Readable text
 */
function describeEffects(e: AuditEffects | undefined): string {
  if (!e) return 'none recorded'
  const parts: string[] = []
  if (e.urlChanged) parts.push(`url ${e.urlChanged.from} → ${e.urlChanged.to}`)
  parts.push(`${e.mutations} mutation(s)`)
  if (e.writeRequests.length) parts.push(`writes: ${e.writeRequests.map((w) => `${w.method} ${w.url}`).join(', ')}`)
  else if (e.requests.length) parts.push(`${e.requests.length} request(s)`)
  if (e.consoleErrors.length) parts.push(`console errors: ${e.consoleErrors.length}`)
  if (e.valueSet) parts.push(`value set to ${JSON.stringify(e.valueSet.actual)} (${e.valueSet.matched ? 'matched' : 'REJECTED'})`)
  return parts.join('; ')
}
