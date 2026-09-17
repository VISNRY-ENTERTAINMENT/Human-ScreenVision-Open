import { describe, it, expect } from 'vitest'
import crypto from 'crypto'
import { AuditLog, AUDIT_SCHEMA_VERSION, type AuditEntry } from '../../src/core/AuditLog'
import type { ActionRequest, ActionResult } from '../../src/core/types'

/**
 * The audit log is only a ledger if it is tamper-evident. A log an agent could quietly rewrite
 * to hide a step is not evidence of anything, so these tests are about the chain: it records in
 * order, it verifies while intact, and it points at the exact step when a step is edited,
 * removed or reordered.
 */

function fakeResult(overrides: Partial<ActionResult> = {}): ActionResult {
  return {
    ok: true,
    action: 'click',
    target: { description: 'button "Save"', resolvedSelector: '#save' },
    precondition: { met: true },
    inert: null,
    effects: {
      urlChanged: null,
      titleChanged: null,
      mutations: { total: 3, nodesAdded: [], nodesRemoved: [], textChanges: [], attributeChanges: [], navigated: false },
      requests: [],
      writeRequests: [],
      consoleErrors: [],
      valueSet: null,
    },
    expectations: [{ expectation: 'text "saved" appears', met: true, detail: 'found on the page' }],
    undeclared: [],
    verdict: 'confirmed',
    summary: 'click on #save confirmed',
    durationMs: 12,
    ...overrides,
  }
}

const req: ActionRequest = { do: 'click', selector: '#save', expect: { textAppears: 'saved' } }

describe('the chain records in order and verifies', () => {
  it('stamps a monotonic index, schema and timestamp on every entry', () => {
    const log = new AuditLog({ goal: 'save the draft' })
    log.recordObservation({ affordances: [], notices: [], truncated: 0 } as never)
    log.recordAction(req, fakeResult())
    log.recordNote('checked by hand')
    expect(log.length).toBe(3)
    expect(log.entries.map((e) => e.index)).toEqual([1, 2, 3])
    expect(log.entries.every((e) => e.schema === AUDIT_SCHEMA_VERSION)).toBe(true)
    expect(log.entries.every((e) => typeof e.at === 'string' && e.at.length > 0)).toBe(true)
  })

  it('links each entry to the one before it, starting from a genesis hash', () => {
    const log = new AuditLog({ goal: 'g' })
    log.recordNote('one')
    log.recordNote('two')
    const [a, b] = log.entries
    expect(a.prevHash).toBe('0'.repeat(64))
    expect(b.prevHash).toBe(a.hash)
    expect(log.head).toBe(b.hash)
  })

  it('verifies clean while intact', () => {
    const log = new AuditLog({ goal: 'g' })
    log.recordAction(req, fakeResult())
    log.recordAction(req, fakeResult({ verdict: 'no-effect' }))
    const v = log.verify()
    expect(v.ok).toBe(true)
    expect(v.brokenAt).toBeNull()
  })

  it('records the declared-vs-undeclared reconciliation and marks a clean step', () => {
    const log = new AuditLog({ goal: 'g' })
    const clean = log.recordAction(req, fakeResult())
    const dirty = log.recordAction(req, fakeResult({ verdict: 'side-effects', undeclared: [{ kind: 'write-request', detail: 'POST /charge' }] }))
    expect(clean.reconciliation?.clean).toBe(true)
    expect(dirty.reconciliation?.clean).toBe(false)
    expect(dirty.reconciliation?.undeclared[0].detail).toBe('POST /charge')
  })
})

describe('tampering is detected', () => {
  it('catches an edited entry (content no longer matches its hash)', () => {
    const log = new AuditLog({ goal: 'g' })
    log.recordNote('one')
    log.recordNote('two')
    log.recordNote('three')
    // reach past the readonly view and edit the middle entry in place
    const entry = log.entries[1] as AuditEntry
    entry.summary = 'this step was changed after the fact'
    const v = log.verify()
    expect(v.ok).toBe(false)
    expect(v.brokenAt).toBe(2)
    expect(v.reason).toMatch(/edited/)
  })

  it('catches a re-hashed entry via the next link (prevHash no longer matches)', () => {
    const log = new AuditLog({ goal: 'g' })
    log.recordNote('one')
    log.recordNote('two')
    log.recordNote('three')
    // a smarter tamper: edit entry 2 AND fix its own hash, but not entry 3's prevHash
    const e2 = log.entries[1] as AuditEntry
    e2.text = 'forged'
    // recompute e2.hash the way the log would, leaving e3 pointing at the old hash
    e2.hash = crypto.createHash('sha256').update(JSON.stringify({ tampered: true })).digest('hex')
    const v = log.verify()
    expect(v.ok).toBe(false)
    // detected at 2 (its own hash is wrong) or 3 (prevHash mismatch) — either way, caught
    expect([2, 3]).toContain(v.brokenAt)
  })

  it('catches a deleted step (indices and links no longer line up)', () => {
    const log = new AuditLog({ goal: 'g' })
    log.recordNote('one')
    log.recordNote('two')
    log.recordNote('three')
    // splice out the middle entry
    ;(log.entries as AuditEntry[]).splice(1, 1)
    const v = log.verify()
    expect(v.ok).toBe(false)
    expect(v.brokenAt).toBe(2)
  })

  it('catches a wholesale re-forge against a trusted head anchor', () => {
    const log = new AuditLog({ goal: 'g' })
    log.recordNote('one')
    const trustedHead = log.head
    log.recordNote('two')
    // a re-forge would rebuild a self-consistent chain; the anchor is what still catches it
    expect(log.verify().ok).toBe(true)
    expect(log.verify(trustedHead).ok).toBe(false)
    expect(log.verify(log.head).ok).toBe(true)
  })
})

describe('two surfaces, one set of facts', () => {
  it('emits JSONL with a header line and one entry per line', () => {
    const log = new AuditLog({ goal: 'save the draft' })
    log.recordAction(req, fakeResult())
    log.recordNote('done')
    const lines = log.toJSONL().trim().split('\n')
    expect(lines.length).toBe(3) // header + 2 entries
    const header = JSON.parse(lines[0])
    expect(header.kind).toBe('header')
    expect(header.goal).toBe('save the draft')
    expect(header.head).toBe(log.head)
    const first = JSON.parse(lines[1])
    expect(first.verdict).toBe('confirmed')
    expect(first.hash).toBe(log.entries[0].hash)
  })

  it('renders Markdown carrying the same verdict and an integrity line', () => {
    const log = new AuditLog({ goal: 'save the draft' })
    log.recordAction(req, fakeResult({ verdict: 'side-effects', undeclared: [{ kind: 'write-request', detail: 'POST /charge' }] }))
    const md = log.toMarkdown()
    expect(md).toMatch(/# Audit log — save the draft/)
    expect(md).toMatch(/VERIFIED/)
    expect(md).toMatch(/side-effects/)
    expect(md).toMatch(/UNDECLARED.*POST \/charge/)
  })
})
