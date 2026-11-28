import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';

import { getCatalogArchetypeById } from '@/shared/domain';

import { matchesVerifiedCatalogExport, parseCadWorkerPayload } from '../cadExports.ts';

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'dual-scorpion-pipeline-result.json',
);
const exportedResult = JSON.parse(readFileSync(fixturePath, 'utf8'));
const archetype = getCatalogArchetypeById('dual_scorpion_v1');

it('rejects the cached source payload without reports and accepts the measured export', () => {
  const missingReports = {
    ...exportedResult,
    validation: { ...exportedResult.validation },
  };
  delete missingReports.validation.sourceInterferenceReport;
  delete missingReports.validation.engineeringReport;

  assert.equal(
    matchesVerifiedCatalogExport(parseCadWorkerPayload(missingReports, archetype), archetype),
    false,
  );
  assert.equal(
    matchesVerifiedCatalogExport(parseCadWorkerPayload(exportedResult, archetype), archetype),
    true,
  );
});
