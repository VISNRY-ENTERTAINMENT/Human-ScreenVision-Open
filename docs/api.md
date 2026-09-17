# ScreenVision API

All types are exported from the package root (`import { LaunchOptions } from 'screenvision'`).

## `ScreenVision`

```ts
const sv = new ScreenVision()            // or: import screenvision from 'screenvision'
sv.launch(options?: LaunchOptions): Promise<Browser>
sv.chromium.launch(options?)             // the only engine that works
sv.devices                               // Record<string, DeviceDescriptor>
```

`sv.firefox.launch()` and `sv.webkit.launch()` exist on the type but throw. This library
speaks the Chrome DevTools Protocol; Firefox removed its CDP endpoint and WebKit never had
one. A WebDriver BiDi driver for Firefox is in `src/bidi`, with unit tests passing against a
mock and no verification against real Gecko yet, so it is not wired in.

`LaunchOptions`: `browserType`, `headless` (default true), `executablePath`, `args`,
`timeout` (30000), `codebase` (enables the code index), `framework`
(`react | vue | svelte | html | auto`), `visionEndpoint`, `visionApiKey`.

## `Browser`

| Method | Description |
|---|---|
| `newContext(options?)` | Isolated context; `options.device` (name or descriptor) or `options.viewport` enables device emulation + expectations |
| `newPage()` | New context + page |
| `contexts()` | Live contexts |
| `browserType()` | `'chromium' \| 'firefox' \| 'webkit'` |
| `version()` | `Browser.getVersion` product string |
| `codeIndexResult()` | The `CodeIndexResult` built at launch, or null |
| `close()` | Closes pages, contexts, CDP connection and the process |

## `BrowserContext`

`newPage()`, `pages()`, `addCookies(cookies)`, `cookies(urls?)`, `clearCookies()`,
`storageState()`, `route(pattern, handler, options?)`, `close()`.
Read-only: `deviceExpectations: DeviceExpectations | null`, `device: DeviceDescriptor | null`.

## `Page`

### Navigation
`goto(url, options?)`, `reload(options?)`, `goBack()`, `goForward()`, `title()`, `url()`.
`NavigateOptions.waitUntil`: `load` (default) | `domcontentloaded` | `networkidle` | `commit`.

### DOM
`$(selector)`, `$$(selector)`, `evaluate(expressionOrFn, arg?)`.

### Semantic
```ts
find(description, options?): Promise<ElementHandle>          // throws when not found
findOrNull(description, options?): Promise<ElementHandle | null>
findAll(description, options?): Promise<ElementHandle[]>
findResolved(description, options?): Promise<ResolvedElement> // + strategy, confidence, selector, bbox
```
`FindOptions`: `timeout` (30000), `strategy` (`code-index | dom | vision | auto`), `context` hint.

### Screenshots
`screenshot(options?)`, `screenshotElement(description, options?)`.
`ScreenshotOptions`: `type` (`png | jpeg | webp`), `quality`, `fullPage`, `clip`,
`omitBackground`, `annotate: AnnotationSpec[]`, `path`.
`AnnotationSpec`: `{ element? | bbox?, label?, style, color? }` with style
`circle | highlight | arrow | box | crosshair | label-only`.

### Verification
```ts
verify(options: VerifyOptions): Promise<VerificationResult>
verifyElement(description): Promise<boolean>
```
`VerifyOptions`: `contains`, `notContains`, `layout { columns, navigationVisible, mobileMenuVisible }`,
`device`, `timeout` (per element, default 2000).
`VerificationResult`: `pass`, `score`, `issues[] { severity, element, message, expected, actual, bbox }`,
`checkedElements[]`, `screenshotBuffer` (annotated PNG when issues exist), `durationMs`.

### Interaction
`click`, `fill`, `press`, `selectOption`, `focus`, `hover`, `check`, `uncheck` (all take a CSS selector),
`keyboard.press/type/down/up`, `mouse.move/click/down/up`.

### Waiting
`waitForSelector(selector, { state, timeout })`, `waitForNavigation`, `waitForNetworkIdle`,
`waitForFunction(expression)`, `waitForTimeout(ms)`.

### Events, network, misc
`on('console' | 'dialog' | 'load' | 'close', handler)`, `off(event, handler)`,
`route(pattern, handler, { times })`, `unroute(pattern)`,
`addScriptTag`, `addStyleTag`, `setContent(html)`, `content()`, `close()`, `isClosed()`, `viewportSize()`.

## `ElementHandle`

`click`, `fill`, `press`, `selectOption`, `focus`, `hover`, `scrollIntoViewIfNeeded`,
`boundingBox()` (viewport CSS px, null when hidden), `getAttribute`, `textContent`, `innerHTML`,
`inputValue`, `isVisible`, `isEnabled`, `isChecked`, `$`, `$$`, `screenshot(options?)` (8 px padding),
`verify(options)` (scoped to the element's subtree), `evaluate(fn)`.
Read-only: `nodeId`, `selector`.

## Intelligence

```ts
CodeIndex.build(path, framework = 'auto'): Promise<CodeIndexResult>
CodeIndex.detectFramework(path) / findSourceFiles(path, framework)
CodeIndex.inferSemanticRole(name, source): SemanticRole
CodeIndex.inferPosition(role): ExpectedPosition

DeviceContext.getDevice(name) / buildExpectations(device) / deviceNames()
DEVICES: 'iPhone 15', 'iPhone 15 Pro Max', 'iPad Pro 12.9', 'Galaxy S24',
        'MacBook Pro 16', 'Desktop 1920x1080', 'Desktop 1440x900'

new ElementResolver(codeIndex | null, visionResolver | null).resolve(query, page, options?, scope?)
new VerificationEngine(resolver, annotationEngine, deviceExpectations | null).verify(page, options, scope?)
new AnnotationEngine().annotate(buffer, annotations): Promise<Buffer>   // PNG
```

`ComponentEntry`: `name`, `filePath`, `selector`, `alternateSelectors`, `parentComponent`,
`childComponents`, `semanticRole`, `expectedPosition`, `testIds`, `ariaLabels`, `cssClasses`.

## Vision

```ts
new VisionClient(endpoint, apiKey, modelId = 'claude-sonnet-4-6').query({ imageBase64, imageMediaType, prompt, maxTokens? })
new VisionResolver(client).findElement(pngBuffer, query)   // { found, bbox?, confidence }
new VisionResolver(client).detectDevice(pngBuffer)         // { device, widthEstimate }
```
Constructed by `Page` only when `LaunchOptions.visionEndpoint` is set. The request body
follows the Anthropic Messages format; responses in Anthropic, OpenAI-style or plain
`{ text }` shapes are parsed.

## Low level

`BrowserLauncher.findExecutable(type, override?)`, `BrowserLauncher.launch(options)`,
`BrowserLauncher.kill(process)`; `CDPClient` (`connect`, `send`, `on`, `off`, `close`);
`CDPSession`; `ProtocolMapper` (one method per CDP-backed operation, see source).
Set `SV_DEBUG=1` to log launches and CDP traffic.

## `Locator`

Lazy: resolved on every use, so it survives a re-render that would invalidate an
`ElementHandle`. Built from `page.locator`, `page.getByRole`, `page.getByText`,
`page.getByLabel`, `page.getByPlaceholder`, `page.getByTestId`, `page.getByTitle`,
`page.getByAltText`.

| Method | Description |
|---|---|
| `locator`, `getBy*` | Narrow to descendants; chains |
| `filter({ hasText, hasNotText })` | Keep or drop matches by their text |
| `nth(i)`, `first()`, `last()` | Pick one; `nth` accepts a negative index |
| `count()`, `all()` | How many, and every match as a handle |
| `click`, `fill`, `check`, `uncheck`, `selectOption`, `press`, `hover`, `tap` | Act, waiting for actionability |
| `textContent`, `inputValue`, `isVisible`, `isEnabled` | Read |
| `waitFor`, `elementHandle` | Resolve, with a timeout |

## Agent API

| Method | Description |
|---|---|
| `page.observe(options?)` | Regions, available actions with stable `ref`s, text, and notices. `maxAffordances` defaults to 60; what is dropped is reported in `truncated` |
| `page.act(request)` | Perform an action and return a verdict of `confirmed`, `no-effect`, `unexpected` or `blocked`, with the effects measured |
| `page.actions()` | Every action performed, in order, with its evidence |
| `page.findCandidates(desc)` | Every element that could match, ranked, with the reason for each score |

## Assertions

`page.expect(descriptionOrLocator)` returns an `Expectation`; every matcher retries until it
holds or its timeout expires, and `.not` inverts.

`toBeVisible`, `toBeHidden`, `toExist`, `toBeEnabled`, `toBeDisabled`, `toBeChecked`,
`toBeFocused`, `toBeEmpty`, `toBeEditable`, `toHaveText`, `toHaveExactText`, `toHaveValue`,
`toHaveAttribute`, `toHaveClass`, `toHaveCSS`, `toHaveCount` (locator only), `toHaveScreenshot`.

Page level: `page.expectURL(stringOrRegExp)`, `page.expectTitle(stringOrRegExp)`,
`page.expectScreenshot(name, options?)`.

## Frames, popups and network

| Method | Description |
|---|---|
| `page.frame(selectorOrNameOrUrl)`, `page.frames()`, `page.mainFrame()` | Same-origin and cross-origin frames |
| `context.waitForPage(options?)` | The next page the site opens itself |
| `page.on('request' \| 'response' \| 'requestfailed')` | Network events; a response body is readable inside the handler |
| `page.waitForResponse(match)`, `page.waitForRequest(match)` | `match` is a substring, a glob, a regular expression or a predicate |
| `page.waitForDownload(options?)` | Resolves with `path` and `saveAs` |
| `context.request` | HTTP calls outside the browser, sharing its cookies both ways |

## Time, input and capture

| Method | Description |
|---|---|
| `page.clock` | `install`, `tick`, `runFor`, `setTime`, `now`, `uninstall`. Installed before the page's own scripts run |
| `page.touchscreen` | `tap(x, y)`, `swipe(from, to)`; `tap()` also on handles and locators |
| `handle.setInputFiles(paths)` | Attach files; refuses anything that is not a file input |
| `handle.dragTo(target)` | Native HTML5 drag or pointer drag; refuses to report success when nothing changed |
| `handle.visibility()` | Rendering, viewport position and what occludes it, as separate facts |
| `page.trace` | `start`, `note`, `stop`, `discard`; writes one self-contained HTML file |
| `page.record` | Codegen: `start`, `stop`, `writeTest` |

## Running

`Runner` runs jobs in parallel, each in its own context, with timeouts, retries and traces on
failure. `writeJUnitReport(results, path)` emits XML for CI. A small test runner provides
`describe`, `it`, `it.only`, `it.skip`, `beforeEach`, `afterEach`, `expect` and `runTests`,
reachable from the command line as `screenvision test <files>`.
