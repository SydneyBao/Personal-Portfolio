const FIREBASE_API_KEY = import.meta.env.VITE_FIREBASE_API_KEY || '';
const FIREBASE_PROJECT_ID = import.meta.env.VITE_FIREBASE_PROJECT_ID || '';

const SESSION_KEY = 'sydney-portfolio-firebase-session-v1';
const LOCAL_DATA_KEY = 'sydney-portfolio-social-preview-v1';
const REQUEST_TIMEOUT_MS = 12000;
const COMMENT_COOLDOWN_MS = 10000;

const DATABASE_PATH = `projects/${FIREBASE_PROJECT_ID}/databases/(default)`;
const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/${DATABASE_PATH}`;
const DOCUMENTS_BASE_URL = `${FIRESTORE_BASE_URL}/documents`;

export const isCloudConfigured = Boolean(FIREBASE_API_KEY && FIREBASE_PROJECT_ID);
export const storageMode = isCloudConfigured ? 'cloud' : 'local';

let activeSessionRequest = null;
let forcedRefreshRequest = null;

function readJson(key, fallback) {
  try {
    const value = window.localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // The UI still works in-memory when storage is unavailable.
  }
}

function removeStoredValue(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in privacy-focused browser contexts.
  }
}

function getLocalData() {
  return readJson(LOCAL_DATA_KEY, { liked: {}, comments: {} });
}

function saveLocalData(data) {
  writeJson(LOCAL_DATA_KEY, data);
}

function normalizeSession(payload, fallbackUserId = '') {
  const idToken = payload?.idToken || payload?.id_token;
  const refreshToken = payload?.refreshToken || payload?.refresh_token;
  const userId = payload?.localId || payload?.user_id || fallbackUserId;
  const expiresIn = Number(payload?.expiresIn || payload?.expires_in || 3600);

  if (!idToken || !refreshToken || !userId) {
    throw new Error('Firebase did not return a usable anonymous session.');
  }

  return {
    idToken,
    refreshToken,
    userId,
    projectId: FIREBASE_PROJECT_ID,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
  };
}

function friendlyFirebaseMessage(data, status) {
  const raw = data?.error?.message || data?.message || data?.error_description || data?.error;
  const code = data?.error?.status || (typeof raw === 'string' ? raw.split(' : ')[0] : '');

  const knownMessages = {
    OPERATION_NOT_ALLOWED: 'Anonymous sign-in is not enabled in Firebase Authentication.',
    PERMISSION_DENIED: 'Firestore rejected this request. Check the deployed Security Rules.',
    FAILED_PRECONDITION: 'Firestore needs its database or indexes configured before this request can run.',
    RESOURCE_EXHAUSTED: 'The Firebase free-tier quota has been reached. Please try again later.',
  };

  return knownMessages[code] || raw || `Request failed (${status}).`;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = null;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text.slice(0, 180) };
      }
    }

    if (!response.ok) {
      const error = new Error(friendlyFirebaseMessage(data, response.status));
      error.status = response.status;
      error.code = data?.error?.status || '';
      error.firebaseMessage = data?.error?.message || '';
      throw error;
    }

    return data;
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('The social feed took too long to respond. Please try again.');
      timeoutError.code = 'CLIENT_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function withApiKey(url) {
  const target = new URL(url);
  target.searchParams.set('key', FIREBASE_API_KEY);
  return target.toString();
}

function authHeaders(idToken, contentType = 'application/json') {
  const headers = { 'Content-Type': contentType };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  return headers;
}

async function createAnonymousSession() {
  const payload = await fetchJson(
    withApiKey('https://identitytoolkit.googleapis.com/v1/accounts:signUp'),
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ returnSecureToken: true }),
    },
  );
  const session = normalizeSession(payload);
  writeJson(SESSION_KEY, session);
  return session;
}

async function refreshAnonymousSession(cached) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: cached.refreshToken,
  });
  const payload = await fetchJson(
    withApiKey('https://securetoken.googleapis.com/v1/token'),
    {
      method: 'POST',
      headers: authHeaders(null, 'application/x-www-form-urlencoded'),
      body: body.toString(),
    },
  );
  const session = normalizeSession(payload, cached.userId);
  writeJson(SESSION_KEY, session);
  return session;
}

async function resolveSession(createIfMissing = true) {
  let cached = readJson(SESSION_KEY, null);
  const now = Math.floor(Date.now() / 1000);

  if (cached && cached.projectId !== FIREBASE_PROJECT_ID) {
    removeStoredValue(SESSION_KEY);
    cached = null;
  }

  if (cached?.idToken && cached?.userId && cached.expiresAt > now + 90) {
    return cached;
  }

  if (cached?.refreshToken && cached?.userId) {
    try {
      return await refreshAnonymousSession(cached);
    } catch (error) {
      if ([400, 401, 403].includes(error.status)) {
        removeStoredValue(SESSION_KEY);
      } else {
        throw error;
      }
    }
  }

  return createIfMissing ? createAnonymousSession() : null;
}

async function getSession(createIfMissing = true) {
  if (activeSessionRequest) {
    const current = await activeSessionRequest;
    if (current || !createIfMissing) return current;
  }

  activeSessionRequest = resolveSession(createIfMissing).finally(() => {
    activeSessionRequest = null;
  });
  return activeSessionRequest;
}

async function refreshAfterUnauthorized(session) {
  if (!session?.refreshToken) {
    removeStoredValue(SESSION_KEY);
    throw new Error('Your anonymous Firebase session expired. Please try again.');
  }

  if (!forcedRefreshRequest) {
    forcedRefreshRequest = refreshAnonymousSession(session).finally(() => {
      forcedRefreshRequest = null;
    });
  }

  try {
    const refreshed = await forcedRefreshRequest;
    Object.assign(session, refreshed);
    return refreshed;
  } catch (error) {
    if ([400, 401, 403].includes(error.status)) removeStoredValue(SESSION_KEY);
    throw error;
  }
}

async function withAuthenticatedRetry(session, operation) {
  try {
    return await operation(session?.idToken || null);
  } catch (error) {
    const unauthorized = error.status === 401 || error.code === 'UNAUTHENTICATED';
    if (!session || !unauthorized) throw error;

    const refreshed = await refreshAfterUnauthorized(session);
    return operation(refreshed.idToken);
  }
}

function documentName(path) {
  return `${DATABASE_PATH}/documents/${path}`;
}

function encodeValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  return { stringValue: String(value) };
}

function encodeFields(data) {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encodeValue(value)]));
}

function decodeValue(value = {}) {
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('stringValue' in value) return value.stringValue;
  return null;
}

function decodeDocument(document) {
  if (!document) return null;

  return {
    id: document.name?.split('/').pop() || '',
    name: document.name,
    updateTime: document.updateTime,
    data: Object.fromEntries(
      Object.entries(document.fields || {}).map(([key, value]) => [key, decodeValue(value)]),
    ),
  };
}

async function getDocument(path, session = null) {
  const responses = await withAuthenticatedRetry(session, (idToken) => fetchJson(
    withApiKey(`${FIRESTORE_BASE_URL}/documents:batchGet`),
    {
      method: 'POST',
      headers: authHeaders(idToken),
      body: JSON.stringify({ documents: [documentName(path)] }),
    },
  ));
  const result = Array.isArray(responses) ? responses[0] : responses;
  return decodeDocument(result?.found);
}

async function listDocuments(path, query = {}, session = null) {
  const url = new URL(`${DOCUMENTS_BASE_URL}/${path}`);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  url.searchParams.set('key', FIREBASE_API_KEY);

  const payload = await withAuthenticatedRetry(session, (idToken) => fetchJson(
    url.toString(),
    { headers: authHeaders(idToken) },
  ));
  return (payload?.documents || []).map(decodeDocument);
}

function updateWrite(path, data, snapshot, timestampFields = []) {
  const write = {
    update: {
      name: documentName(path),
      fields: encodeFields(data),
    },
    updateMask: { fieldPaths: Object.keys(data) },
    currentDocument: snapshot?.updateTime
      ? { updateTime: snapshot.updateTime }
      : { exists: false },
  };

  if (timestampFields.length) {
    write.updateTransforms = timestampFields.map((fieldPath) => ({
      fieldPath,
      setToServerValue: 'REQUEST_TIME',
    }));
  }

  return write;
}

function deleteWrite(path, snapshot) {
  return {
    delete: documentName(path),
    currentDocument: snapshot?.updateTime
      ? { updateTime: snapshot.updateTime }
      : { exists: false },
  };
}

async function commitWrites(writes, session) {
  return withAuthenticatedRetry(session, (idToken) => fetchJson(
    withApiKey(`${FIRESTORE_BASE_URL}/documents:commit`),
    {
      method: 'POST',
      headers: authHeaders(idToken),
      body: JSON.stringify({ writes }),
    },
  ));
}

function isRetryableWriteError(error) {
  const conflict = [409, 412].includes(error.status)
    || ['ABORTED', 'ALREADY_EXISTS'].includes(error.code)
    || (
      error.code === 'FAILED_PRECONDITION'
      && /precondition|update.?time|already exists|version/i.test(error.firebaseMessage || '')
    );
  const transient = ['DEADLINE_EXCEEDED', 'UNAVAILABLE', 'INTERNAL', 'CLIENT_TIMEOUT']
    .includes(error.code);
  const networkFailure = error instanceof TypeError && !error.status;
  return conflict || transient || networkFailure;
}

async function retryWrites(operation, attempts = 5) {
  let lastError;
  let internalRetries = 0;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (error.code === 'INTERNAL') {
        if (internalRetries >= 1) throw error;
        internalRetries += 1;
      }
      if (!isRetryableWriteError(error) || attempt === attempts - 1) throw error;

      const backoff = 80 * (2 ** attempt) + Math.floor(Math.random() * 80);
      await new Promise((resolve) => window.setTimeout(resolve, backoff));
    }
  }

  throw lastError;
}

function localStats(slugs) {
  const local = getLocalData();
  return slugs.map((projectSlug) => ({
    project_slug: projectSlug,
    like_count: local.liked[projectSlug] ? 1 : 0,
    comment_count: (local.comments[projectSlug] || []).length,
    liked_by_me: Boolean(local.liked[projectSlug]),
  }));
}

function statsPath(projectSlug) {
  return `portfolioProjects/${projectSlug}`;
}

function likePath(projectSlug, userId) {
  return `${statsPath(projectSlug)}/likes/${userId}`;
}

function commentPath(projectSlug, commentId) {
  return `${statsPath(projectSlug)}/comments/${commentId}`;
}

function rateLimitPath(userId) {
  return `portfolioCommentRateLimits/${userId}`;
}

function countsFromSnapshot(snapshot) {
  return {
    likes: Number(snapshot?.data?.likeCount || 0),
    comments: Number(snapshot?.data?.commentCount || 0),
  };
}

function statsWrite(projectSlug, counts, snapshot) {
  return updateWrite(
    statsPath(projectSlug),
    {
      likeCount: Math.max(0, counts.likes),
      commentCount: Math.max(0, counts.comments),
    },
    snapshot,
    ['updatedAt'],
  );
}

export async function fetchProjectStats(slugs) {
  if (!isCloudConfigured) return localStats(slugs);

  const session = await getSession(false);
  return Promise.all(
    slugs.map(async (projectSlug) => {
      const [stats, ownLike] = await Promise.all([
        getDocument(statsPath(projectSlug)),
        session
          ? getDocument(likePath(projectSlug, session.userId), session)
          : Promise.resolve(null),
      ]);
      const counts = countsFromSnapshot(stats);

      return {
        project_slug: projectSlug,
        like_count: counts.likes,
        comment_count: counts.comments,
        liked_by_me: Boolean(ownLike),
      };
    }),
  );
}

export async function fetchComments(projectSlug) {
  if (!isCloudConfigured) {
    return getLocalData().comments[projectSlug] || [];
  }

  const documents = await listDocuments(
    `${statsPath(projectSlug)}/comments`,
    { pageSize: 80, orderBy: 'createdAt desc' },
  );

  return documents.map((document) => ({
    id: document.id,
    project_slug: projectSlug,
    display_name: document.data.displayName,
    body: document.data.body,
    created_at: document.data.createdAt,
  }));
}

export async function setProjectLiked(projectSlug, shouldLike) {
  if (!isCloudConfigured) {
    const local = getLocalData();
    local.liked[projectSlug] = shouldLike;
    saveLocalData(local);
    return { liked: shouldLike, like_count: shouldLike ? 1 : 0 };
  }

  const session = await getSession();

  return retryWrites(async () => {
    const [stats, ownLike] = await Promise.all([
      getDocument(statsPath(projectSlug)),
      getDocument(likePath(projectSlug, session.userId), session),
    ]);
    const counts = countsFromSnapshot(stats);

    if (shouldLike === Boolean(ownLike)) {
      return { liked: shouldLike, like_count: counts.likes };
    }

    if (!shouldLike && counts.likes < 1) {
      throw new Error('This project\'s like count is out of sync. Please refresh and try again.');
    }

    const nextCounts = {
      ...counts,
      likes: counts.likes + (shouldLike ? 1 : -1),
    };
    const writes = [statsWrite(projectSlug, nextCounts, stats)];

    if (shouldLike) {
      writes.push(
        updateWrite(
          likePath(projectSlug, session.userId),
          { ownerUid: session.userId },
          null,
          ['createdAt'],
        ),
      );
    } else {
      writes.push(deleteWrite(likePath(projectSlug, session.userId), ownLike));
    }

    await commitWrites(writes, session);
    return { liked: shouldLike, like_count: nextCounts.likes };
  });
}

function createCommentId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `comment-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export async function createComment(projectSlug, displayName, body) {
  const cleanName = displayName.trim() || 'Guest';
  const cleanBody = body.trim();

  if (!cleanBody) throw new Error('Write a comment before posting.');
  if (cleanName.length > 32) throw new Error('Names can be at most 32 characters.');
  if (cleanBody.length > 500) throw new Error('Comments can be at most 500 characters.');

  if (!isCloudConfigured) {
    const local = getLocalData();
    const comment = {
      id: `local-${Date.now()}`,
      project_slug: projectSlug,
      display_name: cleanName,
      body: cleanBody,
      created_at: new Date().toISOString(),
    };
    local.comments[projectSlug] = [comment, ...(local.comments[projectSlug] || [])];
    saveLocalData(local);
    return comment;
  }

  const session = await getSession();
  const commentId = createCommentId();
  let commitAttempted = false;

  const commit = await retryWrites(async () => {
    if (commitAttempted) {
      const existing = await getDocument(commentPath(projectSlug, commentId));
      if (existing) return { commitTime: existing.data.createdAt };
    }

    const [stats, limiter] = await Promise.all([
      getDocument(statsPath(projectSlug)),
      getDocument(rateLimitPath(session.userId), session),
    ]);
    const previousCommentAt = Date.parse(limiter?.data?.lastCommentAt || '');

    if (Number.isFinite(previousCommentAt)) {
      const waitMs = COMMENT_COOLDOWN_MS - (Date.now() - previousCommentAt);
      if (waitMs > 0) {
        throw new Error(`Please wait ${Math.ceil(waitMs / 1000)} seconds before commenting again.`);
      }
    }

    const counts = countsFromSnapshot(stats);
    const nextCounts = { ...counts, comments: counts.comments + 1 };
    const writes = [
      statsWrite(projectSlug, nextCounts, stats),
      updateWrite(
        commentPath(projectSlug, commentId),
        {
          projectSlug,
          displayName: cleanName,
          body: cleanBody,
        },
        null,
        ['createdAt'],
      ),
      updateWrite(
        rateLimitPath(session.userId),
        { projectSlug, lastCommentId: commentId },
        limiter,
        ['lastCommentAt'],
      ),
    ];

    commitAttempted = true;
    return commitWrites(writes, session);
  });

  return {
    id: commentId,
    project_slug: projectSlug,
    display_name: cleanName,
    body: cleanBody,
    created_at: commit?.commitTime || new Date().toISOString(),
  };
}
