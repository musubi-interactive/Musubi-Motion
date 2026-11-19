import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  CONTACT_SAMPLING_MODES,
  diagnoseStressContacts,
  stressContactFrames,
  type ContactSamplingMode,
} from '../scripts/motion-transfer-experiment/boundary-sampling.ts';
import {
  ROOT_POLICIES,
  alignedGridDiagnostic,
  applyRootPolicy,
  calibratedContacts,
  mapCalibration,
} from '../scripts/motion-transfer-experiment/calibration.ts';
import {
  FRAMES, ROLES, explicitMap, mapSkeletonUtils, targetFixture, type Rig, type Role,
} from '../scripts/motion-transfer-experiment/harness.ts';
import { STRESS_VARIANTS, stressFixture } from '../scripts/motion-transfer-experiment/stress-fixtures.ts';
import { importFBX } from '../src/fbx-import.ts';
import { emptyScene } from '../src/scene-document.ts';

const TARGETS = ['MT17-IDENTITY', 'MT17-SCALE08', 'MT17-PROPORTION', 'MT17-BASIS'];
const fixtureDir = resolve('tests/fixtures/motion-transfer');
const sourcePath = resolve(fixtureDir, 'MT17-SOURCE-24.fbx');
const referencePath = resolve(fixtureDir, 'MT17-reference.json');
const helperPath = createRequire(import.meta.url).resolve('three/addons/utils/SkeletonUtils.js');
const evidencePath = process.env.MT17_BOUNDARY_SAMPLING_EVIDENCE;

type Reference = Rig['coordinates'] & { reference: Parameters<typeof targetFixture>[0] };
type Contacts = ReturnType<typeof calibratedContacts>;
type ContactRow = Contacts[string][number];
type SamplingResults = Record<ContactSamplingMode, Contacts>;
const results: Record<string, SamplingResults> = {};

const gates = ['passesSlip', 'passesPenetration', 'passesSymmetricFloorDistance', 'passesAllExploratoryGates'] as const;
const metrics = ['horizontalMax', 'horizontalRms', 'verticalMax', 'verticalRms', 'clearanceMax', 'penetrationMax'] as const;
const comparisons = [
  ['sparse53', 'boundaryAware'],
  ['boundaryAware', 'dense0.125'],
  ['boundaryAware', 'dense0.0625'],
  ['boundaryAware', 'dense0.03125'],
  ['dense0.125', 'dense0.0625'],
  ['dense0.0625', 'dense0.03125'],
] as const;

const sha256 = (content: Uint8Array | string) => createHash('sha256').update(content).digest('hex');
const inputHashes = () => ({
  fbx: sha256(readFileSync(sourcePath)),
  reference: sha256(readFileSync(referencePath)),
  skeletonUtils: sha256(readFileSync(helperPath)),
});

type MetricGap = {
  absoluteGap: number;
  scenario: string;
  foot: string;
  start: number;
  end: number;
  before: number;
  after: number;
};

function compareGrids(from: ContactSamplingMode, to: ContactSamplingMode) {
  const metricGaps: Partial<Record<typeof metrics[number], MetricGap>> = {};
  const disagreements = [];
  let fromSamples = 0;
  let toSamples = 0;
  let stances = 0;
  for (const [scenario, grids] of Object.entries(results)) {
    for (const [foot, rows] of Object.entries(grids[from])) {
      for (const [i, before] of rows.entries()) {
        const after = grids[to][foot][i];
        const location = { scenario, foot, start: before.start, end: before.end };
        stances++;
        fromSamples += before.samples;
        toSamples += after.samples;
        for (const gate of gates) {
          if (before[gate] !== after[gate]) {
            disagreements.push({
              ...location, gate, before: before[gate], after: after[gate],
              fromSamples: before.samples, toSamples: after.samples,
            });
          }
        }
        for (const metric of metrics) {
          const absoluteGap = Math.abs(after[metric] - before[metric]);
          if (absoluteGap > (metricGaps[metric]?.absoluteGap ?? -1)) {
            metricGaps[metric] = { ...location, absoluteGap, before: before[metric], after: after[metric] };
          }
        }
      }
    }
  }
  return { from, to, stances, fromSamples, toSamples, metricGaps, disagreements };
}

function task012Digest(mode: ContactSamplingMode) {
  const cases = Object.keys(results).sort().map(key => [key, results[key][mode]]);
  // Round recorded metrics to nine decimals to avoid depending on platform floating-point noise.
  return sha256(JSON.stringify(cases, (_key, value: unknown) =>
    typeof value === 'number' && !Number.isInteger(value) ? Number(value.toFixed(9)) : value));
}

let gridComparisons: ReturnType<typeof compareGrids>[] = [];
let reference: Reference;
let source: Rig;
let beforeHashes: ReturnType<typeof inputHashes>;

beforeAll(async () => {
  beforeHashes = inputHashes();
  reference = JSON.parse(readFileSync(referencePath, 'utf8')) as Reference;
  const { document } = await importFBX(new File([readFileSync(sourcePath)], 'MT17-SOURCE-24.fbx'), emptyScene());
  const roles = Object.fromEntries(ROLES.map(role => [
    role, document.joints!.find(joint => joint.name === role)!.id,
  ])) as Record<Role, string>;
  source = {
    doc: document,
    roles,
    reference: reference.reference.map(joint => ({
      id: roles[joint.role as Role], name: joint.role, parentId: joint.parent ? roles[joint.parent as Role] : null,
      position: [joint.position[0], joint.position[1], joint.position[2]],
      rotation: [joint.rotation[0], joint.rotation[1], joint.rotation[2]],
      orientation: [0, 0, 0],
    })),
    coordinates: {
      metersPerUnit: reference.metersPerUnit, up: reference.up, forward: reference.forward, basis: reference.basis,
    },
  };
});

afterAll(() => {
  const afterHashes = inputHashes();
  expect(afterHashes).toEqual(beforeHashes);
  if (evidencePath && gridComparisons.length) {
    const frameCounts = Object.fromEntries(STRESS_VARIANTS.map(variant => [
      variant, Object.fromEntries(CONTACT_SAMPLING_MODES.map(mode => [
        mode, stressContactFrames(stressFixture(source, variant), mode).length,
      ])),
    ]));
    writeFileSync(evidencePath, JSON.stringify({
      node: process.version,
      beforeHashes,
      afterHashes,
      mappingCases: Object.keys(results).length,
      frameCounts,
      comparisons: gridComparisons,
      results,
    }, null, 2) + '\n');
  }
});

it('uses the exact in-range boundary union and three endpoint-inclusive dense grids', () => {
  const sparseBefore = [...FRAMES];
  for (const variant of STRESS_VARIANTS) {
    const fixture = stressFixture(source, variant);
    expect(stressContactFrames(fixture, 'sparse53')).toEqual(sparseBefore);

    const boundaries = Object.values(fixture.stances).flat(2);
    const expected = new Set(sparseBefore);
    for (const boundary of boundaries) {
      expected.add(boundary);
      if (boundary > 0) expected.add(boundary - 1e-6);
      if (boundary < 48) expected.add(boundary + 1e-6);
    }
    expect(stressContactFrames(fixture, 'boundaryAware')).toEqual([...expected].sort((a, b) => a - b));

    const dense = stressContactFrames(fixture, 'dense0.125');
    const finer = stressContactFrames(fixture, 'dense0.0625');
    const finest = stressContactFrames(fixture, 'dense0.03125');
    expect(dense).toEqual(Array.from({ length: 385 }, (_, i) => i / 8));
    expect(finer).toEqual(Array.from({ length: 769 }, (_, i) => i / 16));
    expect(finest).toEqual(Array.from({ length: 1537 }, (_, i) => i / 32));
  }
  expect(FRAMES).toEqual(sparseBefore);
});

function measureMappings(variant: typeof STRESS_VARIANTS[number], target: string) {
  const inputBefore = JSON.stringify({ source, reference });
  const fixture = stressFixture(source, variant);
  const targetRig = targetFixture(reference.reference, target);
  const rigsBefore = JSON.stringify({ fixture, targetRig });
  const mapping = explicitMap(fixture.source, targetRig);
  const helper48 = mapSkeletonUtils(fixture.source, targetRig, mapping).doc;
  const aligned49 = alignedGridDiagnostic(fixture.source, targetRig, mapping).doc;

  for (const policy of ROOT_POLICIES) {
    const documents = {
      original: mapCalibration(fixture.source, targetRig, mapping, policy),
      measuredHelper48: applyRootPolicy(fixture.source, targetRig, helper48, policy),
      aligned49Diagnostic: applyRootPolicy(fixture.source, targetRig, aligned49, policy),
    };
    for (const [path, doc] of Object.entries(documents)) {
      const scenario = `${variant}.${target}.${policy}.${path}`;
      const rig = { ...targetRig, doc };
      const documentBefore = JSON.stringify(doc);
      const measured = Object.fromEntries(CONTACT_SAMPLING_MODES.map(mode => [
        mode, diagnoseStressContacts(rig, fixture, mode),
      ])) as SamplingResults;
      expect(diagnoseStressContacts(rig, fixture), scenario).toEqual(measured.sparse53);
      expect(measured.sparse53, scenario).toEqual(calibratedContacts(rig, fixture.stances));
      expect(JSON.stringify(doc), scenario).toBe(documentBefore);
      results[scenario] = measured;
    }
  }
  expect(JSON.stringify({ fixture, targetRig })).toBe(rigsBefore);
  expect(JSON.stringify({ source, reference })).toBe(inputBefore);
}

function assertCounterexamples() {
  const scenario = 'fractional-boundaries.MT17-PROPORTION.reference-relative-xyz.original';
  const measured = results[scenario];
  const cases: Array<{
    row: number; start: number; end: number; metric: keyof ContactRow;
    gate: keyof ContactRow; sparse: number; dense: number;
  }> = [
    { row: 0, start: 0, end: 24.375, metric: 'horizontalMax', gate: 'passesSlip',
      sparse: 0.01566909148, dense: 0.02206536608 },
    { row: 1, start: 47.625, end: 48, metric: 'verticalMax', gate: 'passesSymmetricFloorDistance',
      sparse: 0.00923569697, dense: 0.01027339418 },
  ];
  for (const { row, start, end, metric, gate, sparse, dense } of cases) {
    const sparseRow = measured.sparse53.rightFoot[row];
    expect(sparseRow).toMatchObject({ start, end, [gate]: true, passesAllExploratoryGates: true });
    expect(sparseRow[metric]).toBeCloseTo(sparse, 10);
    for (const mode of ['boundaryAware', 'dense0.125', 'dense0.0625', 'dense0.03125'] as const) {
      const result = measured[mode].rightFoot[row];
      expect(result).toMatchObject({ start, end, [gate]: false, passesAllExploratoryGates: false });
      expect(result[metric]).toBeCloseTo(dense, 10);
    }
  }
}

it('reproduces the TASK-012 baselines and detects both counterexamples across the fixed mapping matrix', () => {
  for (const variant of STRESS_VARIANTS) {
    for (const target of TARGETS) measureMappings(variant, target);
  }
  expect(Object.keys(results)).toHaveLength(72);
  gridComparisons = comparisons.map(([from, to]) => compareGrids(from, to));
  expect(task012Digest('sparse53')).toBe('b3ee25042603338187547dbd9ebb209cb9372da3e4b1a198e60e6b198d275d3e');
  expect(task012Digest('dense0.125')).toBe('6e5cecff10a30edfb55a29ee0ad53bfce5e7394df2439acd2119e2cb61503406');
  assertCounterexamples();
  const sampleTotals: Record<ContactSamplingMode, number> = {
    sparse53: 4776, boundaryAware: 5688, 'dense0.125': 32808, 'dense0.0625': 65352, 'dense0.03125': 130440,
  };
  for (const { from, to, stances, fromSamples, toSamples, disagreements } of gridComparisons) {
    const comparison = `${from} vs ${to}`;
    expect(stances, comparison).toBe(264);
    expect(fromSamples, comparison).toBe(sampleTotals[from]);
    expect(toSamples, comparison).toBe(sampleTotals[to]);
    if (from === 'sparse53') {
      expect(disagreements, comparison).toHaveLength(12);
      expect(disagreements.every(result => result.before && !result.after), comparison).toBe(true);
    } else {
      expect(disagreements, comparison).toEqual([]);
    }
  }
}, 120000);
