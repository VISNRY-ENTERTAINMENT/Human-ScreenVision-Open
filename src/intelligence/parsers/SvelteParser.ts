import { ComponentEntry } from '../../core/types'
import { HTMLParser } from './HTMLParser'
import { buildTemplateEntries } from './VueParser'

/**
 * Parses Svelte components: strips `<script>`/`<style>` blocks and Svelte
 * logic blocks, then treats the remaining markup like a Vue template.
 */
export class SvelteParser {
  private html = new HTMLParser()

  /**
   * Parse a `.svelte` file.
   * @param filePath - Absolute path
   * @param sourceCode - Component source
   * @returns Component entries (root component named after the file)
   */
  async parseFile(filePath: string, sourceCode: string): Promise<ComponentEntry[]> {
    const markup = sourceCode
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/\{[#:/@][^}]*\}/g, '') // {#if}, {:else}, {/each}, {@html}
    if (!markup.trim()) return []
    return buildTemplateEntries(this.html, filePath, markup)
  }
}
