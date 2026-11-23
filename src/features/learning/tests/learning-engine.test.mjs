import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  QUADCOPTER_ARCHETYPE,
  parseLearningCloudRequest,
  parseLearningCloudResponse,
} from '@/shared/domain';
import { FirebaseEmulatorRepository, createFirebaseAiLogicLocalRunner } from '@/shared/firebase';

import {
  buildGroundedComponentExplanation,
  hydrateComponentLearningContext,
  retrieveComponentLearningContext,
  runLearningRequest,
} from '@/features/learning';

import { POST } from '../../../app/api/learn+api.ts';

const assembly = {
  ...QUADCOPTER_ARCHETYPE,
  projectId: 'proj_learning_test',
  verificationStatus: 'sourced_verified',
  nodes: QUADCOPTER_ARCHETYPE.nodes.map((blueprint) => ({
    ...blueprint,
    provenance: {
      origin: blueprint.origin,
      verificationStatus: 'sourced_verified',
      sourceUrl: blueprint.sourceUrl,
      sourceName: blueprint.sourceName,
      spdxLicense: blueprint.spdxLicense,
      stepSha256: 'a'.repeat(64),
    },
    glbNodeName: blueprint.id,
    usdzPrimPath: `/${blueprint.id}`,
  })),
  manifest: { manifestHash: 'b'.repeat(64) },
  validation: {
    valid: true,
    brepValid: true,
    interferenceCount: 0,
    maxDimensionalErrorMm: 0,
    nodeMappingComplete: true,
    failures: [],
  },
};

const componentId = 'comp_motor_rr';
const component = assembly.nodes.find(({ id }) => id === componentId);
const request = { kind: 'explain' };
const localText =
  'The rear right brushless motor seats in the rear right arm. Its shaft seats the propeller hub.';
const cloudText =
  'The rear right motor is seated coaxially in the cantilevered arm. Its shaft carries the propeller hub.';
const cloudResponse = { text: cloudText, inferenceSource: 'cloud', providerName: 'DeepSeek' };
const unavailable = async () => ({ available: false, reason: 'No on-device model is available.' });
const offlineRepository = { tryFetchProjectLearningDocsFromFirestore: async () => null };

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

async function seedLearningRecords(offlineStorage = createStorage(), project = assembly) {
  const repository = new FirebaseEmulatorRepository();
  await hydrateComponentLearningContext({
    assembly: project,
    repository,
    offlineStorage,
    syncLearningDocuments: false,
  });
  return { repository, offlineStorage };
}

function createCloudRequest(context, additions) {
  const body = { kind: 'explain', context, ...additions };
  return new Request('http://localhost/api/learn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function isolateProviderKeys(test) {
  const originalDirectory = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), 'zappd-learning-test-'));
  const keys = ['DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY'];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.chdir(directory);
  keys.forEach((key) => delete process.env[key]);
  test.after(() => {
    process.chdir(originalDirectory);
    rmSync(directory, { recursive: true });
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
}

describe('component learning context', () => {
  it('hydrates verified nodes, relationships, steps, and explanations into repository and offline storage', async () => {
    const { repository, offlineStorage } = await seedLearningRecords();
    const explanation = repository.readComponentExplanation(assembly.projectId, componentId);
    assert.equal(explanation.componentId, componentId);
    assert.equal(explanation.verificationStatus, 'sourced_verified');
    assert.deepEqual(
      repository.readDocument(`projects/${assembly.projectId}/explanations/${componentId}`),
      explanation,
    );
    assert.equal(repository.readProjectNodes(assembly.projectId).length, assembly.nodes.length);
    assert.equal(
      repository.readProjectRelationships(assembly.projectId).length,
      assembly.relationships.length,
    );
    assert.equal(
      repository.readProjectSteps(assembly.projectId).length,
      assembly.assemblySteps.length,
    );

    const context = await retrieveComponentLearningContext({
      assembly,
      componentId,
      offlineStorage,
      repository: offlineRepository,
    });
    assert.equal(context.contextSource, 'offline_cache');
    assert.equal(context.component.id, componentId);
    assert.equal(
      context.parentComponentName,
      component.parentId === null
        ? null
        : assembly.nodes.find(({ id }) => id === component.parentId).name,
    );
    assert.deepEqual(
      context.relationships.map(({ id, direction, counterpartId }) => ({
        id,
        direction,
        counterpartId,
      })),
      [
        { id: 'rel_motor_rr_arm', direction: 'outgoing', counterpartId: 'comp_arm_rr' },
        { id: 'rel_prop_rr_motor', direction: 'incoming', counterpartId: 'subcomp_prop_rr' },
      ],
    );
    assert.ok(context.assemblySteps.some(({ id }) => id === 'step_quad_3'));
    assert.deepEqual(context.storedExplanation, explanation);
  });

  it('prefers Firestore data and keeps confirmed updates available offline', async () => {
    const { repository, offlineStorage } = await seedLearningRecords();
    const storedExplanation = {
      ...repository.readComponentExplanation(assembly.projectId, componentId),
      summary: 'The verified rear right motor record was updated.',
    };
    const onlineRepository = {
      tryFetchProjectLearningDocsFromFirestore: async (projectId, requestedId) => {
        assert.equal(projectId, assembly.projectId);
        assert.equal(requestedId, componentId);
        return {
          nodes: assembly.nodes,
          relationships: assembly.relationships,
          assemblySteps: assembly.assemblySteps,
          explanations: [storedExplanation],
        };
      },
    };
    const live = await retrieveComponentLearningContext({
      assembly,
      componentId,
      offlineStorage,
      repository: onlineRepository,
    });
    assert.equal(live.contextSource, 'firestore');
    assert.equal(live.storedExplanation.summary, storedExplanation.summary);

    await seedLearningRecords(offlineStorage);
    const cached = await retrieveComponentLearningContext({
      assembly,
      componentId,
      offlineStorage,
      repository: {
        tryFetchProjectLearningDocsFromFirestore: async () => {
          throw new Error('offline');
        },
      },
    });
    assert.equal(cached.contextSource, 'offline_cache');
    assert.equal(cached.storedExplanation.summary, storedExplanation.summary);
  });

  it('uses memory when the browser blocks storage and rejects malformed cached records', async () => {
    const memoryProject = { ...assembly, projectId: 'proj_learning_memory' };
    const blocked = {
      getItem: () => {
        throw new Error('storage blocked');
      },
      setItem: () => {
        throw new Error('storage blocked');
      },
    };
    await seedLearningRecords(blocked, memoryProject);
    const context = await retrieveComponentLearningContext({
      assembly: memoryProject,
      componentId,
      repository: offlineRepository,
      offlineStorage: blocked,
    });
    assert.equal(context.contextSource, 'offline_cache');

    await assert.rejects(
      retrieveComponentLearningContext({
        assembly: { ...assembly, projectId: 'proj_learning_corrupt' },
        componentId,
        repository: offlineRepository,
        offlineStorage: { getItem: () => '{"nodes":[{"id":2}]}', setItem: () => {} },
      }),
      /No verified learning records/,
    );
  });

  it('grounds saved explanations in component dimensions, mount details, and steps', () => {
    const explanation = buildGroundedComponentExplanation(
      assembly,
      component,
      assembly.relationships,
      assembly.assemblySteps,
    );
    assert.match(explanation.summary, /rear right/i);
    assert.ok(explanation.summary.includes(component.dimensionsMm.join(' × ')));
    assert.equal(
      explanation.operatingPrinciple,
      'Coaxial cylindrical motor stator seat pressed into the cantilevered arm cup.',
    );
    assert.match(explanation.systemRole, /step 3/i);
  });
});

describe('learning inference sequence', () => {
  it('streams the on-device response and finishes without contacting the cloud', async () => {
    const { offlineStorage } = await seedLearningRecords();
    const chunks = [];
    const result = await runLearningRequest({
      assembly,
      componentId,
      request,
      offlineStorage,
      repository: offlineRepository,
      onChunk: (chunk, metadata) => chunks.push({ chunk, ...metadata }),
      localRunner: async ({ prompt, onChunk }) => {
        assert.match(prompt, /cylindrical motor stator seat/);
        assert.match(prompt, /Seat Outrunner Brushless Motors/);
        assert.match(prompt, /specifications/);
        onChunk(localText.slice(0, 29));
        onChunk(localText.slice(29));
        return { available: true, text: localText, inferenceSource: 'on_device' };
      },
      cloudRunner: () => assert.fail('Cloud inference was called after a sufficient local result'),
    });
    assert.deepEqual(result, {
      text: localText,
      inferenceSource: 'on_device',
      contextSource: 'offline_cache',
    });
    assert.equal(chunks.length, 2);
    assert.equal(chunks.map(({ chunk }) => chunk).join(''), localText);
    assert.ok(
      chunks.every(
        ({ contextSource, inferenceSource }) =>
          contextSource === 'offline_cache' && inferenceSource === 'on_device',
      ),
    );
  });

  it('posts grounded context with the selected provider when local inference is unavailable', async (test) => {
    const { offlineStorage } = await seedLearningRecords();
    const providerRequests = [];
    test.mock.method(globalThis, 'fetch', async (url, options) => {
      providerRequests.push({
        url,
        method: options.method,
        body: parseLearningCloudRequest(JSON.parse(options.body)),
      });
      return Response.json(cloudResponse);
    });
    const result = await runLearningRequest({
      assembly,
      componentId,
      request,
      offlineStorage,
      repository: offlineRepository,
      provider: 'deepseek',
      providerExplicitlySelected: true,
      localRunner: unavailable,
      isOnline: () => true,
    });

    assert.deepEqual(result, {
      ...cloudResponse,
      contextSource: 'offline_cache',
      fallbackReason: 'No on-device model is available.',
    });
    assert.equal(providerRequests.length, 1);
    const [{ url, method, body }] = providerRequests;
    assert.equal(url, '/api/learn');
    assert.equal(method, 'POST');
    assert.equal(body.provider, 'deepseek');
    assert.equal(body.providerExplicitlySelected, true);
    assert.equal(body.context.component.id, componentId);
    assert.equal(body.context.contextSource, 'offline_cache');
  });

  for (const [name, insufficientText] of [
    ['too short', 'A motor.'],
    [
      'a placeholder',
      'This placeholder will be replaced with a detailed explanation of the rear right motor.',
    ],
    ['unrelated', 'Honey bees collect nectar and use it to produce food for the colony.'],
    ['missing the requested detail', localText],
  ]) {
    it(`uses cloud fallback when the local answer is ${name}`, async () => {
      const { offlineStorage } = await seedLearningRecords();
      const question = {
        kind: 'question',
        question: 'What is the current rating of the rear right motor?',
      };
      const result = await runLearningRequest({
        assembly,
        componentId,
        request: question,
        offlineStorage,
        repository: offlineRepository,
        localRunner: async () => ({
          available: true,
          text: insufficientText,
          inferenceSource: 'on_device',
        }),
        cloudRunner: async (cloudRequest) => {
          assert.equal(cloudRequest.question, question.question);
          return cloudResponse;
        },
        isOnline: () => true,
      });
      assert.equal(result.inferenceSource, 'cloud');
      assert.equal(result.text, cloudText);
      assert.match(result.fallbackReason, /on-device response/i);
    });
  }

  it('answers recorded questions offline and declines missing facts without calling cloud', async () => {
    const { offlineStorage } = await seedLearningRecords();
    const options = {
      assembly,
      componentId,
      offlineStorage,
      repository: offlineRepository,
      localRunner: unavailable,
      isOnline: () => false,
      cloudRunner: () => assert.fail('Cloud inference was called offline'),
    };

    const explanation = await runLearningRequest({ ...options, request });
    assert.equal(explanation.inferenceSource, 'offline_cache');
    assert.match(explanation.text, /^Saved explanation\./);
    const answer = await runLearningRequest({
      ...options,
      request: { kind: 'question', question: 'What is the material?' },
    });
    assert.equal(answer.inferenceSource, 'offline_cache');
    assert.match(answer.text, /^Saved component records\./);
    assert.ok(answer.text.includes(component.materialHint.replaceAll('_', ' ')));
    const missing = await runLearningRequest({
      ...options,
      request: { kind: 'question', question: 'What is the maximum operating temperature?' },
    });
    assert.match(missing.text, /^The saved records do not answer this question\./);
  });

  it('returns saved records if local execution and cloud inference both fail', async () => {
    const { offlineStorage } = await seedLearningRecords();
    const result = await runLearningRequest({
      assembly,
      componentId,
      request,
      offlineStorage,
      repository: offlineRepository,
      localRunner: async () => {
        throw new Error('local failed');
      },
      cloudRunner: async () => {
        throw new Error('cloud failed');
      },
      isOnline: () => true,
    });
    assert.equal(result.inferenceSource, 'offline_cache');
    assert.match(result.text, /^Saved explanation\./);
    assert.match(result.fallbackReason, /Cloud learning is unavailable/);
  });

  it('reports unsupported on-device inference using the real SDK adapter in Node', async () => {
    const result = await createFirebaseAiLogicLocalRunner()({ prompt: 'Explain the motor.' });
    assert.equal(result.available, false);
    assert.match(result.reason, /unavailable/);
  });
});

describe('cloud learning API', () => {
  it('rejects malformed requests and response payloads at their boundaries', async () => {
    const { offlineStorage } = await seedLearningRecords();
    const context = await retrieveComponentLearningContext({
      assembly,
      componentId,
      offlineStorage,
      repository: offlineRepository,
    });
    const invalidBodies = [
      { kind: 'question', context, question: '  ' },
      { kind: 'explain', context, question: 'Unexpected' },
      { kind: 'explain', context, provider: 'other' },
      { kind: 'explain', context, providerExplicitlySelected: true },
      {
        kind: 'explain',
        context: { ...context, component: { ...context.component, parentId: 123 } },
      },
      {
        kind: 'explain',
        context: {
          ...context,
          storedExplanation: { ...context.storedExplanation, componentId: 'comp_arm_rr' },
        },
      },
      {
        kind: 'explain',
        context: {
          ...context,
          storedExplanation: { ...context.storedExplanation, verificationStatus: 'unverified' },
        },
      },
    ];
    for (const body of invalidBodies) {
      assert.throws(() => parseLearningCloudRequest(body));
      const response = await POST(createCloudRequest(context, body));
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: 'Invalid learning request.' });
    }
    assert.throws(() =>
      parseLearningCloudResponse({ ...cloudResponse, inferenceSource: 'on_device' }),
    );
    assert.throws(() => parseLearningCloudResponse({ ...cloudResponse, text: '  ' }));
  });

  it('returns 503 for an explicitly selected provider without a key', async (test) => {
    isolateProviderKeys(test);
    process.env.DEEPSEEK_API_KEY = 'test-deepseek';
    const { offlineStorage } = await seedLearningRecords();
    const context = await retrieveComponentLearningContext({
      assembly,
      componentId,
      offlineStorage,
      repository: offlineRepository,
    });
    test.mock.method(globalThis, 'fetch', () =>
      assert.fail('An unconfigured provider initiated a request'),
    );
    const response = await POST(
      createCloudRequest(context, { provider: 'openai', providerExplicitlySelected: true }),
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'Cloud learning is unavailable.' });
  });

  it('supports all registry providers and falls back to a configured provider when selection is implicit', async (test) => {
    isolateProviderKeys(test);
    process.env.DEEPSEEK_API_KEY = 'test-deepseek';
    const { offlineStorage } = await seedLearningRecords();
    const context = await retrieveComponentLearningContext({
      assembly,
      componentId,
      offlineStorage,
      repository: offlineRepository,
    });
    const providerUrls = [];
    test.mock.method(globalThis, 'fetch', async (url, options) => {
      const body = JSON.parse(options.body);
      providerUrls.push(url);
      if (url.includes('generativelanguage.googleapis.com')) {
        assert.equal(options.headers['x-goog-api-key'], 'test-gemini');
        assert.match(
          body.systemInstruction.parts[0].text,
          /Use only the component reference records/,
        );
        assert.match(body.contents[0].parts[0].text, /current rating/);
        return Response.json({ candidates: [{ content: { parts: [{ text: cloudText }] } }] });
      }
      const isOpenAi = url.includes('api.openai.com');
      assert.equal(
        options.headers.Authorization,
        isOpenAi ? 'Bearer test-openai' : 'Bearer test-deepseek',
      );
      assert.match(body.messages[0].content, /Use only the component reference records/);
      assert.match(body.messages[1].content, /cylindrical motor stator seat/);
      return Response.json({ choices: [{ message: { content: cloudText } }] });
    });

    const implicit = await POST(createCloudRequest(context, { provider: 'openai' }));
    assert.equal(implicit.status, 200);
    assert.deepEqual(await implicit.json(), cloudResponse);

    process.env.OPENAI_API_KEY = 'test-openai';
    process.env.GEMINI_API_KEY = 'test-gemini';
    for (const [provider, providerName] of [
      ['openai', 'OpenAI'],
      ['gemini', 'Google Gemini'],
    ]) {
      const response = await POST(
        createCloudRequest(context, {
          kind: 'question',
          question: 'What is the current rating?',
          provider,
          providerExplicitlySelected: true,
        }),
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ...cloudResponse, providerName });
    }
    assert.deepEqual(providerUrls, [
      'https://api.deepseek.com/chat/completions',
      'https://api.openai.com/v1/chat/completions',
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    ]);
  });
});
