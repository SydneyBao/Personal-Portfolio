const STORAGE_PREFIX = 'sydney-portfolio:pending-capture:v1:';
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validSlug(value) {
  return typeof value === 'string' && value.length <= 80 && SLUG_PATTERN.test(value);
}

function validHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

function expectedMediaItems(slug, requestId) {
  const base = `/portfolio/uploads/${slug}/captures/${requestId}`;
  return [
    { url: `${base}/cover.webp`, type: 'image' },
    { url: `${base}/walkthrough.webm`, type: 'video' },
  ];
}

export function pendingCaptureStorageKey(slug) {
  if (!validSlug(slug)) return '';
  return `${STORAGE_PREFIX}${slug}`;
}

export function normalizePendingCapture(value, expectedSlug = value?.slug) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const slug = String(value.slug || '');
  const requestId = String(value.requestId || '');
  const url = String(value.url || '');
  const createdAt = String(value.createdAt || '');

  if (
    !validSlug(slug)
    || slug !== expectedSlug
    || !UUID_PATTERN.test(requestId)
    || !validHttpsUrl(url)
    || !createdAt
    || !Number.isFinite(Date.parse(createdAt))
    || new Date(createdAt).toISOString() !== createdAt
    || !Array.isArray(value.mediaItems)
  ) {
    return null;
  }

  const expected = expectedMediaItems(slug, requestId);
  if (
    value.mediaItems.length !== expected.length
    || value.mediaItems.some((item, index) => (
      !item
      || typeof item !== 'object'
      || Array.isArray(item)
      || item.url !== expected[index].url
      || item.type !== expected[index].type
    ))
  ) {
    return null;
  }

  return {
    slug,
    requestId,
    url,
    createdAt,
    mediaItems: expected,
  };
}

export function createPendingCapture({
  createdAt = new Date().toISOString(),
  mediaItems,
  requestId,
  slug,
  url,
}) {
  const pending = normalizePendingCapture({
    slug,
    requestId,
    url,
    createdAt,
    mediaItems,
  }, slug);
  if (!pending) {
    throw new Error('The media service returned unexpected capture recovery details.');
  }
  return pending;
}

export function loadPendingCapture(storage, slug) {
  const key = pendingCaptureStorageKey(slug);
  if (!key || !storage) return null;

  let rawValue;
  try {
    rawValue = storage.getItem(key);
  } catch {
    return null;
  }
  if (!rawValue) return null;

  let value;
  try {
    value = JSON.parse(rawValue);
  } catch {
    value = null;
  }
  const pending = normalizePendingCapture(value, slug);
  if (pending) return pending;

  try {
    storage.removeItem(key);
  } catch {
    // An invalid record can be ignored even when storage is read-only.
  }
  return null;
}

export function loadLatestPendingCapture(storage) {
  if (!storage) return null;
  let keys;
  try {
    keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key) => typeof key === 'string' && key.startsWith(STORAGE_PREFIX));
  } catch {
    return null;
  }

  return keys.reduce((latest, key) => {
    const slug = key.slice(STORAGE_PREFIX.length);
    const pending = loadPendingCapture(storage, slug);
    if (!pending) return latest;
    if (!latest || Date.parse(pending.createdAt) > Date.parse(latest.createdAt)) return pending;
    return latest;
  }, null);
}

export function savePendingCapture(storage, value) {
  const pending = normalizePendingCapture(value, value?.slug);
  const key = pendingCaptureStorageKey(pending?.slug);
  if (!pending || !key || !storage) return false;
  try {
    storage.setItem(key, JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

export function clearPendingCapture(storage, slug, requestId) {
  const key = pendingCaptureStorageKey(slug);
  if (!key || !storage) return false;

  const pending = loadPendingCapture(storage, slug);
  if (pending && pending.requestId !== requestId) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
