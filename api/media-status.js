import { handleOwnerMediaRequest, vercelRequest } from '../netlify/functions/_shared/backend-core.mjs';

export const maxDuration = 30;

export default async function mediaStatus(request, response) {
  const result = await handleOwnerMediaRequest(vercelRequest(request), 'status');
  Object.entries(result.headers || {}).forEach(([name, value]) => response.setHeader(name, value));
  if (result.statusCode === 204) return response.status(204).end();
  return response.status(result.statusCode).send(result.body);
}
