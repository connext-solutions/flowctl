/** One line of `decisions.jsonl`: what System 1 saw, answered, and what flowctl did with it. */
export interface DecisionLogEntry {
  at: string;
  source: 'explore' | 'heal';
  /** Actions executed before this decision (explore) or the flow step being healed (heal). */
  step: number;
  url: string;
  /** Round trip to System 1. */
  ms: number;
  ranked: { op: string; p: number }[];
  targets: Record<string, { control: string; p: number }>;
  input?: { key: string; p: number };
  outcome: string;
}
