/**
 * The true screen and controls of each fixture spec document, written by hand from the spec text
 * (`fixture-app/spec/`) and the fixture pages (`fixture-app/src/pages.ts`, `crawl.ts`), never from the matcher's
 * output. `labels` are the literals the operation quotes in its steps and expected items that name a control or a
 * field of that screen, with the role the page gives them; `path` is a quoted address literal of that screen.
 */
export interface Truth {
  screen: string;
  labels: Record<string, readonly string[]>;
  paths: readonly string[];
}

export const FIXTURE_TRUTH: Readonly<Record<string, Truth>> = {
  'leave/submit.md': {
    screen: '/requests',
    labels: {
      'Lý do': ['textbox'],
      'Số tiền': ['textbox'],
      'Nhân viên': ['combobox'],
      Gửi: ['button'],
    },
    paths: ['/requests?saved=1'],
  },
  'leave/validation.md': { screen: '/requests', labels: {}, paths: [] },
  'leave/persist.md': { screen: '/requests', labels: {}, paths: [] },
  'leave/approve.md': { screen: '/approvals', labels: {}, paths: [] },
  'map/pages.md': { screen: '/map', labels: {}, paths: [] },
};
