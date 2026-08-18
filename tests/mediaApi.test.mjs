import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, sign } from 'node:crypto';
import { deflateSync } from 'node:zlib';

import {
  detectMedia,
  handleOwnerMediaRequest,
} from '../netlify/functions/_shared/backend-core.mjs';
import {
  isPublicAddress,
  parsePublicHttpsUrl,
} from '../netlify/functions/_shared/safe-url.mjs';

const ORIGIN = 'https://sydneybao.com';
const PROJECT_ID = 'portfolio-media-test';
const OWNER_UID = 'owner-test-uid';
const OWNER_EMAIL = 'owner@example.com';
const TEST_KID = 'portfolio-test-key';

function base64Url(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return bytes.toString('base64url');
}

function createToken(privateKey, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url({ alg: 'RS256', kid: TEST_KID, typ: 'JWT' });
  const payload = base64Url({
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    sub: OWNER_UID,
    exp: now + 3600,
    iat: now,
    auth_time: now,
    email: OWNER_EMAIL,
    firebase: { sign_in_provider: 'password' },
    ...overrides,
  });
  const unsigned = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
  return `${unsigned}.${signature}`;
}

function request(token, body, headers = {}) {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      origin: ORIGIN,
      ...headers,
    },
    body,
  };
}

function responseJson(response) {
  return response.body ? JSON.parse(response.body) : null;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, 'ascii');
  const bytes = Buffer.alloc(12 + data.length);
  bytes.writeUInt32BE(data.length, 0);
  typeBytes.copy(bytes, 4);
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return bytes;
}

function pngFixture(
  pixel = [32, 96, 192, 255],
  includeImageData = true,
  compressedData = null,
) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const chunks = [pngChunk('IHDR', header)];
  if (includeImageData) {
    chunks.push(pngChunk('IDAT', compressedData || deflateSync(Buffer.from([0, ...pixel]))));
  }
  chunks.push(pngChunk('IEND'));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    ...chunks,
  ]);
}

function isoBox(type, ...parts) {
  const payload = Buffer.concat(parts);
  const bytes = Buffer.alloc(8 + payload.length);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.write(type, 4, 'ascii');
  payload.copy(bytes, 8);
  return bytes;
}

function mp4Fixture({ brand = 'isom', handler = 'vide', includeMovie = true, includeMedia = true } = {}) {
  const fileType = isoBox(
    'ftyp',
    Buffer.from(brand, 'ascii'),
    Buffer.alloc(4),
    Buffer.from('isommp42', 'ascii'),
  );
  const handlerPayload = Buffer.alloc(12);
  handlerPayload.write(handler, 8, 'ascii');
  const movie = isoBox(
    'moov',
    isoBox('trak', isoBox('mdia', isoBox('hdlr', handlerPayload))),
  );
  const mediaData = isoBox('mdat', Buffer.from([0, 0, 0, 1, 0x65, 0x88, 0x84]));
  return Buffer.concat([
    fileType,
    ...(includeMovie ? [movie] : []),
    ...(includeMedia ? [mediaData] : []),
  ]);
}

function ebmlSize(value) {
  const size = BigInt(value);
  for (let length = 1; length <= 8; length += 1) {
    const max = (1n << BigInt(7 * length)) - 2n;
    if (size > max) continue;
    const bytes = Buffer.alloc(length);
    let remaining = size;
    for (let index = length - 1; index >= 0; index -= 1) {
      bytes[index] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    bytes[0] |= 1 << (8 - length);
    return bytes;
  }
  throw new Error('Test EBML fixture is too large.');
}

function ebmlElement(id, data) {
  return Buffer.concat([Buffer.from(id), ebmlSize(data.length), data]);
}

function webmFixture({
  docType = 'webm',
  includeSegment = true,
  includeTracks = true,
  includeCluster = true,
  trackType = 1,
  codecId = 'V_VP9',
} = {}) {
  const documentType = ebmlElement([0x42, 0x82], Buffer.from(docType, 'ascii'));
  const header = ebmlElement([0x1a, 0x45, 0xdf, 0xa3], documentType);
  if (!includeSegment) return header;

  const trackEntry = ebmlElement([0xae], Buffer.concat([
    ebmlElement([0x83], Buffer.from([trackType])),
    ebmlElement([0x86], Buffer.from(codecId, 'ascii')),
  ]));
  const tracks = ebmlElement([0x16, 0x54, 0xae, 0x6b], trackEntry);
  const cluster = ebmlElement(
    [0x1f, 0x43, 0xb6, 0x75],
    ebmlElement([0xe7], Buffer.from([0])),
  );
  const segmentPayload = Buffer.concat([
    ...(includeTracks ? [tracks] : []),
    ...(includeCluster ? [cluster] : []),
  ]);
  return Buffer.concat([
    header,
    ebmlElement([0x18, 0x53, 0x80, 0x67], segmentPayload),
  ]);
}

function pdfFixture({ xrefOffsetDelta = 0, includePage = true, includeEof = true } = {}) {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n',
    ...(includePage
      ? ['3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n']
      : ['3 0 obj\n<< /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n']),
  ];
  const header = '%PDF-1.7\n%portfolio-resume\n';
  const objectOffsets = [];
  let body = header;
  for (const object of objects) {
    objectOffsets.push(Buffer.byteLength(body, 'latin1'));
    body += object;
  }
  const xrefOffset = Buffer.byteLength(body, 'latin1');
  const xrefEntries = [
    '0000000000 65535 f \n',
    ...objectOffsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
  ].join('');
  const trailer = [
    'xref\n',
    `0 ${objects.length + 1}\n`,
    xrefEntries,
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`,
    `startxref\n${xrefOffset + xrefOffsetDelta}\n`,
    ...(includeEof ? ['%%EOF\n'] : []),
  ].join('');
  return Buffer.from(`${body}${trailer}`, 'latin1');
}

function gitBlobSha(bytes) {
  return createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

const fixtureDirectory = mkdtempSync(join(tmpdir(), 'portfolio-media-test-'));
const privateKeyPath = join(fixtureDirectory, 'private-key.pem');
const certificatePath = join(fixtureDirectory, 'certificate.pem');

try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', privateKeyPath,
    '-out', certificatePath,
    '-subj', '/CN=portfolio-media-test',
    '-days', '1',
  ], { stdio: 'ignore' });

  const privateKey = readFileSync(privateKeyPath, 'utf8');
  const certificate = readFileSync(certificatePath, 'utf8');
  const validToken = createToken(privateKey);
  const githubCalls = [];
  const githubFiles = new Map();
  const originalFetch = globalThis.fetch;

  Object.assign(process.env, {
    FIREBASE_OWNER_EMAIL: OWNER_EMAIL,
    FIREBASE_OWNER_SIGN_IN_PROVIDER: 'password',
    FIREBASE_OWNER_UID: OWNER_UID,
    FIREBASE_PROJECT_ID: PROJECT_ID,
    GITHUB_ACTIONS_TOKEN: 'actions-test-token',
    GITHUB_CONTENTS_TOKEN: 'contents-test-token',
    GITHUB_MEDIA_BRANCH: 'main',
    GITHUB_MEDIA_REPOSITORY: 'SydneyBao/Personal-Portfolio',
    OWNER_MEDIA_ALLOWED_ORIGINS: ORIGIN,
  });

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('securetoken@system.gserviceaccount.com')) {
      return new Response(JSON.stringify({ [TEST_KID]: certificate }), {
        status: 200,
        headers: { 'cache-control': 'public, max-age=3600', 'content-type': 'application/json' },
      });
    }

    githubCalls.push({ target, options });
    if (target.includes('/actions/workflows/capture-portfolio-media.yml/dispatches')) {
      return new Response(null, { status: 204 });
    }
    if (target.includes('/contents/')) {
      const key = target.split('?', 1)[0];
      if ((options.method || 'GET') === 'GET') {
        const existing = githubFiles.get(key);
        if (!existing) return new Response(null, { status: 404 });
        return new Response(JSON.stringify({ sha: existing.sha }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      const body = JSON.parse(options.body);
      const content = Buffer.from(body.content, 'base64');
      const sha = gitBlobSha(content);
      githubFiles.set(key, { content, sha });
      return new Response(JSON.stringify({ content: { sha } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch target: ${target}`);
  };

  try {
    assert.equal(parsePublicHttpsUrl('https://example.com/demo#section').url, 'https://example.com/demo');
    assert.throws(() => parsePublicHttpsUrl('http://example.com/'), /HTTPS/);
    assert.throws(() => parsePublicHttpsUrl('https://example.com/?token=secret'), /query parameters/);
    assert.throws(() => parsePublicHttpsUrl('https://127.0.0.1/'), /Private|reserved|non-routable/);
    assert.throws(() => parsePublicHttpsUrl('https://2130706433/'), /Private|reserved|non-routable/);
    assert.equal(isPublicAddress('8.8.8.8'), true);
    assert.equal(isPublicAddress('::ffff:127.0.0.1'), false);

    const png = pngFixture();
    assert.equal(detectMedia(png).mimeType, 'image/png');
    assert.throws(() => detectMedia(pngFixture(undefined, false)), /PNG, JPEG, GIF, WebP, MP4, or WebM/);
    assert.throws(
      () => detectMedia(pngFixture(undefined, true, Buffer.from('not-zlib'))),
      /PNG, JPEG, GIF, WebP, MP4, or WebM/,
    );
    const corruptPng = Buffer.from(png);
    corruptPng[corruptPng.length - 1] ^= 1;
    assert.throws(() => detectMedia(corruptPng), /PNG, JPEG, GIF, WebP, MP4, or WebM/);

    assert.equal(detectMedia(mp4Fixture()).mimeType, 'video/mp4');
    assert.throws(() => detectMedia(mp4Fixture({ brand: 'heic' })), /PNG, JPEG, GIF, WebP, MP4, or WebM/);
    assert.throws(() => detectMedia(mp4Fixture({ handler: 'soun' })), /PNG, JPEG, GIF, WebP, MP4, or WebM/);
    assert.throws(() => detectMedia(mp4Fixture({ includeMovie: false })), /PNG, JPEG, GIF, WebP, MP4, or WebM/);
    assert.throws(() => detectMedia(mp4Fixture({ includeMedia: false })), /PNG, JPEG, GIF, WebP, MP4, or WebM/);

    assert.equal(detectMedia(webmFixture()).mimeType, 'video/webm');
    assert.throws(() => detectMedia(webmFixture({ docType: 'matroska' })), /PNG, JPEG, GIF, WebP, MP4, or WebM/);
    assert.throws(() => detectMedia(webmFixture({ includeSegment: false })), /PNG, JPEG, GIF, WebP, MP4, or WebM/);
    assert.throws(() => detectMedia(webmFixture({ includeTracks: false })), /PNG, JPEG, GIF, WebP, MP4, or WebM/);
    assert.throws(() => detectMedia(webmFixture({ includeCluster: false })), /PNG, JPEG, GIF, WebP, MP4, or WebM/);
    assert.throws(() => detectMedia(webmFixture({ trackType: 2, codecId: 'A_OPUS' })), /PNG, JPEG, GIF, WebP, MP4, or WebM/);

    const pdf = pdfFixture();
    assert.deepEqual(detectMedia(pdf), {
      extension: 'pdf',
      mimeType: 'application/pdf',
      type: 'document',
    });
    assert.equal(
      detectMedia(readFileSync(new URL('../public/SydneyBaoResume.pdf', import.meta.url))).mimeType,
      'application/pdf',
    );
    assert.throws(() => detectMedia(pdfFixture({ xrefOffsetDelta: 1 })), /PDF or PNG/);
    assert.throws(() => detectMedia(pdfFixture({ includePage: false })), /PDF or PNG/);
    assert.throws(() => detectMedia(pdfFixture({ includeEof: false })), /PDF or PNG/);
    assert.throws(() => detectMedia(Buffer.from('%PDF-1.7\n<script>alert(1)</script>\n%%EOF')), /PDF or PNG/);

    const preflight = await handleOwnerMediaRequest({
      method: 'OPTIONS',
      headers: { origin: ORIGIN },
      body: null,
    }, 'upload');
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.body, '');

    const missingAuth = await handleOwnerMediaRequest({
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: { invalid: 'body must not be parsed before auth' },
    }, 'upload');
    assert.equal(missingAuth.statusCode, 401);
    assert.equal(responseJson(missingAuth).error.code, 'authentication_required');

    const rejectedDispatches = [];
    const rejectedCaptureOptions = {
      captureDispatcher: async (payload) => rejectedDispatches.push(payload),
    };
    const wrongOwner = await handleOwnerMediaRequest(
      request(createToken(privateKey, { sub: 'different-user' }), { slug: 'demo', url: 'https://8.8.8.8/' }),
      'capture',
      rejectedCaptureOptions,
    );
    assert.equal(wrongOwner.statusCode, 403);
    assert.equal(responseJson(wrongOwner).error.code, 'owner_only');

    const privateCapture = await handleOwnerMediaRequest(
      request(validToken, { slug: 'demo', url: 'https://127.0.0.1/' }),
      'capture',
      rejectedCaptureOptions,
    );
    assert.equal(privateCapture.statusCode, 400);
    assert.equal(responseJson(privateCapture).error.code, 'unsafe_url');
    assert.equal(rejectedDispatches.length, 0);

    const capture = await handleOwnerMediaRequest(
      request(validToken, { slug: 'demo-project', url: 'https://8.8.8.8/' }),
      'capture',
    );
    assert.equal(capture.statusCode, 202);
    const capturePayload = responseJson(capture);
    assert.equal(capturePayload.status, 'queued');
    assert.match(capturePayload.requestId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(capturePayload.mediaItems.map(({ type }) => type), ['image', 'video']);
    assert.match(
      capturePayload.mediaItems[0].url,
      new RegExp(`^/portfolio/uploads/demo-project/captures/${capturePayload.requestId}/cover\\.webp$`),
    );
    const dispatchCall = githubCalls.find(({ target }) => target.includes('/actions/workflows/'));
    assert.equal(dispatchCall.options.headers.Authorization, 'Bearer actions-test-token');
    const dispatchBody = JSON.parse(dispatchCall.options.body);
    assert.equal(dispatchBody.inputs.requestId, capturePayload.requestId);
    assert.equal(dispatchBody.inputs.url, 'https://8.8.8.8/');

    const injectedDispatches = [];
    const locallyDispatchedCapture = await handleOwnerMediaRequest(
      request(validToken, { slug: 'local-project', url: 'https://8.8.4.4/' }),
      'capture',
      {
        captureDispatcher: async (payload) => injectedDispatches.push(payload),
      },
    );
    assert.equal(locallyDispatchedCapture.statusCode, 202);
    const locallyDispatchedPayload = responseJson(locallyDispatchedCapture);
    assert.equal(injectedDispatches.length, 1);
    assert.deepEqual(injectedDispatches[0], {
      requestId: locallyDispatchedPayload.requestId,
      slug: 'local-project',
      url: 'https://8.8.4.4/',
    });
    assert.deepEqual(locallyDispatchedPayload.mediaItems.map(({ type }) => type), ['image', 'video']);

    const uploadRequestId = '123e4567-e89b-42d3-a456-426614174000';
    const putsBeforeUpload = githubCalls.filter(({ options }) => options.method === 'PUT').length;
    const upload = await handleOwnerMediaRequest(
      request(validToken, {
        slug: 'demo-project',
        kind: 'image',
        contentBase64: png.toString('base64'),
        requestId: uploadRequestId,
      }),
      'upload',
    );
    assert.equal(upload.statusCode, 201);
    const uploadPayload = responseJson(upload);
    assert.equal(uploadPayload.mimeType, 'image/png');
    assert.equal(uploadPayload.requestId, uploadRequestId);
    assert.equal(
      uploadPayload.path,
      `public/portfolio/uploads/demo-project/image-${uploadRequestId}.png`,
    );
    assert.equal(uploadPayload.publicUrl, uploadPayload.path.replace(/^public/, ''));
    const uploadCall = githubCalls.filter(({ options }) => options.method === 'PUT').at(-1);
    assert.equal(uploadCall.options.headers.Authorization, 'Bearer contents-test-token');
    assert.equal(JSON.parse(uploadCall.options.body).content, png.toString('base64'));

    const retry = await handleOwnerMediaRequest(
      request(validToken, {
        slug: 'demo-project',
        kind: 'image',
        contentBase64: png.toString('base64'),
        requestId: uploadRequestId,
      }),
      'upload',
    );
    assert.equal(retry.statusCode, 201);
    assert.equal(responseJson(retry).path, uploadPayload.path);
    assert.equal(
      githubCalls.filter(({ options }) => options.method === 'PUT').length,
      putsBeforeUpload + 1,
    );

    const collision = await handleOwnerMediaRequest(
      request(validToken, {
        slug: 'demo-project',
        kind: 'image',
        contentBase64: pngFixture([192, 64, 32, 255]).toString('base64'),
        requestId: uploadRequestId,
      }),
      'upload',
    );
    assert.equal(collision.statusCode, 409);
    assert.equal(responseJson(collision).error.code, 'upload_collision');

    const documentRequestId = '628d26fa-2796-4eb8-9c06-51b9a77dd2c1';
    const documentUpload = await handleOwnerMediaRequest(
      request(validToken, {
        slug: 'profile',
        kind: 'document',
        contentBase64: pdf.toString('base64'),
        requestId: documentRequestId,
      }),
      'upload',
    );
    assert.equal(documentUpload.statusCode, 201);
    const documentPayload = responseJson(documentUpload);
    assert.equal(documentPayload.mimeType, 'application/pdf');
    assert.deepEqual(documentPayload.media, {
      url: `/portfolio/uploads/profile/document-${documentRequestId}.pdf`,
      type: 'document',
    });
    assert.equal(
      documentPayload.path,
      `public/portfolio/uploads/profile/document-${documentRequestId}.pdf`,
    );
    const documentCall = githubCalls.filter(({ options }) => options.method === 'PUT').at(-1);
    assert.equal(JSON.parse(documentCall.options.body).content, pdf.toString('base64'));

    const documentWrongSlug = await handleOwnerMediaRequest(
      request(validToken, {
        slug: 'demo-project',
        kind: 'document',
        contentBase64: pdf.toString('base64'),
        requestId: '3109696a-868f-48a6-9fe2-3b87e5fe9123',
      }),
      'upload',
    );
    assert.equal(documentWrongSlug.statusCode, 400);
    assert.equal(responseJson(documentWrongSlug).error.code, 'invalid_document_slug');

    const documentMismatch = await handleOwnerMediaRequest(
      request(validToken, {
        slug: 'profile',
        kind: 'document',
        contentBase64: png.toString('base64'),
        requestId: '4a2bd98c-b423-44aa-945c-fb54187569fa',
      }),
      'upload',
    );
    assert.equal(documentMismatch.statusCode, 415);
    assert.equal(responseJson(documentMismatch).error.code, 'media_mismatch');

    const oversizedDocument = await handleOwnerMediaRequest(
      request(validToken, {
        slug: 'profile',
        kind: 'document',
        contentBase64: Buffer.alloc((3 * 1024 * 1024) + 1, 0x20).toString('base64'),
        requestId: '0dbc74b6-87ae-41b8-83b6-4d187eaa97f8',
      }),
      'upload',
    );
    assert.equal(oversizedDocument.statusCode, 413);
    assert.equal(responseJson(oversizedDocument).error.code, 'file_too_large');

    const invalidRequestId = await handleOwnerMediaRequest(
      request(validToken, {
        slug: 'demo-project',
        kind: 'image',
        contentBase64: png.toString('base64'),
        requestId: 'not-a-uuid',
      }),
      'upload',
    );
    assert.equal(invalidRequestId.statusCode, 400);
    assert.equal(responseJson(invalidRequestId).error.code, 'invalid_request_id');

    const invalidMedia = await handleOwnerMediaRequest(
      request(validToken, {
        slug: 'demo-project',
        kind: 'image',
        contentBase64: Buffer.from('<svg></svg>').toString('base64'),
        requestId: 'f90c7285-dfcf-477a-b2f8-daf3997e36ae',
      }),
      'upload',
    );
    assert.equal(invalidMedia.statusCode, 415);
    assert.equal(responseJson(invalidMedia).error.code, 'unsupported_media');

    console.log('Firebase owner media endpoint tests passed.');
  } finally {
    globalThis.fetch = originalFetch;
  }
} finally {
  rmSync(fixtureDirectory, { recursive: true, force: true });
}
