import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

Error.stackTraceLimit = 0;

const sourceUrl = new URL('../src/lib/contentApi.js', import.meta.url);
let source = await readFile(sourceUrl, 'utf8');
source = source
  .replace(
    "import { DEFAULT_RESUME_URL } from '../data/profile';",
    "const DEFAULT_RESUME_URL = '/SydneyBaoResume.pdf';",
  )
  .replaceAll('import.meta.env.VITE_FIREBASE_API_KEY', "'test-api-key'")
  .replaceAll('import.meta.env.VITE_FIREBASE_PROJECT_ID', "'test-project'")
  .replaceAll('import.meta.env.VITE_FIREBASE_OWNER_EMAIL', "'owner@example.com'");

const storedSession = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => storedSession.get(key) ?? null,
    setItem: (key, value) => storedSession.set(key, value),
    removeItem: (key) => storedSession.delete(key),
  },
  setTimeout,
  clearTimeout,
};

const databasePath = 'projects/test-project/databases/(default)';
const documents = new Map();
const commits = [];
let batchGetRequests = 0;
let legacyDocumentGets = 0;
let projectListRequests = 0;
let deletionListRequests = 0;
let clock = 0;

function timestamp() {
  clock += 1;
  return new Date(Date.UTC(2026, 7, 17, 12, 0, clock)).toISOString();
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function encode(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  if (typeof value === 'object') {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value).map(([key, child]) => [key, encode(child)]),
        ),
      },
    };
  }
  return { stringValue: String(value) };
}

function decode(value = {}) {
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('stringValue' in value) return value.stringValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
  if ('mapValue' in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields || {}).map(([key, child]) => [key, decode(child)]),
    );
  }
  return null;
}

function firestoreDocument(path, data) {
  return {
    name: `${databasePath}/documents/${path}`,
    fields: Object.fromEntries(
      Object.entries(data).map(([key, value]) => [key, encode(value)]),
    ),
  };
}

function applyCommit(payload) {
  const commitTime = timestamp();

  for (const write of payload.writes) {
    if (write.delete) {
      documents.delete(write.delete.split('/documents/')[1]);
      continue;
    }

    const path = write.update.name.split('/documents/')[1];
    const previous = documents.get(path) || {};
    const next = write.updateMask ? { ...previous } : {};

    for (const [key, value] of Object.entries(write.update.fields || {})) {
      next[key] = decode(value);
    }
    for (const transform of write.updateTransforms || []) {
      if (transform.setToServerValue === 'REQUEST_TIME') {
        next[transform.fieldPath] = commitTime;
      }
    }

    documents.set(path, next);
  }

  return commitTime;
}

documents.set('portfolioContent/existing-project', {
  slug: 'existing-project',
  title: 'Existing project',
  status: 'published',
  schemaVersion: 1,
  revision: 4,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
});

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (options.method || 'GET').toUpperCase();

  if (url.hostname === 'identitytoolkit.googleapis.com') {
    assert.equal(method, 'POST');
    return json({
      idToken: 'owner-id-token',
      refreshToken: 'owner-refresh-token',
      localId: 'owner-user-id',
      email: 'owner@example.com',
      expiresIn: '3600',
    });
  }

  assert.equal(url.hostname, 'firestore.googleapis.com');
  assert.equal(url.searchParams.get('key'), 'test-api-key');

  if (url.pathname.endsWith('/documents:batchGet')) {
    assert.equal(method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');
    const payload = JSON.parse(options.body);
    assert.equal(payload.documents.length, 1);
    assert.equal(payload.documents[0].startsWith(`${databasePath}/documents/`), true);
    batchGetRequests += 1;

    const path = payload.documents[0].split('/documents/')[1];
    const value = documents.get(path);
    const readTime = timestamp();
    return json(value
      ? [{ found: firestoreDocument(path, value), readTime }]
      : [{ missing: payload.documents[0], readTime }]);
  }

  if (url.pathname.endsWith('/documents:runQuery')) {
    assert.equal(method, 'POST');
    const payload = JSON.parse(options.body);
    const collectionId = payload.structuredQuery.from[0].collectionId;
    assert.equal(payload.structuredQuery.limit, 100);
    if (collectionId === 'portfolioContent') {
      projectListRequests += 1;
      assert.equal(payload.structuredQuery.where.fieldFilter.field.fieldPath, 'status');
      assert.equal(payload.structuredQuery.where.fieldFilter.value.stringValue, 'published');
      return json([...documents.entries()]
        .filter(([path, value]) => path.startsWith('portfolioContent/') && value.status === 'published')
        .map(([path, value]) => ({ document: firestoreDocument(path, value) })));
    }
    if (collectionId === 'portfolioDeletedProjects') {
      deletionListRequests += 1;
      assert.equal(payload.structuredQuery.where, undefined);
      return json([...documents.entries()]
        .filter(([path]) => path.startsWith('portfolioDeletedProjects/'))
        .map(([path, value]) => ({ document: firestoreDocument(path, value) })));
    }
    assert.fail(`Unexpected collection query: ${collectionId}`);
  }

  if (url.pathname.endsWith('/documents:commit')) {
    assert.equal(method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer owner-id-token');
    const payload = JSON.parse(options.body);
    commits.push(payload);
    const commitTime = applyCommit(payload);
    return json({ commitTime, writeResults: [] });
  }

  if (method === 'GET' && url.pathname.includes('/documents/')) {
    legacyDocumentGets += 1;
    return json({ error: { status: 'NOT_FOUND', message: 'missing document' } }, 404);
  }

  return json({ error: { status: 'NOT_FOUND', message: 'unexpected request' } }, 404);
};

const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const content = await import(moduleUrl);

assert.equal(content.isContentCloudConfigured, true);

const initial = await content.fetchPortfolioContent();
assert.equal(initial.profile, null);
assert.deepEqual(initial.projects.map(({ slug }) => slug), ['existing-project']);
assert.deepEqual(initial.deletedProjectSlugs, []);
assert.equal(batchGetRequests, 1, 'the optional profile read should use batchGet');
assert.equal(projectListRequests, 1);
assert.equal(deletionListRequests, 1);
assert.equal(legacyDocumentGets, 0, 'an absent profile should not emit an HTTP 404');

await content.signInOwner('owner@example.com', 'test-password');

await content.saveProjectContent({ slug: 'new-project', title: 'New project' });
assert.equal(batchGetRequests, 2, 'the create preflight should use batchGet');
assert.equal(commits.length, 1);
assert.equal(commits[0].writes[0].updateMask, undefined);
assert.deepEqual(
  commits[0].writes[0].updateTransforms.map(({ fieldPath }) => fieldPath),
  ['updatedAt', 'createdAt'],
);
assert.equal(documents.get('portfolioContent/new-project').revision, 1);

await content.saveProjectContent({ slug: 'existing-project', title: 'Updated project' });
assert.equal(batchGetRequests, 3, 'the update preflight should use batchGet');
assert.equal(commits.length, 2);
assert.ok(commits[1].writes[0].updateMask);
assert.deepEqual(
  commits[1].writes[0].updateTransforms.map(({ fieldPath }) => fieldPath),
  ['updatedAt'],
);
assert.equal(documents.get('portfolioContent/existing-project').revision, 5);
assert.equal(
  documents.get('portfolioContent/existing-project').createdAt,
  '2026-08-01T00:00:00.000Z',
);

const commitsBeforeInvalidDelete = commits.length;
await assert.rejects(
  content.deleteProjectContent('../existing-project'),
  /valid project/i,
);
assert.equal(commits.length, commitsBeforeInvalidDelete, 'invalid slugs must fail before any write');

await content.deleteProjectContent('existing-project');
assert.equal(commits.length, 3);
assert.equal(commits[2].writes.length, 2);
assert.equal(
  commits[2].writes[0].delete,
  `${databasePath}/documents/portfolioContent/existing-project`,
);
assert.equal(
  commits[2].writes[1].update.name,
  `${databasePath}/documents/portfolioDeletedProjects/existing-project`,
);
assert.deepEqual(
  commits[2].writes[1].updateTransforms,
  [{ fieldPath: 'deletedAt', setToServerValue: 'REQUEST_TIME' }],
);
assert.equal(documents.has('portfolioContent/existing-project'), false);
assert.equal(documents.get('portfolioDeletedProjects/existing-project').slug, 'existing-project');
assert.equal(typeof documents.get('portfolioDeletedProjects/existing-project').deletedAt, 'string');
assert.equal(
  commits[2].writes.some((write) => JSON.stringify(write).includes('/portfolioProjects/')),
  false,
  'deletion must preserve social history instead of writing to stats or subcollections',
);

const afterDelete = await content.fetchPortfolioContent();
assert.deepEqual(afterDelete.projects.map(({ slug }) => slug), ['new-project']);
assert.deepEqual(afterDelete.deletedProjectSlugs, ['existing-project']);
assert.equal(legacyDocumentGets, 0, 'optional content reads should not emit HTTP 404s');

console.log('Firebase content adapter tests passed');
