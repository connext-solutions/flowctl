/**
 * Observe (roadmap section 3.2): a deterministic crawler and the `AppMap` it produces.
 */
export { PageBudget, type CrawlBudget } from './budget.js';
export {
  CHECK_IDS,
  CheckFindingSchema,
  FreeChecksSchema,
  freeChecks,
  type CheckFinding,
  type CheckId,
  type CheckResult,
  type FreeChecks,
} from './checks/index.js';
export { observe, type Observation, type ObserveOptions } from './crawl.js';
export { appMapPath, refuseReservedOut, writeAppMap } from './output.js';
export { observeSummary, type ObserveSummary } from './summary.js';
export {
  loginPath,
  mayOpen,
  pageLinks,
  pagePath,
  type LinkRules,
  type RawLink,
} from './links.js';
export {
  AppMapSchema,
  CallSchema,
  ControlSchema,
  FieldSchema,
  FormSchema,
  PageSchema,
  type AppCall,
  type AppForm,
  type AppMap,
  type AppPage,
} from './schema.js';
