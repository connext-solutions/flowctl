import { describe, expect, it } from 'vitest';
import { VideoRecorder, describeStep } from '../src/run/video.js';

describe('describeStep (what the demo overlay says)', () => {
  it('names the action and its target, and an input by its key, never its value', () => {
    expect(
      describeStep({ kind: 'click', target: { role: 'button', name: 'Gửi' } }),
    ).toBe('Click button "Gửi"');
    expect(
      describeStep({
        kind: 'fill',
        target: { role: 'textbox', name: 'Lý do' },
        input: 'reason',
      }),
    ).toBe('Fill textbox "Lý do" with input reason');
    expect(
      describeStep({
        kind: 'select',
        target: { testId: 'type' },
        input: 'kind',
      }),
    ).toBe('Select input kind in testId=type');
    expect(describeStep({ kind: 'as', profile: 'manager' })).toBe(
      'Switch to profile manager',
    );
    expect(describeStep({ kind: 'scroll', dy: -300 })).toBe('Scroll up');
  });
});

describe('VideoRecorder', () => {
  it('refuses a run with a secret input: a video cannot hide what is typed', () => {
    const v = new VideoRecorder('/tmp/none', 'flow');
    expect(() => v.useSecrets([])).not.toThrow();
    expect(() => v.useSecrets(['s3cret'])).toThrow(
      /refused for a flow with \{ env \} inputs/,
    );
  });
});
