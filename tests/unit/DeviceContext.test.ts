import { describe, it, expect } from 'vitest'
import { DeviceContext, DEVICES } from '../../src/intelligence/DeviceContext'

describe('DeviceContext', () => {

  it('has iPhone 15 profile', () => {
    const device = DeviceContext.getDevice('iPhone 15')
    expect(device.viewport.width).toBe(390)
    expect(device.isMobile).toBe(true)
    expect(device.hasTouch).toBe(true)
    expect(DEVICES['iPhone 15']).toBeDefined()
  })

  it('iPhone 15 gets mobile expectations', () => {
    const device = DeviceContext.getDevice('iPhone 15')
    const expectations = DeviceContext.buildExpectations(device)
    expect(expectations.layoutType).toBe('mobile')
    expect(expectations.hasHamburgerMenu).toBe(true)
    expect(expectations.maxColumns).toBe(1)
    expect(expectations.navigationPosition).toBe('hamburger')
    expect(expectations.minTapTargetSize).toBe(44)
  })

  it('Desktop 1920x1080 gets desktop expectations', () => {
    const device = DeviceContext.getDevice('Desktop 1920x1080')
    const expectations = DeviceContext.buildExpectations(device)
    expect(expectations.layoutType).toBe('desktop')
    expect(expectations.hasHamburgerMenu).toBe(false)
    expect(expectations.maxColumns).toBe(12)
  })

  it('iPad Pro 12.9 gets tablet expectations', () => {
    const device = DeviceContext.getDevice('iPad Pro 12.9')
    const expectations = DeviceContext.buildExpectations(device)
    expect(expectations.layoutType).toBe('tablet')
    expect(expectations.maxColumns).toBe(2)
  })

  it('throws for unknown device name', () => {
    expect(() => DeviceContext.getDevice('Nokia 3310')).toThrow()
  })
})
