import {
  timelineEntries as defaultTimelineEntries,
  timelineKindOptions,
  timelineSources,
} from '../data/timeline.js';

export const TIMELINE_ENTRY_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const TIMELINE_ENTRY_ID_MAX_LENGTH = 64;
export const TIMELINE_MAX_YEARS = 25;
export const TIMELINE_MAX_HIGHLIGHTS = 12;
export const TIMELINE_MAX_HIGHLIGHT_LENGTH = 240;

export const timelineKinds = timelineKindOptions
  .map(({ id }) => id)
  .filter((id) => id !== 'all');

const timelineKindSet = new Set(timelineKinds);

function cleanString(value, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function isSafeHttpsUrl(value) {
  if (!value || value.length > 1000) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && Boolean(parsed.hostname)
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

function validPartialDate(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

function normalizeYears(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback;
  return [...new Set(source.map(Number))]
    .filter((year) => Number.isInteger(year) && year >= 1900 && year <= 2100)
    .sort((left, right) => left - right)
    .slice(0, TIMELINE_MAX_YEARS);
}

function normalizeHighlights(value, fallback = []) {
  const source = Array.isArray(value) ? value : fallback;
  return source
    .map((highlight) => cleanString(highlight))
    .filter(Boolean)
    .map((highlight) => highlight.slice(0, TIMELINE_MAX_HIGHLIGHT_LENGTH))
    .slice(0, TIMELINE_MAX_HIGHLIGHTS);
}

export function isValidTimelineEntryId(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= TIMELINE_ENTRY_ID_MAX_LENGTH
    && TIMELINE_ENTRY_ID_PATTERN.test(value);
}

export function slugifyTimelineEntryTitle(value) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, TIMELINE_ENTRY_ID_MAX_LENGTH)
    .replace(/-$/g, '');
}

export function normalizeTimelineEntry(entry, fallback = null) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;

  const base = fallback && typeof fallback === 'object' ? fallback : {};
  const id = cleanString(entry.id, cleanString(base.id));
  const kind = cleanString(entry.kind, cleanString(base.kind));
  const title = cleanString(entry.title, cleanString(base.title));
  const dateLabel = cleanString(entry.dateLabel, cleanString(base.dateLabel));
  const startDate = cleanString(entry.startDate, cleanString(base.startDate));
  const sortDate = cleanString(entry.sortDate, cleanString(base.sortDate || startDate));
  const sourceUrl = cleanString(entry.sourceUrl, cleanString(base.sourceUrl || timelineSources[kind]));
  const years = normalizeYears(entry.years, base.years);

  if (
    !isValidTimelineEntryId(id)
    || !timelineKindSet.has(kind)
    || !title
    || !dateLabel
    || !validPartialDate(startDate)
    || !validPartialDate(sortDate)
    || sortDate.localeCompare(startDate) < 0
    || years.length === 0
    || !years.includes(Number(startDate.slice(0, 4)))
    || !years.includes(Number(sortDate.slice(0, 4)))
    || !isSafeHttpsUrl(sourceUrl)
  ) {
    return null;
  }

  const externalUrl = cleanString(entry.externalUrl, cleanString(base.externalUrl));
  if (externalUrl && !isSafeHttpsUrl(externalUrl)) return null;

  const relatedProjectSlug = cleanString(
    entry.relatedProjectSlug,
    cleanString(base.relatedProjectSlug),
  );
  if (relatedProjectSlug && !isValidTimelineEntryId(relatedProjectSlug)) return null;

  return {
    id,
    kind,
    title: title.slice(0, 120),
    organization: cleanString(entry.organization, cleanString(base.organization)).slice(0, 120),
    dateLabel: dateLabel.slice(0, 80),
    startDate,
    sortDate,
    years,
    description: cleanString(entry.description, cleanString(base.description)).slice(0, 1200),
    highlights: normalizeHighlights(entry.highlights, base.highlights),
    relatedProjectSlug,
    externalUrl,
    externalLabel: cleanString(entry.externalLabel, cleanString(base.externalLabel)).slice(0, 80),
    sourceUrl,
    status: 'published',
  };
}

export function validateTimelineEntry(entry) {
  const normalized = normalizeTimelineEntry(entry);
  if (!normalized) {
    throw new Error('Complete the required timeline fields with valid dates and HTTPS links.');
  }

  if (cleanString(entry.id) !== normalized.id) {
    throw new Error('Use lowercase letters, numbers, and hyphens for the timeline ID.');
  }
  if (cleanString(entry.title).length > 120) throw new Error('Timeline titles can use up to 120 characters.');
  if (cleanString(entry.organization).length > 120) throw new Error('Organizations can use up to 120 characters.');
  if (cleanString(entry.dateLabel).length > 80) throw new Error('Date labels can use up to 80 characters.');
  if (cleanString(entry.description).length > 1200) throw new Error('Timeline descriptions can use up to 1,200 characters.');
  if (cleanString(entry.externalLabel).length > 80) throw new Error('Link labels can use up to 80 characters.');
  if (!Array.isArray(entry.years) || entry.years.length < 1 || entry.years.length > TIMELINE_MAX_YEARS) {
    throw new Error(`Add between 1 and ${TIMELINE_MAX_YEARS} timeline years.`);
  }
  if (entry.years.some((year) => (
    !Number.isInteger(Number(year))
    || Number(year) < 1900
    || Number(year) > 2100
  ))) {
    throw new Error('Timeline years must be whole numbers from 1900 through 2100.');
  }
  if (!Array.isArray(entry.highlights) || entry.highlights.length > TIMELINE_MAX_HIGHLIGHTS) {
    throw new Error(`Timeline entries can include up to ${TIMELINE_MAX_HIGHLIGHTS} highlights.`);
  }
  if (entry.highlights.some((highlight) => (
    typeof highlight !== 'string'
    || !highlight.trim()
    || highlight.length > TIMELINE_MAX_HIGHLIGHT_LENGTH
  ))) {
    throw new Error(`Each timeline highlight must use 1 to ${TIMELINE_MAX_HIGHLIGHT_LENGTH} characters.`);
  }
  if (normalized.externalUrl && !normalized.externalLabel) {
    throw new Error('Add a label for the external link.');
  }

  return normalized;
}

export function mergeTimelineEntries(
  remoteEntries = [],
  deletedEntryIds = [],
  bundledEntries = defaultTimelineEntries,
) {
  const defaults = bundledEntries
    .map((entry) => normalizeTimelineEntry(entry))
    .filter(Boolean);
  const defaultById = new Map(defaults.map((entry) => [entry.id, entry]));
  const remoteById = new Map();

  remoteEntries.forEach((entry) => {
    if (entry?.status && entry.status !== 'published') return;
    const id = cleanString(entry?.id);
    const normalized = normalizeTimelineEntry(entry, defaultById.get(id));
    if (normalized) remoteById.set(normalized.id, normalized);
  });

  const deleted = new Set(
    deletedEntryIds.filter((id) => isValidTimelineEntryId(id)),
  );
  const merged = defaults
    .filter((entry) => remoteById.has(entry.id) || !deleted.has(entry.id))
    .map((entry) => remoteById.get(entry.id) || entry);

  remoteById.forEach((entry, id) => {
    if (!defaultById.has(id)) merged.push(entry);
  });

  const defaultOrder = new Map(defaults.map((entry, index) => [entry.id, index]));
  return merged.sort((left, right) => {
    const byDate = right.sortDate.localeCompare(left.sortDate);
    if (byDate) return byDate;
    const leftOrder = defaultOrder.get(left.id);
    const rightOrder = defaultOrder.get(right.id);
    if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder;
    if (leftOrder !== undefined) return -1;
    if (rightOrder !== undefined) return 1;
    return left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
  });
}
