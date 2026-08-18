/* eslint-env node */
import crypto from 'node:crypto';
import { inflateSync } from 'node:zlib';
import {
  parsePublicHttpsUrl,
  UnsafeUrlError,
  validatePublicHttpsUrl,
} from './safe-url.mjs';

const FIREBASE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const GITHUB_API_ROOT = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const CAPTURE_WORKFLOW = 'capture-portfolio-media.yml';
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_PNG_DECODED_BYTES = 64 * 1024 * 1024;
export const MAX_OWNER_MEDIA_REQUEST_BYTES = 4_400_000;
const MAX_STATUS_PATHS = 12;
const MAX_TOKEN_LENGTH = 8192;
const CLOCK_SKEW_SECONDS = 300;

let firebaseCertCache = { expiresAt: 0, fetchedAt: 0, certificates: null };

export class HttpError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function getHeader(headers, name) {
  if (!headers) return '';
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  const value = entry?.[1];
  return Array.isArray(value) ? value[0] || '' : String(value || '');
}

function configuredOrigins(override) {
  const configured = Array.isArray(override)
    ? override
    : String(override ?? process.env.OWNER_MEDIA_ALLOWED_ORIGINS ?? '').split(',');
  return configured
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      try {
        const parsed = new URL(value);
        if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== value) return '';
        return parsed.origin;
      } catch {
        return '';
      }
    })
    .filter(Boolean);
}

function configuredPublicMediaOrigin(override) {
  const value = String(override ?? process.env.OWNER_MEDIA_PUBLIC_ORIGIN ?? '').trim();
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:'
      || parsed.origin !== value
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) throw new Error('invalid');
    parsePublicHttpsUrl(`${value}/`);
    return value;
  } catch {
    throw new HttpError(500, 'server_not_configured', 'The media service is not configured.');
  }
}

function requireAllowedOrigin(headers, allowedOriginOverride) {
  const allowedOrigins = configuredOrigins(allowedOriginOverride);
  if (allowedOrigins.length === 0) {
    throw new HttpError(500, 'server_not_configured', 'The media service is not configured.');
  }

  const origin = getHeader(headers, 'origin');
  if (!origin || !allowedOrigins.includes(origin)) {
    throw new HttpError(403, 'origin_not_allowed', 'This request origin is not allowed.');
  }
  return origin;
}

function responseHeaders(origin = '') {
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
  };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}

function jsonResponse(statusCode, payload, origin = '', extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...responseHeaders(origin), ...extraHeaders },
    body: JSON.stringify(payload),
  };
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new HttpError(401, 'invalid_token', 'Authentication failed.');
  }
  try {
    return Buffer.from(value, 'base64url');
  } catch {
    throw new HttpError(401, 'invalid_token', 'Authentication failed.');
  }
}

function parseJwtPart(value) {
  try {
    const parsed = JSON.parse(decodeBase64Url(value).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, 'invalid_token', 'Authentication failed.');
  }
}

function cacheMaxAge(headers) {
  const match = String(headers.get('cache-control') || '').match(/(?:^|,)\s*max-age=(\d+)/i);
  if (!match) return 3600;
  return Math.max(60, Math.min(Number(match[1]), 24 * 60 * 60));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function firebaseCertificates(forceRefresh = false) {
  const now = Date.now();
  if (forceRefresh && firebaseCertCache.certificates && now - firebaseCertCache.fetchedAt < 60000) {
    return firebaseCertCache.certificates;
  }
  if (!forceRefresh && firebaseCertCache.certificates && firebaseCertCache.expiresAt > now) {
    return firebaseCertCache.certificates;
  }

  let response;
  try {
    response = await fetchWithTimeout(FIREBASE_CERTS_URL, {
      headers: { Accept: 'application/json' },
    }, 5000);
  } catch {
    throw new HttpError(503, 'auth_unavailable', 'Authentication is temporarily unavailable.');
  }
  if (!response.ok) {
    throw new HttpError(503, 'auth_unavailable', 'Authentication is temporarily unavailable.');
  }

  const certificates = await response.json();
  if (!certificates || typeof certificates !== 'object' || Array.isArray(certificates)) {
    throw new HttpError(503, 'auth_unavailable', 'Authentication is temporarily unavailable.');
  }

  firebaseCertCache = {
    certificates,
    expiresAt: now + cacheMaxAge(response.headers) * 1000,
    fetchedAt: now,
  };
  return certificates;
}

async function verifyFirebaseOwner(headers, override = {}) {
  const projectId = String(override.projectId ?? process.env.FIREBASE_PROJECT_ID ?? '').trim();
  const ownerUid = String(override.ownerUid ?? process.env.FIREBASE_OWNER_UID ?? '').trim();
  if (!projectId || !ownerUid) {
    throw new HttpError(500, 'server_not_configured', 'The media service is not configured.');
  }

  const authorization = getHeader(headers, 'authorization');
  const match = authorization.match(/^Bearer ([A-Za-z0-9._-]+)$/);
  if (!match || match[1].length > MAX_TOKEN_LENGTH) {
    throw new HttpError(401, 'authentication_required', 'Owner authentication is required.');
  }

  const token = match[1];
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new HttpError(401, 'invalid_token', 'Authentication failed.');
  }

  const header = parseJwtPart(parts[0]);
  const claims = parseJwtPart(parts[1]);
  if (
    header.alg !== 'RS256'
    || typeof header.kid !== 'string'
    || header.kid.length === 0
    || header.kid.length > 200
  ) {
    throw new HttpError(401, 'invalid_token', 'Authentication failed.');
  }

  let certificates = await firebaseCertificates();
  if (!certificates[header.kid]) certificates = await firebaseCertificates(true);
  const certificate = certificates[header.kid];
  if (typeof certificate !== 'string' || !certificate.includes('BEGIN CERTIFICATE')) {
    throw new HttpError(401, 'invalid_token', 'Authentication failed.');
  }

  const signature = decodeBase64Url(parts[2]);
  const signatureValid = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'),
    certificate,
    signature,
  );
  if (!signatureValid) {
    throw new HttpError(401, 'invalid_token', 'Authentication failed.');
  }

  const now = Math.floor(Date.now() / 1000);
  if (
    claims.aud !== projectId
    || claims.iss !== `https://securetoken.google.com/${projectId}`
    || typeof claims.sub !== 'string'
    || claims.sub.length === 0
    || claims.sub.length > 128
    || !Number.isFinite(claims.exp)
    || claims.exp <= now
    || !Number.isFinite(claims.iat)
    || claims.iat > now + CLOCK_SKEW_SECONDS
    || !Number.isFinite(claims.auth_time)
    || claims.auth_time > now + CLOCK_SKEW_SECONDS
  ) {
    throw new HttpError(401, 'invalid_token', 'Authentication failed.');
  }

  if (claims.sub !== ownerUid) {
    throw new HttpError(403, 'owner_only', 'This action is restricted to the portfolio owner.');
  }

  const expectedEmail = String(
    override.ownerEmail ?? process.env.FIREBASE_OWNER_EMAIL ?? '',
  ).trim().toLowerCase();
  if (expectedEmail && String(claims.email || '').toLowerCase() !== expectedEmail) {
    throw new HttpError(403, 'owner_only', 'This action is restricted to the portfolio owner.');
  }

  const expectedProvider = String(
    override.signInProvider ?? process.env.FIREBASE_OWNER_SIGN_IN_PROVIDER ?? '',
  ).trim();
  if (expectedProvider && claims.firebase?.sign_in_provider !== expectedProvider) {
    throw new HttpError(403, 'owner_only', 'Use the configured owner sign-in method.');
  }

  return claims;
}

function parseJsonBody(request) {
  const contentType = getHeader(request.headers, 'content-type').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new HttpError(415, 'json_required', 'Send this request as application/json.');
  }

  const rawDeclaredLength = getHeader(request.headers, 'content-length');
  const declaredLength = Number(rawDeclaredLength || 0);
  if (
    rawDeclaredLength
    && (
      !Number.isInteger(declaredLength)
      || declaredLength < 0
      || declaredLength > MAX_OWNER_MEDIA_REQUEST_BYTES
    )
  ) {
    throw new HttpError(413, 'request_too_large', 'The request is too large.');
  }

  let body;
  try {
    body = request.body;
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    if (body.byteLength > MAX_OWNER_MEDIA_REQUEST_BYTES) {
      throw new HttpError(413, 'request_too_large', 'The request is too large.');
    }
    body = Buffer.from(body).toString('utf8');
  }
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > MAX_OWNER_MEDIA_REQUEST_BYTES) {
      throw new HttpError(413, 'request_too_large', 'The request is too large.');
    }
    try {
      body = JSON.parse(body);
    } catch {
      throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.');
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_body', 'The request body must be a JSON object.');
  }
  try {
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_OWNER_MEDIA_REQUEST_BYTES) {
      throw new HttpError(413, 'request_too_large', 'The request is too large.');
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'invalid_body', 'The request body must be a JSON object.');
  }
  return body;
}

function requireOnlyKeys(body, allowed) {
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new HttpError(400, 'unexpected_field', `Unexpected request field: ${unexpected[0]}.`);
  }
}

function validateSlug(value) {
  if (
    typeof value !== 'string'
    || value.length > 80
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
  ) {
    throw new HttpError(400, 'invalid_slug', 'Use a lowercase project slug with letters, numbers, and hyphens.');
  }
  return value;
}

function validateRequestId(value) {
  if (
    typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  ) {
    throw new HttpError(400, 'invalid_request_id', 'Upload requestId must be a canonical UUID.');
  }
  return value;
}

function validateMediaStatusPaths(slug, value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_STATUS_PATHS) {
    throw new HttpError(
      400,
      'invalid_media_paths',
      `Provide between 1 and ${MAX_STATUS_PATHS} media paths.`,
    );
  }

  const prefix = `/portfolio/uploads/${slug}/`;
  const relativeMediaPath = /^(?:[a-z0-9][a-z0-9_-]*\/)*[a-z0-9][a-z0-9._-]*\.(?:png|jpe?g|gif|webp|mp4|webm)$/;
  const profileDocumentPath = /^document-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/;
  const paths = value.map((path) => {
    const relativePath = typeof path === 'string' && path.startsWith(prefix)
      ? path.slice(prefix.length)
      : '';
    const isGeneratedMedia = relativeMediaPath.test(relativePath);
    const isGeneratedProfileDocument = slug === 'profile' && profileDocumentPath.test(relativePath);
    if (
      typeof path !== 'string'
      || path.length > 512
      || !path.startsWith(prefix)
      || path.includes('..')
      || (!isGeneratedMedia && !isGeneratedProfileDocument)
    ) {
      throw new HttpError(
        400,
        'invalid_media_path',
        'Media status is limited to generated files for this project.',
      );
    }
    return path;
  });

  if (new Set(paths).size !== paths.length) {
    throw new HttpError(400, 'duplicate_media_path', 'Media status paths must be unique.');
  }
  return paths;
}

function decodeCanonicalBase64(value) {
  const maxBase64Length = Math.ceil(MAX_FILE_BYTES / 3) * 4;
  if (typeof value === 'string' && value.length > maxBase64Length) {
    throw new HttpError(413, 'file_too_large', 'Media files must be 3 MiB or smaller.');
  }
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxBase64Length
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new HttpError(400, 'invalid_base64', 'The media data is not valid Base64.');
  }

  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES || bytes.toString('base64') !== value) {
    throw new HttpError(413, 'file_too_large', 'Media files must be 3 MiB or smaller.');
  }
  return bytes;
}

export function detectMedia(bytes) {
  if (isPng(bytes)) {
    return { extension: 'png', mimeType: 'image/png', type: 'image' };
  }
  if (isJpeg(bytes)) {
    return { extension: 'jpg', mimeType: 'image/jpeg', type: 'image' };
  }
  if (isGif(bytes)) {
    return { extension: 'gif', mimeType: 'image/gif', type: 'image' };
  }
  if (isWebp(bytes)) {
    return { extension: 'webp', mimeType: 'image/webp', type: 'image' };
  }
  if (isMp4(bytes)) {
    return { extension: 'mp4', mimeType: 'video/mp4', type: 'video' };
  }
  if (isWebm(bytes)) {
    return { extension: 'webm', mimeType: 'video/webm', type: 'video' };
  }
  if (isPdf(bytes)) {
    return { extension: 'pdf', mimeType: 'application/pdf', type: 'document' };
  }
  throw new HttpError(415, 'unsupported_media', 'Use a PDF or PNG, JPEG, GIF, WebP, MP4, or WebM file.');
}

/* eslint-disable no-control-regex -- PDF syntax defines NUL and ASCII whitespace explicitly. */
function isPdf(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 128) return false;

  const header = bytes.subarray(0, 16).toString('latin1');
  if (!/^%PDF-(?:1\.[0-7]|2\.0)(?:\r\n|\r|\n)/.test(header)) return false;

  const eofIndex = bytes.lastIndexOf(Buffer.from('%%EOF', 'ascii'));
  if (eofIndex < 0) return false;
  const trailingBytes = bytes.subarray(eofIndex + 5);
  if (trailingBytes.length > 1024 || !/^[\x00\x09\x0a\x0c\x0d\x20]*$/.test(trailingBytes.toString('latin1'))) {
    return false;
  }

  const beforeEof = bytes.subarray(0, eofIndex).toString('latin1');
  const startXref = /startxref[\x00\x09\x0a\x0c\x0d\x20]+([0-9]+)[\x00\x09\x0a\x0c\x0d\x20]*$/.exec(beforeEof);
  if (!startXref) return false;
  const xrefOffset = Number(startXref[1]);
  if (!Number.isSafeInteger(xrefOffset) || xrefOffset <= 0 || xrefOffset >= bytes.length) return false;

  const xrefStart = bytes.subarray(xrefOffset, Math.min(bytes.length, xrefOffset + 4096)).toString('latin1');
  const hasTraditionalXref = /^xref(?:\r\n|\r|\n|[\x09\x0c\x20])/.test(xrefStart);
  const hasXrefStream = /^\d+[\x09\x0c\x20]+\d+[\x09\x0c\x20]+obj\b[\s\S]*?\/Type[\x09\x0a\x0c\x0d\x20]+\/XRef\b/.test(xrefStart);
  if (!hasTraditionalXref && !hasXrefStream) return false;

  const documentText = bytes.subarray(0, eofIndex).toString('latin1');
  return /(?:^|[\r\n])\d+[\x09\x0c\x20]+\d+[\x09\x0c\x20]+obj\b[\s\S]*?endobj\b/.test(documentText)
    && /\/Root[\x09\x0a\x0c\x0d\x20]+\d+[\x09\x0c\x20]+\d+[\x09\x0c\x20]+R\b/.test(documentText)
    && /\/Type[\x09\x0a\x0c\x0d\x20]+\/Catalog\b/.test(documentText)
    && /\/Pages[\x09\x0a\x0c\x0d\x20]+\d+[\x09\x0c\x20]+\d+[\x09\x0c\x20]+R\b/.test(documentText)
    && /\/Type[\x09\x0a\x0c\x0d\x20]+\/Page\b/.test(documentText);
}
/* eslint-enable no-control-regex */

function validImageDimensions(width, height) {
  return Number.isInteger(width)
    && Number.isInteger(height)
    && width > 0
    && height > 0
    && width <= 8192
    && height <= 8192
    && width * height <= 40_000_000;
}

function isPng(bytes) {
  if (
    bytes.length < 57
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) return false;

  let offset = 8;
  let chunkIndex = 0;
  let colorType = null;
  let bitDepth = null;
  let width = null;
  let height = null;
  let interlaceMethod = null;
  let sawPalette = false;
  let sawImageData = false;
  let imageDataEnded = false;
  let imageDataBytes = 0;
  const imageDataChunks = [];

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) return false;
    const dataLength = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const dataEnd = dataStart + dataLength;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > bytes.length) return false;

    const typeBytes = bytes.subarray(typeStart, dataStart);
    const type = typeBytes.toString('ascii');
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(type)) return false;
    if (pngCrc32(bytes.subarray(typeStart, dataEnd)) !== bytes.readUInt32BE(dataEnd)) return false;

    if (chunkIndex === 0 && type !== 'IHDR') return false;
    if (type === 'IHDR') {
      if (chunkIndex !== 0 || dataLength !== 13) return false;
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      interlaceMethod = bytes[dataStart + 12];
      const validBitDepths = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        !validImageDimensions(width, height)
        || !validBitDepths[colorType]?.includes(bitDepth)
        || bytes[dataStart + 10] !== 0
        || bytes[dataStart + 11] !== 0
        || ![0, 1].includes(interlaceMethod)
      ) return false;
    } else if (type === 'PLTE') {
      if (
        sawPalette
        || sawImageData
        || [0, 4].includes(colorType)
        || dataLength === 0
        || dataLength > 768
        || dataLength % 3 !== 0
        || (colorType === 3 && dataLength / 3 > 2 ** bitDepth)
      ) return false;
      sawPalette = true;
    } else if (type === 'IDAT') {
      if (imageDataEnded || (colorType === 3 && !sawPalette)) return false;
      sawImageData = true;
      imageDataBytes += dataLength;
      imageDataChunks.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      return dataLength === 0
        && sawImageData
        && imageDataBytes > 0
        && chunkEnd === bytes.length
        && pngImageDataIsDecodable({
          bitDepth,
          colorType,
          height,
          imageDataChunks,
          interlaceMethod,
          width,
        });
    } else {
      if (type[0] === type[0].toUpperCase()) return false;
      if (sawImageData) imageDataEnded = true;
    }

    offset = chunkEnd;
    chunkIndex += 1;
  }
  return false;
}

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngImageDataIsDecodable({
  bitDepth,
  colorType,
  height,
  imageDataChunks,
  interlaceMethod,
  width,
}) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) return false;
  const bitsPerPixel = channels * bitDepth;
  const passes = interlaceMethod === 0
    ? [{ x: 0, y: 0, dx: 1, dy: 1 }]
    : [
      { x: 0, y: 0, dx: 8, dy: 8 },
      { x: 4, y: 0, dx: 8, dy: 8 },
      { x: 0, y: 4, dx: 4, dy: 8 },
      { x: 2, y: 0, dx: 4, dy: 4 },
      { x: 0, y: 2, dx: 2, dy: 4 },
      { x: 1, y: 0, dx: 2, dy: 2 },
      { x: 0, y: 1, dx: 1, dy: 2 },
    ];

  const scanlineLayouts = passes.map((pass) => {
    const passWidth = width <= pass.x ? 0 : Math.ceil((width - pass.x) / pass.dx);
    const rows = height <= pass.y ? 0 : Math.ceil((height - pass.y) / pass.dy);
    return {
      rowBytes: Math.ceil((passWidth * bitsPerPixel) / 8),
      rows: passWidth === 0 ? 0 : rows,
    };
  });
  const expectedLength = scanlineLayouts.reduce(
    (total, { rowBytes, rows }) => total + rows * (rowBytes + 1),
    0,
  );
  if (expectedLength <= 0 || expectedLength > MAX_PNG_DECODED_BYTES) return false;

  let decoded;
  try {
    decoded = inflateSync(Buffer.concat(imageDataChunks), { maxOutputLength: expectedLength });
  } catch {
    return false;
  }
  if (decoded.length !== expectedLength) return false;

  let offset = 0;
  for (const { rowBytes, rows } of scanlineLayouts) {
    for (let row = 0; row < rows; row += 1) {
      if (decoded[offset] > 4) return false;
      offset += rowBytes + 1;
    }
  }
  return offset === decoded.length;
}

function jpegDimensions(bytes) {
  if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (startOfFrameMarkers.has(marker)) {
      if (segmentLength < 7) return null;
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += segmentLength;
  }
  return null;
}

function isJpeg(bytes) {
  const dimensions = jpegDimensions(bytes);
  return dimensions
    && bytes[bytes.length - 2] === 0xff
    && bytes[bytes.length - 1] === 0xd9
    && validImageDimensions(dimensions.width, dimensions.height);
}

function isGif(bytes) {
  return bytes.length >= 14
    && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
    && validImageDimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8))
    && bytes[bytes.length - 1] === 0x3b;
}

function webpDimensions(bytes) {
  if (
    bytes.length < 25
    || bytes.subarray(0, 4).toString('ascii') !== 'RIFF'
    || bytes.subarray(8, 12).toString('ascii') !== 'WEBP'
    || bytes.readUInt32LE(4) + 8 !== bytes.length
  ) return null;

  const chunk = bytes.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  if (
    chunk === 'VP8 '
    && bytes.length >= 30
    && bytes[23] === 0x9d
    && bytes[24] === 0x01
    && bytes[25] === 0x2a
  ) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    return {
      width: 1 + (((bytes[22] & 0x3f) << 8) | bytes[21]),
      height: 1 + (((bytes[24] & 0x0f) << 10) | (bytes[23] << 2) | (bytes[22] >> 6)),
    };
  }
  return null;
}

function isWebp(bytes) {
  const dimensions = webpDimensions(bytes);
  return dimensions && validImageDimensions(dimensions.width, dimensions.height);
}

function isMp4(bytes) {
  const boxes = readIsoBoxes(bytes, 0, bytes.length);
  if (!boxes || boxes.length < 3 || boxes[0].type !== 'ftyp') return false;
  const fileType = boxes[0];
  if (fileType.dataEnd - fileType.dataStart < 8 || (fileType.dataEnd - fileType.dataStart) % 4 !== 0) {
    return false;
  }
  const allowedMajorBrands = new Set([
    'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6',
    'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'MSNV',
  ]);
  if (!allowedMajorBrands.has(bytes.subarray(fileType.dataStart, fileType.dataStart + 4).toString('ascii'))) {
    return false;
  }

  const movieBoxes = boxes.filter(({ type }) => type === 'moov');
  const hasMediaData = boxes.some(({ type, dataStart, dataEnd }) => (
    type === 'mdat' && dataEnd > dataStart
  ));
  return movieBoxes.length === 1
    && hasMediaData
    && movieBoxes.some((movie) => isoMovieHasVideoTrack(bytes, movie));
}

function readIsoBoxes(bytes, start, end) {
  const boxes = [];
  let offset = start;
  while (offset < end) {
    if (offset + 8 > end) return null;
    const size32 = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    if (!/^[\x20-\x7e]{4}$/.test(type)) return null;

    let headerSize = 8;
    let boxSize = size32;
    if (size32 === 1) {
      if (offset + 16 > end) return null;
      const extendedSize = bytes.readBigUInt64BE(offset + 8);
      if (extendedSize > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      headerSize = 16;
      boxSize = Number(extendedSize);
    } else if (size32 === 0) {
      boxSize = end - offset;
    }

    if (boxSize < headerSize || offset + boxSize > end) return null;
    boxes.push({
      type,
      dataStart: offset + headerSize,
      dataEnd: offset + boxSize,
    });
    offset += boxSize;
    if (size32 === 0 && offset !== end) return null;
  }
  return offset === end ? boxes : null;
}

function isoMovieHasVideoTrack(bytes, movie) {
  const movieChildren = readIsoBoxes(bytes, movie.dataStart, movie.dataEnd);
  if (!movieChildren) return false;

  return movieChildren.some((child) => {
    if (child.type !== 'trak') return false;
    const trackChildren = readIsoBoxes(bytes, child.dataStart, child.dataEnd);
    if (!trackChildren) return false;
    return trackChildren.some((trackChild) => {
      if (trackChild.type !== 'mdia') return false;
      const mediaChildren = readIsoBoxes(bytes, trackChild.dataStart, trackChild.dataEnd);
      if (!mediaChildren) return false;
      return mediaChildren.some((mediaChild) => (
        mediaChild.type === 'hdlr'
        && mediaChild.dataEnd - mediaChild.dataStart >= 12
        && bytes.subarray(mediaChild.dataStart + 8, mediaChild.dataStart + 12).toString('ascii') === 'vide'
      ));
    });
  });
}

function readEbmlVint(bytes, offset, stripMarker) {
  if (offset >= bytes.length || bytes[offset] === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && (bytes[offset] & mask) === 0) {
    length += 1;
    mask >>= 1;
  }
  if (length > 8 || offset + length > bytes.length) return null;

  let value = BigInt(stripMarker ? bytes[offset] & (mask - 1) : bytes[offset]);
  for (let index = 1; index < length; index += 1) {
    value = (value << 8n) | BigInt(bytes[offset + index]);
  }
  const unknown = stripMarker && value === (1n << BigInt(7 * length)) - 1n;
  return { length, unknown, value };
}

function isWebm(bytes) {
  if (bytes.length < 12 || !bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return false;
  }

  const headerSize = readEbmlVint(bytes, 4, true);
  if (!headerSize || headerSize.unknown || headerSize.value > 4096n) return false;
  const headerStart = 4 + headerSize.length;
  const headerEnd = headerStart + Number(headerSize.value);
  if (headerEnd > bytes.length) return false;

  let offset = headerStart;
  let hasWebmDocType = false;
  let sawDocType = false;
  while (offset < headerEnd) {
    const id = readEbmlVint(bytes, offset, false);
    if (!id || id.length > 4) return false;
    offset += id.length;
    const size = readEbmlVint(bytes, offset, true);
    if (!size || size.unknown) return false;
    offset += size.length;
    if (size.value > BigInt(headerEnd - offset)) return false;
    const dataLength = Number(size.value);
    if (offset + dataLength > headerEnd) return false;
    if (id.value === 0x4282n) {
      if (sawDocType || dataLength !== 4) return false;
      sawDocType = true;
      hasWebmDocType = bytes.subarray(offset, offset + 4).toString('ascii') === 'webm';
    }
    offset += dataLength;
  }
  if (!hasWebmDocType || offset !== headerEnd) return false;

  const segmentId = readEbmlVint(bytes, headerEnd, false);
  if (!segmentId || segmentId.value !== 0x18538067n) return false;
  const segmentSizeOffset = headerEnd + segmentId.length;
  const segmentSize = readEbmlVint(bytes, segmentSizeOffset, true);
  if (!segmentSize) return false;
  const segmentStart = segmentSizeOffset + segmentSize.length;
  if (!segmentSize.unknown && segmentSize.value !== BigInt(bytes.length - segmentStart)) return false;
  const segmentEnd = bytes.length;

  let hasVideoTrack = false;
  let hasCluster = false;
  offset = segmentStart;
  while (offset < segmentEnd) {
    const elementId = readEbmlVint(bytes, offset, false);
    if (!elementId || elementId.length > 4) return false;
    offset += elementId.length;
    const elementSize = readEbmlVint(bytes, offset, true);
    if (!elementSize) return false;
    offset += elementSize.length;
    if (elementSize.unknown) {
      return elementId.value === 0x1f43b675n && hasVideoTrack && offset < segmentEnd;
    }

    if (elementSize.value > BigInt(segmentEnd - offset)) return false;
    const elementEnd = offset + Number(elementSize.value);
    if (elementId.value === 0x1654ae6bn) {
      hasVideoTrack = hasVideoTrack || webmTracksHaveVideo(bytes, offset, elementEnd);
    } else if (elementId.value === 0x1f43b675n) {
      if (elementEnd === offset) return false;
      hasCluster = true;
    }
    offset = elementEnd;
  }
  return offset === segmentEnd && hasVideoTrack && hasCluster;
}

function webmTracksHaveVideo(bytes, start, end) {
  let offset = start;
  let hasVideoTrack = false;
  while (offset < end) {
    const id = readEbmlVint(bytes, offset, false);
    if (!id || id.length > 4) return false;
    offset += id.length;
    const size = readEbmlVint(bytes, offset, true);
    if (!size || size.unknown) return false;
    offset += size.length;
    if (size.value > BigInt(end - offset)) return false;
    const elementEnd = offset + Number(size.value);
    if (id.value === 0xaen && webmTrackEntryIsVideo(bytes, offset, elementEnd)) {
      hasVideoTrack = true;
    }
    offset = elementEnd;
  }
  return offset === end && hasVideoTrack;
}

function webmTrackEntryIsVideo(bytes, start, end) {
  let offset = start;
  let isVideo = false;
  let hasVideoCodec = false;
  while (offset < end) {
    const id = readEbmlVint(bytes, offset, false);
    if (!id || id.length > 4) return false;
    offset += id.length;
    const size = readEbmlVint(bytes, offset, true);
    if (!size || size.unknown) return false;
    offset += size.length;
    if (size.value > BigInt(end - offset)) return false;
    const dataLength = Number(size.value);
    const elementEnd = offset + dataLength;
    if (id.value === 0x83n && dataLength > 0 && dataLength <= 8) {
      let trackType = 0n;
      for (let index = offset; index < elementEnd; index += 1) {
        trackType = (trackType << 8n) | BigInt(bytes[index]);
      }
      isVideo = trackType === 1n;
    } else if (id.value === 0x86n && dataLength > 2 && dataLength <= 64) {
      hasVideoCodec = bytes.subarray(offset, elementEnd).toString('ascii').startsWith('V_');
    }
    offset = elementEnd;
  }
  return offset === end && isVideo && hasVideoCodec;
}

function githubConfiguration(tokenName) {
  const repository = String(process.env.GITHUB_MEDIA_REPOSITORY || '').trim();
  const branch = String(process.env.GITHUB_MEDIA_BRANCH || 'main').trim();
  const token = String(process.env[tokenName] || process.env.GITHUB_MEDIA_TOKEN || '').trim();
  const repositoryMatch = repository.match(/^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/);
  if (
    !repositoryMatch
    || !token
    || !/^[A-Za-z0-9](?:[A-Za-z0-9._/-]{0,198}[A-Za-z0-9])?$/.test(branch)
    || branch.includes('..')
    || branch.includes('//')
  ) {
    throw new HttpError(500, 'server_not_configured', 'The media service is not configured.');
  }
  return {
    owner: repositoryMatch[1],
    repo: repositoryMatch[2],
    branch,
    token,
  };
}

function encodeGithubPath(value) {
  return value.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

async function githubRequest(config, pathname, options = {}) {
  let response;
  try {
    response = await fetchWithTimeout(`${GITHUB_API_ROOT}${pathname}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'SydneyBao-portfolio-media-service',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        ...options.headers,
      },
    }, 6500);
  } catch {
    throw new HttpError(502, 'github_unavailable', 'GitHub is temporarily unavailable.');
  }
  return response;
}

function gitBlobSha(bytes) {
  return crypto.createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

async function existingGithubFile(config, path) {
  const response = await githubRequest(
    config,
    `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encodeGithubPath(path)}?ref=${encodeURIComponent(config.branch)}`,
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new HttpError(502, 'github_error', 'GitHub could not check the upload destination.');
  }
  return response.json();
}

function captureRequestIdForPaths(slug, paths) {
  if (paths.length !== 2) return '';

  const escapedSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const capturePath = new RegExp(
    `^/portfolio/uploads/${escapedSlug}/captures/`
      + '([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/'
      + '(cover\\.webp|walkthrough\\.webm)$',
  );
  let requestId = '';
  const filenames = new Set();
  for (const path of paths) {
    const match = path.match(capturePath);
    if (!match || (requestId && match[1] !== requestId)) return '';
    requestId = match[1];
    filenames.add(match[2]);
  }
  return filenames.size === 2
    && filenames.has('cover.webp')
    && filenames.has('walkthrough.webm')
    ? requestId
    : '';
}

async function productionCaptureStatus({ requestId, slug }) {
  const config = githubConfiguration('GITHUB_ACTIONS_TOKEN');
  const endpoint = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`
    + `/actions/workflows/${encodeURIComponent(CAPTURE_WORKFLOW)}/runs`
    + `?branch=${encodeURIComponent(config.branch)}&event=workflow_dispatch&per_page=100`;
  const response = await githubRequest(config, endpoint);
  if (!response.ok) {
    throw new HttpError(502, 'github_error', 'GitHub could not check the capture status.');
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new HttpError(502, 'github_error', 'GitHub could not check the capture status.');
  }
  if (!payload || !Array.isArray(payload.workflow_runs)) {
    throw new HttpError(502, 'github_error', 'GitHub could not check the capture status.');
  }

  const displayTitle = `Capture ${slug} (${requestId})`;
  const run = payload.workflow_runs.find((candidate) => (
    candidate
    && typeof candidate === 'object'
    && candidate.display_title === displayTitle
  ));
  if (!run) return { status: 'unknown' };

  const conclusion = typeof run.conclusion === 'string' ? run.conclusion : null;
  const runUrl = typeof run.html_url === 'string' ? run.html_url : undefined;
  if (run.status === 'completed') {
    return {
      status: conclusion === 'success' ? 'success' : 'failed',
      conclusion,
      ...(runUrl ? { runUrl } : {}),
    };
  }
  return { status: 'pending', conclusion, ...(runUrl ? { runUrl } : {}) };
}

function expectedMediaContentType(path) {
  if (/\.pdf$/.test(path)) return 'application/pdf';
  return /\.(?:mp4|webm)$/.test(path) ? 'video/' : 'image/';
}

async function deployedMediaExists(publicOrigin, path) {
  const expectedContentType = expectedMediaContentType(path);
  let response;
  try {
    response = await fetchWithTimeout(`${publicOrigin}${path}`, {
      cache: 'no-store',
      method: 'HEAD',
      headers: {
        Accept: expectedContentType.endsWith('/') ? `${expectedContentType}*` : expectedContentType,
        'Cache-Control': 'no-cache',
      },
      redirect: 'manual',
    }, 5000);
  } catch {
    return false;
  }

  const contentType = String(response.headers.get('content-type') || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  return response.ok && (
    expectedContentType.endsWith('/')
      ? contentType.startsWith(expectedContentType)
      : contentType === expectedContentType
  );
}

async function mediaStatus(body, options = {}) {
  requireOnlyKeys(body, ['slug', 'paths']);
  const slug = validateSlug(body.slug);
  const paths = validateMediaStatusPaths(slug, body.paths);
  const publicOrigin = configuredPublicMediaOrigin(options.publicMediaOrigin);
  let findCommittedMedia = options.mediaStorage?.findCommittedMedia;
  if (!findCommittedMedia) {
    const config = githubConfiguration('GITHUB_CONTENTS_TOKEN');
    findCommittedMedia = (path) => existingGithubFile(config, path);
  }

  const githubItems = await Promise.all(paths.map(async (path) => {
    const file = await findCommittedMedia(`public${path}`);
    return {
      path,
      githubReady: Boolean(file && !Array.isArray(file) && file.type === 'file' && file.sha),
    };
  }));

  const hasCommittedMedia = githubItems.some(({ githubReady }) => githubReady);
  if (hasCommittedMedia) {
    try {
      await validatePublicHttpsUrl(`${publicOrigin}/`);
    } catch (error) {
      if (error instanceof UnsafeUrlError) {
        throw new HttpError(500, 'server_not_configured', 'The media service is not configured.');
      }
      throw error;
    }
  }

  const items = await Promise.all(githubItems.map(async ({ path, githubReady }) => {
    const publicReady = githubReady && await deployedMediaExists(publicOrigin, path);
    return {
      path,
      githubReady,
      publicReady,
      ready: githubReady && publicReady,
    };
  }));
  const pendingPaths = items.filter(({ ready }) => !ready).map(({ path }) => path);
  const ready = pendingPaths.length === 0;

  const captureRequestId = captureRequestIdForPaths(slug, paths);
  if (!ready && captureRequestId) {
    const captureStatusProvider = options.captureStatusProvider || productionCaptureStatus;
    if (typeof captureStatusProvider !== 'function') {
      throw new HttpError(500, 'server_not_configured', 'The media service is not configured.');
    }
    const captureStatus = await captureStatusProvider({ requestId: captureRequestId, slug });
    if (!captureStatus || !['unknown', 'pending', 'success', 'failed'].includes(captureStatus.status)) {
      throw new HttpError(502, 'capture_status_unavailable', 'The capture status is temporarily unavailable.');
    }
    if (captureStatus.status === 'failed') {
      throw new HttpError(
        422,
        'capture_failed',
        'The capture workflow failed before producing media. Retry the capture after checking GitHub Actions.',
      );
    }
  }

  return {
    statusCode: ready ? 200 : 202,
    payload: {
      ok: true,
      ready,
      status: ready ? 'ready' : 'pending',
      items,
      pendingPaths,
    },
  };
}

async function commitUniqueMedia({ bytes, path, slug, media }) {
  const config = githubConfiguration('GITHUB_CONTENTS_TOKEN');
  const expectedBlobSha = gitBlobSha(bytes);
  const endpoint = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${encodeGithubPath(path)}`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const existing = await existingGithubFile(config, path);
      if (existing) {
        if (existing.sha === expectedBlobSha) return existing;
        throw new HttpError(409, 'upload_collision', 'The upload destination is already in use. Try again.');
      }

      const response = await githubRequest(config, endpoint, {
        method: 'PUT',
        body: JSON.stringify({
          branch: config.branch,
          message: `Add ${media.type} media for ${slug}`,
          content: bytes.toString('base64'),
        }),
      });
      if (response.ok) {
        const payload = await response.json();
        return payload.content || payload;
      }
      if (![409, 422, 429, 500, 502, 503, 504].includes(response.status)) {
        throw new HttpError(502, 'github_rejected', 'GitHub rejected the media upload.');
      }
    } catch (error) {
      if (
        !(error instanceof HttpError)
        || !['github_unavailable', 'github_error'].includes(error.code)
      ) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt) + crypto.randomInt(100)));
  }

  let reconciled = null;
  try {
    reconciled = await existingGithubFile(config, path);
  } catch {
    // A final reconciliation failure is reported as a retryable upload failure below.
  }
  if (reconciled?.sha === expectedBlobSha) return reconciled;
  throw new HttpError(503, 'upload_retry', 'The upload could not be completed. Try again.');
}

async function uploadMedia(body, options = {}) {
  requireOnlyKeys(body, ['slug', 'kind', 'contentBase64', 'requestId']);
  const slug = validateSlug(body.slug);
  const requestId = validateRequestId(body.requestId);
  if (!['image', 'video', 'document'].includes(body.kind)) {
    throw new HttpError(400, 'invalid_kind', 'Upload kind must be image, video, or document.');
  }
  if (body.kind === 'document' && slug !== 'profile') {
    throw new HttpError(400, 'invalid_document_slug', 'Resume documents must use the profile slug.');
  }

  const bytes = decodeCanonicalBase64(body.contentBase64);
  const media = detectMedia(bytes);
  if (media.type !== body.kind) {
    throw new HttpError(415, 'media_mismatch', `The uploaded bytes are not a valid ${body.kind}.`);
  }

  const filename = `${media.type}-${requestId}.${media.extension}`;
  const path = `public/portfolio/uploads/${slug}/${filename}`;
  const commitMedia = options.mediaStorage?.commitUniqueMedia || commitUniqueMedia;
  const committed = await commitMedia({ bytes, path, slug, media });
  const publicUrl = `/portfolio/uploads/${slug}/${filename}`;
  const mediaItem = { url: publicUrl, type: media.type };

  return {
    statusCode: 201,
    payload: {
      ok: true,
      media: mediaItem,
      mediaItems: [mediaItem],
      publicUrl,
      path,
      sha: committed.sha || null,
      mimeType: media.mimeType,
      requestId,
    },
  };
}

async function dispatchProductionCapture({ requestId, slug, url }) {
  const config = githubConfiguration('GITHUB_ACTIONS_TOKEN');
  const endpoint = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/actions/workflows/${CAPTURE_WORKFLOW}/dispatches`;
  const response = await githubRequest(config, endpoint, {
    method: 'POST',
    body: JSON.stringify({
      ref: config.branch,
      inputs: { requestId, slug, url },
    }),
  });

  if (![200, 204].includes(response.status)) {
    throw new HttpError(502, 'capture_dispatch_failed', 'GitHub could not queue the project capture.');
  }
}

async function dispatchCapture(body, options = {}) {
  requireOnlyKeys(body, ['slug', 'url']);
  const slug = validateSlug(body.slug);
  let target;
  try {
    target = await validatePublicHttpsUrl(body.url);
  } catch (error) {
    if (error instanceof UnsafeUrlError) {
      throw new HttpError(400, 'unsafe_url', error.message);
    }
    throw error;
  }

  const requestId = crypto.randomUUID();
  const captureDispatcher = options.captureDispatcher || dispatchProductionCapture;
  if (typeof captureDispatcher !== 'function') {
    throw new HttpError(500, 'server_not_configured', 'The media service is not configured.');
  }
  await captureDispatcher({ requestId, slug, url: target.url });

  const base = `/portfolio/uploads/${slug}/captures/${requestId}`;
  const mediaItems = [
    { url: `${base}/cover.webp`, type: 'image' },
    { url: `${base}/walkthrough.webm`, type: 'video' },
  ];
  return {
    statusCode: 202,
    payload: {
      ok: true,
      requestId,
      status: 'queued',
      message: 'Capture queued. The stable media URLs will publish after the workflow finishes.',
      mediaItems,
      cover: mediaItems[0],
      walkthrough: mediaItems[1],
    },
  };
}

export async function handleOwnerMediaRequest(request, endpoint, options = {}) {
  let origin = '';
  try {
    origin = requireAllowedOrigin(request.headers, options.allowedOrigins);

    if (request.method === 'OPTIONS') {
      return {
        statusCode: 204,
        headers: responseHeaders(origin),
        body: '',
      };
    }
    if (request.method !== 'POST') {
      return jsonResponse(405, {
        error: { code: 'method_not_allowed', message: 'Use POST for this endpoint.' },
      }, origin, { Allow: 'POST, OPTIONS' });
    }

    await verifyFirebaseOwner(request.headers, options.firebaseOwner);
    const body = parseJsonBody(request);
    let result;
    if (endpoint === 'upload') result = await uploadMedia(body, options);
    else if (endpoint === 'capture') result = await dispatchCapture(body, options);
    else if (endpoint === 'status') result = await mediaStatus(body, options);
    else throw new HttpError(500, 'server_not_configured', 'The media service is not configured.');
    return jsonResponse(result.statusCode, result.payload, origin);
  } catch (error) {
    const handled = error instanceof HttpError
      ? error
      : new HttpError(500, 'internal_error', 'The media request could not be completed.');
    const localDiagnostic = typeof handled.localDiagnostic === 'string'
      && /^[a-z0-9_]{1,80}$/.test(handled.localDiagnostic)
      ? handled.localDiagnostic
      : '';
    if (localDiagnostic) {
      console.error(`Owner media endpoint: ${handled.code} (${localDiagnostic})`);
    } else if (!(error instanceof HttpError)) {
      console.error('Owner media endpoint failed:', error?.name || 'Error', error?.message || 'Unknown error');
    }
    return jsonResponse(handled.statusCode, {
      error: { code: handled.code, message: handled.message },
    }, origin);
  }
}

export function netlifyRequest(event) {
  let body = event.body;
  if (event.isBase64Encoded && typeof body === 'string') body = Buffer.from(body, 'base64');
  return {
    method: String(event.httpMethod || '').toUpperCase(),
    headers: event.headers || {},
    body,
  };
}

export function vercelRequest(request) {
  return {
    method: String(request.method || '').toUpperCase(),
    headers: request.headers || {},
    get body() {
      return request.body;
    },
  };
}
