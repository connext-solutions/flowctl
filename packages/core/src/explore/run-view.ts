import type { PageSnapshot } from '../browser/index.js';
import type { AssertionFailure } from '../result.js';
import type { RunSession } from '../run/index.js';
import type { Decision, HistoryEntry } from '../system1/index.js';
import { decisionEntry } from './decisions.js';
import { controlRow, MAX_DETAIL_CHARS, pageText } from './page-text.js';
import type { EscalationReason, Escalated } from './types.js';

const MAX_CONTROLS = 40;
/** How long an escalation waits for in-flight response bodies before it writes the logs. */
const SETTLE_MS = 2000;

/**
 * What only an exploration adds on top of its {@link RunSession}: the decision log and escalation
 * results.
 */
export class RunView {
  constructor(
    private readonly run: RunSession,
    private readonly history: HistoryEntry[],
  ) {}

  /** Appends one exploration decision to the run's `decisions.jsonl`. */
  decided(
    snap: PageSnapshot,
    decision: Decision,
    ms: number,
    outcome: string,
  ): void {
    this.run.evidence.decided(
      decisionEntry({
        source: 'explore',
        step: this.history.length,
        url: snap.url,
        ms,
        outcome,
        decision,
        snap,
        secrets: this.run.secrets,
      }),
    );
  }

  /**
   * An escalation with the control table of `snap` (or a fresh snapshot) and, unless given, the
   * first assertion that does not pass yet. `detail`, the control rows and `failed.got` carry page text, so
   * each goes through `pageText`: secrets masked, line breaks and hidden characters removed, length capped,
   * names quoted (issue #49). The network and console logs are written at every escalation, so a run abandoned
   * there still leaves them (task H0.1).
   */
  async escalated(
    reason: EscalationReason,
    detail: string,
    snap?: PageSnapshot,
    failed?: AssertionFailure,
  ): Promise<Escalated> {
    const page = snap ?? (await this.run.snapshot());
    await this.run.evidence.settle(SETTLE_MS);
    this.run.evidence.flushLogs();
    const secrets = this.run.secrets;
    const miss = failed ?? (await this.run.check(0)).failed;
    return {
      runId: this.run.runId,
      status: 'escalated',
      steps: this.history.length,
      escalation: {
        reason,
        detail: pageText(detail, secrets, MAX_DETAIL_CHARS),
        controls: page.controls
          .slice(0, MAX_CONTROLS)
          .map((c) => controlRow(c, secrets)),
      },
      failed:
        miss === undefined
          ? undefined
          : { ...miss, got: pageText(miss.got, secrets, MAX_DETAIL_CHARS) },
    };
  }
}
