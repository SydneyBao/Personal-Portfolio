import assert from 'node:assert/strict';
import {
  clearPendingCapture,
  createPendingCapture,
  loadLatestPendingCapture,
  loadPendingCapture,
  normalizePendingCapture,
  pendingCaptureStorageKey,
  savePendingCapture,
} from '../src/lib/pendingCapture.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
    get length() { return values.size; },
    values,
  };
}

const slug = 'gemini-chatbot';
const requestId = 'c3f2b552-a42a-4d12-925f-3ccb0faa7fb0';
const url = 'https://gemini-chatbot-iota-five.vercel.app/';
const createdAt = '2026-08-17T20:00:00.000Z';
const base = `/portfolio/uploads/${slug}/captures/${requestId}`;
const mediaItems = [
  { url: `${base}/cover.webp`, type: 'image', ignored: 'not persisted' },
  { url: `${base}/walkthrough.webm`, type: 'video' },
];

const pending = createPendingCapture({
  slug,
  requestId,
  url,
  createdAt,
  mediaItems,
});
assert.deepEqual(pending, {
  slug,
  requestId,
  url,
  createdAt,
  mediaItems: mediaItems.map(({ url: mediaUrl, type }) => ({ url: mediaUrl, type })),
});

const storage = memoryStorage();
assert.equal(savePendingCapture(storage, pending), true);
const key = pendingCaptureStorageKey(slug);
assert.equal(key.endsWith(`:${slug}`), true);
assert.deepEqual(loadPendingCapture(storage, slug), pending);
assert.deepEqual(JSON.parse(storage.getItem(key)), pending);
assert.deepEqual(loadLatestPendingCapture(storage), pending);

const newerPending = createPendingCapture({
  ...pending,
  slug: 'newer-project',
  requestId: '123e4567-e89b-42d3-a456-426614174000',
  createdAt: '2026-08-17T20:01:00.000Z',
  mediaItems: [
    { url: '/portfolio/uploads/newer-project/captures/123e4567-e89b-42d3-a456-426614174000/cover.webp', type: 'image' },
    { url: '/portfolio/uploads/newer-project/captures/123e4567-e89b-42d3-a456-426614174000/walkthrough.webm', type: 'video' },
  ],
});
assert.equal(savePendingCapture(storage, newerPending), true);
assert.deepEqual(loadLatestPendingCapture(storage), newerPending);
clearPendingCapture(storage, newerPending.slug, newerPending.requestId);

assert.equal(clearPendingCapture(storage, slug, '123e4567-e89b-42d3-a456-426614174000'), false);
assert.deepEqual(loadPendingCapture(storage, slug), pending);
assert.equal(clearPendingCapture(storage, slug, requestId), true);
assert.equal(loadPendingCapture(storage, slug), null);

for (const invalid of [
  { ...pending, slug: 'Gemini Chatbot' },
  { ...pending, requestId: 'not-a-uuid' },
  { ...pending, url: 'http://example.com/' },
  { ...pending, createdAt: 'yesterday' },
  { ...pending, mediaItems: pending.mediaItems.slice(0, 1) },
  {
    ...pending,
    mediaItems: [
      { url: `${base}/../cover.webp`, type: 'image' },
      pending.mediaItems[1],
    ],
  },
  {
    ...pending,
    mediaItems: [...pending.mediaItems].reverse(),
  },
]) {
  assert.equal(normalizePendingCapture(invalid, slug), null);
}

storage.setItem(key, '{not json');
assert.equal(loadPendingCapture(storage, slug), null);
assert.equal(storage.getItem(key), null);
assert.equal(savePendingCapture(null, pending), false);
assert.equal(loadPendingCapture(null, slug), null);

console.log('Pending capture recovery tests passed.');
