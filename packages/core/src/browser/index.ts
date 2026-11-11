export {
  StepError,
  perform,
  unique,
  visibleOnly,
  type ActContext,
  type ExecOptions,
  type Performable,
  type StepErrorKind,
} from './executor.js';
export { describeLoc, toPlaywright } from './locator.js';
export {
  MARK_ATTRIBUTE,
  describeControl,
  markControl,
  takeSnapshot,
  type Control,
  type ControlOp,
  type PageSnapshot,
} from './snapshot.js';
export { parseAriaLine, recordLoc } from './recorder.js';
export {
  DESTRUCTIVE_WORDS,
  SAFE_PHRASES,
  destructiveRequest,
  destructiveWord,
} from './destructive.js';
export {
  BUILT_IN_DENY,
  inScope,
  normalisePath,
  pathGlob,
  type Scope,
  type ScopeKind,
  type ScopeVerdict,
} from './scope.js';
