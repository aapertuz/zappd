import { type LearningCloudRequest, parseLearningCloudRequest } from '@/shared/domain';

import { generateCloudLearningResponse } from '@/backend/orchestrator/learningResponder';

export async function POST(request: Request): Promise<Response> {
  let input: LearningCloudRequest;
  try {
    input = parseLearningCloudRequest(await request.json());
  } catch {
    return Response.json({ error: 'Invalid learning request.' }, { status: 400 });
  }

  try {
    return Response.json(await generateCloudLearningResponse(input), { status: 200 });
  } catch {
    return Response.json({ error: 'Cloud learning is unavailable.' }, { status: 503 });
  }
}
