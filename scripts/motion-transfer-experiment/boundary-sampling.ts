/** Optional contact sampling for the owned offline MT17 stress experiment. */
import { calibratedContacts } from './calibration.ts';
import { FRAMES, type Rig } from './harness.ts';
import { stressGrids, type StressFixture } from './stress-fixtures.ts';

export const CONTACT_SAMPLING_MODES = [
  'sparse53',
  'boundaryAware',
  'dense0.125',
  'dense0.0625',
  'dense0.03125',
] as const;
export type ContactSamplingMode = typeof CONTACT_SAMPLING_MODES[number];

const DENSE_STEPS = {
  'dense0.125': 0.125,
  'dense0.0625': 0.0625,
  'dense0.03125': 0.03125,
} as const;

export function stressContactFrames(fixture: StressFixture, mode: ContactSamplingMode) {
  if (mode === 'sparse53') return [...FRAMES];
  if (mode === 'boundaryAware') {
    return [...new Set([...FRAMES, ...stressGrids(fixture).boundaries])].sort((a, b) => a - b);
  }

  const step = DENSE_STEPS[mode];
  return Array.from({ length: 48 / step + 1 }, (_, i) => i * step);
}

export function diagnoseStressContacts(
  rig: Rig,
  fixture: StressFixture,
  mode: ContactSamplingMode = 'sparse53',
) {
  return mode === 'sparse53'
    ? calibratedContacts(rig, fixture.stances)
    : calibratedContacts(rig, fixture.stances, stressContactFrames(fixture, mode));
}
