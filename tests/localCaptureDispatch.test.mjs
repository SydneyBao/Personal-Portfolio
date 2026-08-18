import assert from 'node:assert/strict';

import {
  createLocalCaptureDispatcher,
  createLocalCaptureStatusMonitor,
  createLocalCaptureStatusProvider,
  createLocalMediaStatusStorage,
} from '../dev/local-media-plugin.mjs';
import { HttpError } from '../netlify/functions/_shared/backend-core.mjs';

const payload = {
  requestId: '123e4567-e89b-42d3-a456-426614174000',
  slug: 'demo-project',
  url: 'https://example.com/demo',
};

const calls = [];
let credentialReads = 0;
const dispatch = createLocalCaptureDispatcher({
  credentialProvider: async () => {
    credentialReads += 1;
    return { password: 'github-test-token' };
  },
  fetchImpl: async (url, options) => {
    calls.push({ options, url });
    return new Response(null, { status: 204 });
  },
});

await dispatch(payload);
assert.equal(credentialReads, 1);
assert.equal(calls.length, 1);
assert.equal(
  calls[0].url,
  'https://api.github.com/repos/SydneyBao/Personal-Portfolio/actions/workflows/capture-portfolio-media.yml/dispatches',
);
assert.equal(calls[0].options.method, 'POST');
assert.equal(calls[0].options.redirect, 'error');
assert.equal(calls[0].options.headers.Authorization, 'Bearer github-test-token');
assert.equal(calls[0].options.headers['X-GitHub-Api-Version'], '2022-11-28');
assert.ok(calls[0].options.signal instanceof AbortSignal);
assert.deepEqual(JSON.parse(calls[0].options.body), {
  ref: 'main',
  inputs: payload,
});
assert.equal(calls[0].options.body.includes('github-test-token'), false);

let invalidCredentialRead = false;
const invalidPayloadDispatch = createLocalCaptureDispatcher({
  credentialProvider: async () => {
    invalidCredentialRead = true;
    return { password: 'unused' };
  },
  fetchImpl: async () => new Response(null, { status: 204 }),
});
await assert.rejects(
  invalidPayloadDispatch({ ...payload, url: 'http://example.com/' }),
  (error) => error.statusCode === 500 && error.code === 'local_media_not_configured',
);
assert.equal(invalidCredentialRead, false);

const missingCredentialDispatch = createLocalCaptureDispatcher({
  credentialProvider: async () => null,
  fetchImpl: async () => new Response(null, { status: 204 }),
});
await assert.rejects(
  missingCredentialDispatch(payload),
  (error) => error.statusCode === 503 && error.code === 'local_github_credentials_missing',
);

let networkFailureCalls = 0;
const networkFailureDispatch = createLocalCaptureDispatcher({
  credentialProvider: async () => ({ password: 'github-test-token' }),
  fetchImpl: async () => {
    networkFailureCalls += 1;
    const error = new Error('network details must not escape');
    error.cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
    throw error;
  },
});
await assert.rejects(
  networkFailureDispatch(payload),
  (error) => error.statusCode === 503
    && error.code === 'local_github_unavailable'
    && error.localDiagnostic === 'dispatch_retry_und_err_connect_timeout'
    && !error.message.includes('network details'),
);
assert.equal(networkFailureCalls, 2);

let recoveredDispatchCalls = 0;
const recoveredDispatch = createLocalCaptureDispatcher({
  credentialProvider: async () => ({ password: 'github-test-token' }),
  fetchImpl: async () => {
    recoveredDispatchCalls += 1;
    if (recoveredDispatchCalls === 1) {
      const error = new Error('connection was never established');
      error.cause = { code: 'ENOTFOUND' };
      throw error;
    }
    return new Response(null, { status: 204 });
  },
});
await recoveredDispatch(payload);
assert.equal(recoveredDispatchCalls, 2);

let ambiguousFailureCalls = 0;
const ambiguousFailureDispatch = createLocalCaptureDispatcher({
  credentialProvider: async () => ({ password: 'github-test-token' }),
  fetchImpl: async () => {
    ambiguousFailureCalls += 1;
    const error = new Error('socket may have failed after request transmission');
    error.cause = { code: 'ECONNRESET' };
    throw error;
  },
});
await assert.rejects(
  ambiguousFailureDispatch(payload),
  (error) => error.statusCode === 503
    && error.code === 'local_github_unavailable'
    && error.localDiagnostic === 'dispatch_econnreset',
);
assert.equal(ambiguousFailureCalls, 1);

let abortedDispatchCalls = 0;
const abortedDispatch = createLocalCaptureDispatcher({
  credentialProvider: async () => ({ password: 'github-test-token' }),
  fetchImpl: async () => {
    abortedDispatchCalls += 1;
    throw new DOMException('request deadline reached', 'AbortError');
  },
});
await assert.rejects(
  abortedDispatch(payload),
  (error) => error.statusCode === 503
    && error.code === 'local_github_unavailable'
    && error.localDiagnostic === 'dispatch_timeout',
);
assert.equal(abortedDispatchCalls, 1);

const responseCases = [
  [401, 503, 'local_github_credentials_rejected'],
  [403, 502, 'local_capture_permission_denied'],
  [404, 502, 'local_capture_workflow_missing'],
  [422, 502, 'local_capture_workflow_invalid'],
  [429, 503, 'local_github_rate_limited'],
  [500, 503, 'local_github_unavailable'],
  [400, 502, 'local_capture_dispatch_failed'],
];

for (const [githubStatus, statusCode, code] of responseCases) {
  const failingDispatch = createLocalCaptureDispatcher({
    credentialProvider: async () => ({ password: 'github-test-token' }),
    fetchImpl: async () => new Response(null, { status: githubStatus }),
  });
  await assert.rejects(
    failingDispatch(payload),
    (error) => error.statusCode === statusCode
      && error.code === code
      && (githubStatus !== 500 || error.localDiagnostic === 'dispatch_http_500'),
  );
}

const statusCalls = [];
let statusCredentialReads = 0;
const captureStatus = createLocalCaptureStatusProvider({
  credentialProvider: async () => {
    statusCredentialReads += 1;
    return { password: 'github-status-token' };
  },
  fetchImpl: async (url, options) => {
    statusCalls.push({ options, url });
    return Response.json({
      workflow_runs: [
        {
          conclusion: 'failure',
          display_title: `Capture ${payload.slug} (${payload.requestId})`,
          status: 'completed',
        },
      ],
    });
  },
});
assert.deepEqual(await captureStatus(payload), { status: 'failed', conclusion: 'failure' });
assert.equal(statusCredentialReads, 1);
assert.equal(statusCalls.length, 1);
assert.equal(
  statusCalls[0].url,
  'https://api.github.com/repos/SydneyBao/Personal-Portfolio/actions/workflows/capture-portfolio-media.yml/runs?branch=main&event=workflow_dispatch&per_page=100',
);
assert.equal(statusCalls[0].options.method, 'GET');
assert.equal(statusCalls[0].options.redirect, 'error');
assert.equal(statusCalls[0].options.headers.Authorization, 'Bearer github-status-token');
assert.equal(statusCalls[0].options.body, undefined);

const statusCases = [
  [{ workflow_runs: [] }, { status: 'unknown' }],
  [{
    workflow_runs: [{
      conclusion: null,
      display_title: `Capture ${payload.slug} (${payload.requestId})`,
      status: 'queued',
    }],
  }, { status: 'pending' }],
  [{
    workflow_runs: [{
      conclusion: 'success',
      display_title: `Capture ${payload.slug} (${payload.requestId})`,
      status: 'completed',
    }],
  }, { status: 'success' }],
  [{
    workflow_runs: [{
      conclusion: 'cancelled',
      display_title: `Capture ${payload.slug} (${payload.requestId})`,
      status: 'completed',
    }],
  }, { status: 'failed', conclusion: 'cancelled' }],
  [{
    workflow_runs: [{
      conclusion: 'failure',
      display_title: 'Capture another-project (123e4567-e89b-42d3-a456-426614174000)',
      status: 'completed',
    }],
  }, { status: 'unknown' }],
];

for (const [githubPayload, expected] of statusCases) {
  const provider = createLocalCaptureStatusProvider({
    credentialProvider: async () => ({ password: 'github-test-token' }),
    fetchImpl: async () => Response.json(githubPayload),
  });
  assert.deepEqual(await provider(payload), expected);
}

const invalidStatusIdentity = createLocalCaptureStatusProvider({
  credentialProvider: async () => {
    throw new Error('must not read credentials');
  },
  fetchImpl: async () => Response.json({ workflow_runs: [] }),
});
await assert.rejects(
  invalidStatusIdentity({ ...payload, requestId: 'not-a-uuid' }),
  (error) => error.statusCode === 500 && error.code === 'local_media_not_configured',
);

const invalidStatusPayload = createLocalCaptureStatusProvider({
  credentialProvider: async () => ({ password: 'github-test-token' }),
  fetchImpl: async () => Response.json({ workflow_runs: null }),
});
await assert.rejects(
  invalidStatusPayload(payload),
  (error) => error.statusCode === 502 && error.code === 'local_capture_status_invalid',
);

const unavailableStatus = createLocalCaptureStatusProvider({
  credentialProvider: async () => ({ password: 'github-test-token' }),
  fetchImpl: async () => new Response(null, { status: 500 }),
});
await assert.rejects(
  unavailableStatus(payload),
  (error) => error.statusCode === 503
    && error.code === 'local_github_unavailable'
    && error.localDiagnostic === 'status_http_500',
);

const transientStatusLogs = [];
let transientStatusNow = 1_000;
let transientStatusCalls = 0;
const tolerantStatus = createLocalCaptureStatusMonitor({
  logger: (message) => transientStatusLogs.push(message),
  now: () => transientStatusNow,
  statusProvider: async (identity) => {
    transientStatusCalls += 1;
    return unavailableStatus(identity);
  },
});
assert.deepEqual(await tolerantStatus(payload), { status: 'unknown' });
assert.equal(transientStatusCalls, 1);
transientStatusNow += 5_000;
assert.deepEqual(await tolerantStatus(payload), { status: 'unknown' });
assert.equal(transientStatusCalls, 1);
transientStatusNow += 10_001;
assert.deepEqual(await tolerantStatus(payload), { status: 'unknown' });
assert.equal(transientStatusCalls, 2);
assert.deepEqual(transientStatusLogs, [
  'Local capture status is temporarily unavailable: local_github_unavailable (status_http_500)',
  'Local capture status is temporarily unavailable: local_github_unavailable (status_http_500)',
]);

const rejectedStatusProvider = createLocalCaptureStatusProvider({
  credentialProvider: async () => ({ password: 'github-test-token' }),
  fetchImpl: async () => new Response(null, { status: 401 }),
});
const rejectedStatus = createLocalCaptureStatusMonitor({
  logger: () => assert.fail('A non-transient status error must not be swallowed.'),
  statusProvider: rejectedStatusProvider,
});
await assert.rejects(
  rejectedStatus(payload),
  (error) => error.statusCode === 503 && error.code === 'local_github_credentials_rejected',
);

let mediaStatusNow = 2_000;
let mediaOriginReads = 0;
const mediaStatusLogs = [];
const monitoredStorage = createLocalMediaStatusStorage({
  logger: (message) => mediaStatusLogs.push(message),
  now: () => mediaStatusNow,
  storage: {
    commitUniqueMedia: async (upload) => ({ sha: upload.sha }),
    findCommittedMedia: async () => {
      mediaOriginReads += 1;
      if (mediaOriginReads === 1) {
        throw new HttpError(503, 'local_git_remote_unavailable', 'raw origin details');
      }
      return { sha: 'remote-blob', type: 'file' };
    },
  },
});
assert.equal(await monitoredStorage.findCommittedMedia('public/portfolio/uploads/demo/image.webp'), null);
assert.equal(mediaOriginReads, 1);
mediaStatusNow += 5_000;
assert.equal(await monitoredStorage.findCommittedMedia('public/portfolio/uploads/demo/image.webp'), null);
assert.equal(mediaOriginReads, 1);
mediaStatusNow += 10_001;
assert.deepEqual(
  await monitoredStorage.findCommittedMedia('public/portfolio/uploads/demo/image.webp'),
  { sha: 'remote-blob', type: 'file' },
);
assert.equal(mediaOriginReads, 2);
assert.deepEqual(mediaStatusLogs, [
  'Local media origin status is temporarily unavailable: local_git_remote_unavailable',
]);
assert.deepEqual(await monitoredStorage.commitUniqueMedia({ sha: 'upload-blob' }), { sha: 'upload-blob' });

const strictStorage = createLocalMediaStatusStorage({
  logger: () => assert.fail('A non-transient storage error must not be swallowed.'),
  storage: {
    commitUniqueMedia: async () => null,
    findCommittedMedia: async () => {
      throw new HttpError(500, 'local_media_not_configured', 'configuration details');
    },
  },
});
await assert.rejects(
  strictStorage.findCommittedMedia('public/portfolio/uploads/demo/image.webp'),
  (error) => error.code === 'local_media_not_configured',
);

console.log('Local capture dispatcher tests passed.');
