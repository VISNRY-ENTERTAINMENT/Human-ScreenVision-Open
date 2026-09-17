// Everything a consumer needs

export { ScreenVision } from './core/ScreenVision'
export { Browser } from './core/Browser'
export { BrowserContext } from './core/BrowserContext'
export { Page } from './core/Page'
export { ElementHandle } from './core/ElementHandle'
export { Frame } from './core/Frame'
export { Locator, type LocatorStep } from './core/Locator'
export { Clock } from './core/Clock'
export { ApiRequestContext, type ApiResponse, type ApiRequestOptions } from './core/ApiRequest'
export { TraceRecorder } from './trace/TraceRecorder'
export { Recorder, generateTest } from './codegen/Recorder'
export { Runner, writeJUnitReport, type Job, type JobResult, type RunOptions } from './runner/Runner'
export {
  describe,
  it,
  test,
  beforeEach,
  afterEach,
  expect,
  runTests,
  collectTestFiles,
  defineFixture,
  shardOf,
  AssertionError,
  type TestRunOptions,
  type TestRunSummary,
} from './testing/TestRunner'
export { Expectation, type AssertOptions } from './core/Expectation'
export { DEVICES, DeviceContext } from './intelligence/DeviceContext'
export { CodeIndex } from './intelligence/CodeIndex'
export { ElementResolver } from './intelligence/ElementResolver'
export { VerificationEngine } from './intelligence/VerificationEngine'
export { AnnotationEngine } from './capture/AnnotationEngine'
export { compareScreenshot, type ScreenshotComparison, type ScreenshotCompareOptions } from './capture/VisualCompare'
export { VisionClient } from './vision/VisionClient'
export { VisionResolver } from './vision/VisionResolver'
export { BrowserLauncher } from './cdp/BrowserLauncher'
export {
  registerSelectorEngine,
  clearSelectorEngines,
  hasSelectorEngine,
  type EngineSelector,
} from './core/selectorEngines'
export { HarRouter, type HarNotFound } from './core/HarRouter'
export { buildMjpegAvi, jpegSize } from './capture/MjpegAvi'
export { canvasProbeSource, describeCanvas, type CanvasContent } from './capture/CanvasProbe'
export { FileChooser } from './core/FileChooser'
export { Episode, type EpisodeOptions, type LedgerEntry, type EpisodeStop } from './core/Episode'
export {
  AuditLog,
  AUDIT_SCHEMA_VERSION,
  type AuditEntry,
  type AuditIntent,
  type AuditEffects,
  type AuditReconciliation,
  type AuditCost,
  type AuditVerification,
  type AuditLogOptions,
} from './core/AuditLog'
export { FrameLocator } from './core/FrameLocator'
export { ariaSnapshotSource } from './intelligence/ariaSnapshot'
export * from './core/types'

// Default export
import { ScreenVision } from './core/ScreenVision'
export default new ScreenVision()
