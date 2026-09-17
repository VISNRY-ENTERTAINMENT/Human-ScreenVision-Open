/**
 * Browser-side traversal that sees into shadow roots.
 *
 * `document.querySelectorAll` stops at a shadow boundary, and so does CSS. A page built from
 * web components therefore looks empty: an auditor found `observe()` reporting zero
 * affordances on a page whose only control lived in a shadow root, which is a confident
 * report of an empty page rather than an error. Every collector and query in the library
 * shares the traversal below so none of them has that blind spot.
 *
 * These are source fragments rather than functions because they run in the page, and the
 * whole point of the observation is that it costs one round trip.
 */

/**
 * Declares `svWalk`, `svQueryAll` and `svQueryOne` in the evaluated scope.
 *
 * `svWalk` visits every element in the document including those inside open shadow roots.
 * Closed shadow roots are unreachable by design and nothing can be done about them.
 */
export const DEEP_TRAVERSAL = `
  const svWalk = (visit) => {
    const stack = [document]
    while (stack.length) {
      const root = stack.pop()
      const nodes = root.querySelectorAll ? root.querySelectorAll('*') : []
      for (const node of nodes) {
        visit(node)
        // an open shadow root is a separate tree that CSS cannot cross into
        if (node.shadowRoot) stack.push(node.shadowRoot)
      }
    }
  }
  const svQueryAll = (selector) => {
    const found = []
    try {
      for (const node of document.querySelectorAll(selector)) found.push(node)
    } catch (e) {
      return found
    }
    svWalk((node) => {
      if (node.shadowRoot) {
        try {
          for (const inner of node.shadowRoot.querySelectorAll(selector)) {
            if (found.indexOf(inner) === -1) found.push(inner)
          }
        } catch (e) { /* an invalid selector fails the same way everywhere */ }
      }
    })
    return found
  }
  const svQueryOne = (selector) => {
    const direct = (() => { try { return document.querySelector(selector) } catch (e) { return null } })()
    if (direct) return direct
    const all = svQueryAll(selector)
    return all.length ? all[0] : null
  }
`

/**
 * An expression that resolves one element by selector, piercing shadow roots.
 * @param selector - CSS selector
 * @returns JavaScript source evaluating to the element or null
 */
export function deepQueryExpression(selector: string): string {
  return `(() => {${DEEP_TRAVERSAL}
  return svQueryOne(${JSON.stringify(selector)})
})()`
}

/**
 * An expression that resolves the nth match of a selector, piercing shadow roots.
 * @param selector - CSS selector
 * @param index - Zero-based index
 * @returns JavaScript source evaluating to the element or null
 */
export function deepQueryNthExpression(selector: string, index: number): string {
  return `(() => {${DEEP_TRAVERSAL}
  const all = svQueryAll(${JSON.stringify(selector)})
  return all.length > ${index} ? all[${index}] : null
})()`
}

/**
 * An expression counting matches of a selector, piercing shadow roots.
 * @param selector - CSS selector
 * @returns JavaScript source evaluating to a number
 */
export function deepCountExpression(selector: string): string {
  return `(() => {${DEEP_TRAVERSAL}
  return svQueryAll(${JSON.stringify(selector)}).length
})()`
}
