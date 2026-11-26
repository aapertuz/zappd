import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { registerHooks } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const targetBase = path.join(repoRoot, 'src', specifier.slice(2));
      for (const candidate of [`${targetBase}.ts`, path.join(targetBase, 'index.ts')]) {
        if (fs.existsSync(candidate)) {
          return { url: pathToFileURL(candidate).href, shortCircuit: true };
        }
      }
    }
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      context.parentURL?.startsWith('file://')
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL));
      const targetBase = path.resolve(parentDir, specifier);
      if (!path.extname(targetBase) && fs.existsSync(`${targetBase}.ts`)) {
        return { url: pathToFileURL(`${targetBase}.ts`).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const { getCatalogArchetypeById } = await import('../../../src/shared/domain/index.ts');
const { FirebaseEmulatorRepository } = await import('../../../src/shared/firebase/index.ts');
const {
  matchesCatalogPlacements,
  orchestrateProjectAssemblyCreation,
  rebuildAssemblyWithParameters,
} = await import('../genkitOrchestrator.ts');
const { planProjectWithProvider } = await import('../aiProviders.ts');
const { requestWarmCadBuild, shutdownWarmCadWorker } = await import('../warmCadClient.ts');

after(shutdownWarmCadWorker);

function assertReusesAvailableExports(assembly) {
  const manifestFile = path.join(
    repoRoot,
    'backend',
    'data',
    'exports',
    assembly.archetypeId,
    'manifest.json',
  );
  if (!fs.existsSync(manifestFile)) return;
  const cachedManifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (
    Object.values(cachedManifest.files).every(
      ({ publicUrl, format }) =>
        publicUrl === `/assemblies/${cachedManifest.manifestHash}/model.${format}`,
    )
  ) {
    assert.deepEqual(assembly.manifest, cachedManifest);
  }
}

describe('Genkit multi-provider orchestrator with OpenCascade and Firebase emulator persistence', () => {
  it('orchestrates a quadcopter request end-to-end and persists hierarchy and binaries', async () => {
    const repository = new FirebaseEmulatorRepository();
    const assembly = await orchestrateProjectAssemblyCreation({
      prompt: 'I want to learn how to build a quadcopter',
      provider: 'gemini',
      repository,
    });

    assert.equal(assembly.archetypeId, 'quadcopter_drone_v1');
    assert.equal(assembly.verificationStatus, 'composed_validated');
    assert.equal(assembly.validation.valid, true);
    assert.equal(assembly.validation.brepValid, true);
    assert.equal(assembly.validation.interferenceCount, 0);
    assert.ok(assembly.validation.maxDimensionalErrorMm <= 0.1);
    assert.equal(assembly.nodes.length, 42);
    assert.equal(assembly.assemblySteps.length, 6);
    assertReusesAvailableExports(assembly);
    assert.equal(assembly.orchestration.provider, 'gemini');
    assert.equal(assembly.orchestration.apiFormat, 'google_genai');

    const persistedProject = repository.getProjectAssembly(assembly.projectId);
    assert.ok(persistedProject);
    assert.equal(
      repository.listCollection(`projects/${assembly.projectId}/nodes`).length,
      assembly.nodes.length,
    );
    assert.equal(
      repository.listCollection(`projects/${assembly.projectId}/relationships`).length,
      assembly.relationships.length,
    );
    assert.equal(
      repository.listCollection(`projects/${assembly.projectId}/steps`).length,
      assembly.assemblySteps.length,
    );

    const stepObj = repository.readStorageObject(assembly.manifest.files.step.storagePath);
    const glbObj = repository.readStorageObject(assembly.manifest.files.glb.storagePath);
    const usdzObj = repository.readStorageObject(assembly.manifest.files.usdz.storagePath);
    assert.ok(stepObj && stepObj.sizeBytes > 0);
    assert.ok(glbObj && glbObj.sizeBytes > 0);
    assert.ok(usdzObj && usdzObj.sizeBytes > 0);
    assert.equal(Buffer.from(glbObj.bytes.slice(0, 4)).toString('utf8'), 'glTF');
  });

  it('orchestrates a second robotics archetype (SO-ARM100 manipulator)', async () => {
    const repository = new FirebaseEmulatorRepository();
    const assembly = await orchestrateProjectAssemblyCreation({
      prompt: 'Build a 5-DOF SO-100 robotic arm with parallel gripper',
      provider: 'gemini',
      repository,
    });

    assert.equal(assembly.archetypeId, 'robotic_arm_3dof_v1');
    assert.equal(assembly.verificationStatus, 'composed_validated');
    assert.equal(assembly.validation.valid, true);
    assert.equal(assembly.validation.interferenceCount, 0);
    assert.equal(assembly.nodes.length, 31);
    assert.equal(assembly.assemblySteps.length, 5);
    assertReusesAvailableExports(assembly);
  });

  it('orchestrates a third robotics archetype (NOVA2 open-source rover)', async () => {
    const repository = new FirebaseEmulatorRepository();
    const assembly = await orchestrateProjectAssemblyCreation({
      prompt: 'Explore an autonomous ground rover chassis with stereo camera',
      provider: 'gemini',
      repository,
    });

    assert.equal(assembly.archetypeId, 'open_source_rover_v1');
    assert.equal(assembly.verificationStatus, 'composed_validated');
    assert.equal(assembly.validation.valid, true);
    assert.equal(assembly.validation.interferenceCount, 0);
    assert.equal(assembly.nodes.length, 21);
    assert.equal(assembly.assemblySteps.length, 4);
    const computeBay = assembly.nodes.find(({ id }) => id === 'comp_rover_compute_bay');
    assert.equal(computeBay.enclosureRole, 'shell');
    assert.equal(computeBay.explodeDistanceMeters, 0.075);
    assertReusesAvailableExports(assembly);
  });

  it('orchestrates a fourth robotics archetype (HeyPCB Reachy Mini desktop robot)', async () => {
    const repository = new FirebaseEmulatorRepository();
    const assembly = await orchestrateProjectAssemblyCreation({
      prompt: 'Build Reachy Mini desktop companion robot',
      provider: 'gemini',
      repository,
    });

    assert.equal(assembly.archetypeId, 'reachy_mini_v1');
    assert.equal(assembly.verificationStatus, 'composed_validated');
    assert.equal(assembly.validation.valid, true);
    assert.equal(assembly.validation.interferenceCount, 0);
    assert.equal(assembly.nodes.length, 98);
    assert.equal(assembly.assemblySteps.length, 51);
    const topShell = assembly.nodes.find(({ id }) => id === 'comp_reachy_top_shell');
    assert.equal(topShell.enclosureRole, 'shell');
    assert.deepEqual(topShell.explodeDirection, [0.921954, 0.140297, -0.360765]);
    assert.equal(topShell.explodeDistanceMeters, 0.165);
    const mainPlate = assembly.nodes.find(({ id }) => id === 'comp_reachy_main_plate');
    assert.equal(Object.hasOwn(mainPlate, 'enclosureRole'), false);
    assertReusesAvailableExports(assembly);
  });

  it('drives both OpenAI and DeepSeek through the shared OpenAI-compatible API integration', async () => {
    const receivedRequests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        receivedRequests.push({
          url: req.url,
          authorization: req.headers.authorization,
          model: body.model,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    archetypeId:
                      body.model === 'deepseek-chat'
                        ? 'robotic_arm_3dof_v1'
                        : 'quadcopter_drone_v1',
                    projectTitle:
                      body.model === 'deepseek-chat'
                        ? 'DeepSeek Planned SO-ARM100'
                        : 'OpenAI Planned Quadcopter',
                    plannedSubsystems: ['Subsystem A', 'Subsystem B'],
                    rationale: 'Planned over OpenAI-compatible endpoint',
                  }),
                },
              },
            ],
          }),
        );
      });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}/v1`;

    try {
      const repo = new FirebaseEmulatorRepository();
      const openaiRun = await orchestrateProjectAssemblyCreation({
        prompt: 'Plan a quadcopter drone',
        provider: 'openai',
        apiKey: 'sk-test-openai',
        baseUrl,
        repository: repo,
      });
      const deepseekRun = await orchestrateProjectAssemblyCreation({
        prompt: 'Plan a 5-DOF robotic arm',
        provider: 'deepseek',
        apiKey: 'sk-test-deepseek',
        baseUrl,
        repository: repo,
      });

      assert.equal(openaiRun.orchestration.provider, 'openai');
      assert.equal(openaiRun.orchestration.apiFormat, 'openai_compatible');
      assert.equal(openaiRun.orchestration.executionMode, 'live_api');
      assert.equal(openaiRun.title, 'OpenAI Planned Quadcopter');

      assert.equal(deepseekRun.orchestration.provider, 'deepseek');
      assert.equal(deepseekRun.orchestration.apiFormat, 'openai_compatible');
      assert.equal(deepseekRun.orchestration.executionMode, 'live_api');
      assert.equal(deepseekRun.title, 'DeepSeek Planned SO-ARM100');

      assert.deepEqual(receivedRequests, [
        {
          url: '/v1/chat/completions',
          authorization: 'Bearer sk-test-openai',
          model: 'gpt-4o',
        },
        {
          url: '/v1/chat/completions',
          authorization: 'Bearer sk-test-deepseek',
          model: 'deepseek-chat',
        },
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('rejects colliding CAD geometry before persisting to Firestore or Storage', async () => {
    const repository = new FirebaseEmulatorRepository();
    await assert.rejects(
      () =>
        orchestrateProjectAssemblyCreation({
          prompt: 'I want to build a quadcopter',
          provider: 'gemini',
          injectCollisionTest: true,
          repository,
        }),
      /OpenCascade validation rejected assembly/,
    );
    assert.equal(repository.listCollection('projects').length, 0);
  });

  it('extracts custom dimensions, rebuilds without a provider, and keeps both published bundles', async (t) => {
    const repository = new FirebaseEmulatorRepository();
    const prompt = 'Build a custom 6-rotor hexacopter with 320mm wheelbase';
    const assembly = await orchestrateProjectAssemblyCreation({
      prompt,
      provider: 'gemini',
      repository,
    });
    assert.equal(assembly.orchestration.executionMode, 'local_catalog_planner');
    assert.equal(assembly.archetypeId, 'parametric_multirotor_v1');
    assert.equal(assembly.parameterValues.rotor_count, 6);
    assert.equal(assembly.parameterValues.wheelbase_mm, 320);
    assert.equal(assembly.nodes.filter(({ category }) => category === 'motor').length, 6);
    const originalDir = path.join(repoRoot, 'public', 'assemblies', assembly.manifest.manifestHash);
    const originalGlb = fs.readFileSync(path.join(originalDir, 'model.glb'));

    const providerCall = t.mock.method(globalThis, 'fetch', () => {
      throw new Error('Parameter rebuild must not call an AI provider');
    });
    const rebuilt = await rebuildAssemblyWithParameters({
      archetypeId: assembly.archetypeId,
      parameterValues: { ...assembly.parameterValues, rotor_count: 4, wheelbase_mm: 264 },
      title: assembly.title,
      userPrompt: prompt,
      orchestration: assembly.orchestration,
      repository,
    });

    assert.equal(providerCall.mock.callCount(), 0);
    assert.notEqual(rebuilt.manifest.manifestHash, assembly.manifest.manifestHash);
    assert.equal(rebuilt.parameterValues.rotor_count, 4);
    assert.equal(rebuilt.parameterValues.wheelbase_mm, 260);
    assert.equal(rebuilt.parameters.find(({ name }) => name === 'wheelbase_mm').value, 260);
    assert.equal(rebuilt.nodes.filter(({ category }) => category === 'motor').length, 4);
    assert.ok(rebuilt.relationships.length < assembly.relationships.length);
    assert.notDeepEqual(rebuilt.assemblySteps, assembly.assemblySteps);
    assert.equal(rebuilt.validation.buildTimingMs.cacheMode, 'warm_ram');
    assert.deepEqual(
      repository.getProjectAssembly(rebuilt.projectId).parameterValues,
      rebuilt.parameterValues,
    );

    for (const build of [assembly, rebuilt]) {
      const publicPath = `/assemblies/${build.manifest.manifestHash}`;
      for (const format of ['glb', 'step', 'usdz']) {
        const url = `${publicPath}/model.${format}`;
        assert.equal(build.manifest.files[format].publicUrl, url);
        assert.equal(
          fs.statSync(path.join(repoRoot, 'public', url)).size,
          build.manifest.files[format].sizeBytes,
        );
      }
      for (const file of ['manifest.json', 'pipeline_result.json']) {
        assert.ok(fs.statSync(path.join(repoRoot, 'public', publicPath, file)).size > 0);
      }
    }
    assert.deepEqual(fs.readFileSync(path.join(originalDir, 'model.glb')), originalGlb);
  });

  it('supplements partial live plans with clamped prompt parameters', async (t) => {
    t.mock.method(globalThis, 'fetch', async () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                archetypeId: 'parametric_multirotor_v1',
                projectTitle: 'Custom multirotor',
                rationale: 'Requested custom dimensions',
                plannedSubsystems: [],
                parameterValues: { wheelbase_mm: 320 },
              }),
            },
          },
        ],
      }),
    );
    const plan = await planProjectWithProvider({
      prompt: 'Hexacopter with wheelbase 310 mm, 31mm deck gap, and 5mm arm',
      provider: 'openai',
      apiKey: 'sk-test-openai',
    });
    assert.deepEqual(plan.parameterValues, {
      rotor_count: 6,
      wheelbase_mm: 320,
      deck_gap_mm: 32,
      arm_thickness_mm: 5,
    });

    const localPlan = await planProjectWithProvider({
      prompt: 'Drone with wheelbase of 400 mm',
      provider: 'gemini',
    });
    assert.equal(localPlan.archetypeId, 'parametric_multirotor_v1');
    assert.equal(localPlan.parameterValues.wheelbase_mm, 360);

    const roverPlan = await planProjectWithProvider({
      prompt: 'Build a rover with a 300 mm wheelbase',
      provider: 'gemini',
    });
    assert.equal(roverPlan.archetypeId, 'open_source_rover_v1');
    assert.equal(roverPlan.parameterValues, undefined);
  });

  it('repairs a corrupt public manifest directory on subsequent publication', async () => {
    const repository = new FirebaseEmulatorRepository();
    const first = await orchestrateProjectAssemblyCreation({
      prompt: 'Explore an autonomous ground rover chassis with stereo camera',
      provider: 'gemini',
      repository,
    });
    const publishedGlb = path.join(repoRoot, 'public', first.manifest.files.glb.publicUrl);
    fs.writeFileSync(publishedGlb, 'corrupt');

    const second = await orchestrateProjectAssemblyCreation({
      prompt: 'Explore an autonomous ground rover chassis with stereo camera',
      provider: 'gemini',
      repository,
    });
    assert.equal(second.manifest.manifestHash, first.manifest.manifestHash);
    assert.equal(fs.statSync(publishedGlb).size, second.manifest.files.glb.sizeBytes);
    assert.equal(fs.readFileSync(publishedGlb).subarray(0, 4).toString('utf8'), 'glTF');
  });

  it('releases the warm worker queue after a build deadline expires', async () => {
    const tempOut = fs.mkdtempSync(path.join(os.tmpdir(), 'zappd-timeout-'));
    try {
      await assert.rejects(
        () =>
          requestWarmCadBuild(
            {
              cmd: 'build',
              archetypeId: 'open_source_rover_v1',
              outputDir: tempOut,
              cacheDir: path.join(repoRoot, 'backend', 'data', 'open_step_cache'),
            },
            { timeoutMs: 1 },
          ),
        /CAD worker timed out/,
      );
      const recovered = await orchestrateProjectAssemblyCreation({
        prompt: 'Explore an autonomous ground rover chassis with stereo camera',
        provider: 'gemini',
        repository: new FirebaseEmulatorRepository(),
      });
      assert.equal(recovered.archetypeId, 'open_source_rover_v1');
      assert.equal(recovered.validation.valid, true);
    } finally {
      fs.rmSync(tempOut, { recursive: true, force: true });
    }
  });

  it('persists and publishes colliding geometry with its original validation failures when allowed', async () => {
    const repository = new FirebaseEmulatorRepository();
    const assembly = await orchestrateProjectAssemblyCreation({
      prompt: 'I want to build a quadcopter',
      provider: 'gemini',
      injectCollisionTest: true,
      allowUnverified: true,
      repository,
    });
    assert.equal(assembly.verificationStatus, 'unverified');
    assert.equal(assembly.validation.valid, false);
    assert.ok(assembly.validation.failures.length > 0);
    assert.ok(assembly.validation.interferenceCount > 0);
    const pipeline = JSON.parse(
      fs.readFileSync(
        path.join(
          repoRoot,
          'public',
          'assemblies',
          assembly.manifest.manifestHash,
          'pipeline_result.json',
        ),
        'utf8',
      ),
    );
    for (const field of ['failures', 'electricalFailures', 'floatingComponentIds']) {
      assert.deepEqual(assembly.validation[field], pipeline.validation[field]);
    }
    assert.deepEqual(
      repository.getProjectAssembly(assembly.projectId).validation,
      assembly.validation,
    );
  });

  it('requires a live provider key instead of falling back to keyword matching', async () => {
    const repository = new FirebaseEmulatorRepository();
    const originalCwd = process.cwd();
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zappd-no-env-'));
    delete process.env.OPENAI_API_KEY;
    process.chdir(isolatedCwd);
    try {
      await assert.rejects(
        () =>
          orchestrateProjectAssemblyCreation({
            prompt: 'I want to build a quadcopter',
            provider: 'openai',
            requireLiveApiKey: true,
            repository,
          }),
        /Missing OPENAI_API_KEY in \.env\.local for OpenAI/,
      );
      assert.equal(repository.listCollection('projects').length, 0);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(isolatedCwd, { recursive: true, force: true });
      if (originalOpenAiKey !== undefined) {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
    }
  });

  it('rejects shifted or collision-injected Poppy outputs through the orchestrator before saving or publishing', async () => {
    const poppy = getCatalogArchetypeById('poppy_humanoid_v1');
    assert.ok(poppy);
    const originalCwd = process.cwd();
    const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zappd-poppy-orch-'));

    const stepBytes = Buffer.from('ISO-10303-21;POPPY-STUB;');
    const glbBytes = Buffer.from('glTF\x02\x00\x00\x00');
    const usdzBytes = Buffer.from('PK\x03\x04usdz');
    const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');
    const stepSha = sha256Hex(stepBytes);
    const glbSha = sha256Hex(glbBytes);
    const usdzSha = sha256Hex(usdzBytes);
    const manifestHash = sha256Hex(
      Buffer.from(`poppy_humanoid_v1:${stepSha}:${glbSha}:${usdzSha}`),
    );

    const buildPoppyPayload = (shiftLastNode) => {
      const nodes = poppy.nodes.map((node, index) => ({
        id: node.id,
        parentId: node.parentId,
        name: node.name,
        level: node.level,
        depth: node.depth,
        category: node.category,
        colorHex: node.colorHex,
        dimensionsMm: node.dimensionsMm,
        restPositionMeters:
          shiftLastNode && index === poppy.nodes.length - 1
            ? [
                node.restPositionMeters[0] + 0.01,
                node.restPositionMeters[1],
                node.restPositionMeters[2],
              ]
            : node.restPositionMeters,
        explodeDirection: node.explodeDirection,
        explodeDistanceMeters: node.explodeDistanceMeters,
        materialHint: node.materialHint,
        specifications: node.specifications,
        geometry: node.geometry,
        provenance: {
          origin: node.origin,
          verificationStatus: 'unverified',
          spdxLicense: node.spdxLicense,
          sourceUrl: node.sourceUrl,
          sourceName: node.sourceName,
          stepSha256: node.expectedStepSha256 ?? stepSha,
        },
        glbNodeName: node.id,
        usdzPrimPath: `/World/${node.id}`,
      }));
      const mappedLeaves = nodes.filter(
        (node) =>
          (node.level === 'component' || node.level === 'subcomponent') &&
          node.geometry?.kind !== 'unavailable',
      );
      return {
        archetypeId: 'poppy_humanoid_v1',
        verificationStatus: 'unverified',
        nodes,
        glbNodeIds: mappedLeaves.map((node) => node.glbNodeName),
        usdzPrimPaths: mappedLeaves.map((node) => node.usdzPrimPath),
        manifest: {
          manifestHash,
          archetypeId: 'poppy_humanoid_v1',
          generatedAtIso: '2026-11-25T00:00:00.000Z',
          files: {
            step: {
              format: 'step',
              storagePath: `assemblies/${manifestHash}/model.step`,
              publicUrl: `/assemblies/${manifestHash}/model.step`,
              sha256: stepSha,
              sizeBytes: stepBytes.length,
            },
            glb: {
              format: 'glb',
              storagePath: `assemblies/${manifestHash}/model.glb`,
              publicUrl: `/assemblies/${manifestHash}/model.glb`,
              sha256: glbSha,
              sizeBytes: glbBytes.length,
            },
            usdz: {
              format: 'usdz',
              storagePath: `assemblies/${manifestHash}/model.usdz`,
              publicUrl: `/assemblies/${manifestHash}/model.usdz`,
              sha256: usdzSha,
              sizeBytes: usdzBytes.length,
            },
          },
        },
        validation: {
          valid: false,
          brepValid: true,
          interferenceCount: 0,
          maxDimensionalErrorMm: 0.05,
          nodeMappingComplete: true,
          unitSystem: 'meters_y_up',
          checkedAtIso: '2026-11-25T00:00:00.000Z',
          failures: ['Partial source inspection'],
          sourceInterferenceReport: {
            status: 'partial',
            solidCount: 199,
            possiblePairCount: 19701,
            candidatePairCount: 0,
            intersectionCount: 0,
            unresolvedPairCount: 0,
            volumeThresholdMm3: 0.001,
            aabbToleranceMm: 1e-7,
            excludedComponents: [],
            pairs: [],
            limitations: [],
          },
          engineeringReport: {
            status: 'unverified',
            manufacturingReadiness: 'not_established',
            materials: 'unknown',
            manufacturingTolerances: 'unknown',
            loadsAndConstraints: 'not_verified',
            renderDimensionComparison: {
              maximumErrorMm: 0.05,
              thresholdMm: 0.1,
              meaning: 'CAD to render bounds comparison',
            },
            nodeMappingComplete: true,
            rejectedCadComponentIds: [],
            surfaceComponentIds: [],
          },
        },
      };
    };

    const writeExportFixture = (dir, payload) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'model.step'), stepBytes);
      fs.writeFileSync(path.join(dir, 'model.glb'), glbBytes);
      fs.writeFileSync(path.join(dir, 'model.usdz'), usdzBytes);
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(payload.manifest));
      fs.writeFileSync(path.join(dir, 'pipeline_result.json'), JSON.stringify(payload));
    };

    const canonicalPayload = buildPoppyPayload(false);
    const shiftedPayload = buildPoppyPayload(true);
    assert.equal(matchesCatalogPlacements(poppy.nodes, canonicalPayload.nodes), true);
    assert.equal(matchesCatalogPlacements(poppy.nodes, shiftedPayload.nodes), false);

    const pythonStubPath = path.join(isolatedCwd, 'backend', '.venv', 'bin', 'python');
    const stubPayloadPath = path.join(isolatedCwd, 'stub-payload.json');
    fs.mkdirSync(path.dirname(pythonStubPath), { recursive: true });
    fs.writeFileSync(
      pythonStubPath,
      [
        `#!${process.execPath}`,
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const readline = require('node:readline');",
        'const rl = readline.createInterface({ input: process.stdin });',
        "rl.on('line', (line) => {",
        '  const req = JSON.parse(line);',
        "  if (req.cmd === 'shutdown') {",
        "    process.stdout.write(JSON.stringify({ id: req.id, ok: true }) + '\\n', () => process.exit(0));",
        '    rl.close();',
        '    return;',
        '  }',
        `  const payload = JSON.parse(fs.readFileSync(${JSON.stringify(stubPayloadPath)}, 'utf8'));`,
        '  fs.mkdirSync(req.outputDir, { recursive: true });',
        `  fs.writeFileSync(path.join(req.outputDir, 'model.step'), Buffer.from(${JSON.stringify(stepBytes.toString('base64'))}, 'base64'));`,
        `  fs.writeFileSync(path.join(req.outputDir, 'model.glb'), Buffer.from(${JSON.stringify(glbBytes.toString('base64'))}, 'base64'));`,
        `  fs.writeFileSync(path.join(req.outputDir, 'model.usdz'), Buffer.from(${JSON.stringify(usdzBytes.toString('base64'))}, 'base64'));`,
        "  fs.writeFileSync(path.join(req.outputDir, 'manifest.json'), JSON.stringify(payload.manifest));",
        "  fs.writeFileSync(path.join(req.outputDir, 'pipeline_result.json'), JSON.stringify(payload));",
        "  process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: payload }) + '\\n');",
        '});',
      ].join('\n'),
      { mode: 0o755 },
    );

    const precomputedDir = path.join(
      isolatedCwd,
      'backend',
      'data',
      'exports',
      'poppy_humanoid_v1',
    );
    const publicDir = path.join(isolatedCwd, 'public', 'assemblies', manifestHash);

    await shutdownWarmCadWorker();
    process.chdir(isolatedCwd);
    try {
      writeExportFixture(precomputedDir, shiftedPayload);
      fs.writeFileSync(stubPayloadPath, JSON.stringify(shiftedPayload));
      const shiftedRepo = new FirebaseEmulatorRepository();
      await assert.rejects(
        () =>
          orchestrateProjectAssemblyCreation({
            prompt: 'Inspect Poppy humanoid',
            provider: 'gemini',
            repository: shiftedRepo,
          }),
        /OpenCascade validation rejected assembly "poppy_humanoid_v1"/,
      );
      assert.equal(shiftedRepo.listCollection('projects').length, 0);
      assert.equal(fs.existsSync(publicDir), false);

      fs.writeFileSync(stubPayloadPath, JSON.stringify(canonicalPayload));
      const injectedRepo = new FirebaseEmulatorRepository();
      await assert.rejects(
        () =>
          orchestrateProjectAssemblyCreation({
            prompt: 'Inspect Poppy humanoid',
            provider: 'gemini',
            injectCollisionTest: true,
            repository: injectedRepo,
          }),
        /OpenCascade validation rejected assembly "poppy_humanoid_v1"/,
      );
      assert.equal(injectedRepo.listCollection('projects').length, 0);
      assert.equal(fs.existsSync(publicDir), false);

      writeExportFixture(precomputedDir, canonicalPayload);
      const canonicalRepo = new FirebaseEmulatorRepository();
      const persisted = await orchestrateProjectAssemblyCreation({
        prompt: 'Inspect Poppy humanoid',
        provider: 'gemini',
        repository: canonicalRepo,
      });
      assert.equal(persisted.archetypeId, 'poppy_humanoid_v1');
      assert.equal(canonicalRepo.listCollection('projects').length, 1);
      assert.equal(fs.existsSync(path.join(publicDir, 'pipeline_result.json')), true);
    } finally {
      await shutdownWarmCadWorker();
      process.chdir(originalCwd);
      fs.rmSync(isolatedCwd, { recursive: true, force: true });
    }
  });

  it('terminates a worker that acknowledges shutdown without exiting', async () => {
    const originalCwd = process.cwd();
    const isolatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zappd-lingering-worker-'));
    const pythonStubPath = path.join(isolatedCwd, 'backend', '.venv', 'bin', 'python');
    const pidFilePath = path.join(isolatedCwd, 'worker.pid');
    fs.mkdirSync(path.dirname(pythonStubPath), { recursive: true });
    fs.writeFileSync(
      pythonStubPath,
      [
        `#!${process.execPath}`,
        "const fs = require('node:fs');",
        "const readline = require('node:readline');",
        `fs.writeFileSync(${JSON.stringify(pidFilePath)}, String(process.pid));`,
        'setInterval(() => {}, 1000);',
        'const rl = readline.createInterface({ input: process.stdin });',
        "rl.on('line', (line) => {",
        '  const req = JSON.parse(line);',
        "  process.stdout.write(JSON.stringify({ id: req.id, ok: true, result: { stub: true } }) + '\\n');",
        '});',
      ].join('\n'),
      { mode: 0o755 },
    );

    await shutdownWarmCadWorker();
    process.chdir(isolatedCwd);
    try {
      const response = await requestWarmCadBuild({
        cmd: 'build',
        archetypeId: 'open_source_rover_v1',
        outputDir: isolatedCwd,
        cacheDir: isolatedCwd,
      });
      assert.deepEqual(response, { stub: true });
      const workerPid = Number(fs.readFileSync(pidFilePath, 'utf8'));
      assert.ok(Number.isInteger(workerPid) && workerPid > 0);

      const startedAt = Date.now();
      await shutdownWarmCadWorker({ closeTimeoutMs: 150 });
      assert.ok(Date.now() - startedAt < 2_000);
      assert.throws(() => process.kill(workerPid, 0), { code: 'ESRCH' });
    } finally {
      await shutdownWarmCadWorker({ closeTimeoutMs: 150 });
      process.chdir(originalCwd);
      fs.rmSync(isolatedCwd, { recursive: true, force: true });
    }
  });
});
