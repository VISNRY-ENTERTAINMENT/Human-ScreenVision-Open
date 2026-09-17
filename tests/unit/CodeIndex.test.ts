import { describe, it, expect } from 'vitest'
import { CodeIndex } from '../../src/intelligence/CodeIndex'
import path from 'path'

const FIXTURE_PATH = path.join(__dirname, '../fixtures/react-app')

describe('CodeIndex', () => {

  it('detects React framework from package.json', async () => {
    const framework = await CodeIndex.detectFramework(FIXTURE_PATH)
    expect(framework).toBe('react')
  })

  it('finds JSX source files', async () => {
    const files = await CodeIndex.findSourceFiles(FIXTURE_PATH, 'react')
    expect(files.length).toBeGreaterThan(0)
    expect(files.some(f => f.endsWith('.tsx'))).toBe(true)
  })

  it('builds index with NavBar component', async () => {
    const index = await CodeIndex.build(FIXTURE_PATH, 'react')
    expect(index.components.has('NavBar')).toBe(true)
  })

  it('NavBar gets correct semantic role', async () => {
    const index = await CodeIndex.build(FIXTURE_PATH, 'react')
    const navBar = index.components.get('NavBar')!
    expect(navBar.semanticRole).toBe('navigation')
  })

  it('NavBar has data-testid selector', async () => {
    const index = await CodeIndex.build(FIXTURE_PATH, 'react')
    const navBar = index.components.get('NavBar')!
    expect(navBar.selector).toBe('[data-testid="navbar"]')
  })

  it('HeroSection gets correct semantic role', async () => {
    const index = await CodeIndex.build(FIXTURE_PATH, 'react')
    const hero = index.components.get('HeroSection')!
    expect(hero.semanticRole).toBe('hero')
  })

  it('infers correct position for navigation', () => {
    const pos = CodeIndex.inferPosition('navigation')
    expect(pos.region).toBe('top')
    expect(pos.sticky).toBe(true)
  })

  it('reports no errors for valid fixture', async () => {
    const index = await CodeIndex.build(FIXTURE_PATH, 'react')
    expect(index.errors).toHaveLength(0)
  })
})
