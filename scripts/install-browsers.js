#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * ScreenVision browser installer.
 *
 * Downloads a Chromium build from Playwright's browser CDN into
 *   $HOME/.screenvision/browsers/chromium/
 * and marks the binary executable. Run once via:
 *   npm run install-browsers        (or)   npx screenvision install
 *
 * Environment overrides:
 *   SCREENVISION_CHROMIUM_REVISION   Playwright chromium build number (default below)
 *   SCREENVISION_BROWSERS_PATH       alternative install root
 *   HTTPS_PROXY / https_proxy        honoured by Node's fetch when undici proxy support is enabled
 */
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const https = require('https')
const { spawnSync } = require('child_process')

// Playwright chromium build numbers are monotonically increasing; this one
// corresponds to the Chromium 130 line shipped with Playwright 1.48.
const DEFAULT_REVISION = '1140'
const HOSTS = ['https://cdn.playwright.dev/builds', 'https://playwright.azureedge.net/builds']

function detectPlatform() {
  const platform = process.platform
  const arch = process.arch
  if (platform === 'win32') return arch === 'x64' ? 'win64' : 'win32'
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac'
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux'
  throw new Error(`Unsupported platform: ${platform}/${arch}`)
}

function installRoot() {
  return process.env.SCREENVISION_BROWSERS_PATH || path.join(os.homedir(), '.screenvision', 'browsers')
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'))
    const file = fs.createWriteStream(dest)
    const req = https.get(url, { headers: { 'user-agent': 'screenvision-installer' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close()
        fs.rmSync(dest, { force: true })
        const next = new URL(res.headers.location, url).toString()
        return resolve(download(next, dest, redirects + 1))
      }
      if (res.statusCode !== 200) {
        file.close()
        fs.rmSync(dest, { force: true })
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }
      const total = Number(res.headers['content-length'] || 0)
      let received = 0
      let lastPct = -1
      res.on('data', (chunk) => {
        received += chunk.length
        if (total) {
          const pct = Math.floor((received / total) * 100)
          if (pct !== lastPct && pct % 10 === 0) {
            lastPct = pct
            process.stdout.write(`\r  downloading… ${pct}%`)
          }
        }
      })
      res.pipe(file)
      file.on('finish', () => {
        process.stdout.write('\n')
        file.close(resolve)
      })
    })
    req.on('error', (err) => {
      file.close()
      fs.rmSync(dest, { force: true })
      reject(err)
    })
  })
}

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  const attempts = [
    // bsdtar (Windows 10+, macOS) understands zip archives
    { cmd: 'tar', args: ['-xf', zipPath, '-C', destDir] },
    { cmd: 'unzip', args: ['-q', '-o', zipPath, '-d', destDir] },
  ]
  if (process.platform === 'win32') {
    attempts.push({
      cmd: 'powershell',
      args: ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`],
    })
  }
  const errors = []
  for (const attempt of attempts) {
    const result = spawnSync(attempt.cmd, attempt.args, { stdio: 'ignore' })
    if (result.status === 0) return
    errors.push(`${attempt.cmd}: ${result.error ? result.error.message : `exit ${result.status}`}`)
  }
  throw new Error(`Could not extract ${zipPath}. Tried: ${errors.join('; ')}`)
}

function findBinary(dir, names, depth = 4) {
  if (depth < 0) return null
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) if (e.isFile() && names.includes(e.name.toLowerCase())) return path.join(dir, e.name)
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = findBinary(path.join(dir, e.name), names, depth - 1)
      if (found) return found
    }
  }
  return null
}

async function main() {
  const args = process.argv.slice(2)
  if (args[0] && args[0] !== 'install' && args[0] !== 'chromium') {
    console.log('Usage: screenvision install [chromium]')
    process.exit(args[0] === '--help' || args[0] === '-h' ? 0 : 1)
  }
  const revision = process.env.SCREENVISION_CHROMIUM_REVISION || DEFAULT_REVISION
  const platform = detectPlatform()
  const root = path.join(installRoot(), 'chromium')
  const binaryNames = ['chrome.exe', 'chrome', 'chromium', 'chromium-browser', 'Chromium']

  const existing = findBinary(root, binaryNames)
  if (existing && !args.includes('--force')) {
    console.log(`Chromium already installed: ${existing}`)
    return
  }

  fs.mkdirSync(root, { recursive: true })
  const zipName = `chromium-${platform}.zip`
  const zipPath = path.join(root, zipName)
  let lastError = null
  for (const host of HOSTS) {
    const url = `${host}/chromium/${revision}/${zipName}`
    console.log(`Downloading ${url}`)
    try {
      await download(url, zipPath)
      lastError = null
      break
    } catch (err) {
      lastError = err
      console.log(`  failed: ${err.message}`)
    }
  }
  if (lastError) throw new Error(`All download hosts failed: ${lastError.message}`)

  console.log(`Extracting to ${root}`)
  extractZip(zipPath, root)
  fs.rmSync(zipPath, { force: true })

  const binary = findBinary(root, binaryNames)
  if (!binary) throw new Error(`Extraction finished but no Chromium binary was found under ${root}`)
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(binary, 0o755)
      // Helper binaries next to the main executable also need +x.
      for (const e of fs.readdirSync(path.dirname(binary))) {
        const p = path.join(path.dirname(binary), e)
        if (fs.statSync(p).isFile()) fs.chmodSync(p, 0o755)
      }
    } catch (err) {
      console.log(`  warning: chmod failed: ${err.message}`)
    }
  }
  console.log(`Chromium ${revision} installed: ${binary}`)
  console.log('ScreenVision will find it automatically; or set SCREENVISION_CHROMIUM_PATH to override.')
}

main().catch((err) => {
  console.error(`install-browsers failed: ${err.message}`)
  process.exit(1)
})
