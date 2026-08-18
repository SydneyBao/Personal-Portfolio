import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';

import {
  MAX_GUIDED_CLICKS,
  describeSafeInteraction,
  isSameDocumentUrl,
  selectSafeInteractions,
} from '../.github/workflows/scripts/capture-interactions.mjs';
import { startPinnedHttpsProxy } from '../.github/workflows/scripts/capture-portfolio-media.mjs';

function connectedSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function waitForSocketClose(socket, label) {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${label} was not closed by the frozen proxy.`));
    }, 1500);
    socket.on('error', () => {});
    socket.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function candidate(index, overrides = {}) {
  return {
    index,
    tagName: 'BUTTON',
    role: '',
    type: 'button',
    text: `Show feature ${index}`,
    ariaLabel: '',
    title: '',
    name: '',
    id: '',
    className: '',
    testId: '',
    disabled: false,
    ariaDisabled: false,
    inert: false,
    formOwned: false,
    anchorOwned: false,
    hasHref: false,
    downloadOwned: false,
    contentEditable: false,
    visible: true,
    occluded: false,
    ariaExpanded: '',
    ariaPressed: '',
    ariaHasPopup: '',
    ...overrides,
  };
}

function assertSafe(overrides, message) {
  const description = describeSafeInteraction(candidate(0, overrides));
  assert.ok(description, message);
  assert.equal(description.index, 0);
  assert.equal(typeof description.fingerprint, 'string');
  assert.ok(description.fingerprint.length > 0);
  assert.ok(Number.isFinite(description.score));
  return description;
}

function assertUnsafe(overrides, message) {
  assert.equal(describeSafeInteraction(candidate(0, overrides)), null, message);
}

assert.ok(Number.isInteger(MAX_GUIDED_CLICKS));
assert.equal(MAX_GUIDED_CLICKS, 4, 'the walkthrough must retain a small fixed click budget');

assertSafe({ text: 'Next image' }, 'ordinary type=button controls should be eligible');
assertSafe(
  { type: '', text: 'Open gallery' },
  'presentation buttons without an explicit type are safe when they are not owned by a form',
);
assertSafe(
  {
    tagName: 'DIV',
    role: 'button',
    text: 'Project details',
    ariaHasPopup: 'dialog',
  },
  'visible ARIA buttons should be eligible',
);
assertSafe(
  { text: 'Open navigation', ariaExpanded: 'false' },
  'disclosure buttons should be eligible',
);
assertSafe(
  { text: 'Open chat menu' },
  'narrowly labelled chat menus should be eligible visual controls',
);
assertSafe(
  { text: 'Pause animation', ariaPressed: 'false' },
  'non-destructive toggle buttons should be eligible',
);
assertSafe(
  { tagName: 'DIV', role: 'tab', text: 'Overview' },
  'ARIA tabs should be eligible for a guided walkthrough',
);
assertSafe(
  { text: 'Close navigation' },
  'local dismiss controls should be eligible once networking is frozen',
);
assertSafe(
  { text: 'Close chat menu', ariaExpanded: 'true' },
  'chat menu dismiss controls should remain eligible after the menu opens',
);
assertSafe(
  { text: 'Cancel' },
  'short local dismiss controls should be eligible once networking is frozen',
);
assertUnsafe(
  { text: 'Summarize Sydney\'s coding experience' },
  'generic prompt buttons must not be clicked because they can start server-backed actions',
);
assertUnsafe(
  { tagName: 'DIV', role: 'button', text: 'Tell me about Sydney' },
  'generic ARIA buttons must not be clicked',
);
assertUnsafe(
  { text: 'Tell me more about Sydney' },
  'broad conversational labels must not qualify as visual controls',
);
assertUnsafe(
  { text: 'Start a chat' },
  'start actions must not qualify as visual controls',
);
assertUnsafe(
  { text: 'Ask about this resume', className: 'feature-menu-button' },
  'class and test identifiers must not turn a generic action into a presentation control',
);
assertUnsafe(
  { text: 'Ask about this resume', ariaHasPopup: 'false' },
  'aria-haspopup=false must not qualify a generic button',
);

for (const [overrides, reason] of [
  [{ visible: false }, 'hidden controls'],
  [{ disabled: true }, 'disabled controls'],
  [{ ariaDisabled: true }, 'ARIA-disabled controls'],
  [{ inert: true }, 'inert controls'],
  [{ contentEditable: true }, 'editable controls'],
  [{ type: 'submit' }, 'submit buttons'],
  [{ type: 'reset' }, 'reset buttons'],
  [{ formOwned: true }, 'form-owned controls'],
  [{ anchorOwned: true }, 'controls nested in links'],
  [{ hasHref: true }, 'link-like controls'],
  [{ downloadOwned: true }, 'download controls'],
  [{ occluded: true }, 'occluded controls'],
  [{ tagName: 'INPUT', type: 'file' }, 'file inputs'],
  [{ tagName: 'A', role: '', text: 'Details' }, 'ordinary anchors'],
]) {
  assertUnsafe(overrides, `${reason} must not be clicked`);
}

for (const label of [
  'Delete project',
  'Buy now',
  'Sign in',
  'Log out',
  'Submit application',
  'Upload file',
  'Download report',
]) {
  assertUnsafe({ text: label }, `action labelled ${JSON.stringify(label)} must not be clicked`);
}

assertUnsafe(
  { text: 'Details', ariaLabel: 'Delete account' },
  'accessible labels must participate in the safety check',
);
assertUnsafe(
  { text: 'Details', title: 'Buy subscription' },
  'titles must participate in the safety check',
);

const ordered = selectSafeInteractions([
  candidate(9, { tagName: 'DIV', role: 'tab', text: 'Gamma' }),
  candidate(2, { tagName: 'DIV', role: 'tab', text: 'Alpha' }),
  candidate(5, { tagName: 'DIV', role: 'tab', text: 'Beta' }),
], { limit: 3 });
assert.deepEqual(
  ordered.map(({ index }) => index),
  [2, 5, 9],
  'equal-score candidates should use DOM order as a deterministic tie-breaker',
);

const prioritized = selectSafeInteractions([
  candidate(0, { text: 'Show gallery' }),
  candidate(1, { text: 'Next image' }),
  candidate(2, { tagName: 'DIV', role: 'tab', text: 'Overview' }),
], { limit: 3 });
assert.deepEqual(
  prioritized.map(({ index }) => index),
  [2, 0, 1],
  'tabs and presentation controls should be prioritized deterministically',
);

const menuControls = selectSafeInteractions([
  candidate(0, { text: 'Close chat menu', ariaExpanded: 'true' }),
  candidate(1, { text: 'Archived', ariaExpanded: 'false' }),
], { limit: 2 });
assert.deepEqual(
  menuControls.map(({ index }) => index),
  [1, 0],
  'an available disclosure should be demonstrated before dismissing its menu',
);

const repeated = candidate(4, {
  text: 'Open gallery',
  id: 'gallery-control',
  ariaExpanded: 'false',
});
const repeatedDescription = describeSafeInteraction(repeated);
assert.ok(repeatedDescription);
assert.deepEqual(
  selectSafeInteractions([repeated, repeated], { limit: MAX_GUIDED_CLICKS }).map(({ index }) => index),
  [4],
  'the same control should only be selected once per pass',
);
assert.deepEqual(
  selectSafeInteractions([repeated], {
    limit: MAX_GUIDED_CLICKS,
    seenFingerprints: new Set([repeatedDescription.fingerprint]),
  }),
  [],
  'controls clicked in an earlier pass should not be selected again',
);

const abundantCandidates = Array.from(
  { length: MAX_GUIDED_CLICKS + 5 },
  (_, index) => candidate(index, { tagName: 'DIV', role: 'tab', text: `Section ${index}` }),
);
assert.equal(
  selectSafeInteractions(abundantCandidates, { limit: MAX_GUIDED_CLICKS + 100 }).length,
  MAX_GUIDED_CLICKS,
  'callers cannot raise the hard guided-click ceiling',
);
assert.equal(
  selectSafeInteractions(abundantCandidates, { limit: 2 }).length,
  2,
  'callers can request a smaller click budget',
);
assert.deepEqual(
  selectSafeInteractions(abundantCandidates, { limit: 0 }),
  [],
  'a zero click budget should select nothing',
);

const initialUrl = 'https://demo.example/app?mode=preview#intro';
assert.equal(isSameDocumentUrl(initialUrl, initialUrl), true);
assert.equal(
  isSameDocumentUrl(initialUrl, 'https://demo.example/app?mode=preview#gallery'),
  true,
  'hash-only changes stay in the captured document',
);
for (const changedUrl of [
  'https://demo.example/app?mode=published#intro',
  'https://demo.example/another?mode=preview#intro',
  'https://other.example/app?mode=preview#intro',
  'http://demo.example/app?mode=preview#intro',
  'https://user@demo.example/app?mode=preview#intro',
  'not a URL',
]) {
  assert.equal(
    isSameDocumentUrl(initialUrl, changedUrl),
    false,
    `navigation to ${JSON.stringify(changedUrl)} must stop guided clicks`,
  );
}
assert.equal(isSameDocumentUrl('not a URL', initialUrl), false);

const proxy = await startPinnedHttpsProxy();
try {
  const existingSocket = await connectedSocket(proxy.port);
  const existingClose = waitForSocketClose(existingSocket, 'an existing client socket');
  proxy.freeze();
  await existingClose;

  const postFreezeSocket = net.connect({ host: '127.0.0.1', port: proxy.port });
  await waitForSocketClose(postFreezeSocket, 'a post-freeze client socket');
} finally {
  await proxy.close();
}

const captureScript = readFileSync(
  new URL('../.github/workflows/scripts/capture-portfolio-media.mjs', import.meta.url),
  'utf8',
);
const coverIndex = captureScript.indexOf('const pngCover = await page.screenshot');
const offlineIndex = captureScript.indexOf('await context.setOffline(true)');
const freezeIndex = captureScript.indexOf('proxy.freeze()');
const guidedIndex = captureScript.indexOf('await runGuidedInteractions');
assert.ok(coverIndex >= 0 && coverIndex < offlineIndex, 'the cover should be captured before interaction');
assert.ok(
  offlineIndex < freezeIndex && freezeIndex < guidedIndex,
  'networking must be offline and proxy-frozen before guided clicks begin',
);
assert.match(
  captureScript,
  /if \(interactionPhase\) \{\s*interactionViolation = true;\s*await route\.abort\('blockedbyclient'\);\s*return;/,
  'every routed request must be aborted during the interaction phase',
);
for (const guardedEvent of ['dialog', 'download', 'filechooser', 'crash']) {
  assert.match(
    captureScript,
    new RegExp(`page\\.on\\('${guardedEvent}'`),
    `${guardedEvent} events should stop remaining guided clicks`,
  );
}
assert.match(
  captureScript,
  /context\.on\('page',[\s\S]*?interactionViolation = true;/,
  'popup pages should stop remaining guided clicks',
);
assert.match(captureScript, /let clickCount = 0;/);
assert.match(captureScript, /clickCount < MAX_GUIDED_CLICKS/);
assert.match(captureScript, /clickCount \+= 1;/);
assert.doesNotMatch(captureScript, /\.click\(\{[^}]*force\s*:\s*true/);
assert.doesNotMatch(captureScript, /\.setInputFiles\(|\.fill\(|\.type\(/);

console.log('Capture interaction safety tests passed.');
