import assert from 'node:assert/strict';

import { timelineEntries as bundledTimelineEntries } from '../src/data/timeline.js';
import {
  isValidTimelineEntryId,
  mergeTimelineEntries,
  normalizeTimelineEntry,
  slugifyTimelineEntryTitle,
  validateTimelineEntry,
} from '../src/lib/timelineContent.js';

const validEntry = {
  id: 'new-research-milestone',
  kind: 'research',
  title: 'New research milestone',
  organization: 'Northeastern University',
  dateLabel: 'Aug 2026',
  startDate: '2026-08',
  sortDate: '2026-08',
  years: [2026],
  description: 'A concise description.',
  highlights: ['Built a useful prototype.'],
  relatedProjectSlug: '',
  externalUrl: '',
  externalLabel: '',
  sourceUrl: 'https://www.linkedin.com/in/sydney-bao',
};

const baseline = mergeTimelineEntries();
assert.equal(baseline.length, 42, 'an empty cloud collection must retain all bundled milestones');
assert.deepEqual(
  baseline.map(({ id }) => id),
  bundledTimelineEntries.map(({ id }) => id),
  'the zero-data fallback must preserve bundled ordering',
);

const normalized = validateTimelineEntry(validEntry);
assert.deepEqual(normalized, { ...validEntry, status: 'published' });
assert.deepEqual(
  Object.keys(normalized).sort(),
  [
    'id',
    'kind',
    'title',
    'organization',
    'dateLabel',
    'startDate',
    'sortDate',
    'years',
    'description',
    'highlights',
    'relatedProjectSlug',
    'externalUrl',
    'externalLabel',
    'sourceUrl',
    'status',
  ].sort(),
  'saved entries must serialize every content field',
);

const bundledOracle = bundledTimelineEntries.find(({ id }) => id === 'oracle-software-engineer-intern');
const partialOverride = {
  id: bundledOracle.id,
  title: 'Software Engineering Intern',
  status: 'published',
};
const withOverride = mergeTimelineEntries([partialOverride]);
const mergedOracle = withOverride.find(({ id }) => id === bundledOracle.id);
assert.equal(mergedOracle.title, 'Software Engineering Intern');
assert.equal(mergedOracle.organization, bundledOracle.organization);
assert.equal(mergedOracle.dateLabel, bundledOracle.dateLabel);

const hidden = mergeTimelineEntries([], [bundledOracle.id]);
assert.equal(hidden.some(({ id }) => id === bundledOracle.id), false);
assert.equal(hidden.length, 41);

const staleMarkerWithPublishedOverride = mergeTimelineEntries(
  [partialOverride],
  [bundledOracle.id],
);
assert.equal(
  staleMarkerWithPublishedOverride.find(({ id }) => id === bundledOracle.id)?.title,
  'Software Engineering Intern',
  'a published override must win over a stale deletion marker',
);

const draftDoesNotRestoreMarker = mergeTimelineEntries(
  [{ ...partialOverride, status: 'draft' }],
  [bundledOracle.id],
);
assert.equal(draftDoesNotRestoreMarker.some(({ id }) => id === bundledOracle.id), false);

const withAddition = mergeTimelineEntries([{ ...validEntry, status: 'published' }]);
assert.equal(withAddition.length, 43);
assert.equal(withAddition[0].id, validEntry.id, 'newer additions should sort ahead of older entries');
assert.equal(
  mergeTimelineEntries(
    [{ ...validEntry, status: 'published' }],
    [validEntry.id],
  ).some(({ id }) => id === validEntry.id),
  true,
  'a published addition must also win over a stale marker',
);

assert.equal(
  mergeTimelineEntries([{ ...validEntry, id: '../unsafe' }]).length,
  42,
  'malformed remote entries must not break the bundled fallback',
);

assert.equal(slugifyTimelineEntryTitle('  New Research & Design!  '), 'new-research-design');
assert.equal(isValidTimelineEntryId('new-research-design'), true);
assert.equal(isValidTimelineEntryId('../new-research-design'), false);
assert.equal(normalizeTimelineEntry({ ...validEntry, sourceUrl: '' }), null);

assert.throws(
  () => validateTimelineEntry({ ...validEntry, title: 'x'.repeat(121) }),
  /120 characters/,
);
assert.throws(
  () => validateTimelineEntry({ ...validEntry, sourceUrl: 'http://example.com' }),
  /required timeline fields/i,
);
assert.throws(
  () => validateTimelineEntry({ ...validEntry, sortDate: '2026-07' }),
  /required timeline fields/i,
);
assert.throws(
  () => validateTimelineEntry({ ...validEntry, years: [2025] }),
  /required timeline fields/i,
);
assert.throws(
  () => validateTimelineEntry({ ...validEntry, externalUrl: 'https://example.com', externalLabel: '' }),
  /label for the external link/i,
);
assert.throws(
  () => validateTimelineEntry({ ...validEntry, years: Array.from({ length: 26 }, (_, index) => 2002 + index) }),
  /between 1 and 25 timeline years/i,
);
assert.throws(
  () => validateTimelineEntry({ ...validEntry, highlights: ['x'.repeat(241)] }),
  /1 to 240 characters/i,
);

console.log('Timeline content merge and validation tests passed');
