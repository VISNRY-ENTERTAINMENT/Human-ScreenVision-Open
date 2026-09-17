import fs from 'fs'
import path from 'path'
import type { ProtocolMapper } from '../cdp/ProtocolMapper'
import type { Page } from './Page'

/**
 * A file picker the page opened, intercepted before the operating system sees it.
 *
 * A native file dialog is the hardest kind of dead end in an automated run: it is not part of
 * the page, so nothing in the DOM can dismiss it, and the run simply stops. Intercepting the
 * request means the dialog never opens; the page is told which files were "chosen" instead.
 *
 * This exists alongside `setInputFiles` because the two solve different problems.
 * `setInputFiles` works when you can find the `<input type="file">` yourself. Plenty of
 * applications hide the input entirely and open the picker from a button, and then the only
 * thing you can observe is the request for a dialog.
 */
export class FileChooser {
  /**
   * @param pageRef - Page whose dialog was intercepted
   * @param mapper - Protocol mapper owning the input element
   * @param backendNodeId - The `<input type="file">` behind the dialog
   * @param multiple - Whether the page asked for more than one file
   */
  constructor(
    private pageRef: Page,
    private mapper: ProtocolMapper,
    private backendNodeId: number,
    private multiple: boolean
  ) {}

  /** The page that opened the picker. */
  page(): Page {
    return this.pageRef
  }

  /** Whether the page asked for more than one file. */
  isMultiple(): boolean {
    return this.multiple
  }

  /**
   * Answer the picker with these files.
   *
   * Paths are checked here rather than passed straight through, because the protocol accepts
   * a path that does not exist without complaint and the page then receives an empty
   * selection — a silent wrong answer of exactly the kind this library exists to avoid.
   * @param files - One or more paths, absolute or relative to the working directory
   */
  async setFiles(files: string | string[]): Promise<void> {
    const list = (Array.isArray(files) ? files : [files]).map((f) => path.resolve(f))
    const missing = list.filter((f) => !fs.existsSync(f))
    if (missing.length > 0) {
      throw new Error(
        `FileChooser.setFiles: ${missing.length === 1 ? 'this file does not exist' : 'these files do not exist'}: ` +
          `${missing.join(', ')}. The protocol accepts a missing path silently and the page would ` +
          `receive an empty selection.`
      )
    }
    if (!this.multiple && list.length > 1) {
      throw new Error(
        `FileChooser.setFiles: the page asked for a single file but ${list.length} were given. ` +
          `Only the first would be delivered, so this is refused rather than quietly dropping the rest.`
      )
    }
    await this.mapper.setFileInputFilesByBackendId(this.backendNodeId, list)
  }
}
