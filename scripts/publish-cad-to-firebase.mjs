import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { CATALOG_ARCHETYPES, getCatalogArchetypeById } from '@/shared/domain';

import {
  createProjectAssembly,
  readOptionalInspectionReports,
  readVerifiedCatalogExport,
} from '@/backend/orchestrator/cadExports';
import {
  assertFirebaseCloudCredentials,
  configureStorageBucketCors,
  publishAssemblyToFirebaseCloud,
} from '@/backend/orchestrator/firebaseCloudStore';
import { formatApiError } from '@/backend/orchestrator/errorFormatting';
import { requestWarmCadBuild, shutdownWarmCadWorker } from '@/backend/orchestrator/warmCadClient';

const exportsRoot = path.resolve('backend/data/exports');

function readOptions() {
  const { values } = parseArgs({
    options: {
      archetypes: { type: 'string' },
      'skip-cors': { type: 'boolean' },
      'skip-build': { type: 'boolean' },
      'force-rebuild': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
  });
  if (values['force-rebuild'] && values['skip-build']) {
    throw new Error('Choose either --force-rebuild or --skip-build.');
  }
  const archetypes =
    values.archetypes === undefined
      ? CATALOG_ARCHETYPES
      : [...new Set(values.archetypes.split(',').map((id) => id.trim()))].map((id) => {
          const archetype = getCatalogArchetypeById(id);
          if (!archetype) throw new Error(`Unknown catalog archetype "${id}".`);
          return archetype;
        });

  return {
    archetypes,
    skipCors: values['skip-cors'] ?? false,
    skipBuild: values['skip-build'] ?? false,
    forceRebuild: values['force-rebuild'] ?? false,
    dryRun: values['dry-run'] ?? false,
  };
}

async function installExport(staged, destination, previous) {
  let backedUp = false;
  try {
    await fs.rename(destination, previous);
    backedUp = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await fs.rename(staged, destination);
  } catch (error) {
    if (backedUp) {
      try {
        await fs.rename(previous, destination);
      } catch (restoreError) {
        if (restoreError.code !== 'EEXIST' && restoreError.code !== 'ENOTEMPTY') throw restoreError;
      }
    }
    throw error;
  }
}

async function getExport(archetype, options) {
  const destination = path.join(exportsRoot, archetype.archetypeId);
  if (!options.forceRebuild) {
    try {
      return await readVerifiedCatalogExport(destination, archetype);
    } catch (error) {
      if (options.skipBuild) {
        throw new Error(
          `No valid local CAD export for ${archetype.archetypeId} and --skip-build is set.`,
          {
            cause: error,
          },
        );
      }
    }
  }
  if (options.dryRun) return null;

  await fs.mkdir(exportsRoot, { recursive: true });
  const temporaryDir = await fs.mkdtemp(path.join(exportsRoot, `.${archetype.archetypeId}-`));
  const outputDir = path.join(temporaryDir, 'export');
  try {
    console.info(`Building ${archetype.archetypeId}…`);
    await requestWarmCadBuild(
      {
        cmd: 'build',
        archetypeId: archetype.archetypeId,
        outputDir,
        cacheDir: path.resolve('backend/data/open_step_cache'),
      },
      { timeoutMs: 900_000 },
    );
    const result = await readVerifiedCatalogExport(outputDir, archetype);
    await installExport(outputDir, destination, path.join(temporaryDir, 'previous'));
    return result;
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
}

async function main() {
  const options = readOptions();
  if (!options.dryRun) {
    await assertFirebaseCloudCredentials();
    if (!options.skipCors) await configureStorageBucketCors();
  }

  const rows = [];
  for (const archetype of options.archetypes) {
    const exported = await getExport(archetype, options);
    if (options.dryRun) {
      rows.push({
        archetype: archetype.archetypeId,
        manifestHash: exported?.payload.manifest.manifestHash ?? 'Pending build',
        action: exported === null ? 'Build and publish' : 'Publish cached export',
      });
      continue;
    }

    const { payload, rawPipelineResult, artifacts } = exported;
    const optionalReports = await readOptionalInspectionReports(
      path.join(exportsRoot, archetype.archetypeId),
    );
    const result = await publishAssemblyToFirebaseCloud({
      assembly: createProjectAssembly(payload, archetype),
      rawPipelineResult,
      artifacts,
      optionalReports,
      updateCatalogPointer: true,
    });
    rows.push({
      archetype: archetype.archetypeId,
      manifestHash: result.pointer.manifestHash,
      uploaded: result.uploadedFiles,
      skipped: result.skippedFiles,
      firestoreDocsWritten: result.firestoreDocsWritten,
    });
  }
  console.table(rows);
}

try {
  await main();
} catch (error) {
  console.error(formatApiError(error, 'Firebase publish failed.'));
  process.exitCode = 1;
} finally {
  await shutdownWarmCadWorker();
}
