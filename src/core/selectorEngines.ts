/**
 * Selector engines the caller defines.
 *
 * Applications carry conventions a general library cannot know: `data-cy`, a framework's
 * component name, a translation key. Without a way to name those, an agent is pushed back to
 * brittle CSS paths, which is precisely the thing that breaks on the next re-render.
 *
 * An engine may be either shape:
 *
 * - a **predicate**, `(element, value) => boolean`, which is filtered through the same deep
 *   traversal every built-in step uses, so it inherits shadow-piercing and scoping for free;
 * - a **query**, `(root, value) => Element[]`, which receives each scope root and returns
 *   whatever it likes — the only way to express anything positional or relational, such as
 *   "the third match" or "the field after this label".
 *
 * The predicate form was the only one at first, and that was a mistake: it cannot express
 * position or relationship at all, which is most of the reason anyone writes a custom engine.
 * The query form is detected by what the function returns, so neither has to be declared.
 *
 * Both are scoped to the current chain, and both stay subject to strictness: a query engine
 * that returns three elements refuses to act, exactly as `getByRole` would.
 */

/** Registered engines, by name. */
const engines = new Map<string, string>()

/** A parsed `name=value` selector. */
export interface EngineSelector {
  engine: string
  value: string
}

/**
 * Register a selector engine.
 *
 * The source is a JavaScript expression evaluating to a function, and runs inside the page,
 * so it cannot close over anything in your test. Return a boolean to filter elements one at a
 * time, or an array of elements to select them yourself.
 *
 * @param name - Prefix that will select it, as in `mine=value`
 * @param source - Expression for `(element, value) => boolean`, or `(root, value) => Element[]`
 * @example
 * // predicate: judged per element
 * registerSelectorEngine('cy', `(el, value) => el.getAttribute('data-cy') === value`)
 * await page.locator('cy=submit').click()
 * @example
 * // query: positional, which a predicate cannot express
 * registerSelectorEngine('nth-cell', `(root, value) => {
 *   const cells = Array.from(root.querySelectorAll('td'))
 *   const el = cells[Number(value)]
 *   return el ? [el] : []
 * }`)
 * await page.locator('nth-cell=2').textContent()
 */
export function registerSelectorEngine(name: string, source: string): void {
  if (!/^[a-zA-Z][\w-]*$/.test(name)) {
    throw new Error(
      `registerSelectorEngine: "${name}" is not a usable name. Use letters, digits, hyphens ` +
        `and underscores, starting with a letter, so that "${name}=value" cannot be confused ` +
        `with a CSS selector.`
    )
  }
  if (BUILT_IN_PREFIXES.has(name)) {
    throw new Error(
      `registerSelectorEngine: "${name}" is already a built-in selector prefix. Choose another ` +
        `name rather than shadowing it, which would silently change what existing locators mean.`
    )
  }
  engines.set(name, source)
}

/** Prefixes the library already understands, which an engine must not shadow. */
const BUILT_IN_PREFIXES = new Set(['css', 'text', 'role', 'label', 'placeholder', 'testid', 'title', 'alt'])

/** Forget every registered engine. Intended for tests. */
export function clearSelectorEngines(): void {
  engines.clear()
}

/** Whether a name has been registered. */
export function hasSelectorEngine(name: string): boolean {
  return engines.has(name)
}

/**
 * Split `name=value` when `name` is a registered engine.
 *
 * A selector that merely contains `=` — `input[type=text]` — is left alone, because the name
 * must be registered for the split to happen at all.
 * @param selector - The raw selector
 * @returns The parsed engine selector, or null when this is ordinary CSS
 */
export function parseEngineSelector(selector: string): EngineSelector | null {
  const eq = selector.indexOf('=')
  if (eq <= 0) return null
  const name = selector.slice(0, eq)
  if (!engines.has(name)) return null
  return { engine: name, value: selector.slice(eq + 1) }
}

/**
 * In-page source defining every registered engine as `svEngines`.
 * @returns JavaScript source, empty-safe
 */
export function selectorEngineSource(): string {
  const entries = [...engines.entries()]
    .map(([name, source]) => `  ${JSON.stringify(name)}: (${source}),`)
    .join('\n')
  return `const svEngines = {\n${entries}\n}`
}
