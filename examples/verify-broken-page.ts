/**
 * Independent end-to-end check of ScreenVision (written by hand, outside the test suite).
 *
 * Serves TWO versions of the same page:
 *   good.html   — nav with 3 links + login button, hero, footer
 *   broken.html — the SAME page with the third nav link deleted and the footer removed
 *
 * Then asks ScreenVision, with no CSS selectors, to:
 *   1. find the navigation bar and the hero on the good page,
 *   2. verify the good page passes,
 *   3. verify the broken page FAILS and says which elements are missing,
 *   4. check the mobile (iPhone 15) expectation that a hamburger is present,
 *   5. save an annotated screenshot of the broken page.
 *
 * Run: npx tsx examples/verify-broken-page.ts   (or: npm run build && node dist-examples/…)
 */
import http from 'http'
import fs from 'fs/promises'
import path from 'path'
import screenvision from '../src/index'

const NAV_LINKS_GOOD = `
      <ul class="nav-links">
        <li><a href="/features">Features</a></li>
        <li><a href="/pricing">Pricing</a></li>
        <li><a href="/docs">Docs</a></li>
      </ul>`
const NAV_LINKS_BROKEN = `
      <ul class="nav-links">
        <li><a href="/features">Features</a></li>
        <li><a href="/pricing">Pricing</a></li>
      </ul>`

function page(navLinks: string, withFooter: boolean): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>ScreenVision demo</title>
<style>
  body { margin:0; font-family: system-ui, sans-serif }
  .navbar { display:flex; align-items:center; gap:24px; padding:16px 24px; background:#111; color:#fff }
  .nav-links { display:flex; gap:16px; list-style:none; margin:0; padding:0 }
  .nav-links a { color:#fff; text-decoration:none }
  .hero { padding:64px 24px; background:#f5f5f7 }
  .hamburger { display:none; margin-left:auto; min-width:44px; min-height:44px }
  footer { padding:24px; background:#111; color:#999 }
  @media (max-width: 480px) { .nav-links { display:none } .hamburger { display:block } }
</style></head>
<body>
  <nav data-testid="navbar" class="navbar" role="navigation" aria-label="main navigation">
    <div class="nav-logo">Acme</div>${navLinks}
    <button class="nav-login" aria-label="login">Login</button>
    <button class="hamburger" aria-label="menu">&#9776;</button>
  </nav>
  <section data-testid="hero" class="hero">
    <h1>Build faster with AI</h1>
    <p>The code-aware browser automation library</p>
    <button data-testid="hero-cta" class="btn-primary">Get Started</button>
  </section>
  ${withFooter ? '<footer data-testid="site-footer">&copy; 2026 Acme</footer>' : ''}
</body></html>`
}

async function main(): Promise<void> {
  const server = http.createServer((req, res) => {
    const broken = (req.url ?? '').startsWith('/broken')
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(page(broken ? NAV_LINKS_BROKEN : NAV_LINKS_GOOD, !broken))
  })
  await new Promise<void>((r) => server.listen(9911, r))
  const base = 'http://127.0.0.1:9911'
  const outDir = path.join(__dirname, 'output')
  await fs.mkdir(outDir, { recursive: true })

  const browser = await screenvision.launch({ headless: true })
  const results: string[] = []
  try {
    // ---- 1 + 2: the good page --------------------------------------------------
    const desktop = await browser.newContext({ device: 'Desktop 1440x900' })
    const good = await desktop.newPage()
    await good.goto(`${base}/good`)

    const nav = await good.find('navigation bar')      // no selector given
    const hero = await good.find('hero section')
    const navBox = await nav.boundingBox()
    const heroBox = await hero.boundingBox()
    results.push(`find('navigation bar') -> ${nav.selector} at y=${navBox?.y}`)
    results.push(`find('hero section')   -> ${hero.selector} at y=${heroBox?.y}`)
    if (!navBox || !heroBox || navBox.y >= heroBox.y) throw new Error('nav should sit above hero')

    const okResult = await good.verify({ contains: ['navigation bar', 'hero section', 'footer'] })
    results.push(`verify(good)   pass=${okResult.pass} score=${okResult.score.toFixed(2)} issues=${okResult.issues.length}`)

    // ---- 3: the broken page ----------------------------------------------------
    const bad = await desktop.newPage()
    await bad.goto(`${base}/broken`)
    const badResult = await bad.verify({ contains: ['navigation bar', 'hero section', 'footer'] })
    results.push(`verify(broken) pass=${badResult.pass} score=${badResult.score.toFixed(2)}`)
    for (const issue of badResult.issues) results.push(`   issue: [${issue.severity}] ${issue.message}`)

    // the third nav link is gone: count links inside the resolved nav element
    const badNav = await bad.find('navigation bar')
    const linkCount = await badNav.evaluate((el) => el.querySelectorAll('a').length)
    results.push(`nav links on broken page: ${linkCount} (good page has 3)`)

    // ---- 4: mobile expectations ------------------------------------------------
    const mobile = await browser.newContext({ device: 'iPhone 15' })
    const phone = await mobile.newPage()
    await phone.goto(`${base}/good`)
    const hamburger = await phone.findOrNull('hamburger menu', { timeout: 2000 })
    const mobileResult = await phone.verify({ contains: ['navigation bar', 'hero section'] })
    results.push(`iPhone 15: hamburger found=${hamburger !== null}; verify pass=${mobileResult.pass}`)
    for (const issue of mobileResult.issues) results.push(`   mobile issue: [${issue.severity}] ${issue.message}`)

    // ---- 5: annotated screenshot of the broken page ----------------------------
    const shot = await bad.screenshot({
      annotate: [
        { element: badNav, style: 'box', label: 'nav: missing 3rd link' },
        { element: await bad.find('hero section'), style: 'highlight', label: 'hero OK' },
      ],
    })
    const shotPath = path.join(outDir, 'broken-annotated.png')
    await fs.writeFile(shotPath, shot)
    results.push(`annotated screenshot: ${shotPath} (${(shot.length / 1024).toFixed(0)} KB)`)

    const elementShot = await bad.screenshotElement('navigation bar')
    await fs.writeFile(path.join(outDir, 'nav-element.png'), elementShot)
    results.push(`element screenshot: nav-element.png (${(elementShot.length / 1024).toFixed(0)} KB)`)
  } finally {
    await browser.close()
    server.close()
  }
  process.stdout.write(results.join('\n') + '\n')
}

main().catch((err) => {
  process.stderr.write(String(err?.stack ?? err) + '\n')
  process.exit(1)
})
