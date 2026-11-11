/**
 * The read-only code index (task T6.1, ADR 0033): routes, i18n labels and validator messages of a web app's
 * source, with file and line, read only through the containment helper from a root of purpose `repos`.
 *
 * @see docs/adr/0033-code-index.md
 */
export { buildCodeIndex, type CodeIndexOptions } from './build.js';
export {
  fileRoute,
  nextAppRoute,
  nextPagesRoute,
  type PathRoute,
  remixRoute,
} from './file-routes.js';
export { MAX_JSON_DEPTH, type JsonEntry, parseJsonEntries } from './json.js';
export { labelsInJson, localeFileOf } from './labels.js';
export { lex, type Token } from './lexer.js';
export { type CodeIndex } from './lookup.js';
export { messagesInSource } from './messages.js';
export {
  joinRoute,
  MAX_ROUTE_SEGMENTS,
  matchRoute,
  parseRoutePattern,
  type RouteSegment,
} from './route-match.js';
export {
  type ExtractedRoute,
  extractRoutes,
  ROUTE_EXTRACTORS,
  type RouteExtractor,
  routesInSource,
} from './routes.js';
export { type FoundRoute, jsxRoutes, objectRoutes } from './source-routes.js';
export {
  type DecodedSource,
  decodeSource,
  type NormalisedText,
  normaliseText,
} from './text.js';
export {
  CODE_INDEX_LIMITS,
  type CodeIndexLimits,
  type IndexSkip,
  type LabelRecord,
  type LookupResult,
  type MessageRecord,
  PRUNED_DIRS,
  type RouteRecord,
  type SourceLocation,
} from './types.js';
