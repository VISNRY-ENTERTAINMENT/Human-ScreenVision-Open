# Human ScreenVision Open

Browser automation for AI agents. It speaks the Chrome DevTools Protocol directly, with no
Playwright or Puppeteer dependency, and adds two things a conventional automation library does
not have: a compact model of what is on screen, and proof of what an action actually did.

The library is imported as `screenvision`.

```typescript
import screenvision from 'screenvision'

const browser = await screenvision.launch({ headless: true })
const context = await browser.newContext({ device: 'Desktop 1440x900' })
const page = await context.newPage()
await page.goto('http://localhost:3000')

// what can I do here?
const view = await page.observe()
const submit = view.affordances.find((a) => a.role === 'button' && a.name === 'Submit')

// do it, and find out whether it worked
const result = await page.act({ do: 'click', ref: submit.ref })
if (!result.ok) console.log(result.summary)
```

## Two ways to use it

**As a test framework — the way you use Playwright Test.** Each test gets its own isolated page.

```typescript
import { test, expect, describe } from 'screenvision'

describe('checkout', () => {
  test('the Pay button charges the card', async (page) => {
    await page.goto('http://localhost:3000/cart')
    await page.getByRole('button', { name: 'Pay' }).click()
    await page.expect(page.getByText('Payment received')).toBeVisible()
  })
})
```

Run them with `npx screenvision test tests/` (`npx tsx screenvision test tests/` for TypeScript
files). Options: `--workers`, `--timeout`, `--grep`, `--trace-dir`. `test`, `it`, `describe`,
`beforeEach`, `afterEach`, `expect`, and `defineFixture` are all exported.

**As an MCP server — the way you use Playwright MCP.** Point any MCP client (Claude Desktop, Claude
Code, …) at it and the agent drives a real browser through tools:

```json
{ "mcpServers": { "screenvision": { "command": "npx", "args": ["screenvision-mcp"] } } }
```

Tools: `browser_navigate`, `browser_snapshot` (a compact, ref-addressable model of the page —
regions, every available action with a stable `ref`, and blocking conditions), `browser_act` /
`browser_click` / `browser_fill` (actions that report whether they actually did anything, so a dead
button comes back as `no-effect` rather than a false success), `browser_get_text`,
`browser_screenshot`, `browser_close`. The agent snapshots, reads a `ref`, and acts by ref — it never
invents a CSS selector. Run `npm run build` first; set `SCREENVISION_MCP_HEADLESS=0` to watch it.

## What makes it different

**`observe()` — a page model an agent can afford.** Landmark regions, every currently
available action with a stable `ref`, the readable text, and a short list of conditions an
agent would otherwise discover only by failing, such as a modal covering the page. On a
300-row dashboard it is about 1,000 tokens against 2,400 for Playwright's aria snapshot and
37,500 for the raw markup. Acting by `ref` removes the step where an agent invents a selector
and gets it wrong.

**`act()` — actions that prove themselves.** Every automation library resolves a click when
the event is dispatched, which is equally true of a button that worked, a button whose handler
crashed, and a button with no handler at all. `act()` records what actually changed and
returns a verdict, with `no-effect` as a first-class outcome:

```
click on #subscribe was performed, but nothing changed: no navigation, no DOM mutation and no
network request. Diagnosis: the element has no event listener on it or any ancestor, no href,
and is not a form submit control, so activating it cannot do anything.
```

It stays cheap by watching mutations rather than diffing snapshots, so cost scales with what
changed, not with page size. Actions whose effect is a value rather than a DOM change, such as
`fill`, are confirmed by reading the value back, which catches a field that silently rejected
what was typed.

**`verify()` — checking a page against what it should be.** Names regions rather than
selectors, understands what a device implies, and orders findings by cause: a missing viewport
meta tag is reported as the root cause with the hamburger and desktop-nav symptoms beneath it.
Results carry a per-check status of pass, fail or could-not-run, so a genuine regression is
never confused with a check that never ran.

## The rest of the surface

Familiar if you know Playwright, and intended to be.

| | |
|---|---|
| Locators | `page.locator`, `getByRole`, `getByText`, `getByLabel`, `getByPlaceholder`, `getByTestId`, `getByTitle`, `getByAltText`, with `filter`, `nth`, `first`, `last`, `all`, `count` |
| Actions | `click`, `dblclick`, `fill`, `clear`, `check`, `selectOption`, `press`, `hover`, `tap`, `dragTo`, `setInputFiles`, `mouse.wheel` |
| Waiting | `waitForSelector`, `waitForResponse`, `waitForRequest`, `waitForDownload`, `waitForNavigation`, `waitForLoadState`, `waitForURL`, `waitForFunction` |
| Assertions | `page.expect(...)` with auto-retrying matchers (`toBeVisible`, `toHaveText`, `toHaveValue`, `toBeChecked`, `toHaveRole`, `toHaveAccessibleName`, `toBeInViewport`, `toMatchAriaSnapshot`, and more); `expectURL`, `expectTitle`, `expectScreenshot` |
| Frames | `page.frame(...)`, `page.frames()`, same-origin and cross-origin |
| Pages the site opens | `context.waitForPage()` for `target="_blank"`, `window.open` and OAuth popups |
| Network | `page.route`, `page.on('request' \| 'response' \| 'requestfailed')`, `context.request` for calls outside the browser sharing its cookies |
| Emulation | device descriptors, touch, geolocation, `page.clock` for controlling time |
| Capture | screenshots, element screenshots, annotation, visual comparison against baselines |
| Tracing | `page.trace` writes one self-contained HTML file with a screenshot, DOM snapshot, network panel and the verdict for every action |
| Running | `Runner` for parallel jobs, and a small test runner with a `screenvision test` command |
| Codegen | `page.record` turns a hand-driven flow into a script |

Shadow DOM is pierced by queries, `observe()` and the matcher, so a page built from web
components is not reported as empty.

## Install and run

```bash
npm install
npm run build
npx screenvision test tests/          # TypeScript tests need: npx tsx screenvision test tests/
```

Requires Node 20 or later and a Chromium-based browser. It finds Chrome or Edge automatically;
pass `executablePath` to choose one.

## What it does not do

Stated plainly, because the point of this library is not overstating what happened.

- **Chromium first; Firefox via WebDriver BiDi.** The primary engine speaks the Chrome DevTools
  Protocol. Firefox removed its CDP endpoint and WebKit never had one, so those need WebDriver
  BiDi. The Firefox driver in `src/bidi` has its unit tests passing and its end-to-end suite
  passing against real Firefox on Linux; WebKit is not yet supported.
- **No trace viewer of Playwright's depth.** The trace records a DOM snapshot per step and you
  can step back through a run, but there is no time-travel debugging or source integration.
- **A small test runner, not a framework.** No watch mode, no fixtures beyond a page per test,
  no plugins, no sharding across machines. If you already run Vitest or Jest, call this library
  from inside it; that is fully supported and probably better.
- **`act()` proves that an effect happened, not that it was the right one.** A click that does
  the wrong thing on a page that responds correctly is reported as confirmed. Verifying intent
  is a different and unsolved problem.

## Honest benchmarks

Measured against Playwright 1.63 driving the same browser.

| | ScreenVision | Playwright |
|---|---|---|
| Core automation, 15 tasks | 15 / 15 | 15 / 15 |
| Detecting 12 planted defects from a generic spec | 9 / 12 | 3 / 12 |
| Knowing whether an action did anything | 6 / 6 | 2 / 6 |
| Understanding a 300-row page | ~1,000 tokens | ~2,400 tokens |
| 12 jobs on 4 workers | at parity | at parity |

Two qualifications the numbers need. Playwright's 2 / 6 is bare `click()` with no verification;
a caller who checks their own work with about 25 lines of document fingerprinting reaches the
same outcomes, so what `act()` buys is less code and a real diagnosis rather than an otherwise
unobtainable capability. And the 12-defect comparison is against a generic spec: both reach
12 / 12 when the author already knows what broke, at 26 lines for Playwright against 5.
