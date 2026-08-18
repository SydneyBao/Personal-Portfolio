import assert from 'node:assert/strict';

import { suppressedProjectSlugs } from '../src/lib/projectVisibility.js';

assert.deepEqual(
  [...suppressedProjectSlugs([], ['popper-social', 'deleted-cloud-project'])],
  ['popper-social', 'deleted-cloud-project'],
  'deletion markers should suppress both bundled and cloud-only projects',
);

assert.deepEqual(
  [...suppressedProjectSlugs(
    [{ slug: 'popper-social' }, { slug: 'restored-cloud-project' }],
    ['popper-social', 'restored-cloud-project', 'still-deleted'],
  )],
  ['still-deleted'],
  'a newly published remote document should restore a previously deleted slug',
);

console.log('Project deletion visibility tests passed.');
