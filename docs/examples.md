# ScreenVision examples

## Plain automation (no code index)

```ts
import screenvision from 'screenvision'

const browser = await screenvision.launch()
const page = await browser.newPage()
await page.goto('https://example.com')
await page.fill('#email', 'test@test.com')
await page.click('button[type="submit"]')
await page.waitForSelector('.dashboard', { state: 'visible' })
console.log(await page.title())
await browser.close()
```

## Semantic find with and without source access

```ts
// With the code index: NavBar's [data-testid="navbar"] is tried first.
const browser = await screenvision.launch({ codebase: './src', framework: 'react' })
const page = await browser.newPage()
await page.goto('http://localhost:3000')

const r = await page.findResolved('navigation bar')
console.log(r.strategy, r.confidence, r.selector, r.componentName)
// → 'code-index' 0.8 '[data-testid="navbar"]' 'NavBar'

// Without a code index the DOM tier answers: role → tag → attributes.
const login = await page.find('login button')     // matches [aria-label*="login" i]
await login.click()
```

## Element screenshots and annotations

```ts
const nav = await page.find('navigation bar')
await nav.screenshot({ path: 'out/nav.png' })          // element + 8px padding

await page.screenshot({
  fullPage: true,
  path: 'out/annotated.png',
  annotate: [
    { element: nav, style: 'highlight', label: 'Navigation' },
    { element: await page.find('hero section'), style: 'circle', label: 'Hero' },
    { bbox: { x: 20, y: 20, width: 100, height: 30 }, style: 'arrow', label: 'Here', color: '#34C759' },
  ],
})
```

## Verification across devices

```ts
const desktop = await (await browser.newContext({ device: 'Desktop 1440x900' })).newPage()
await desktop.goto('http://localhost:3000')
const d = await desktop.verify({
  contains: ['navigation bar', 'hero section', 'footer'],
  notContains: ['modal'],
  layout: { navigationVisible: true, columns: 3 },
})

const mobile = await (await browser.newContext({ device: 'iPhone 15' })).newPage()
await mobile.goto('http://localhost:3000')
const m = await mobile.verify({ contains: ['hamburger menu'] })
if (!m.pass) {
  for (const issue of m.issues) console.log(issue.severity, issue.element, issue.message)
  await require('fs/promises').writeFile('out/mobile-issues.png', m.screenshotBuffer!)
}
```

## Scoped verification

```ts
const nav = await page.find('navigation bar')
const result = await nav.verify({ contains: ['login button'] })   // searched inside <nav> only
```

## Network interception and events

```ts
await page.route('**/api/**', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
)
page.on('console', (msg) => console.log(`[page:${msg.type()}]`, msg.text()))
page.on('dialog', (dialog) => dialog.accept())
```

## Using the code index directly

```ts
import { CodeIndex } from 'screenvision'

const index = await CodeIndex.build('./src')          // framework auto-detected
for (const [name, entry] of index.components) {
  console.log(name, entry.semanticRole, entry.selector, entry.childComponents)
}
```

## Vision fallback

```ts
const browser = await screenvision.launch({
  visionEndpoint: 'https://api.anthropic.com/v1/messages',
  visionApiKey: process.env.ANTHROPIC_API_KEY,
})
// find() now falls through to the vision tier when code index and DOM tiers miss.
const el = await (await browser.newPage()).find('the blue "Buy now" button', { strategy: 'vision' })
```
