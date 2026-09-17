import type { Page } from '../core/Page'
import { describeCanvas } from '../capture/CanvasProbe'
import type { ActionRequest } from '../core/types'

/**
 * A UI task that can be scored without a human and without a model judge.
 *
 * The harness's one confirmed finding is that gains come from **executable checks written
 * before the candidates exist**, and its measured limit is that they exist only where such a
 * check exists — which so far has meant arithmetic and code. That limit is now the binding
 * one: MATH-500, MBPP+ and HumanEval+ are all at or near ceiling for the 27B, so "+5 points
 * plain" cannot be measured on any of them.
 *
 * A UI task closes that. The postcondition is written before the model sees the task, it is
 * evaluated against the page's real state afterwards, and nothing in between consults an
 * opinion. Three properties make it a genuine third domain rather than a dressed-up variant
 * of the first two:
 *
 *  - **it is not saturated** — long-horizon computer use sits near 20% at the frontier;
 *  - **it is multi-step**, so a single wrong move is recoverable and the score reflects a
 *    sequence rather than a lucky guess;
 *  - **it has side conditions a correct answer can still violate** — a plan that reaches the
 *    right end state by charging a card on the way is not correct, and the environment can
 *    say so. Arithmetic has no equivalent of that.
 */

/**
 * One clause of a postcondition. Each is decided by looking at the page, never by asking.
 *
 * The value clause is `inputValue`, not `valueOf`: every JavaScript object inherits `valueOf`,
 * so `'valueOf' in a` is true of every variant and the union would not narrow.
 */
export type UiAssertion =
  | { textIn: { selector: string; contains?: string; equals?: string } }
  | { inputValue: { selector: string; equals: string } }
  | { countOf: { selector: string; equals: number } }
  | { absent: { selector: string } }
  | { present: { selector: string } }
  | { checked: { selector: string; is: boolean } }
  | { urlContains: string }
  /**
   * A canvas has been drawn on.
   *
   * The only clause decided by pixels, because it is the only one the DOM cannot decide: a
   * chart that silently failed to render is a healthy element of the right size with nothing
   * on it. Without this, any task whose outcome is a rendered chart is unscoreable, and
   * "unscoreable" has quietly meant "excluded from the benchmark".
   */
  | { canvasNotBlank: { selector: string; minEnergy?: number } }
  /**
   * A canvas has NOT been drawn on.
   *
   * The silent-failure case, and the reason canvas probing earns its place: a report that runs,
   * updates its caption, logs success and produces an empty chart. Every DOM assertion passes.
   * Only the pixels disagree, and without this clause the task would have to be written as
   * though the empty chart were fine.
   */
  | { canvasBlank: { selector: string; maxEnergy?: number } }

/** A task: a page, a goal stated in words, and what must be true afterwards. */
export interface UiTask {
  id: string
  /** Fixture directory name served for this task. */
  page: string
  /** Route within the fixture. */
  route?: string
  /** What the model is asked to achieve, in words. */
  goal: string
  /** Written before the candidate exists. Every clause must hold. */
  postcondition: UiAssertion[]
  /**
   * Things a correct plan must not do on the way.
   *
   * The property arithmetic has no equivalent of. A plan that reaches the right end state by
   * deleting a different invoice, or by posting to the payment endpoint, has not solved the
   * task — and only the environment can tell you that.
   */
  forbidden?: {
    /** No state-changing HTTP request other than those listed. */
    writeRequestsExcept?: string[]
    /** No text matching this may appear anywhere when the plan finishes. */
    textAbsent?: string[]
  }
  /** Steps the reference solution needs; the budget is set from this. */
  referenceSteps?: number
}

/**
 * One step of a candidate's plan.
 *
 * `waitFor` is a step like any other, and it has to be: a real application loads in pieces,
 * and a plan with no way to say "not yet" can only race it. Without this the grader punishes
 * a correct sequence for arriving early, which measures the fixture's timing rather than the
 * model's reasoning.
 */
export interface UiPlanStep {
  do: ActionRequest['do'] | 'waitFor'
  selector?: string
  target?: string
  ref?: string
  value?: string
  /** The candidate's own declared expectation; recorded, never trusted as evidence. */
  expect?: ActionRequest['expect']
  confirmed?: boolean
  /** For `waitFor`: how long to allow. */
  timeout?: number
}

/** How a candidate's plan fared. */
export interface UiTaskResult {
  taskId: string
  passed: boolean
  /** Per-clause outcome of the pre-committed postcondition. */
  clauses: Array<{ assertion: string; met: boolean; detail: string }>
  /** Side conditions the plan violated on the way. */
  violations: string[]
  stepsTaken: number
  stepsAllowed: number
  stoppedBecause: string | null
  /**
   * What the environment made of each step.
   *
   * Carried because a failed task is otherwise a single word. Which step went wrong, and
   * whether it was refused, did nothing, or did something extra, is the difference between a
   * usable training signal and a score.
   */
  steps: Array<{ do: string; target: string; verdict: string; summary: string }>
  /** Why it failed, in one line, when it did. */
  reason: string
}

/**
 * Render one assertion as text, for reporting.
 * @param a - The assertion
 * @returns A short description
 */
function describe(a: UiAssertion): string {
  if ('textIn' in a) {
    const { selector, contains, equals } = a.textIn
    return `text of ${selector} ${equals !== undefined ? `equals ${JSON.stringify(equals)}` : `contains ${JSON.stringify(contains)}`}`
  }
  if ('inputValue' in a) {
    return `value of ${a.inputValue.selector} equals ${JSON.stringify(a.inputValue.equals)}`
  }
  if ('countOf' in a) return `${a.countOf.selector} matches ${a.countOf.equals} element(s)`
  if ('absent' in a) return `${a.absent.selector} is absent`
  if ('present' in a) return `${a.present.selector} is present`
  if ('checked' in a) return `${a.checked.selector} is ${a.checked.is ? 'checked' : 'unchecked'}`
  if ('canvasNotBlank' in a) {
    return `canvas ${a.canvasNotBlank.selector} has been drawn on`
  }
  if ('canvasBlank' in a) {
    return `canvas ${a.canvasBlank.selector} has nothing drawn on it`
  }
  return `url contains ${JSON.stringify(a.urlContains)}`
}

/**
 * Evaluate one clause against the live page.
 * @param page - The page, after the plan has run
 * @param a - The assertion
 * @returns Whether it held, and what was seen
 */
async function evaluate(page: Page, a: UiAssertion): Promise<{ met: boolean; detail: string }> {
  // A sentinel no page can produce, so "the element is missing" is never confused with "the
  // element is there and empty" -- two different failures with two different remedies.
  const MISSING = '__SV_MISSING__'
  const read = async (expr: string): Promise<string> =>
    page.evaluate<string>(expr).catch((e) => `<error: ${(e as Error).message}>`)

  if ('urlContains' in a) {
    const url = page.url()
    return { met: url.includes(a.urlContains), detail: `url is ${url}` }
  }
  if ('canvasNotBlank' in a) {
    const min = a.canvasNotBlank.minEnergy ?? 0.5
    const c = await page.canvasContent(a.canvasNotBlank.selector).catch(() => null)
    if (c === null || !c.readable) {
      // "could not read it" is not "it was blank": different facts, different remedies
      return { met: false, detail: c?.reason ?? 'the canvas could not be measured' }
    }
    return { met: c.energy > min, detail: describeCanvas(a.canvasNotBlank.selector, c, min) }
  }
  if ('canvasBlank' in a) {
    const max = a.canvasBlank.maxEnergy ?? 0.5
    const c = await page.canvasContent(a.canvasBlank.selector).catch(() => null)
    if (c === null || !c.readable) {
      // an unreadable canvas is not a blank one; saying otherwise would let a broken probe
      // silently satisfy a clause about emptiness
      return { met: false, detail: c?.reason ?? 'the canvas could not be measured' }
    }
    return { met: c.energy <= max, detail: describeCanvas(a.canvasBlank.selector, c, max) }
  }
  if ('textIn' in a) {
    const sel = JSON.stringify(a.textIn.selector)
    const got = await read(
      `(() => { const e = document.querySelector(${sel}); return e ? (e.innerText || e.textContent || '').replace(/\\s+/g,' ').trim() : '__SV_MISSING__' })()`
    )
    if (got === MISSING) return { met: false, detail: `${a.textIn.selector} is not on the page` }
    const met =
      a.textIn.equals !== undefined ? got === a.textIn.equals : got.includes(a.textIn.contains ?? '')
    return { met, detail: `saw ${JSON.stringify(got.slice(0, 120))}` }
  }
  if ('inputValue' in a) {
    const sel = JSON.stringify(a.inputValue.selector)
    const got = await read(
      `(() => { const e = document.querySelector(${sel}); return e ? String(e.value ?? '') : '__SV_MISSING__' })()`
    )
    if (got === MISSING) return { met: false, detail: `${a.inputValue.selector} is not on the page` }
    return { met: got === a.inputValue.equals, detail: `value is ${JSON.stringify(got)}` }
  }
  if ('countOf' in a) {
    const sel = JSON.stringify(a.countOf.selector)
    const got = await read(`String(document.querySelectorAll(${sel}).length)`)
    return { met: Number(got) === a.countOf.equals, detail: `found ${got}` }
  }
  if ('absent' in a) {
    const sel = JSON.stringify(a.absent.selector)
    const got = await read(`String(document.querySelectorAll(${sel}).length)`)
    return { met: Number(got) === 0, detail: `found ${got}` }
  }
  if ('present' in a) {
    const sel = JSON.stringify(a.present.selector)
    const got = await read(`String(document.querySelectorAll(${sel}).length)`)
    return { met: Number(got) > 0, detail: `found ${got}` }
  }
  const sel = JSON.stringify(a.checked.selector)
  const got = await read(
    `(() => { const e = document.querySelector(${sel}); return e ? String(!!e.checked) : '__SV_MISSING__' })()`
  )
  if (got === MISSING) return { met: false, detail: `${a.checked.selector} is not on the page` }
  return { met: got === String(a.checked.is), detail: `checked is ${got}` }
}

/**
 * Run a candidate's plan against a task and score it.
 *
 * The plan's own `expect` fields are recorded and never believed: a candidate that declares
 * success proves nothing, which is the entire reason the postcondition is written first and
 * evaluated here.
 * @param page - A page already navigated to the task's route
 * @param task - The task, with its pre-committed postcondition
 * @param plan - The candidate's steps
 * @returns The scored result
 */
export async function runUiTask(
  page: Page,
  task: UiTask,
  plan: UiPlanStep[]
): Promise<UiTaskResult> {
  const allowed = Math.max(1, (task.referenceSteps ?? 6) * 2)
  const episode = page.episode({ goal: task.goal, maxSteps: allowed })
  const violations: string[] = []
  const writes: string[] = []

  const stopWatching = page.watchActivity(
    (url, method) => {
      const verb = (method || 'GET').toUpperCase()
      if (verb !== 'GET' && verb !== 'HEAD') writes.push(`${verb} ${url}`)
    },
    () => undefined
  )

  try {
    for (const step of plan) {
      if (episode.stoppedBecause !== null) break
      try {
        if (step.do === 'waitFor') {
          if (!step.selector) throw new Error('waitFor needs a selector')
          await page.waitForSelector(step.selector, { timeout: step.timeout ?? 8000 })
          episode.note(`waited for ${step.selector}`)
          continue
        }
        await episode.act(step as ActionRequest)
      } catch (err) {
        // A refused step is information, not a crash: the gate refusing an unconfirmed
        // payment is the environment doing its job, and the plan simply stops there.
        violations.push(`step refused: ${(err as Error).message.split('\n')[0].slice(0, 200)}`)
        break
      }
    }
  } finally {
    stopWatching()
  }

  const clauses: UiTaskResult['clauses'] = []
  for (const a of task.postcondition) {
    const { met, detail } = await evaluate(page, a)
    clauses.push({ assertion: describe(a), met, detail })
  }

  const allowedWrites = task.forbidden?.writeRequestsExcept
  if (allowedWrites !== undefined) {
    for (const w of writes) {
      if (!allowedWrites.some((ok) => w.includes(ok))) violations.push(`forbidden write: ${w}`)
    }
  }
  for (const text of task.forbidden?.textAbsent ?? []) {
    const found = await page
      .evaluate<boolean>(`document.body.innerText.includes(${JSON.stringify(text)})`)
      .catch(() => false)
    if (found) violations.push(`forbidden text present: ${JSON.stringify(text)}`)
  }

  const unmet = clauses.filter((c) => !c.met)
  const passed = unmet.length === 0 && violations.length === 0
  const reason = passed
    ? ''
    : unmet.length > 0
      ? `${unmet.length} postcondition clause(s) did not hold: ${unmet
          .map((c) => `${c.assertion} (${c.detail})`)
          .join('; ')}`
      : `the end state was reached but the plan violated ${violations.length} side condition(s): ${violations.join('; ')}`

  return {
    taskId: task.id,
    passed,
    steps: episode.ledger
      .filter((e) => e.kind === 'action')
      .map((e) => ({
        do: e.request?.do ?? '?',
        target: e.target ?? e.request?.selector ?? e.request?.target ?? '?',
        verdict: e.verdict ?? '?',
        summary: e.summary ?? '',
      })),
    clauses,
    violations,
    stepsTaken: episode.stepsTaken,
    stepsAllowed: allowed,
    stoppedBecause: episode.stoppedBecause,
    reason,
  }
}
