import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, BrowserContextOptions, Page } from 'playwright';
import {
  OVERLAY_COLORS,
  describeLoc,
  moveCursor,
  narrate,
  overlayScript,
  toPlaywright,
} from '../browser/index.js';
import type { Step } from '../flow/index.js';
import { RunError } from '../foundation/index.js';
import type { Outcome } from './outcome.js';

/** The video frame: the run's viewport, so nothing is scaled. */
const SIZE = { width: 1280, height: 800 };
/** How long a step's text and the cursor stay on screen before the step acts, so a viewer can read it. */
const STEP_PAUSE_MS = 900;
/** How long the result line stays on screen before the video ends. */
const RESULT_HOLD_MS = 2500;
/** How long to look for a step's target to point the cursor at; a missing target is the step's own failure. */
const CURSOR_LOOKUP_MS = 1000;

/**
 * What the overlay says for a step: the action and its target, never a value (an input shows its key).
 *
 * @example describeStep({ kind: 'fill', target: { role: 'textbox', name: 'Lý do' }, input: 'reason' })
 *   // 'Fill textbox "Lý do" with input reason'
 */
export function describeStep(step: Step): string {
  switch (step.kind) {
    case 'click':
    case 'check':
    case 'hover':
      return `${step.kind[0]?.toUpperCase() ?? ''}${step.kind.slice(1)} ${describeLoc(step.target)}`;
    case 'fill':
      return `Fill ${describeLoc(step.target)} with input ${step.input}`;
    case 'select':
      return `Select input ${step.input} in ${describeLoc(step.target)}`;
    case 'press':
      return `Press ${step.key}`;
    case 'upload':
      return `Upload ${step.file.split('/').pop() ?? step.file} to ${describeLoc(step.target)}`;
    case 'drag':
      return `Drag ${describeLoc(step.target)} to ${describeLoc(step.to)}`;
    case 'goto':
      return `Open ${step.url}`;
    case 'as':
      return `Switch to profile ${step.profile}`;
    case 'reload':
      return 'Reload the page';
    case 'wait':
      return `Wait ${step.ms} ms`;
    case 'scroll':
      return `Scroll ${step.dy < 0 ? 'up' : 'down'}`;
  }
}

/**
 * A demo video of a run (ADR 0032): Playwright records each profile's context, and an overlay shows the step about
 * to run, a cursor on its target, and the result at the end. Owned by {@link Evidence}; files land in the run
 * directory as `video-<profile>.webm`.
 *
 * @remarks Opt-in only. A video cannot be masked, so a run with a secret input refuses it ({@link useSecrets}).
 *   The pauses make a recorded replay slower on purpose; a run without a video has none.
 */
export class VideoRecorder {
  private readonly saved: string[] = [];

  constructor(
    private readonly dir: string,
    private readonly title: string,
  ) {}

  /** Context options that start recording into the run directory. */
  contextOptions(): Pick<BrowserContextOptions, 'recordVideo'> {
    return { recordVideo: { dir: join(this.dir, '.video'), size: SIZE } };
  }

  /** @throws {RunError} `flow_invalid` when the run has a secret input: what is typed would be on the video. */
  useSecrets(secrets: readonly string[]): void {
    if (secrets.length > 0)
      throw new RunError(
        'flow_invalid',
        'A video cannot hide what is typed, so it is refused for a flow with { env } inputs. Replay it without --video (ADR 0032).',
      );
  }

  /** Adds the overlay to every page of `context` before its first navigation. */
  async attach(context: BrowserContext): Promise<void> {
    await context.addInitScript(overlayScript(this.title));
  }

  /** Shows `step` and points the cursor at its target, then pauses so a viewer can follow. Never throws. */
  async step(
    page: Page,
    step: Step,
    n: number,
    testIdAttribute: string,
  ): Promise<void> {
    await narrate(page, `Step ${n}:`, describeStep(step));
    if ('target' in step && step.target !== undefined) {
      const box = await toPlaywright(page, step.target, testIdAttribute)
        .first()
        .boundingBox({ timeout: CURSOR_LOOKUP_MS })
        .catch(() => null);
      if (box !== null)
        await moveCursor(
          page,
          box.x + Math.min(box.width / 2, 60),
          box.y + box.height / 2,
        );
    }
    if (!page.isClosed())
      await page.waitForTimeout(STEP_PAUSE_MS).catch(() => undefined);
  }

  /** Shows the run's outcome on every profile's page, so each video ends on it, and holds it. Never throws. */
  async result(pages: Page[], outcome: Outcome): Promise<void> {
    const open = pages.filter((p) => !p.isClosed());
    const page = open[0];
    if (page === undefined) return;
    const text =
      outcome.status === 'passed'
        ? 'passed: every assertion held'
        : outcome.status === 'failed'
          ? `failed: ${outcome.failed && 'assertion' in outcome.failed ? JSON.stringify(outcome.failed.assertion) : 'a step failed'}`
          : `error: ${outcome.error?.kind ?? 'internal'}`;
    const color =
      outcome.status === 'passed'
        ? OVERLAY_COLORS.passed
        : OVERLAY_COLORS.failed;
    await Promise.all(open.map((p) => narrate(p, 'Result:', text, color)));
    await page.waitForTimeout(RESULT_HOLD_MS).catch(() => undefined);
  }

  /**
   * Moves each profile's finished video to `video-<profile>.webm`; call after the contexts closed (Playwright
   * finishes the file on close).
   *
   * @throws {Error} from Playwright when a video cannot be written.
   */
  async save(pages: [string, Page][]): Promise<void> {
    for (const [profile, page] of pages) {
      const video = page.video();
      if (video === null) continue;
      const path = join(this.dir, `video-${profile}.webm`);
      await video.saveAs(path);
      await video.delete();
      this.saved.push(path);
    }
    rmSync(join(this.dir, '.video'), { recursive: true, force: true });
  }

  /** The videos written by {@link save}. */
  get files(): string[] {
    return [...this.saved];
  }
}
