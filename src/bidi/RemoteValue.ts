/**
 * Deserialisation of WebDriver BiDi `RemoteValue`s.
 *
 * BiDi has no equivalent of CDP's `returnByValue`. Every result arrives as a tagged tree —
 * `{type: 'array', value: [RemoteValue, …]}` — which has to be walked back into a plain
 * JavaScript value. The refusals mirror `unwrapRemoteValue` in `src/cdp/ProtocolMapper.ts`:
 * anything that cannot survive the wire is rejected by name rather than quietly handed back
 * as `undefined`, because a silent `undefined` reads as a page bug rather than a caller
 * mistake.
 */

/** A BiDi `RemoteValue`, loose enough to cover every type the spec defines. */
export interface RemoteValue {
  type: string
  value?: unknown
  handle?: string
  sharedId?: string
  internalId?: string
}

/** A BiDi `NodeRemoteValue`: a DOM node reference plus a shallow description of it. */
export interface NodeRemoteValue extends RemoteValue {
  type: 'node'
  sharedId?: string
  value?: {
    nodeType?: number
    localName?: string
    namespaceURI?: string
    attributes?: Record<string, string>
    childNodeCount?: number
  }
}

/** BiDi `script.evaluate` / `script.callFunction` reply. */
export interface ScriptEvaluateResult {
  type: 'success' | 'exception'
  realm: string
  result?: RemoteValue
  exceptionDetails?: {
    text?: string
    lineNumber?: number
    columnNumber?: number
    exception?: RemoteValue
    stackTrace?: unknown
  }
}

/**
 * Types that exist on the page but have no faithful JSON form.
 *
 * Kept as a table so the error message can name the kind precisely; a generic "not
 * serialisable" tells the caller nothing about which of their expressions was at fault.
 */
const NON_SERIALISABLE: Record<string, string> = {
  function: 'function',
  symbol: 'symbol',
  promise: 'promise',
  weakmap: 'WeakMap',
  weakset: 'WeakSet',
  generator: 'generator',
  proxy: 'proxy',
  error: 'Error',
  window: 'window',
  htmlcollection: 'HTMLCollection',
  nodelist: 'NodeList',
  arraybuffer: 'ArrayBuffer',
  typedarray: 'typed array',
  channel: 'channel',
}

/**
 * Convert a BiDi `RemoteValue` into a plain JavaScript value.
 * @param remote - The value as it came off the wire
 * @param source - The expression that produced it, quoted in errors so the caller can find it
 * @returns The deserialised value, typed as the caller asked
 * @throws Error naming the offending kind when the value cannot be serialised
 */
export function unwrapBiDiValue<T>(remote: RemoteValue, source: string): T {
  return unwrap(remote, source.slice(0, 200), 0) as T
}

/**
 * Recursive worker for {@link unwrapBiDiValue}.
 * @param remote - Value to convert
 * @param where - Truncated source expression for error messages
 * @param depth - Current recursion depth, used only to fail loudly on a cyclic reply
 * @returns The deserialised value
 */
function unwrap(remote: RemoteValue, where: string, depth: number): unknown {
  if (depth > 100) {
    throw new Error(`evaluate returned a value nested more than 100 levels deep: ${where}`)
  }

  switch (remote.type) {
    case 'undefined':
      return undefined
    case 'null':
      return null
    case 'string':
    case 'boolean':
      return remote.value

    case 'number':
      // NaN, Infinity and -Infinity have no JSON form, so BiDi sends them as those literal
      // strings in the same field an ordinary number would occupy.
      if (typeof remote.value === 'string') return Number(remote.value)
      return remote.value

    case 'bigint':
      return BigInt(String(remote.value))

    case 'date':
      return new Date(String(remote.value))

    case 'regexp': {
      const spec = remote.value as { pattern?: string; flags?: string } | undefined
      return new RegExp(spec?.pattern ?? '', spec?.flags ?? '')
    }

    case 'array':
    case 'set': {
      if (!Array.isArray(remote.value)) throw truncatedError(remote.type, where)
      const items = remote.value.map((item) => unwrap(item as RemoteValue, where, depth + 1))
      return remote.type === 'set' ? new Set(items) : items
    }

    case 'object':
    case 'map': {
      if (!Array.isArray(remote.value)) throw truncatedError(remote.type, where)
      // Entries are [key, value] pairs. A plain object's key is a bare string; a Map's key
      // is itself a RemoteValue, because Map keys may be any value at all.
      const entries = remote.value.map((entry) => {
        const [rawKey, rawValue] = entry as [unknown, RemoteValue]
        const key = typeof rawKey === 'string' ? rawKey : unwrap(rawKey as RemoteValue, where, depth + 1)
        return [key, unwrap(rawValue, where, depth + 1)] as [unknown, unknown]
      })
      if (remote.type === 'map') return new Map(entries)
      const out: Record<string, unknown> = {}
      for (const [key, value] of entries) out[String(key)] = value
      return out
    }

    case 'node':
      throw new Error(
        `evaluate returned a DOM node, which cannot be serialised ` +
          `(${describeNode(remote as NodeRemoteValue)}) — return a plain value such as its id, ` +
          `text or a boolean instead: ${where}`
      )

    default: {
      const kind = NON_SERIALISABLE[remote.type] ?? remote.type
      throw new Error(
        `evaluate returned a non-serialisable ${kind}, which has no JSON form — ` +
          `return a plain value such as its id or text instead: ${where}`
      )
    }
  }
}

/**
 * Error for a container that arrived without its contents.
 *
 * This is BiDi's depth limit biting: past `maxObjectDepth` the remote end sends the type tag
 * but omits `value` entirely, so the result is indistinguishable from an empty object unless
 * we refuse it.
 * @param type - The container's BiDi type
 * @param where - Truncated source expression
 * @returns The error to throw
 */
function truncatedError(type: string, where: string): Error {
  return new Error(
    `evaluate returned a ${type} whose contents were omitted by the remote end (nested deeper than ` +
      `the serialisation limit) — return a shallower or smaller value instead: ${where}`
  )
}

/**
 * Render a node reference for an error message.
 * @param node - The node value
 * @returns A short CSS-like description such as `div#main.card`
 */
export function describeNode(node: NodeRemoteValue): string {
  const detail = node.value
  if (!detail) return node.sharedId ? `node ${node.sharedId}` : 'node'
  const tag = detail.localName ?? (detail.nodeType === 3 ? '#text' : 'node')
  const id = detail.attributes?.['id']
  const cls = detail.attributes?.['class']
  return `${tag}${id ? `#${id}` : ''}${cls ? `.${cls.trim().split(/\s+/).join('.')}` : ''}`
}

/**
 * Unpack a `script.evaluate` reply, turning a page-side throw into a host-side one.
 * @param raw - The raw `result` object from the BiDi command
 * @param source - The expression that was evaluated, quoted in errors
 * @returns The successful `RemoteValue`
 * @throws Error carrying the page's exception text when the script threw
 */
export function expectScriptSuccess(raw: Record<string, unknown>, source: string): RemoteValue {
  const reply = raw as unknown as ScriptEvaluateResult
  if (reply.type === 'exception') {
    const details = reply.exceptionDetails
    const text =
      details?.text ??
      (details?.exception ? String((details.exception as RemoteValue).value ?? details.exception.type) : 'unknown')
    const at = details?.lineNumber === undefined ? '' : ` (line ${details.lineNumber}:${details.columnNumber ?? 0})`
    throw new Error(`evaluate threw${at}: ${text} — while evaluating: ${source.slice(0, 200)}`)
  }
  if (!reply.result) {
    throw new Error(`evaluate returned no result for: ${source.slice(0, 200)}`)
  }
  return reply.result
}
