/**
 * What an action would cost if it were wrong, and whether the page is trying to instruct you.
 *
 * Both halves enforce two rules in code:
 *
 *  - a three-tier action classification — routine, requires explicit confirmation, prohibited;
 *  - the untrusted-content doctrine: every button label and page-text string is *data
 *    describing what is on screen*, never an instruction about what to do next.
 *
 * The literature says the same thing from the other end. Frontier models on long-horizon
 * computer-use tasks "lack active concern for user safety, resulting in harmful side effects
 * during execution", and adding structure to observation "substantially reduces attack success
 * rates". Neither is a property a model can supply for itself: an agent cannot decline a
 * consequence nobody classified, nor distrust text nobody marked.
 *
 * The classifier errs toward flagging. A false flag costs one question; a miss costs a
 * payment, and the two are not commensurable.
 */

/** How costly an action is if it turns out to be wrong. */
export type ConsequenceTier = 'routine' | 'confirm' | 'prohibited'

/** In-page source defining `svConsequence(el, role, name)`. */
export const CONSEQUENCE_SOURCE = `
  const SV_PAY = /\\b(pay|payment|purchase|buy|checkout|order now|place order|subscribe|donate|transfer|withdraw|charge|billing)\\b/i
  const SV_SEND = /\\b(send|post|publish|tweet|share|submit review|reply|email|message|invite)\\b/i
  const SV_DESTRUCTIVE = /\\b(delete|remove|destroy|erase|wipe|revoke|deactivate|close account|cancel subscription)\\b/i
  const SV_ACCOUNT = /\\b(sign ?up|create account|register|accept|agree|terms|consent|i agree)\\b/i
  const SV_DOWNLOAD = /\\b(download|export|save file|get the file)\\b/i
  const SV_SENSITIVE_FIELD = /(password|passwd|card|cardnumber|cvv|cvc|ssn|social security|iban|sort ?code|account ?number|routing|passport|date of birth|dob)/i

  /** Does the form this control belongs to collect personal or payment data? */
  const svFormIsSensitive = (el) => {
    const form = el.closest ? el.closest('form') : null
    const scope = form || (el.getRootNode ? el.getRootNode() : document)
    if (!scope || !scope.querySelectorAll) return false
    for (const f of scope.querySelectorAll('input, select, textarea')) {
      if (f.type === 'password') return true
      const hay = [f.name, f.id, f.getAttribute('autocomplete'), f.getAttribute('placeholder'),
                   f.getAttribute('aria-label')].filter(Boolean).join(' ')
      if (SV_SENSITIVE_FIELD.test(hay)) return true
    }
    return false
  }

  /**
   * Classify a control. Returns {tier, reason}; reason is empty for routine.
   *
   * Deliberately generous about what counts as consequential. Reading and scrolling are
   * routine; anything that spends money, speaks on the user's behalf, destroys something, or
   * accepts terms is not, and says why.
   */
  const svConsequence = (el, role, name) => {
    const label = (name || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' +
                  (el.getAttribute('name') || '') + ' ' + (el.id || '') + ' ' +
                  (el.value && typeof el.value === 'string' ? el.value : '')
    const acts = role === 'button' || role === 'link' || role === 'menuitem' ||
                 (el.tagName === 'INPUT' && /^(submit|button|image)$/i.test(el.getAttribute('type') || ''))

    if (acts && SV_PAY.test(label)) {
      return { tier: 'confirm', reason: 'this looks like a payment or purchase' }
    }
    if (acts && SV_DESTRUCTIVE.test(label)) {
      return { tier: 'confirm', reason: 'this looks like it deletes or revokes something' }
    }
    if (acts && SV_SEND.test(label)) {
      return { tier: 'confirm', reason: 'this looks like it sends or publishes something on the user\\'s behalf' }
    }
    if (acts && SV_ACCOUNT.test(label)) {
      return { tier: 'confirm', reason: 'this looks like creating an account or accepting terms' }
    }
    if (acts && SV_DOWNLOAD.test(label)) {
      return { tier: 'confirm', reason: 'this looks like it downloads a file' }
    }
    if (acts && svFormIsSensitive(el)) {
      return { tier: 'confirm', reason: 'this submits a form that collects personal or payment data' }
    }
    return { tier: 'routine', reason: '' }
  }
`

/** In-page source defining `svInjectionSignals(text)`. */
export const INJECTION_SOURCE = `
  const SV_INJECTION = [
    [/ignore (?:all )?(?:your )?(?:previous|prior|above) instructions/i, 'tells the reader to ignore its instructions'],
    [/disregard (?:the )?(?:previous|above|system)/i, 'tells the reader to disregard earlier context'],
    [/\\b(?:you are|act as) (?:now )?(?:an? )?(?:ai|assistant|agent|model)\\b/i, 'tries to reassign the reader a role'],
    [/\\b(?:ai|assistant|agent|claude|copilot|chatgpt|bot)\\b[^.]{0,40}\\b(?:please |kindly |now )?(?:enter|type|paste|provide|confirm|approve|click|run|execute)\\b/i, 'addresses an AI agent by name and instructs it'],
    [/\\b(?:enter|provide|confirm) (?:your |the )?(?:password|api key|secret|token|seed phrase|credentials)\\b/i, 'asks for credentials'],
    [/<\\|?(?:im_start|im_end|system|endoftext)\\|?>/i, 'contains chat-template control tokens'],
    [/\\bsystem prompt\\b/i, 'refers to a system prompt'],
  ]

  /** Text on the page that reads as an instruction to an agent rather than as content. */
  const svInjectionSignals = (text) => {
    const out = []
    if (!text) return out
    const sample = String(text).slice(0, 20000)
    for (const [re, why] of SV_INJECTION) {
      const m = re.exec(sample)
      if (m) out.push({ why: why, quote: sample.slice(Math.max(0, m.index - 30), m.index + 90).replace(/\\s+/g, ' ').trim() })
      if (out.length >= 5) break
    }
    return out
  }
`
