import type { DriveStep, InvariantEvidence } from '../../src/derive/index.js';

export const PAGE = '/items';
export const NAME_FIELD = { role: 'textbox', name: 'Tên mục' } as const;
export const EDIT_FIELD = { role: 'textbox', name: 'Tên mới' } as const;
export const CREATE = { role: 'button', name: 'Tạo' } as const;
export const EDIT = { role: 'button', name: 'Sửa' } as const;
export const APPROVE = { role: 'button', name: 'Duyệt' } as const;
export const DELETE = { role: 'button', name: 'Xoá' } as const;
/** The list region of the items page, as the map records it (`ul aria-label`). */
export const LIST = { role: 'list', name: 'Danh sách mục' } as const;

const SHOWN = { listed: true, state: null };
const HIDDEN = { listed: false, state: null };

/**
 * A clean step: create `QA-1` on a visible, enabled control, accepted, the request window settled, listed, kept after
 * a reload, read back equal.
 */
export const step = (over: Partial<DriveStep> = {}): DriveStep => ({
  action: 'create',
  page: PAGE,
  control: CREATE,
  field: NAME_FIELD,
  sent: 'QA-1',
  request: { method: 'POST', path: '/api/items', status: 201 },
  actionable: true,
  settled: true,
  clientBlocked: false,
  before: HIDDEN,
  after: SHOWN,
  reloaded: SHOWN,
  readBack: 'QA-1',
  toast: 'Đã tạo QA-1',
  ...over,
});

/** The clean drive of the items app, one step per kind. */
export const cleanSteps = (): DriveStep[] => [
  step(),
  step({
    request: { method: 'POST', path: '/api/items', status: 409 },
    before: SHOWN,
    after: SHOWN,
    reloaded: null,
    readBack: null,
    toast: 'Tên đã tồn tại',
  }),
  step({
    action: 'edit',
    control: EDIT,
    field: EDIT_FIELD,
    sent: 'QA-1-e',
    request: { method: 'PATCH', path: '/api/items/x', status: 200 },
    readBack: 'QA-1-e',
    toast: 'Đã sửa QA-1-e',
  }),
  step({
    action: 'transition',
    control: APPROVE,
    sent: undefined,
    request: { method: 'POST', path: '/api/items/x/approve', status: 200 },
    before: { listed: true, state: 'Chờ duyệt' },
    after: { listed: true, state: 'Đã duyệt' },
    reloaded: null,
    readBack: null,
    toast: 'Đã duyệt QA-1',
  }),
  step({
    action: 'delete',
    control: DELETE,
    sent: 'QA-1-e',
    request: { method: 'DELETE', path: '/api/items/x', status: 204 },
    before: SHOWN,
    after: HIDDEN,
    reloaded: null,
    readBack: null,
    toast: 'Đã xoá QA-1-e',
  }),
  step({
    action: 'probe',
    sent: 'QA-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    request: null,
    clientBlocked: true,
    before: HIDDEN,
    after: HIDDEN,
    reloaded: null,
    readBack: null,
    toast: 'Tên quá dài',
  }),
];

/** The map of the items page. */
export const itemsMap = (over: Record<string, unknown> = {}) => ({
  v: 1 as const,
  origin: 'http://127.0.0.1:3000',
  observedAt: '2026-11-16T00:00:00.000Z',
  truncated: false,
  pages: [
    {
      path: PAGE,
      title: 'Mục',
      status: 200,
      controls: [CREATE],
      regions: [LIST],
      links: [],
      forms: [],
      calls: [],
      consoleErrors: [],
      refused: [],
      navigationRefused: false,
      ...over,
    },
  ],
});

/** Evidence from a drive of `steps` (the clean drive by default) and the inputs `name` and `rename`. */
export const evidence = (
  steps: DriveStep[] = cleanSteps(),
  map: unknown = itemsMap(),
): InvariantEvidence =>
  ({
    map,
    drive: { v: 1, steps },
    inputs: { name: 'QA-{{uid}}', rename: 'QA-{{uid}}-e' },
  }) as InvariantEvidence;

export const VALUE = { page: PAGE, valueFrom: 'name' };
export const RENAMED = { page: PAGE, valueFrom: 'rename' };
export const PARAMS = {
  'crud-create-appears': { ...VALUE, within: LIST },
  'crud-edit-shows': { ...RENAMED, within: LIST },
  'crud-delete-absent': RENAMED,
  'reload-keeps-data': VALUE,
  'no-5xx': {},
  'no-console-error': {},
  'round-trip-equality': { page: PAGE, field: NAME_FIELD, valueFrom: 'name' },
  'state-change-after-action': { page: PAGE, control: APPROVE },
  'success-toast-implies-2xx': { page: PAGE, control: CREATE },
  'client-blocks-what-server-rejects': { page: PAGE, field: NAME_FIELD },
} as const;
