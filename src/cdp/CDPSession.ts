import { CDPClient, CDPEventListener } from './CDPClient'

/**
 * A CDP session bound to one target (page). All commands and events are
 * scoped to `sessionId` via the flattened Target protocol.
 */
export class CDPSession {
  /**
   * @param client - Shared browser-level CDP connection
   * @param sessionId - Session id from `Target.attachToTarget`
   * @param targetId - Target id of the page this session controls
   */
  constructor(
    private client: CDPClient,
    public readonly sessionId: string,
    public readonly targetId: string
  ) {}

  /**
   * Send a command on this session.
   * @param method - CDP method name
   * @param params - Method parameters
   * @returns The CDP result object
   */
  async send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      return await this.client.send(method, params, this.sessionId)
    } catch (err) {
      throw new Error(`CDPSession(${this.targetId}).send: ${(err as Error).message}`)
    }
  }

  /**
   * Listen for an event emitted on this session.
   * @param event - CDP event name
   * @param listener - Callback receiving event params
   */
  on(event: string, listener: CDPEventListener): void {
    this.client.on(event, listener, this.sessionId)
  }

  /**
   * Remove a session-scoped event listener.
   * @param event - CDP event name
   * @param listener - The callback previously passed to {@link on}
   */
  off(event: string, listener: CDPEventListener): void {
    this.client.off(event, listener, this.sessionId)
  }

  /** The underlying browser-level client. */
  get connection(): CDPClient {
    return this.client
  }
}
