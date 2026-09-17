import { DeviceDescriptor, DeviceExpectations } from '../core/types'

/** Device profile library. */
export const DEVICES: Record<string, DeviceDescriptor> = {
  'iPhone 15': {
    name: 'iPhone 15',
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: 'webkit',
  },
  'iPhone 15 Pro Max': {
    name: 'iPhone 15 Pro Max',
    viewport: { width: 430, height: 932 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: 'webkit',
  },
  'iPad Pro 12.9': {
    name: 'iPad Pro 12.9',
    viewport: { width: 1024, height: 1366 },
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: true,
    defaultBrowserType: 'webkit',
  },
  'Galaxy S24': {
    name: 'Galaxy S24',
    viewport: { width: 412, height: 915 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36',
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    defaultBrowserType: 'chromium',
  },
  'MacBook Pro 16': {
    name: 'MacBook Pro 16',
    viewport: { width: 1728, height: 1117 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
    defaultBrowserType: 'chromium',
  },
  'Desktop 1920x1080': {
    name: 'Desktop 1920x1080',
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    defaultBrowserType: 'chromium',
  },
  'Desktop 1440x900': {
    name: 'Desktop 1440x900',
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    defaultBrowserType: 'chromium',
  },
}

/**
 * Device profiles and the layout expectations derived from them.
 */
export class DeviceContext {
  /**
   * Look up a device profile by name.
   * @param name - e.g. `'iPhone 15'`
   * @returns A copy of the descriptor
   * @throws Error when the device is unknown (message lists available names)
   */
  static getDevice(name: string): DeviceDescriptor {
    const device = DEVICES[name]
    if (!device) {
      throw new Error(
        `DeviceContext.getDevice: unknown device "${name}". Available: ${DeviceContext.deviceNames().join(', ')}`
      )
    }
    return { ...device, viewport: { ...device.viewport } }
  }

  /**
   * Derive deterministic layout expectations from a device's viewport width.
   * @param device - Device descriptor
   * @returns Expectations (mobile ≤480, tablet 481–1024, desktop >1024)
   */
  static buildExpectations(device: DeviceDescriptor): DeviceExpectations {
    const width = device.viewport.width
    if (width <= 480) {
      return {
        layoutType: 'mobile',
        hasHamburgerMenu: true,
        hasBottomNav: true,
        minTapTargetSize: 44,
        maxColumns: 1,
        navigationPosition: 'hamburger',
        fontSizeMin: 14,
        scrollDirection: 'vertical',
      }
    }
    if (width <= 1024) {
      return {
        layoutType: 'tablet',
        hasHamburgerMenu: true,
        hasBottomNav: false,
        minTapTargetSize: 44,
        maxColumns: 2,
        navigationPosition: 'top',
        fontSizeMin: 14,
        scrollDirection: 'vertical',
      }
    }
    return {
      layoutType: 'desktop',
      hasHamburgerMenu: false,
      hasBottomNav: false,
      minTapTargetSize: 24,
      maxColumns: 12,
      navigationPosition: 'top',
      fontSizeMin: 12,
      scrollDirection: 'both',
    }
  }

  /**
   * Names of all built-in devices.
   * @returns Device name list
   */
  static deviceNames(): string[] {
    return Object.keys(DEVICES)
  }
}
