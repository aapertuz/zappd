import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';

import { engineeringReportSchema, sourceInterferenceSchema } from '../assembly.ts';

const report = JSON.parse(
  readFileSync(
    new URL(
      '../../../../backend/cad_worker/tests/evidence/poppy-interference.json',
      import.meta.url,
    ),
  ),
);

it('retains measured pair status, excluded CAD and unresolved pair identities', () => {
  const parsed = sourceInterferenceSchema.parse(report);
  assert.equal(parsed.solidCount, 199);
  assert.throws(() => sourceInterferenceSchema.parse({ ...report, unresolvedPairCount: 999 }));
  assert.throws(() =>
    sourceInterferenceSchema.parse({
      ...report,
      pairs: [...report.pairs, report.pairs[0]],
      candidatePairCount: report.candidatePairCount + 1,
    }),
  );
  assert.equal(parsed.excludedComponents.length, 3);
  assert.equal(parsed.pairs.length, parsed.candidatePairCount);
  assert.equal(
    parsed.pairs.filter((pair) => ['failed', 'timeout'].includes(pair.status)).length,
    parsed.unresolvedPairCount,
  );
  assert.equal(
    parsed.pairs.filter((pair) => pair.status === 'intersection').length,
    parsed.intersectionCount,
  );
  assert.throws(() =>
    sourceInterferenceSchema.parse({
      ...report,
      pairs: [{ componentIds: ['a'], status: 'clear' }],
    }),
  );
});

it('rejects manufacturing certification and unknown numerical values', () => {
  assert.throws(() =>
    engineeringReportSchema.parse({ status: 'verified', manufacturingReadiness: 'certified' }),
  );
  assert.throws(() => sourceInterferenceSchema.parse({ ...report, volumeThresholdMm3: -1 }));
});
