import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

Error.stackTraceLimit = 0;

const sourceUrl = new URL('../src/lib/socialApi.js', import.meta.url);
let source = await readFile(sourceUrl, 'utf8');
source = source
  .replaceAll('import.meta.env.VITE_FIREBASE_API_KEY', "'test-api-key'")
  .replaceAll('import.meta.env.VITE_FIREBASE_PROJECT_ID', "'test-project'");

const stored = new Map();
let commentIdSequence = 0;
globalThis.window = {
  localStorage: {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
    removeItem: (key) => stored.delete(key),
  },
  setTimeout,
  clearTimeout,
  crypto: { randomUUID: () => `comment-test-${commentIdSequence += 1}` },
};

const state = {
  stats: {},
  likes: {},
  comments: {},
  limiter: null,
  commits: [],
  refreshes: 0,
  unauthorizedOnce: false,
  ambiguousCommentCommit: true,
  legacyDocumentGets: 0,
  tick: 0,
};

function timestamp() {
  return new Date(Date.now() + state.tick++).toISOString();
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function encode(value, key) {
  if (key.endsWith('At') || key === 'updatedAt') return { timestampValue: value };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === 'boolean') return { booleanValue: value };
  return { stringValue: String(value) };
}

function decode(value) {
  if ('integerValue' in value) return Number(value.integerValue);
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  return value.stringValue;
}

function document(path, value) {
  return {
    name: `projects/test-project/databases/(default)/documents/${path}`,
    fields: Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !['path', 'updateTime'].includes(key))
        .map(([key, field]) => [key, encode(field, key)]),
    ),
    createTime: value.updateTime,
    updateTime: value.updateTime,
  };
}

function applyWrites(payload, commitTime) {
  for (const write of payload.writes) {
    if (write.update) {
      const path = write.update.name.split('/documents/')[1];
      const data = Object.fromEntries(
        Object.entries(write.update.fields || {}).map(([key, value]) => [key, decode(value)]),
      );
      for (const transform of write.updateTransforms || []) {
        if (transform.setToServerValue === 'REQUEST_TIME') data[transform.fieldPath] = commitTime;
      }

      if (/^portfolioProjects\/[^/]+$/.test(path)) {
        state.stats[path.split('/')[1]] = { ...data, updateTime: commitTime };
      } else if (path.includes('/likes/')) {
        state.likes[path] = { ...data, updateTime: commitTime };
      } else if (path.includes('/comments/')) {
        state.comments[path] = { ...data, updateTime: commitTime };
      } else if (path.startsWith('portfolioCommentRateLimits/')) {
        state.limiter = { path, ...data, updateTime: commitTime };
      }
    }

    if (write.delete) delete state.likes[write.delete.split('/documents/')[1]];
  }
}

function storedDocument(path) {
  if (/^portfolioProjects\/[^/]+$/.test(path)) return state.stats[path.split('/')[1]] || null;
  if (path.includes('/likes/')) return state.likes[path] || null;
  if (path.startsWith('portfolioCommentRateLimits/')) {
    return state.limiter?.path === path ? state.limiter : null;
  }
  if (path.includes('/comments/')) return state.comments[path] || null;
  return null;
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = (options.method || 'GET').toUpperCase();

  if (url.hostname === 'identitytoolkit.googleapis.com') {
    return json({
      idToken: 'mock-id-token',
      refreshToken: 'mock-refresh-token',
      localId: 'mock-user',
      expiresIn: '3600',
    });
  }

  if (url.hostname === 'securetoken.googleapis.com') {
    state.refreshes += 1;
    return json({
      id_token: 'refreshed-id-token',
      refresh_token: 'mock-refresh-token',
      user_id: 'mock-user',
      expires_in: '3600',
    });
  }

  assert.equal(url.hostname, 'firestore.googleapis.com');
  assert.equal(url.searchParams.get('key'), 'test-api-key');

  const batchPayload = url.pathname.endsWith('/documents:batchGet') && method === 'POST'
    ? JSON.parse(options.body)
    : null;

  if (
    state.unauthorizedOnce
    && options.headers?.Authorization
    && batchPayload?.documents?.some((name) => name.includes('/likes/'))
  ) {
    state.unauthorizedOnce = false;
    return json({ error: { status: 'UNAUTHENTICATED', message: 'expired token' } }, 401);
  }

  if (url.pathname.endsWith('/documents:commit') && method === 'POST') {
    const payload = JSON.parse(options.body);
    const commitTime = timestamp();
    state.commits.push(payload);
    applyWrites(payload, commitTime);

    const containsComment = payload.writes.some((write) => write.update?.name.includes('/comments/'));
    if (containsComment && state.ambiguousCommentCommit) {
      state.ambiguousCommentCommit = false;
      throw new TypeError('connection closed after commit');
    }

    return json({ commitTime, writeResults: [] });
  }

  if (batchPayload) {
    const readTime = timestamp();
    return json(batchPayload.documents.map((name) => {
      const path = name.split('/documents/')[1];
      const value = storedDocument(path);
      return value
        ? { found: document(path, value), readTime }
        : { missing: name, readTime };
    }));
  }

  const path = decodeURIComponent(url.pathname.split('/documents/')[1] || '');

  if (method === 'GET' && !/^portfolioProjects\/[^/]+\/comments$/.test(path)) {
    state.legacyDocumentGets += 1;
  }

  if (/^portfolioProjects\/[^/]+$/.test(path)) {
    const value = state.stats[path.split('/')[1]];
    return value
      ? json(document(path, value))
      : json({ error: { status: 'NOT_FOUND', message: 'missing document' } }, 404);
  }

  if (path.includes('/likes/')) {
    const value = state.likes[path];
    return value
      ? json(document(path, value))
      : json({ error: { status: 'NOT_FOUND', message: 'missing document' } }, 404);
  }

  if (path.startsWith('portfolioCommentRateLimits/')) {
    const value = state.limiter?.path === path ? state.limiter : null;
    return value
      ? json(document(path, value))
      : json({ error: { status: 'NOT_FOUND', message: 'missing document' } }, 404);
  }

  if (path.includes('/comments/')) {
    const value = state.comments[path];
    return value
      ? json(document(path, value))
      : json({ error: { status: 'NOT_FOUND', message: 'missing document' } }, 404);
  }

  if (/^portfolioProjects\/[^/]+\/comments$/.test(path)) {
    assert.equal(url.searchParams.get('pageSize'), '80');
    const documents = Object.entries(state.comments)
      .filter(([key]) => key.startsWith(`${path}/`))
      .map(([key, value]) => document(key, value));
    return json({ documents });
  }

  return json({ error: { status: 'NOT_FOUND', message: 'missing document' } }, 404);
};

const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const social = await import(moduleUrl);
const slug = 'popper-social';

assert.equal(social.storageMode, 'cloud');
assert.deepEqual(await social.fetchProjectStats([slug]), [{
  project_slug: slug,
  like_count: 0,
  comment_count: 0,
  liked_by_me: false,
}]);

assert.deepEqual(await social.setProjectLiked(slug, true), { liked: true, like_count: 1 });
assert.equal(state.commits[0].writes.length, 2);
assert.equal(state.commits[0].writes[0].update.fields.likeCount.integerValue, '1');

state.unauthorizedOnce = true;
const refreshedStats = await social.fetchProjectStats([slug]);
assert.equal(refreshedStats[0].liked_by_me, true);
assert.equal(state.refreshes, 1);

assert.deepEqual(await social.setProjectLiked(slug, false), { liked: false, like_count: 0 });
assert.equal(state.commits[1].writes[1].delete.endsWith('/likes/mock-user'), true);

const created = await social.createComment(slug, ' Sydney ', ' Great work! ');
assert.equal(created.display_name, 'Sydney');
assert.equal(created.body, 'Great work!');
assert.equal(state.commits.length, 3, 'an ambiguous response must not duplicate the commit');
assert.equal(state.commits[2].writes.length, 3);

const comments = await social.fetchComments(slug);
assert.equal(comments.length, 1);
assert.equal(comments[0].body, 'Great work!');

const finalStats = await social.fetchProjectStats([slug]);
assert.equal(finalStats[0].comment_count, 1);
await assert.rejects(
  () => social.createComment(slug, 'Sydney', 'Too soon'),
  /Please wait .* seconds before commenting again/,
);
assert.equal(state.legacyDocumentGets, 0, 'optional document reads should not emit HTTP 404s');

console.log('Firebase social adapter tests passed');
