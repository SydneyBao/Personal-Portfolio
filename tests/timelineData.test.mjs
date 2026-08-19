import assert from 'node:assert/strict';

import { projects } from '../src/data/projects.js';
import {
  timelineEntries,
  timelineKindOptions,
  timelineSources,
} from '../src/data/timeline.js';

const expectedKinds = [
  'work',
  'project',
  'research',
  'award',
  'education',
  'leadership',
  'service',
  'credential',
];
const allowedKinds = new Set(expectedKinds);
const knownProjectSlugs = new Set(projects.map(({ slug }) => slug));

function parsePartialDate(value, fieldName) {
  assert.equal(typeof value, 'string', `${fieldName} must be a string`);

  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  assert.ok(match, `${fieldName} must use YYYY, YYYY-MM, or YYYY-MM-DD`);

  const year = Number(match[1]);
  const month = match[2] ? Number(match[2]) : 1;
  const day = match[3] ? Number(match[3]) : 1;

  assert.ok(month >= 1 && month <= 12, `${fieldName} has an invalid month`);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  assert.ok(day >= 1 && day <= lastDay, `${fieldName} has an invalid day`);

  return { year, month, day };
}

function assertSafeHttpsUrl(value, fieldName) {
  assert.equal(typeof value, 'string', `${fieldName} must be a string`);
  const url = new URL(value);
  assert.equal(url.protocol, 'https:', `${fieldName} must use HTTPS`);
  assert.ok(url.hostname, `${fieldName} must include a hostname`);
  assert.equal(url.username, '', `${fieldName} must not contain credentials`);
  assert.equal(url.password, '', `${fieldName} must not contain credentials`);
}

assert.deepEqual(
  timelineKindOptions.map(({ id }) => id),
  ['all', ...expectedKinds],
  'timeline filters should expose exactly the supported kinds',
);

assert.ok(
  timelineEntries.length >= 35,
  'timeline should retain a substantial set of source-grounded entries',
);

const ids = timelineEntries.map(({ id }) => id);
assert.equal(new Set(ids).size, ids.length, 'timeline entry IDs must be unique');

for (const kind of expectedKinds) {
  assert.ok(
    timelineEntries.some((entry) => entry.kind === kind),
    `timeline must include at least one ${kind} entry`,
  );
  assertSafeHttpsUrl(timelineSources[kind], `timelineSources.${kind}`);
}

for (const [index, entry] of timelineEntries.entries()) {
  const context = `timelineEntries[${index}] (${entry.id ?? 'missing ID'})`;

  assert.ok(entry.id, `${context} must have an ID`);
  assert.ok(entry.title, `${context} must have a title`);
  assert.ok(entry.dateLabel, `${context} must have a date label`);
  assert.ok(allowedKinds.has(entry.kind), `${context} has an unsupported kind`);

  const startDate = parsePartialDate(entry.startDate, `${context}.startDate`);
  const sortDate = parsePartialDate(entry.sortDate, `${context}.sortDate`);
  assert.ok(
    entry.sortDate.localeCompare(entry.startDate) >= 0,
    `${context}.sortDate must not precede its startDate`,
  );

  assert.ok(Array.isArray(entry.years), `${context}.years must be an array`);
  assert.ok(entry.years.length > 0, `${context}.years must not be empty`);
  assert.ok(
    entry.years.every((year) => Number.isInteger(year) && year >= 1900 && year <= 2100),
    `${context}.years must contain plausible integer years`,
  );
  assert.deepEqual(
    entry.years,
    [...new Set(entry.years)].sort((left, right) => left - right),
    `${context}.years must be unique and ascending`,
  );
  assert.ok(entry.years.includes(startDate.year), `${context}.years must include its start year`);
  assert.ok(entry.years.includes(sortDate.year), `${context}.years must include its sort year`);

  assert.equal(
    entry.sourceUrl,
    timelineSources[entry.kind],
    `${context} must use the canonical source for its kind`,
  );
  assertSafeHttpsUrl(entry.sourceUrl, `${context}.sourceUrl`);

  if (entry.externalUrl) {
    assertSafeHttpsUrl(entry.externalUrl, `${context}.externalUrl`);
  }

  if (entry.relatedProjectSlug) {
    assert.ok(
      knownProjectSlugs.has(entry.relatedProjectSlug),
      `${context}.relatedProjectSlug must match a bundled project`,
    );
  }

  if (index > 0) {
    assert.ok(
      timelineEntries[index - 1].sortDate.localeCompare(entry.sortDate) >= 0,
      'timeline entries must be sorted by sortDate in descending order',
    );
  }
}

console.log(`Timeline data tests passed (${timelineEntries.length} entries).`);
