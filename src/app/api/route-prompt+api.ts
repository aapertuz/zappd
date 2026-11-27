import {
  type PromptRouteCloudRequest,
  parsePromptRouteCloudRequest,
  parsePromptRouteCloudResponse,
} from '@/shared/domain';

import { classifyPromptWithCloudProvider } from '@/backend/orchestrator/promptRouteResponder';

export async function POST(request: Request): Promise<Response> {
  let input: PromptRouteCloudRequest;
  try {
    input = parsePromptRouteCloudRequest(await request.json());
  } catch {
    return Response.json({ error: 'Invalid prompt routing request.' }, { status: 400 });
  }

  try {
    const decision = await classifyPromptWithCloudProvider(input, {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(3000)]),
    });
    return Response.json(parsePromptRouteCloudResponse(decision));
  } catch {
    return Response.json({ error: 'Cloud prompt routing is unavailable.' }, { status: 503 });
  }
}
