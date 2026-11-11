/**
 * Words that make an action control destructive (ADR 0024 section 5, interim matcher): it deletes, approves,
 * rejects, pays or otherwise changes data that is not the run's own. Lowercase NFC; a multi-word entry matches
 * consecutive tokens. Creating and saving are not listed: exploring a create flow on a shared env is the point.
 *
 * @remarks Both Vietnamese tone placements are listed (`xoá` and `xóa`). `huỷ`/`hủy` and `đặt lại`/`reset` are
 *   not listed, because they label every dialog's close button and every filter's reset button.
 */
export const DESTRUCTIVE_WORDS: readonly string[] = [
  'delete',
  'remove',
  'destroy',
  'purge',
  'erase',
  'wipe',
  'revoke',
  'approve',
  'reject',
  'decline',
  'terminate',
  'deactivate',
  'disable',
  'archive',
  'pay',
  'refund',
  'transfer',
  'void',
  'xoá',
  'xóa',
  'duyệt',
  'từ chối',
  'khoá',
  'khóa',
  'vô hiệu',
  'thanh toán',
  'chuyển khoản',
  'hoàn tiền',
  'thu hồi',
  'chấm dứt',
];

/**
 * Phrases that contain a destructive word but name the run's own action or a label, not a destructive one:
 * submitting one's own request for approval, an approver field, a status, a search keyword. Their tokens are
 * removed before matching.
 */
export const SAFE_PHRASES: readonly string[] = [
  'gửi duyệt',
  'gửi phê duyệt',
  'trình duyệt',
  'người duyệt',
  'người phê duyệt',
  'chờ duyệt',
  'chờ phê duyệt',
  'đã duyệt',
  'từ khoá',
  'từ khóa',
];

/** Tokens of `text`: NFC, split on a lowercase-to-uppercase change and on anything that is not a letter or digit. */
const tokens = (text: string): string[] =>
  text
    .normalize('NFC')
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((t) => t !== '');

const WORDS = DESTRUCTIVE_WORDS.map(tokens);
const SAFE = SAFE_PHRASES.map(tokens);

const at = (t: string[], w: string[], i: number): boolean =>
  w.every((part, j) => t[i + j] === part);

/**
 * The destructive word `label` contains as whole tokens (so "Resend" is not "send", and "Xoá?" is "xoá"), once
 * the {@link SAFE_PHRASES} are removed; or `undefined`.
 *
 * @param extra the repo's `target.destructiveWords`, matched like the core list; they only add words.
 */
export function destructiveWord(
  label: string,
  extra: readonly string[] = [],
): string | undefined {
  const t = tokens(label);
  for (const s of SAFE)
    for (let i = 0; i + s.length <= t.length; i++)
      if (at(t, s, i)) t.splice(i, s.length, '');
  for (const w of [...WORDS, ...extra.map(tokens).filter((x) => x.length > 0)])
    for (let i = 0; i + w.length <= t.length; i++)
      if (at(t, w, i)) return w.join(' ');
  return undefined;
}

/** Decodes percent-escapes until the path stops changing (at most 4 rounds); a malformed escape stops decoding. */
const decoded = (path: string): string => {
  let p = path;
  for (let i = 0; i < 4; i++) {
    try {
      const next = decodeURIComponent(p);
      if (next === p) return p;
      p = next;
    } catch {
      return p;
    }
  }
  return p;
};

/**
 * Why a request looks destructive, or `undefined` (ADR 0024 section 5, request layer, interim): any `DELETE`, and
 * any request whose path, decoded to a fixed point, holds a destructive word as whole tokens, including a
 * side-effecting `GET` (`/items/12/delete`). `HEAD` and `OPTIONS` never are. The query string is not read.
 *
 * @param extra the repo's `target.destructiveWords`.
 * @returns the method (`DELETE`), the matched word, or `unreadable URL` for a URL that does not parse.
 * @remarks Interim: the ADR's stored `destructiveConfirm` entries and the run ledger, which authorise a write on a
 *   record the run created, are not built yet, so a plain create or update (`POST /items`, `PUT /items/12`) passes,
 *   as the label guard lets "Lưu" and "Tạo" pass.
 */
export function destructiveRequest(
  method: string,
  url: string,
  extra: readonly string[] = [],
): string | undefined {
  const m = method.toUpperCase();
  if (m === 'HEAD' || m === 'OPTIONS') return undefined;
  if (m === 'DELETE') return 'DELETE';
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return 'unreadable URL';
  }
  return destructiveWord(decoded(path), extra);
}
