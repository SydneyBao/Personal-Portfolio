/* eslint-env node */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { promisify } from 'node:util';

import {
  handleOwnerMediaRequest,
  HttpError,
  MAX_OWNER_MEDIA_REQUEST_BYTES,
} from '../netlify/functions/_shared/backend-core.mjs';

const execFileAsync = promisify(execFile);
const LOCAL_REMOTE = 'origin';
const LOCAL_BRANCH = 'main';
const LOCAL_CAPTURE_API_URL = 'https://api.github.com/repos/SydneyBao/Personal-Portfolio/actions/workflows/capture-portfolio-media.yml/dispatches';
const LOCAL_CAPTURE_RUNS_API_URL = 'https://api.github.com/repos/SydneyBao/Personal-Portfolio/actions/workflows/capture-portfolio-media.yml/runs?branch=main&event=workflow_dispatch&per_page=100';
const LOCAL_CAPTURE_CREDENTIAL_INPUT = [
  'protocol=https',
  'host=github.com',
  'path=SydneyBao/Personal-Portfolio.git',
  '',
  '',
].join('\n');
const LOCAL_CAPTURE_CREDENTIAL_TIMEOUT_MS = 5000;
const LOCAL_CAPTURE_REQUEST_TIMEOUT_MS = 15_000;
const LOCAL_CAPTURE_RETRY_DELAY_MS = 250;
const LOCAL_CAPTURE_STATUS_COOLDOWN_MS = 15_000;
const LOCAL_CAPTURE_WORKFLOW = 'capture-portfolio-media.yml';
const SAFE_DISPATCH_RETRY_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
]);
const PORTFOLIO_ORIGIN_URLS = new Set([
  'git@github.com:SydneyBao/Personal-Portfolio.git',
  'https://github.com/SydneyBao/Personal-Portfolio',
  'https://github.com/SydneyBao/Personal-Portfolio.git',
  'ssh://git@github.com/SydneyBao/Personal-Portfolio.git',
]);
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MEDIA_EXTENSIONS = {
  document: new Set(['pdf']),
  image: new Set(['gif', 'jpg', 'png', 'webp']),
  video: new Set(['mp4', 'webm']),
};
const API_ENDPOINTS = new Map([
  ['/api/media-upload', 'upload'],
  ['/api/media-status', 'status'],
  ['/api/capture-project', 'capture'],
]);

function configurationError(message = 'The local media service is not configured safely.') {
  return new HttpError(500, 'local_media_not_configured', message);
}

function gitFailure(code, message) {
  return new HttpError(503, code, message);
}

function normalizeLine(value) {
  return String(value || '').trim();
}

function credentialFailure(code, message) {
  return new HttpError(503, code, message);
}

function localGitHubUnavailable(diagnostic) {
  const error = new HttpError(503, 'local_github_unavailable', 'GitHub is temporarily unavailable. Try again.');
  error.localDiagnostic = diagnostic;
  return error;
}

function transportDiagnostic(error, operation) {
  if (error?.name === 'AbortError') return `${operation}_timeout`;
  const code = String(error?.cause?.code || error?.code || '').trim();
  return /^[A-Z0-9_]{1,64}$/.test(code)
    ? `${operation}_${code.toLowerCase()}`
    : `${operation}_network_error`;
}

function transportErrorCode(error) {
  return String(error?.cause?.code || error?.code || '').trim().toUpperCase();
}

function waitForLocalCaptureRetry() {
  return new Promise((resolveRetry) => setTimeout(resolveRetry, LOCAL_CAPTURE_RETRY_DELAY_MS));
}

async function requestLocalCaptureDispatch(fetchImpl, token, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCAL_CAPTURE_REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(LOCAL_CAPTURE_API_URL, {
      body: JSON.stringify({
        ref: LOCAL_BRANCH,
        inputs: payload,
      }),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'SydneyBao-portfolio-local-capture',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      method: 'POST',
      redirect: 'error',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function parseCredentialOutput(output) {
  const values = new Map();
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    if (values.has(key)) {
      throw credentialFailure(
        'local_github_credentials_missing',
        'GitHub credentials are unavailable. Authenticate Git for github.com and try again.',
      );
    }
    values.set(key, line.slice(separator + 1));
  }

  const password = values.get('password') || '';
  if (
    values.get('protocol') !== 'https'
    || values.get('host') !== 'github.com'
    || !password
    || password.length > 8192
    || /[\r\n]/.test(password)
  ) {
    throw credentialFailure(
      'local_github_credentials_missing',
      'GitHub credentials are unavailable. Authenticate Git for github.com and try again.',
    );
  }
  return { password };
}

async function gitHubCredentialFromGit() {
  let result;
  try {
    result = await new Promise((resolveCredential, rejectCredential) => {
      const child = execFile('git', ['credential', 'fill'], {
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        maxBuffer: 32 * 1024,
        timeout: LOCAL_CAPTURE_CREDENTIAL_TIMEOUT_MS,
      }, (error, stdout) => {
        if (error) rejectCredential(error);
        else resolveCredential(stdout);
      });
      child.stdin.on('error', rejectCredential);
      child.stdin.end(LOCAL_CAPTURE_CREDENTIAL_INPUT);
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw credentialFailure(
        'local_git_unavailable',
        'Git is unavailable, so the capture workflow could not be authenticated.',
      );
    }
    throw credentialFailure(
      'local_github_credentials_missing',
      'GitHub credentials are unavailable. Authenticate Git for github.com and try again.',
    );
  }
  return parseCredentialOutput(result);
}

function assertLocalCapturePayload({ requestId, slug, url }) {
  let target;
  try {
    target = new URL(url);
  } catch {
    throw configurationError('The validated capture URL is not canonical.');
  }
  if (
    !new RegExp(`^${UUID_PATTERN}$`).test(requestId)
    || !SLUG_PATTERN.test(slug)
    || target.protocol !== 'https:'
    || target.username
    || target.password
    || target.search
    || target.hash
    || target.toString() !== url
  ) {
    throw configurationError('The validated capture request is not canonical.');
  }
}

function assertLocalCaptureIdentity({ requestId, slug }) {
  if (!new RegExp(`^${UUID_PATTERN}$`).test(requestId) || !SLUG_PATTERN.test(slug)) {
    throw configurationError('The validated capture request is not canonical.');
  }
}

function localCaptureResponseError(status) {
  if (status === 401) {
    return credentialFailure(
      'local_github_credentials_rejected',
      'GitHub rejected the saved Git credential. Re-authenticate Git for github.com and try again.',
    );
  }
  if (status === 403) {
    return new HttpError(
      502,
      'local_capture_permission_denied',
      'The GitHub credential cannot run Actions for SydneyBao/Personal-Portfolio. Grant it Actions write access and try again.',
    );
  }
  if (status === 404) {
    return new HttpError(
      502,
      'local_capture_workflow_missing',
      `The ${LOCAL_CAPTURE_WORKFLOW} workflow is missing from main, or the GitHub credential cannot access SydneyBao/Personal-Portfolio.`,
    );
  }
  if (status === 422) {
    return new HttpError(
      502,
      'local_capture_workflow_invalid',
      'The capture workflow on main does not match this request. Publish the required workflow files and try again.',
    );
  }
  if (status === 429) {
    return new HttpError(503, 'local_github_rate_limited', 'GitHub is rate limiting capture requests. Try again shortly.');
  }
  if (status >= 500) {
    return new HttpError(503, 'local_github_unavailable', 'GitHub is temporarily unavailable. Try again.');
  }
  return new HttpError(502, 'local_capture_dispatch_failed', 'GitHub rejected the project capture request.');
}

export function createLocalCaptureDispatcher({
  credentialProvider = gitHubCredentialFromGit,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof credentialProvider !== 'function' || typeof fetchImpl !== 'function') {
    throw configurationError('The local capture dispatcher is not configured safely.');
  }

  return async (payload) => {
    assertLocalCapturePayload(payload);

    let credential;
    try {
      credential = await credentialProvider();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw credentialFailure(
        'local_github_credentials_missing',
        'GitHub credentials are unavailable. Authenticate Git for github.com and try again.',
      );
    }
    const token = String(credential?.password || '');
    if (!token || token.length > 8192 || /[\r\n]/.test(token)) {
      throw credentialFailure(
        'local_github_credentials_missing',
        'GitHub credentials are unavailable. Authenticate Git for github.com and try again.',
      );
    }

    let response;
    try {
      response = await requestLocalCaptureDispatch(fetchImpl, token, payload);
    } catch (firstError) {
      if (!SAFE_DISPATCH_RETRY_CODES.has(transportErrorCode(firstError))) {
        throw localGitHubUnavailable(transportDiagnostic(firstError, 'dispatch'));
      }
      await waitForLocalCaptureRetry();
      try {
        response = await requestLocalCaptureDispatch(fetchImpl, token, payload);
      } catch (retryError) {
        throw localGitHubUnavailable(transportDiagnostic(retryError, 'dispatch_retry'));
      }
    }

    if (response.status !== 204) {
      const error = localCaptureResponseError(response.status);
      if (response.status >= 500) error.localDiagnostic = `dispatch_http_${response.status}`;
      throw error;
    }
  };
}

export function createLocalCaptureStatusProvider({
  credentialProvider = gitHubCredentialFromGit,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof credentialProvider !== 'function' || typeof fetchImpl !== 'function') {
    throw configurationError('The local capture status provider is not configured safely.');
  }

  return async ({ requestId, slug }) => {
    assertLocalCaptureIdentity({ requestId, slug });

    let credential;
    try {
      credential = await credentialProvider();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw credentialFailure(
        'local_github_credentials_missing',
        'GitHub credentials are unavailable. Authenticate Git for github.com and try again.',
      );
    }
    const token = String(credential?.password || '');
    if (!token || token.length > 8192 || /[\r\n]/.test(token)) {
      throw credentialFailure(
        'local_github_credentials_missing',
        'GitHub credentials are unavailable. Authenticate Git for github.com and try again.',
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOCAL_CAPTURE_REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(LOCAL_CAPTURE_RUNS_API_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'SydneyBao-portfolio-local-capture',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      throw localGitHubUnavailable(transportDiagnostic(error, 'status'));
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const error = localCaptureResponseError(response.status);
      if (response.status >= 500) error.localDiagnostic = `status_http_${response.status}`;
      throw error;
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new HttpError(502, 'local_capture_status_invalid', 'GitHub returned an invalid capture status.');
    }
    if (!payload || !Array.isArray(payload.workflow_runs)) {
      throw new HttpError(502, 'local_capture_status_invalid', 'GitHub returned an invalid capture status.');
    }

    const expectedTitle = `Capture ${slug} (${requestId})`;
    const run = payload.workflow_runs.find((item) => (
      item
      && typeof item === 'object'
      && item.display_title === expectedTitle
    ));
    if (!run) return { status: 'unknown' };
    if (run.status !== 'completed') return { status: 'pending' };
    if (run.conclusion === 'success') return { status: 'success' };
    return { status: 'failed', conclusion: String(run.conclusion || 'failure') };
  };
}

export function createLocalCaptureStatusMonitor({
  logger = (message) => console.warn(message),
  now = () => Date.now(),
  statusProvider = createLocalCaptureStatusProvider(),
} = {}) {
  if (typeof logger !== 'function' || typeof now !== 'function' || typeof statusProvider !== 'function') {
    throw configurationError('The local capture status monitor is not configured safely.');
  }
  let unavailableUntil = 0;

  return async (identity) => {
    if (now() < unavailableUntil) return { status: 'unknown' };
    try {
      const status = await statusProvider(identity);
      unavailableUntil = 0;
      return status;
    } catch (error) {
      if (
        !(error instanceof HttpError)
        || !['local_github_rate_limited', 'local_github_unavailable'].includes(error.code)
      ) {
        throw error;
      }
      const diagnostic = typeof error.localDiagnostic === 'string'
        && /^[a-z0-9_]{1,80}$/.test(error.localDiagnostic)
        ? ` (${error.localDiagnostic})`
        : '';
      unavailableUntil = now() + LOCAL_CAPTURE_STATUS_COOLDOWN_MS;
      logger(`Local capture status is temporarily unavailable: ${error.code}${diagnostic}`);
      return { status: 'unknown' };
    }
  };
}

async function git(repositoryRoot, args) {
  return execFileAsync('git', ['-C', repositoryRoot, ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
}

async function gitValue(repositoryRoot, args) {
  const { stdout } = await git(repositoryRoot, args);
  return normalizeLine(stdout);
}

async function optionalGitValue(repositoryRoot, args) {
  try {
    return await gitValue(repositoryRoot, args);
  } catch {
    return '';
  }
}

async function gitSucceeds(repositoryRoot, args) {
  try {
    await git(repositoryRoot, args);
    return true;
  } catch {
    return false;
  }
}

function validateAdapterConfiguration({ branch, expectedOriginUrls, remote, repositoryRoot }) {
  if (!isAbsolute(repositoryRoot)) {
    throw configurationError('The local media repository must use an absolute path.');
  }
  if (remote !== LOCAL_REMOTE || branch !== LOCAL_BRANCH) {
    throw configurationError('Local media uploads are restricted to origin/main.');
  }
  if (!(expectedOriginUrls instanceof Set) || expectedOriginUrls.size === 0) {
    throw configurationError('The allowed local media origin repository is not configured.');
  }
}

async function inspectRepository({ branch, expectedOriginUrls, remote, repositoryRoot }) {
  let canonicalRoot;
  let gitRoot;
  let currentBranch;
  let remoteFetchUrl;
  let remotePushUrl;
  try {
    canonicalRoot = await realpath(repositoryRoot);
    [gitRoot, currentBranch, remoteFetchUrl, remotePushUrl] = await Promise.all([
      gitValue(canonicalRoot, ['rev-parse', '--show-toplevel']),
      gitValue(canonicalRoot, ['branch', '--show-current']),
      gitValue(canonicalRoot, ['remote', 'get-url', remote]),
      gitValue(canonicalRoot, ['remote', 'get-url', '--push', remote]),
    ]);
  } catch {
    throw configurationError('The local media repository or origin remote is unavailable.');
  }

  if (
    resolve(gitRoot) !== canonicalRoot
    || currentBranch !== branch
    || !expectedOriginUrls.has(remoteFetchUrl)
    || !expectedOriginUrls.has(remotePushUrl)
  ) {
    throw configurationError('Local media uploads require this repository on main with an origin remote.');
  }
  return canonicalRoot;
}

function assertRepositoryMediaPath(repositoryRoot, path) {
  if (
    typeof path !== 'string'
    || path.length > 600
    || !path.startsWith('public/portfolio/uploads/')
    || path.includes('..')
    || path.includes('\\')
    || path.includes('\0')
  ) {
    throw configurationError('The local media destination is outside the allowed upload directory.');
  }

  const absolutePath = resolve(repositoryRoot, path);
  const relativePath = relative(repositoryRoot, absolutePath);
  if (!relativePath || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw configurationError('The local media destination is outside the repository.');
  }
  return absolutePath;
}

function assertCanonicalUploadPath(repositoryRoot, { media, path, slug }) {
  if (!SLUG_PATTERN.test(slug) || !MEDIA_EXTENSIONS[media?.type]?.has(media?.extension)) {
    throw configurationError('The validated media metadata is not canonical.');
  }
  if (media.type === 'document' && slug !== 'profile') {
    throw configurationError('Local documents are restricted to the profile résumé.');
  }

  const filenamePattern = new RegExp(`^${media.type}-${UUID_PATTERN}\\.${media.extension}$`);
  const prefix = `public/portfolio/uploads/${slug}/`;
  if (!path.startsWith(prefix) || !filenamePattern.test(path.slice(prefix.length))) {
    throw configurationError('The local upload filename is not canonical.');
  }
  return assertRepositoryMediaPath(repositoryRoot, path);
}

async function ensureDirectoryChain(repositoryRoot, directory) {
  const relativeDirectory = relative(repositoryRoot, directory);
  if (relativeDirectory.startsWith('..') || isAbsolute(relativeDirectory)) {
    throw configurationError('The local media directory is outside the repository.');
  }

  let current = repositoryRoot;
  for (const segment of relativeDirectory.split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw configurationError('Local media directories cannot be symbolic links.');
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error?.code !== 'ENOENT') {
        throw configurationError('The local media directory could not be inspected.');
      }
      try {
        await mkdir(current, { mode: 0o755 });
      } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') {
          throw configurationError('The local media directory could not be created.');
        }
      }
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw configurationError('Local media directories cannot be symbolic links.');
      }
    }
  }
}

async function writeImmutableFile(absolutePath, bytes) {
  try {
    const metadata = await lstat(absolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw configurationError('The local upload destination is not a regular file.');
    }
    const existing = await readFile(absolutePath);
    if (
      existing.length !== bytes.length
      || !crypto.timingSafeEqual(existing, bytes)
    ) {
      throw new HttpError(409, 'upload_collision', 'The upload destination is already in use. Try again.');
    }
    return false;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error?.code !== 'ENOENT') {
      throw configurationError('The local upload destination could not be inspected.');
    }
  }

  let handle;
  try {
    handle = await open(
      absolutePath,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_NOFOLLOW,
      0o644,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return writeImmutableFile(absolutePath, bytes);
    throw configurationError('The media file could not be written locally.');
  } finally {
    await handle?.close();
  }
}

function blobSha(bytes) {
  return crypto.createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

async function remoteHead(repositoryRoot, remote, branch) {
  let output;
  try {
    output = await gitValue(repositoryRoot, [
      'ls-remote',
      '--exit-code',
      remote,
      `refs/heads/${branch}`,
    ]);
  } catch {
    throw gitFailure('local_git_remote_unavailable', 'The GitHub origin could not be reached. Try again.');
  }
  const match = output.match(/^([0-9a-f]{40})\s+refs\/heads\/main$/);
  if (!match) {
    throw gitFailure('local_git_remote_unavailable', 'The origin/main branch could not be verified.');
  }
  return match[1];
}

async function ensureRemoteCommitAvailable(repositoryRoot, remote, branch, commit) {
  if (await gitSucceeds(repositoryRoot, ['cat-file', '-e', `${commit}^{commit}`])) {
    return;
  }
  try {
    await git(repositoryRoot, ['fetch', '--quiet', '--no-tags', remote, `refs/heads/${branch}`]);
  } catch {
    throw gitFailure('local_git_remote_unavailable', 'The origin/main branch could not be read. Try again.');
  }
}

async function assertOnlyUploadCommitsAreAhead({
  branch,
  expectedBlobSha,
  path,
  remote,
  repositoryRoot,
}) {
  const localHead = await gitValue(repositoryRoot, ['rev-parse', '--verify', 'HEAD']);
  const publishedHead = await remoteHead(repositoryRoot, remote, branch);
  if (localHead === publishedHead) return;

  await ensureRemoteCommitAvailable(repositoryRoot, remote, branch, publishedHead);
  if (!await gitSucceeds(repositoryRoot, ['merge-base', '--is-ancestor', publishedHead, localHead])) {
    throw gitFailure(
      'local_git_sync_required',
      'Local main is not based on origin/main. Sync the repository before uploading media.',
    );
  }

  const unpublishedCommits = (await gitValue(repositoryRoot, [
    'rev-list',
    '--reverse',
    `${publishedHead}..${localHead}`,
  ])).split('\n').filter(Boolean);
  for (const commit of unpublishedCommits) {
    const committedPaths = (await gitValue(repositoryRoot, [
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      commit,
    ])).split('\n').filter(Boolean);
    if (committedPaths.length !== 1 || committedPaths[0] !== path) {
      throw gitFailure(
        'local_git_unpublished_changes',
        'Local main has unpublished commits unrelated to this media file. Push or reconcile them first.',
      );
    }
  }

  const localBlobSha = await optionalGitValue(repositoryRoot, [
    'rev-parse',
    '--verify',
    `${localHead}:${path}`,
  ]);
  if (localBlobSha !== expectedBlobSha) {
    throw gitFailure(
      'local_git_unpublished_changes',
      'The unpublished media commit does not match this upload. Reconcile local main first.',
    );
  }
}

export function createLocalGitMediaStorage({
  branch = LOCAL_BRANCH,
  expectedOriginUrls = PORTFOLIO_ORIGIN_URLS,
  remote = LOCAL_REMOTE,
  repositoryRoot,
}) {
  const allowedOriginUrls = expectedOriginUrls instanceof Set
    ? new Set(expectedOriginUrls)
    : new Set(expectedOriginUrls || []);
  validateAdapterConfiguration({
    branch,
    expectedOriginUrls: allowedOriginUrls,
    remote,
    repositoryRoot,
  });
  let operationQueue = Promise.resolve();

  const enqueue = (operation) => {
    const result = operationQueue.then(operation);
    operationQueue = result.catch(() => {});
    return result;
  };

  const commitUniqueMedia = (upload) => enqueue(async () => {
    const root = await inspectRepository({
      branch,
      expectedOriginUrls: allowedOriginUrls,
      remote,
      repositoryRoot,
    });
    const absolutePath = assertCanonicalUploadPath(root, upload);
    const expectedBlobSha = blobSha(upload.bytes);
    await assertOnlyUploadCommitsAreAhead({
      branch,
      expectedBlobSha,
      path: upload.path,
      remote,
      repositoryRoot: root,
    });
    await ensureDirectoryChain(root, dirname(absolutePath));
    await writeImmutableFile(absolutePath, upload.bytes);

    const committedBlobSha = await optionalGitValue(root, [
      'rev-parse',
      '--verify',
      `HEAD:${upload.path}`,
    ]);
    if (committedBlobSha && committedBlobSha !== expectedBlobSha) {
      throw new HttpError(409, 'upload_collision', 'The upload destination is already committed with different contents.');
    }

    if (!committedBlobSha) {
      try {
        await git(root, ['add', '--', upload.path]);
        await git(root, [
          'commit',
          '--only',
          '--no-verify',
          '-m',
          `Add ${upload.media.type} media for ${upload.slug}`,
          '--',
          upload.path,
        ]);
      } catch {
        try {
          await git(root, ['reset', '--quiet', '--', upload.path]);
        } catch {
          // The original commit error remains the useful failure for the owner.
        }
        throw gitFailure('local_git_commit_failed', 'The media file was saved, but its Git commit failed. Try again.');
      }

      const committedPaths = (await gitValue(root, [
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        'HEAD',
      ])).split('\n').filter(Boolean);
      if (committedPaths.length !== 1 || committedPaths[0] !== upload.path) {
        throw configurationError('The local media commit included an unexpected path.');
      }
      const verifiedBlobSha = await optionalGitValue(root, [
        'rev-parse',
        '--verify',
        `HEAD:${upload.path}`,
      ]);
      if (verifiedBlobSha !== expectedBlobSha) {
        throw configurationError('The local media commit did not contain the expected file.');
      }
    }

    try {
      await git(root, ['push', '--porcelain', remote, `HEAD:refs/heads/${branch}`]);
    } catch {
      throw gitFailure(
        'local_git_push_failed',
        'The media file is committed locally, but GitHub rejected the push. Fix the Git connection and try again.',
      );
    }

    const pushedHead = await remoteHead(root, remote, branch);
    await ensureRemoteCommitAvailable(root, remote, branch, pushedHead);
    const remoteBlobSha = await optionalGitValue(root, [
      'rev-parse',
      '--verify',
      `${pushedHead}:${upload.path}`,
    ]);
    if (remoteBlobSha !== expectedBlobSha) {
      throw gitFailure('local_git_push_unverified', 'The media file could not be verified on origin/main. Try again.');
    }
    return { sha: expectedBlobSha };
  });

  const findCommittedMedia = (path) => enqueue(async () => {
    const root = await inspectRepository({
      branch,
      expectedOriginUrls: allowedOriginUrls,
      remote,
      repositoryRoot,
    });
    assertRepositoryMediaPath(root, path);
    const commit = await remoteHead(root, remote, branch);
    await ensureRemoteCommitAvailable(root, remote, branch, commit);
    const sha = await optionalGitValue(root, ['rev-parse', '--verify', `${commit}:${path}`]);
    return sha ? { sha, type: 'file' } : null;
  });

  return { commitUniqueMedia, findCommittedMedia };
}

export function createLocalMediaStatusStorage({
  logger = (message) => console.warn(message),
  now = () => Date.now(),
  storage,
} = {}) {
  if (
    typeof logger !== 'function'
    || typeof now !== 'function'
    || typeof storage?.commitUniqueMedia !== 'function'
    || typeof storage?.findCommittedMedia !== 'function'
  ) {
    throw configurationError('The local media status storage is not configured safely.');
  }
  let unavailableUntil = 0;

  return {
    commitUniqueMedia: (...args) => storage.commitUniqueMedia(...args),
    async findCommittedMedia(path) {
      if (now() < unavailableUntil) return null;
      try {
        const file = await storage.findCommittedMedia(path);
        unavailableUntil = 0;
        return file;
      } catch (error) {
        if (!(error instanceof HttpError) || error.code !== 'local_git_remote_unavailable') {
          throw error;
        }
        unavailableUntil = now() + LOCAL_CAPTURE_STATUS_COOLDOWN_MS;
        logger('Local media origin status is temporarily unavailable: local_git_remote_unavailable');
        return null;
      }
    },
  };
}

export function ownerIdentityFromRules(rules) {
  const ownerFunction = String(rules || '').match(
    /function\s+isOwner\s*\(\s*\)\s*\{([\s\S]*?)\n\s*\}/,
  )?.[1] || '';
  const uidMatches = [...ownerFunction.matchAll(/request\.auth\.uid\s*==\s*'([A-Za-z0-9_-]{1,128})'/g)];
  const emailMatches = [...ownerFunction.matchAll(/request\.auth\.token\.email\s*==\s*'([^'\r\n]{3,254})'/g)];
  if (uidMatches.length !== 1 || emailMatches.length !== 1) {
    throw configurationError('The owner identity could not be read uniquely from Firestore rules.');
  }
  return { ownerEmail: emailMatches[0][1].toLowerCase(), ownerUid: uidMatches[0][1] };
}

function validateFirebaseOwner({ ownerEmail, ownerUid, projectId, rulesIdentity }) {
  if (
    !/^[a-z][a-z0-9-]{4,29}$/.test(projectId)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(ownerUid)
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)
  ) {
    throw configurationError('The local Firebase owner configuration is incomplete.');
  }
  if (
    rulesIdentity.ownerUid !== ownerUid
    || rulesIdentity.ownerEmail !== ownerEmail.toLowerCase()
  ) {
    throw configurationError('The local Firebase owner must match the pinned Firestore rules.');
  }
}

export function validatePublicOrigin(value) {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:'
      || parsed.origin !== value
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) throw new Error('invalid');
    return parsed.origin;
  } catch {
    throw configurationError('Set the production portfolio homepage to an HTTPS origin.');
  }
}

function localAllowedOrigins(request) {
  const port = Number(request.socket?.localPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
}

function readRequestBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let length = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (tooLarge) return;
      if (length > MAX_OWNER_MEDIA_REQUEST_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      resolveBody(tooLarge
        ? Buffer.alloc(MAX_OWNER_MEDIA_REQUEST_BYTES + 1)
        : Buffer.concat(chunks, length));
    });
    request.on('aborted', () => reject(new Error('Request aborted.')));
    request.on('error', reject);
  });
}

function sendResponse(response, result) {
  response.statusCode = result.statusCode;
  Object.entries(result.headers || {}).forEach(([name, value]) => response.setHeader(name, value));
  response.end(result.body || '');
}

export function createLocalOwnerMediaPlugin({ env, publicOrigin, repositoryRoot, rules }) {
  let runtime;
  let configurationIssue;
  try {
    const rulesIdentity = ownerIdentityFromRules(rules);
    const firebaseOwner = {
      ownerEmail: String(env.VITE_FIREBASE_OWNER_EMAIL || '').trim().toLowerCase(),
      ownerUid: String(env.FIREBASE_OWNER_UID || rulesIdentity.ownerUid).trim(),
      projectId: String(env.VITE_FIREBASE_PROJECT_ID || '').trim(),
      signInProvider: String(env.FIREBASE_OWNER_SIGN_IN_PROVIDER || 'password').trim(),
    };
    validateFirebaseOwner({ ...firebaseOwner, rulesIdentity });
    const mediaStorage = createLocalGitMediaStorage({ repositoryRoot });
    runtime = {
      captureDispatcher: createLocalCaptureDispatcher(),
      captureStatusProvider: createLocalCaptureStatusMonitor(),
      firebaseOwner,
      mediaStorage: createLocalMediaStatusStorage({ storage: mediaStorage }),
      publicMediaOrigin: validatePublicOrigin(publicOrigin),
    };
  } catch (error) {
    configurationIssue = error instanceof HttpError
      ? error
      : configurationError();
  }

  return {
    name: 'local-owner-media-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        let pathname;
        try {
          pathname = new URL(request.url || '/', 'http://local.invalid').pathname;
        } catch {
          next();
          return;
        }
        const endpoint = API_ENDPOINTS.get(pathname);
        if (!endpoint) {
          next();
          return;
        }

        try {
          const body = request.method === 'POST' ? await readRequestBody(request) : null;
          if (configurationIssue) throw configurationIssue;
          const result = await handleOwnerMediaRequest({
            body,
            headers: request.headers,
            method: String(request.method || '').toUpperCase(),
          }, endpoint, {
            ...runtime,
            allowedOrigins: localAllowedOrigins(request),
          });
          sendResponse(response, result);
        } catch (error) {
          const handled = error instanceof HttpError
            ? error
            : new HttpError(500, 'local_media_error', 'The local media request could not be completed.');
          sendResponse(response, {
            statusCode: handled.statusCode,
            headers: {
              'Cache-Control': 'no-store',
              'Content-Type': 'application/json; charset=utf-8',
              'X-Content-Type-Options': 'nosniff',
            },
            body: JSON.stringify({ error: { code: handled.code, message: handled.message } }),
          });
          server.config.logger.error(`Local media API: ${handled.code}`);
        }
      });
    },
  };
}
