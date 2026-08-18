import { handleOwnerMediaRequest, netlifyRequest } from './_shared/backend-core.mjs';

export async function handler(event) {
  return handleOwnerMediaRequest(netlifyRequest(event), 'capture');
}
