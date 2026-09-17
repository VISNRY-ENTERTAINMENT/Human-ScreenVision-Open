import type { ProtocolMapper } from '../cdp/ProtocolMapper'
import { HostResolutionError, Locator, cssOrEngineStep } from './Locator'
import type { LocatorHost } from './Locator'
import type { Page } from './Page'

/**
 * A frame named now and resolved later.
 *
 * `page.frame('#checkout')` is async because finding a frame is async, which forces callers
 * to await before they can describe what they want inside it. That reads badly and, worse,
 * resolves the frame once: if the frame reloads, every locator taken from it is pointing at
 * a dead execution context.
 *
 * A frame locator holds only the *description* of the frame and resolves it on each use, the
 * same way a {@link Locator} re-resolves its element. `page.frameLocator('#checkout')
 * .getByRole('button', { name: 'Pay' }).click()` is a single expression that survives the
 * frame reloading underneath it.
 */
export class FrameLocator {
  /**
   * @param page - Page that owns the frame
   * @param selector - How to find the frame: CSS selector, name, or URL fragment
   */
  constructor(
    private pageRef: Page,
    private selector: string
  ) {}

  /**
   * A locator scoped to this frame, resolved when it is used.
   * @param selector - CSS selector
   * @returns A locator
   */
  locator(selector: string): Locator {
    return new Locator(this.host(), [cssOrEngineStep(selector)])
  }

  /**
   * Find elements in the frame by ARIA role.
   * @param role - ARIA role
   * @param options - Accessible name, and whether to match it exactly
   * @returns A locator
   */
  getByRole(role: string, options?: { name?: string; exact?: boolean }): Locator {
    return new Locator(this.host(), [{ kind: 'role', role, ...options }])
  }

  /**
   * Find elements in the frame by visible text.
   * @param text - Text to match
   * @param options - Whether to match exactly
   * @returns A locator
   */
  getByText(text: string, options?: { exact?: boolean }): Locator {
    return new Locator(this.host(), [{ kind: 'text', text, ...options }])
  }

  /**
   * Find a form control in the frame by its label.
   * @param text - Label text
   * @param options - Whether to match exactly
   * @returns A locator
   */
  getByLabel(text: string, options?: { exact?: boolean }): Locator {
    return new Locator(this.host(), [{ kind: 'label', text, ...options }])
  }

  /**
   * Find a control in the frame by placeholder text.
   * @param text - Placeholder text
   * @returns A locator
   */
  getByPlaceholder(text: string): Locator {
    return new Locator(this.host(), [{ kind: 'placeholder', text }])
  }

  /**
   * Find an element in the frame by its test id.
   * @param id - Value of the data-testid attribute
   * @returns A locator
   */
  getByTestId(id: string): Locator {
    return new Locator(this.host(), [{ kind: 'testid', id }])
  }

  /**
   * Find an element in the frame by its title attribute.
   * @param text - Title text
   * @returns A locator
   */
  getByTitle(text: string): Locator {
    return new Locator(this.host(), [{ kind: 'title', text }])
  }

  /**
   * Find an image in the frame by its alt text.
   * @param text - Alt text
   * @returns A locator
   */
  getByAltText(text: string): Locator {
    return new Locator(this.host(), [{ kind: 'altText', text }])
  }

  /**
   * A nested frame inside this one.
   * @param selector - How to find the inner frame
   * @returns A frame locator for the inner frame
   */
  frameLocator(selector: string): FrameLocator {
    return new FrameLocator(this.pageRef, selector)
  }

  /**
   * The locator host that finds the frame on demand.
   *
   * Every call re-resolves, so a frame that reloaded between two statements is found again
   * rather than addressed through a dead context.
   * @returns A host bound to this frame description
   */
  private host(): LocatorHost {
    const page = this.pageRef
    const selector = this.selector
    const resolve = async (): Promise<{
      evaluate: <T>(expr: string) => Promise<T>
      resolveMapper: () => Promise<ProtocolMapper>
      nodeIdForExpression: (expr: string) => Promise<number | null>
      nodeOffset: () => Promise<{ x: number; y: number }>
    }> => {
      try {
        return await page.frame(selector)
      } catch (err) {
        // Name the frame, not just the element inside it. "no element matched" sends the
        // reader hunting through the frame's contents for something that was never loaded.
        throw new HostResolutionError(
          `frameLocator(${JSON.stringify(selector)}) could not find that frame: ${(err as Error).message}`
        )
      }
    }
    return {
      evaluate: async <T,>(expression: string): Promise<T> => (await resolve()).evaluate<T>(expression),
      resolveMapper: async (): Promise<ProtocolMapper> => (await resolve()).resolveMapper(),
      nodeIdForExpression: async (expression: string): Promise<number | null> =>
        (await resolve()).nodeIdForExpression(expression),
      nodeOffset: async (): Promise<{ x: number; y: number }> => (await resolve()).nodeOffset(),
      page: (): Page => page,
    }
  }
}
