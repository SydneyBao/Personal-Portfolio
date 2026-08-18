import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleOwnerMediaRequest } from '../netlify/functions/_shared/backend-core.mjs';

const REQUEST_ORIGIN = 'https://sydneybao.com';
const PUBLIC_ORIGIN = 'https://8.8.8.8';
const PROJECT_ID = 'portfolio-media-status-test';
const OWNER_UID = 'owner-status-test-uid';
const OWNER_EMAIL = 'owner@example.com';
const TEST_KID = 'portfolio-status-test-key';

function base64Url(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  return bytes.toString('base64url');
}

function createToken(privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url({ alg: 'RS256', kid: TEST_KID, typ: 'JWT' });
  const payload = base64Url({
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    sub: OWNER_UID,
    exp: now + 3600,
    iat: now,
    auth_time: now,
    email: OWNER_EMAIL,
    firebase: { sign_in_provider: 'password' },
  });
  const unsigned = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url');
  return `${unsigned}.${signature}`;
}

function request(token, body) {
  return {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      origin: REQUEST_ORIGIN,
    },
    body,
  };
}

function responseJson(response) {
  return response.body ? JSON.parse(response.body) : null;
}

const fixtureDirectory = mkdtempSync(join(tmpdir(), 'portfolio-media-status-test-'));
const privateKeyPath = join(fixtureDirectory, 'private-key.pem');
const certificatePath = join(fixtureDirectory, 'certificate.pem');

try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', privateKeyPath,
    '-out', certificatePath,
    '-subj', '/CN=portfolio-media-status-test',
    '-days', '1',
  ], { stdio: 'ignore' });

  const privateKey = readFileSync(privateKeyPath, 'utf8');
  const certificate = readFileSync(certificatePath, 'utf8');
  const validToken = createToken(privateKey);
  const githubReadyPaths = new Set();
  const publicResponses = new Map();
  let workflowRuns = [];
  const calls = [];
  const originalFetch = globalThis.fetch;

  Object.assign(process.env, {
    FIREBASE_OWNER_EMAIL: OWNER_EMAIL,
    FIREBASE_OWNER_SIGN_IN_PROVIDER: 'password',
    FIREBASE_OWNER_UID: OWNER_UID,
    FIREBASE_PROJECT_ID: PROJECT_ID,
    GITHUB_ACTIONS_TOKEN: 'actions-status-test-token',
    GITHUB_CONTENTS_TOKEN: 'contents-status-test-token',
    GITHUB_MEDIA_BRANCH: 'main',
    GITHUB_MEDIA_REPOSITORY: 'SydneyBao/Personal-Portfolio',
    OWNER_MEDIA_ALLOWED_ORIGINS: REQUEST_ORIGIN,
    OWNER_MEDIA_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
  });

  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.includes('securetoken@system.gserviceaccount.com')) {
      return new Response(JSON.stringify({ [TEST_KID]: certificate }), {
        status: 200,
        headers: { 'cache-control': 'public, max-age=3600', 'content-type': 'application/json' },
      });
    }

    calls.push({ target, options });
    if (target.startsWith(`${PUBLIC_ORIGIN}/portfolio/uploads/`)) {
      const response = publicResponses.get(target);
      if (response === 'network-error') throw new Error('deployment unavailable');
      return new Response(null, {
        status: response?.status || 404,
        headers: response?.contentType ? { 'content-type': response.contentType } : {},
      });
    }

    if (target.includes(`/actions/workflows/capture-portfolio-media.yml/runs?`)) {
      return new Response(JSON.stringify({ workflow_runs: workflowRuns }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const contentsMarker = '/contents/';
    if (target.includes(contentsMarker)) {
      const encodedPath = target.split(contentsMarker, 2)[1].split('?', 1)[0];
      const repositoryPath = decodeURIComponent(encodedPath);
      if (!githubReadyPaths.has(repositoryPath)) return new Response(null, { status: 404 });
      return new Response(JSON.stringify({
        type: 'file',
        sha: `sha-for-${repositoryPath}`,
        size: 128,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    throw new Error(`Unexpected fetch target: ${target}`);
  };

  try {
    const missingAuth = await handleOwnerMediaRequest({
      method: 'POST',
      headers: { origin: REQUEST_ORIGIN, 'content-type': 'application/json' },
      body: { slug: 'demo-project', paths: ['/portfolio/uploads/demo-project/image-test.webp'] },
    }, 'status');
    assert.equal(missingAuth.statusCode, 401);

    const invalidBodies = [
      { slug: 'demo-project', paths: [] },
      { slug: 'demo-project', paths: ['https://example.com/media.webp'] },
      { slug: 'demo-project', paths: ['/portfolio/uploads/another-project/media.webp'] },
      { slug: 'demo-project', paths: ['/portfolio/uploads/demo-project/captures/../media.webp'] },
      { slug: 'demo-project', paths: ['/portfolio/uploads/demo-project/not-media.txt'] },
      {
        slug: 'demo-project',
        paths: ['/portfolio/uploads/demo-project/document-628d26fa-2796-4eb8-9c06-51b9a77dd2c1.pdf'],
      },
      { slug: 'profile', paths: ['/portfolio/uploads/profile/resume.pdf'] },
      { slug: 'profile', paths: ['/portfolio/uploads/profile/document-not-a-uuid.pdf'] },
      {
        slug: 'demo-project',
        paths: [
          '/portfolio/uploads/demo-project/media.webp',
          '/portfolio/uploads/demo-project/media.webp',
        ],
      },
      {
        slug: 'demo-project',
        paths: Array.from(
          { length: 13 },
          (_, index) => `/portfolio/uploads/demo-project/image-${index}.webp`,
        ),
      },
    ];
    for (const body of invalidBodies) {
      const result = await handleOwnerMediaRequest(request(validToken, body), 'status');
      assert.equal(result.statusCode, 400);
    }

    const requestId = 'fd6e4ee5-8a16-46ec-aee6-0de82ab1df67';
    const coverPath = `/portfolio/uploads/demo-project/captures/${requestId}/cover.webp`;
    const videoPath = `/portfolio/uploads/demo-project/captures/${requestId}/walkthrough.webm`;
    const statusBody = { slug: 'demo-project', paths: [coverPath, videoPath] };

    const uncommitted = await handleOwnerMediaRequest(request(validToken, statusBody), 'status');
    assert.equal(uncommitted.statusCode, 202);
    assert.deepEqual(responseJson(uncommitted), {
      ok: true,
      ready: false,
      status: 'pending',
      items: [
        { path: coverPath, githubReady: false, publicReady: false, ready: false },
        { path: videoPath, githubReady: false, publicReady: false, ready: false },
      ],
      pendingPaths: [coverPath, videoPath],
    });
    assert.equal(calls.some(({ target }) => target.startsWith(PUBLIC_ORIGIN)), false);

    const workflowStatusCheck = calls.find(({ target }) => (
      target.includes('/actions/workflows/capture-portfolio-media.yml/runs?')
    ));
    assert.equal(
      workflowStatusCheck.target,
      'https://api.github.com/repos/SydneyBao/Personal-Portfolio/actions/workflows/'
        + 'capture-portfolio-media.yml/runs?branch=main&event=workflow_dispatch&per_page=100',
    );
    assert.equal(
      workflowStatusCheck.options.headers.Authorization,
      'Bearer actions-status-test-token',
    );

    workflowRuns = [{
      display_title: 'Capture demo-project (11111111-1111-4111-8111-111111111111)',
      status: 'completed',
      conclusion: 'failure',
    }];
    const unrelatedFailedCapture = await handleOwnerMediaRequest(
      request(validToken, statusBody),
      'status',
    );
    assert.equal(unrelatedFailedCapture.statusCode, 202);

    workflowRuns = [{
      display_title: `Capture demo-project (${requestId})`,
      status: 'completed',
      conclusion: 'failure',
      html_url: 'https://github.com/SydneyBao/Personal-Portfolio/actions/runs/123',
    }];
    const failedCapture = await handleOwnerMediaRequest(
      request(validToken, statusBody),
      'status',
    );
    assert.equal(failedCapture.statusCode, 422);
    assert.deepEqual(responseJson(failedCapture), {
      error: {
        code: 'capture_failed',
        message: 'The capture workflow failed before producing media. Retry the capture after checking GitHub Actions.',
      },
    });

    workflowRuns = [{
      display_title: `Capture demo-project (${requestId})`,
      status: 'queued',
      conclusion: null,
    }];
    const queuedCapture = await handleOwnerMediaRequest(
      request(validToken, statusBody),
      'status',
    );
    assert.equal(queuedCapture.statusCode, 202);

    workflowRuns = [{
      display_title: `Capture demo-project (${requestId})`,
      status: 'completed',
      conclusion: 'success',
    }];
    const successfulCaptureAwaitingAssets = await handleOwnerMediaRequest(
      request(validToken, statusBody),
      'status',
    );
    assert.equal(successfulCaptureAwaitingAssets.statusCode, 202);

    const injectedStatusCalls = [];
    const injectedFailure = await handleOwnerMediaRequest(
      request(validToken, { slug: 'demo-project', paths: [videoPath, coverPath] }),
      'status',
      {
        captureStatusProvider: async (capture) => {
          injectedStatusCalls.push(capture);
          return { status: 'failed', conclusion: 'cancelled' };
        },
      },
    );
    assert.equal(injectedFailure.statusCode, 422);
    assert.deepEqual(injectedStatusCalls, [{ requestId, slug: 'demo-project' }]);

    const unavailableStatusIsPending = await handleOwnerMediaRequest(
      request(validToken, { slug: 'demo-project', paths: [videoPath, coverPath] }),
      'status',
      {
        captureStatusProvider: async () => ({ status: 'unknown' }),
      },
    );
    assert.equal(unavailableStatusIsPending.statusCode, 202);
    assert.equal(responseJson(unavailableStatusIsPending).ready, false);

    let ordinaryStatusChecks = 0;
    const ordinaryMedia = await handleOwnerMediaRequest(
      request(validToken, {
        slug: 'demo-project',
        paths: ['/portfolio/uploads/demo-project/image-628d26fa-2796-4eb8-9c06-51b9a77dd2c1.webp'],
      }),
      'status',
      {
        captureStatusProvider: async () => {
          ordinaryStatusChecks += 1;
          return { status: 'failed' };
        },
      },
    );
    assert.equal(ordinaryMedia.statusCode, 202);
    assert.equal(ordinaryStatusChecks, 0);

    githubReadyPaths.add(`public${coverPath}`);
    githubReadyPaths.add(`public${videoPath}`);
    publicResponses.set(`${PUBLIC_ORIGIN}${coverPath}`, { status: 200, contentType: 'text/html' });
    publicResponses.set(`${PUBLIC_ORIGIN}${videoPath}`, 'network-error');

    const notDeployed = await handleOwnerMediaRequest(request(validToken, statusBody), 'status');
    assert.equal(notDeployed.statusCode, 202);
    const notDeployedPayload = responseJson(notDeployed);
    assert.equal(notDeployedPayload.items.every(({ githubReady }) => githubReady), true);
    assert.equal(notDeployedPayload.items.some(({ publicReady }) => publicReady), false);

    const publicChecks = calls.filter(({ target }) => target.startsWith(PUBLIC_ORIGIN));
    assert.equal(publicChecks.length, 2);
    assert.equal(publicChecks.every(({ options }) => options.method === 'HEAD'), true);
    assert.equal(publicChecks.every(({ options }) => options.cache === 'no-store'), true);
    assert.equal(publicChecks.every(({ options }) => options.headers['Cache-Control'] === 'no-cache'), true);
    assert.equal(publicChecks.every(({ options }) => options.redirect === 'manual'), true);
    assert.equal(publicChecks.every(({ options }) => !options.headers.Authorization), true);

    publicResponses.set(`${PUBLIC_ORIGIN}${coverPath}`, { status: 200, contentType: 'image/webp' });
    publicResponses.set(`${PUBLIC_ORIGIN}${videoPath}`, { status: 200, contentType: 'video/webm' });

    const ready = await handleOwnerMediaRequest(request(validToken, statusBody), 'status');
    assert.equal(ready.statusCode, 200);
    const readyPayload = responseJson(ready);
    assert.equal(readyPayload.ready, true);
    assert.equal(readyPayload.status, 'ready');
    assert.deepEqual(readyPayload.pendingPaths, []);
    assert.equal(readyPayload.items.every((item) => item.ready), true);

    const documentPath = '/portfolio/uploads/profile/document-628d26fa-2796-4eb8-9c06-51b9a77dd2c1.pdf';
    const documentStatusBody = { slug: 'profile', paths: [documentPath] };
    githubReadyPaths.add(`public${documentPath}`);
    publicResponses.set(`${PUBLIC_ORIGIN}${documentPath}`, {
      status: 200,
      contentType: 'application/octet-stream',
    });

    const wrongDocumentType = await handleOwnerMediaRequest(
      request(validToken, documentStatusBody),
      'status',
    );
    assert.equal(wrongDocumentType.statusCode, 202);
    assert.equal(responseJson(wrongDocumentType).items[0].publicReady, false);
    const documentCheck = calls.filter(({ target }) => target === `${PUBLIC_ORIGIN}${documentPath}`).at(-1);
    assert.equal(documentCheck.options.headers.Accept, 'application/pdf');

    publicResponses.set(`${PUBLIC_ORIGIN}${documentPath}`, {
      status: 200,
      contentType: 'application/pdf; charset=binary',
    });
    const readyDocument = await handleOwnerMediaRequest(
      request(validToken, documentStatusBody),
      'status',
    );
    assert.equal(readyDocument.statusCode, 200);
    assert.equal(responseJson(readyDocument).items[0].ready, true);

    const githubCheck = calls.find(({ target }) => target.includes(`/contents/public${coverPath}`));
    assert.equal(githubCheck.options.headers.Authorization, 'Bearer contents-status-test-token');

    const originalPublicOrigin = process.env.OWNER_MEDIA_PUBLIC_ORIGIN;
    delete process.env.OWNER_MEDIA_PUBLIC_ORIGIN;
    const missingConfig = await handleOwnerMediaRequest(request(validToken, statusBody), 'status');
    assert.equal(missingConfig.statusCode, 500);
    assert.equal(responseJson(missingConfig).error.code, 'server_not_configured');
    process.env.OWNER_MEDIA_PUBLIC_ORIGIN = originalPublicOrigin;

    const workflow = readFileSync(new URL('../.github/workflows/capture-portfolio-media.yml', import.meta.url), 'utf8');
    assert.doesNotMatch(workflow, /^concurrency:/m);
    assert.match(
      workflow,
      /^run-name: Capture \$\{\{ inputs\.slug \}\} \(\$\{\{ inputs\.requestId \}\}\)$/m,
    );
    assert.match(workflow, /timeout-minutes: 20/);
    assert.doesNotMatch(workflow, /actions\/cache/);
    assert.match(workflow, /for attempt in 1 2/);
    assert.match(workflow, /timeout --kill-after=15s 180 npm install/);
    assert.match(workflow, /--ignore-scripts/);
    assert.match(workflow, /timeout --kill-after=15s 480 "\$runtime_directory\/node_modules\/\.bin\/playwright" install --with-deps chromium/);
    assert.match(
      workflow,
      /sudo sysctl -w kernel\.apparmor_restrict_unprivileged_userns=0/,
    );
    assert.match(
      workflow,
      /test "\$\(sysctl -n kernel\.apparmor_restrict_unprivileged_userns\)" = "0"/,
    );
    assert.doesNotMatch(workflow, /CHROME_DEVEL_SANDBOX/);
    const captureScript = readFileSync(
      new URL('../.github/workflows/scripts/capture-portfolio-media.mjs', import.meta.url),
      'utf8',
    );
    assert.match(captureScript, /chromiumSandbox:\s*true/);
    assert.doesNotMatch(captureScript, /channel:\s*['"]chrome['"]/);
    assert.doesNotMatch(captureScript, /--no-sandbox/);

    console.log('Firebase owner media readiness tests passed.');
  } finally {
    globalThis.fetch = originalFetch;
  }
} finally {
  rmSync(fixtureDirectory, { recursive: true, force: true });
}
