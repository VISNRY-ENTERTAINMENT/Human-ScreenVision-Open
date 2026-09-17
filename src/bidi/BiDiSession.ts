import { BiDiClient } from './BiDiClient'

/**
 * Capabilities offered to `session.new`.
 *
 * Deliberately a small, typed subset rather than a free-form bag: everything ScreenVision
 * actually needs is here, and an untyped bag would let typos through to a remote end that
 * rejects the whole session for one unknown key.
 */
export interface BiDiCapabilities {
  /** Ignore TLS errors for self-signed certificates on local fixtures. */
  acceptInsecureCerts?: boolean
  /** Requested browser name, e.g. `firefox`; the remote end fails the match if it differs. */
  browserName?: string
  /** How to react to a native user prompt: `dismiss`, `accept`, `ignore`, and the `*AndNotify` variants. */
  unhandledPromptBehavior?: string
}

/** Result of a successful `session.new`. */
export interface BiDiSessionInfo {
  sessionId: string
  capabilities: Record<string, unknown>
}

/** Type of top-level navigable to create. */
export type BrowsingContextType = 'tab' | 'window'

/**
 * WebDriver BiDi session lifecycle over a {@link BiDiClient}.
 *
 * Owns the one session a connection may carry, tracks which events have been subscribed so
 * repeat subscriptions are not sent, and tracks the browsing contexts it opened so
 * {@link BiDiSession.dispose} can tidy up after a test that threw halfway through.
 */
export class BiDiSession {
  private info: BiDiSessionInfo | null = null
  private readonly subscribed: Set<string> = new Set()
  private readonly ownedContexts: Set<string> = new Set()

  /**
   * @param client - A connected BiDi client
   */
  constructor(private readonly client: BiDiClient) {}

  /**
   * The negotiated session, once {@link BiDiSession.create} has run.
   * @returns Session id and the capabilities the remote end actually granted, or null
   */
  sessionInfo(): BiDiSessionInfo | null {
    return this.info
  }

  /**
   * Start a session with `session.new`.
   *
   * Capabilities go in `alwaysMatch` rather than `firstMatch`: ScreenVision talks to one
   * browser it has just launched itself, so there is nothing to match against and a silent
   * fallback to a different configuration would be worse than a hard failure.
   * @param capabilities - Requested capabilities
   * @returns The session id and granted capabilities
   * @throws Error if a session already exists on this connection or the remote end refuses
   */
  async create(capabilities: BiDiCapabilities = {}): Promise<BiDiSessionInfo> {
    if (this.info) {
      throw new Error(`BiDiSession.create: a session (${this.info.sessionId}) already exists on this connection`)
    }
    const result = await this.client.send('session.new', { capabilities: { alwaysMatch: { ...capabilities } } })
    const sessionId = result['sessionId']
    if (typeof sessionId !== 'string') {
      throw new Error(`BiDiSession.create: session.new returned no sessionId (got ${JSON.stringify(result)})`)
    }
    this.info = {
      sessionId,
      capabilities: (result['capabilities'] as Record<string, unknown> | undefined) ?? {},
    }
    return this.info
  }

  /**
   * Subscribe to one or more event names via `session.subscribe`.
   *
   * BiDi sends no events at all until they are subscribed — unlike CDP, where enabling a
   * domain opens the floodgates for every event it defines. Names already subscribed at
   * global scope are filtered out, because a duplicate subscription is not an error but does
   * make the remote end deliver the event twice per emission.
   * @param events - Event names, e.g. `browsingContext.load`
   * @param contexts - Restrict the subscription to these contexts; omit for all
   * @returns Resolves once the remote end has acknowledged
   */
  async subscribe(events: string[], contexts?: string[]): Promise<void> {
    const scoped = contexts !== undefined && contexts.length > 0
    const wanted = scoped ? events : events.filter((e) => !this.subscribed.has(e))
    if (wanted.length === 0) return
    await this.client.send('session.subscribe', {
      events: wanted,
      ...(scoped ? { contexts } : {}),
    })
    if (!scoped) for (const e of wanted) this.subscribed.add(e)
  }

  /**
   * Cancel an event subscription via `session.unsubscribe`.
   * @param events - Event names to stop receiving
   * @returns Resolves once the remote end has acknowledged
   */
  async unsubscribe(events: string[]): Promise<void> {
    const wanted = events.filter((e) => this.subscribed.has(e))
    if (wanted.length === 0) return
    await this.client.send('session.unsubscribe', { events: wanted })
    for (const e of wanted) this.subscribed.delete(e)
  }

  /**
   * Create a top-level browsing context (a tab or window) via `browsingContext.create`.
   * @param type - `tab` or `window`
   * @returns The new context id
   * @throws Error if the remote end returns no context id
   */
  async createContext(type: BrowsingContextType = 'tab'): Promise<string> {
    const result = await this.client.send('browsingContext.create', { type })
    const context = result['context']
    if (typeof context !== 'string') {
      throw new Error(
        `BiDiSession.createContext(${type}): browsingContext.create returned no context id ` +
          `(got ${JSON.stringify(result)})`
      )
    }
    this.ownedContexts.add(context)
    return context
  }

  /**
   * Close a browsing context via `browsingContext.close`.
   * @param context - Context id from {@link BiDiSession.createContext}
   * @returns Resolves once the context is gone
   */
  async closeContext(context: string): Promise<void> {
    await this.client.send('browsingContext.close', { context })
    this.ownedContexts.delete(context)
  }

  /**
   * List the top-level contexts the browser currently has open, via `browsingContext.getTree`.
   * @returns Context ids, outermost first
   */
  async contexts(): Promise<string[]> {
    const result = await this.client.send('browsingContext.getTree', {})
    const tree = result['contexts']
    if (!Array.isArray(tree)) return []
    return tree
      .map((node) => (node as { context?: unknown }).context)
      .filter((c): c is string => typeof c === 'string')
  }

  /**
   * End the session with `session.end`, closing every context it opened first.
   *
   * Every step is best-effort: dispose runs on the teardown path, often because something
   * else has already failed, and throwing here would mask the original fault.
   * @returns Resolves once teardown has been attempted
   */
  async dispose(): Promise<void> {
    for (const context of Array.from(this.ownedContexts)) {
      try {
        await this.closeContext(context)
      } catch {
        this.ownedContexts.delete(context)
      }
    }
    if (this.info) {
      try {
        await this.client.send('session.end', {})
      } catch {
        /* the browser may already be gone; nothing useful to do */
      }
      this.info = null
    }
    this.subscribed.clear()
  }
}
