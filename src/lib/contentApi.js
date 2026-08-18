import { DEFAULT_RESUME_URL } from '../data/profile';

const FIREBASE_API_KEY = import.meta.env.VITE_FIREBASE_API_KEY || '';
const FIREBASE_PROJECT_ID = import.meta.env.VITE_FIREBASE_PROJECT_ID || '';

export const OWNER_EMAIL = (
  import.meta.env.VITE_FIREBASE_OWNER_EMAIL || 's.bao2115@gmail.com'
).toLowerCase();

const OWNER_SESSION_KEY = 'sydney-portfolio-owner-session-v1';
const REQUEST_TIMEOUT_MS = 12000;
const PROJECT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATABASE_PATH = `projects/${FIREBASE_PROJECT_ID}/databases/(default)`;
const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/${DATABASE_PATH}`;
let memorySession = null;

export const isContentCloudConfigured = Boolean(FIREBASE_API_KEY && FIREBASE_PROJECT_ID);

function isSafePortfolioResumePath(value) {
  const hasUnsafeCharacter = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return character === '\\' || codePoint < 32 || codePoint === 127;
  });

  if (!value.startsWith('/portfolio/') || value.startsWith('//') || hasUnsafeCharacter) {
    return false;
  }

  try {
    const parsed = new URL(value, 'https://portfolio.invalid');
    return parsed.origin === 'https://portfolio.invalid'
      && parsed.pathname.startsWith('/portfolio/');
  } catch {
    return false;
  }
}

export function isSafeResumeUrl(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate || candidate !== value || candidate.length > 1000) return false;
  if (candidate === DEFAULT_RESUME_URL || isSafePortfolioResumePath(candidate)) return true;

  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

export function normalizeResumeUrl(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return isSafeResumeUrl(candidate) ? candidate : DEFAULT_RESUME_URL;
}

export function normalizeProfileContent(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  return {
    ...profile,
    resumeUrl: normalizeResumeUrl(profile.resumeUrl),
  };
}

function readStoredSession() {
  if (memorySession) return memorySession;
  try {
    const value = window.localStorage.getItem(OWNER_SESSION_KEY);
    memorySession = value ? JSON.parse(value) : null;
    return memorySession;
  } catch {
    return null;
  }
}

function storeSession(session) {
  memorySession = session;
  try {
    window.localStorage.setItem(OWNER_SESSION_KEY, JSON.stringify(session));
  } catch {
    // The current tab can still use the in-memory session.
  }
}

export function signOutOwner() {
  memorySession = null;
  try {
    window.localStorage.removeItem(OWNER_SESSION_KEY);
  } catch {
    // Storage can be unavailable in privacy-focused browser contexts.
  }
}

function friendlyMessage(data, status) {
  const raw = data?.error?.message || data?.message || '';
  const code = typeof raw === 'string' ? raw.split(' : ')[0] : '';
  const messages = {
    EMAIL_NOT_FOUND: 'No portfolio owner account exists for that email.',
    INVALID_EMAIL: 'Enter a valid email address.',
    INVALID_LOGIN_CREDENTIALS: 'The email or password is incorrect.',
    INVALID_PASSWORD: 'The email or password is incorrect.',
    MISSING_PASSWORD: 'Enter your password.',
    OPERATION_NOT_ALLOWED: 'Email/password sign-in is not enabled in Firebase yet.',
    PERMISSION_DENIED: 'This account does not have permission to edit the portfolio.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Wait a moment and try again.',
    USER_DISABLED: 'This owner account has been disabled in Firebase.',
  };

  return messages[code] || raw || `Firebase request failed (${status}).`;
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

    if (!response.ok) throw new Error(friendlyMessage(data, response.status));
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Firebase took too long to respond. Try again.');
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

function normalizeSession(payload, previous = {}) {
  const session = {
    idToken: payload?.idToken || payload?.id_token,
    refreshToken: payload?.refreshToken || payload?.refresh_token,
    userId: payload?.localId || payload?.user_id || previous.userId,
    email: (payload?.email || previous.email || '').toLowerCase(),
    projectId: FIREBASE_PROJECT_ID,
    expiresAt: Math.floor(Date.now() / 1000) + Number(payload?.expiresIn || payload?.expires_in || 3600),
  };

  if (!session.idToken || !session.refreshToken || !session.userId) {
    throw new Error('Firebase did not return a complete owner session.');
  }
  if (session.email !== OWNER_EMAIL) {
    throw new Error('This account is not the portfolio owner.');
  }

  storeSession(session);
  return session;
}

async function refreshOwnerSession(previous) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: previous.refreshToken,
  });
  const payload = await fetchJson(
    withApiKey('https://securetoken.googleapis.com/v1/token'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
  );
  return normalizeSession(payload, previous);
}

export async function restoreOwnerSession() {
  const session = readStoredSession();
  if (!session || session.projectId !== FIREBASE_PROJECT_ID || session.email !== OWNER_EMAIL) {
    signOutOwner();
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (session.expiresAt > now + 90) return session;

  try {
    return await refreshOwnerSession(session);
  } catch {
    signOutOwner();
    return null;
  }
}

export async function signInOwner(email, password) {
  const normalizedEmail = email.trim().toLowerCase();
  if (normalizedEmail !== OWNER_EMAIL) throw new Error('Use the portfolio owner email to sign in.');

  const payload = await fetchJson(
    withApiKey('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: normalizedEmail, password, returnSecureToken: true }),
    },
  );
  return normalizeSession(payload, { email: normalizedEmail });
}

export async function sendOwnerPasswordReset(email) {
  const normalizedEmail = email.trim().toLowerCase();
  if (normalizedEmail !== OWNER_EMAIL) throw new Error('Use the portfolio owner email.');

  await fetchJson(
    withApiKey('https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestType: 'PASSWORD_RESET', email: normalizedEmail }),
    },
  );
}

function encodeValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (Number.isInteger(value)) return { integerValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (typeof value === 'object') return { mapValue: { fields: encodeFields(value) } };
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
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields || {}).map(([key, child]) => [key, decodeValue(child)]),
    );
  }
  return null;
}

function decodeDocument(document) {
  if (!document) return null;
  return {
    id: document.name?.split('/').pop() || '',
    data: Object.fromEntries(
      Object.entries(document.fields || {}).map(([key, value]) => [key, decodeValue(value)]),
    ),
  };
}

async function getDocument(path, idToken = '') {
  const headers = { 'Content-Type': 'application/json' };
  if (idToken) headers.Authorization = `Bearer ${idToken}`;
  const responses = await fetchJson(
    withApiKey(`${FIRESTORE_BASE_URL}/documents:batchGet`),
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ documents: [`${DATABASE_PATH}/documents/${path}`] }),
    },
  );
  const result = Array.isArray(responses) ? responses[0] : responses;
  return decodeDocument(result?.found);
}

async function listPublishedProjects() {
  const payload = await fetchJson(
    withApiKey(`${FIRESTORE_BASE_URL}/documents:runQuery`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'portfolioContent' }],
          where: {
            fieldFilter: {
              field: { fieldPath: 'status' },
              op: 'EQUAL',
              value: { stringValue: 'published' },
            },
          },
          limit: 100,
        },
      }),
    },
  );
  return (payload || []).map(({ document }) => decodeDocument(document)).filter(Boolean);
}

async function listDeletedProjects() {
  const payload = await fetchJson(
    withApiKey(`${FIRESTORE_BASE_URL}/documents:runQuery`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'portfolioDeletedProjects' }],
          limit: 100,
        },
      }),
    },
  );
  return (payload || []).map(({ document }) => decodeDocument(document)).filter(Boolean);
}

export async function fetchPortfolioContent() {
  if (!isContentCloudConfigured) {
    return { profile: null, projects: [], deletedProjectSlugs: [] };
  }
  const [profile, projectDocuments, deletedProjectDocuments] = await Promise.all([
    getDocument('portfolioSite/profile'),
    listPublishedProjects(),
    listDeletedProjects(),
  ]);
  return {
    profile: normalizeProfileContent(profile?.data),
    projects: projectDocuments.map((document) => ({ ...document.data, slug: document.id })),
    deletedProjectSlugs: deletedProjectDocuments.map(({ id }) => id),
  };
}

async function currentOwnerSession() {
  const session = await restoreOwnerSession();
  if (!session) throw new Error('Sign in again before saving changes.');
  return session;
}

async function commitWrites(session, writes) {
  await fetchJson(
    withApiKey(`${FIRESTORE_BASE_URL}/documents:commit`),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.idToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ writes }),
    },
  );
}

async function saveDocument(path, data) {
  const session = await currentOwnerSession();
  const existing = await getDocument(path, session.idToken);
  const documentData = {
    ...data,
    schemaVersion: 1,
    revision: Number(existing?.data?.revision || 0) + 1,
  };
  const transforms = [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }];
  const write = {
    update: {
      name: `${DATABASE_PATH}/documents/${path}`,
      fields: encodeFields(documentData),
    },
    updateTransforms: transforms,
  };

  if (existing) write.updateMask = { fieldPaths: Object.keys(documentData) };
  else transforms.push({ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' });

  await commitWrites(session, [write]);
}

export async function saveProfileContent(profile) {
  const resumeUrl = profile?.resumeUrl == null || profile.resumeUrl === ''
    ? DEFAULT_RESUME_URL
    : profile.resumeUrl;

  if (!isSafeResumeUrl(resumeUrl)) {
    throw new Error('Use an HTTPS résumé URL or a file stored under /portfolio/.');
  }

  await saveDocument('portfolioSite/profile', {
    ...profile,
    resumeUrl,
  });
}

export async function saveProjectContent(project) {
  await saveDocument(`portfolioContent/${project.slug}`, { ...project, status: 'published' });
}

export async function deleteProjectContent(slug) {
  const projectSlug = String(slug || '').trim();
  if (!PROJECT_SLUG_PATTERN.test(projectSlug) || projectSlug.length > 64) {
    throw new Error('Choose a valid project before deleting it.');
  }

  const session = await currentOwnerSession();
  await commitWrites(session, [
    {
      delete: `${DATABASE_PATH}/documents/portfolioContent/${projectSlug}`,
    },
    {
      update: {
        name: `${DATABASE_PATH}/documents/portfolioDeletedProjects/${projectSlug}`,
        fields: encodeFields({ slug: projectSlug }),
      },
      updateTransforms: [{ fieldPath: 'deletedAt', setToServerValue: 'REQUEST_TIME' }],
    },
  ]);
}

export function slugifyProjectTitle(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}
