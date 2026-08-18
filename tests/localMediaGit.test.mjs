import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createLocalGitMediaStorage,
  ownerIdentityFromRules,
} from '../dev/local-media-plugin.mjs';

function runGit(repository, args) {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function upload(path, bytes = Buffer.from('validated image bytes')) {
  return {
    bytes,
    media: { extension: 'png', mimeType: 'image/png', type: 'image' },
    path,
    slug: 'demo-project',
  };
}

const fixtureRoot = mkdtempSync(join(tmpdir(), 'portfolio-local-media-'));
const remoteRepository = join(fixtureRoot, 'remote.git');
const workRepository = join(fixtureRoot, 'work');

try {
  mkdirSync(workRepository);
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remoteRepository], { stdio: 'ignore' });
  execFileSync('git', ['init', '--initial-branch=main', workRepository], { stdio: 'ignore' });
  runGit(workRepository, ['config', 'user.name', 'Local Media Test']);
  runGit(workRepository, ['config', 'user.email', 'local-media@example.com']);
  writeFileSync(join(workRepository, 'seed.txt'), 'seed\n');
  writeFileSync(join(workRepository, 'dirty.txt'), 'clean\n');
  writeFileSync(join(workRepository, 'staged.txt'), 'clean\n');
  runGit(workRepository, ['add', 'seed.txt', 'dirty.txt', 'staged.txt']);
  runGit(workRepository, ['commit', '-m', 'Initial fixture']);
  runGit(workRepository, ['remote', 'add', 'origin', remoteRepository]);
  runGit(workRepository, ['push', '-u', 'origin', 'main']);

  writeFileSync(join(workRepository, 'dirty.txt'), 'dirty local change\n');
  writeFileSync(join(workRepository, 'staged.txt'), 'staged local change\n');
  runGit(workRepository, ['add', 'staged.txt']);

  const storage = createLocalGitMediaStorage({
    expectedOriginUrls: new Set([remoteRepository]),
    repositoryRoot: workRepository,
  });
  const requestId = '123e4567-e89b-42d3-a456-426614174000';
  const path = `public/portfolio/uploads/demo-project/image-${requestId}.png`;
  const bytes = Buffer.from('validated image bytes');
  const committed = await storage.commitUniqueMedia(upload(path, bytes));
  assert.match(committed.sha, /^[0-9a-f]{40}$/);
  assert.equal(runGit(workRepository, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']), path);
  assert.equal(runGit(workRepository, ['diff', '--cached', '--name-only']), 'staged.txt');
  assert.equal(runGit(workRepository, ['diff', '--name-only']), 'dirty.txt');
  assert.deepEqual(
    execFileSync('git', ['--git-dir', remoteRepository, 'show', `main:${path}`]),
    bytes,
  );

  const firstHead = runGit(workRepository, ['rev-parse', 'HEAD']);
  const retried = await storage.commitUniqueMedia(upload(path, bytes));
  assert.equal(retried.sha, committed.sha);
  assert.equal(runGit(workRepository, ['rev-parse', 'HEAD']), firstHead);
  await assert.rejects(
    storage.commitUniqueMedia(upload(path, Buffer.from('different validated bytes'))),
    (error) => error.statusCode === 409 && error.code === 'upload_collision',
  );

  await assert.rejects(
    storage.commitUniqueMedia(upload(`public/portfolio/uploads/demo-project/../image-${requestId}.png`)),
    (error) => error.statusCode === 500 && error.code === 'local_media_not_configured',
  );
  assert.throws(
    () => createLocalGitMediaStorage({
      branch: 'feature',
      expectedOriginUrls: new Set([remoteRepository]),
      repositoryRoot: workRepository,
    }),
    (error) => error.statusCode === 500 && error.code === 'local_media_not_configured',
  );
  assert.throws(
    () => createLocalGitMediaStorage({
      expectedOriginUrls: new Set([remoteRepository]),
      remote: 'upstream',
      repositoryRoot: workRepository,
    }),
    (error) => error.statusCode === 500 && error.code === 'local_media_not_configured',
  );
  const wrongOriginStorage = createLocalGitMediaStorage({
    expectedOriginUrls: new Set(['/not/the/configured/origin.git']),
    repositoryRoot: workRepository,
  });
  await assert.rejects(
    wrongOriginStorage.findCommittedMedia(path),
    (error) => error.statusCode === 500 && error.code === 'local_media_not_configured',
  );
  runGit(workRepository, ['remote', 'set-url', '--push', 'origin', '/not/the/configured/push-origin.git']);
  await assert.rejects(
    storage.findCommittedMedia(path),
    (error) => error.statusCode === 500 && error.code === 'local_media_not_configured',
  );
  runGit(workRepository, ['remote', 'set-url', '--push', 'origin', remoteRepository]);

  const outsideDirectory = join(fixtureRoot, 'outside');
  mkdirSync(outsideDirectory);
  const symlinkSlug = join(workRepository, 'public', 'portfolio', 'uploads', 'linked-project');
  mkdirSync(join(workRepository, 'public', 'portfolio', 'uploads'), { recursive: true });
  symlinkSync(outsideDirectory, symlinkSlug, 'dir');
  await assert.rejects(
    storage.commitUniqueMedia({
      ...upload(`public/portfolio/uploads/linked-project/image-${requestId}.png`),
      slug: 'linked-project',
    }),
    (error) => error.statusCode === 500 && error.code === 'local_media_not_configured',
  );
  assert.equal(readFileSync(join(workRepository, 'staged.txt'), 'utf8'), 'staged local change\n');

  const commitFailureRequestId = '13b94e9b-6be8-49a5-8ed2-08b82332fdc4';
  const commitFailurePath = `public/portfolio/uploads/demo-project/image-${commitFailureRequestId}.png`;
  runGit(workRepository, ['config', 'user.name', '']);
  await assert.rejects(
    storage.commitUniqueMedia(upload(commitFailurePath)),
    (error) => error.statusCode === 503 && error.code === 'local_git_commit_failed',
  );
  assert.equal(
    runGit(workRepository, ['diff', '--cached', '--name-only']).split('\n').includes(commitFailurePath),
    false,
  );
  assert.equal(runGit(workRepository, ['diff', '--cached', '--name-only']), 'staged.txt');
  runGit(workRepository, ['config', 'user.name', 'Local Media Test']);

  const rejectingHook = join(remoteRepository, 'hooks', 'pre-receive');
  writeFileSync(rejectingHook, '#!/bin/sh\nexit 1\n');
  chmodSync(rejectingHook, 0o755);
  const retryRequestId = '628d26fa-2796-4eb8-9c06-51b9a77dd2c1';
  const retryPath = `public/portfolio/uploads/demo-project/image-${retryRequestId}.png`;
  await assert.rejects(
    storage.commitUniqueMedia(upload(retryPath)),
    (error) => error.statusCode === 503 && error.code === 'local_git_push_failed',
  );
  const failedPushHead = runGit(workRepository, ['rev-parse', 'HEAD']);
  rmSync(rejectingHook);
  await storage.commitUniqueMedia(upload(retryPath));
  assert.equal(runGit(workRepository, ['rev-parse', 'HEAD']), failedPushHead);
  assert.equal(
    runGit(remoteRepository, ['rev-parse', `main:${retryPath}`]),
    runGit(workRepository, ['rev-parse', `HEAD:${retryPath}`]),
  );

  const found = await storage.findCommittedMedia(retryPath);
  assert.deepEqual(found, {
    sha: runGit(workRepository, ['rev-parse', `HEAD:${retryPath}`]),
    type: 'file',
  });
  await assert.rejects(
    storage.findCommittedMedia('../outside.png'),
    (error) => error.statusCode === 500 && error.code === 'local_media_not_configured',
  );

  runGit(workRepository, ['commit', '--only', '-m', 'Unpublished unrelated commit', '--', 'staged.txt']);
  const blockedRequestId = '371d6366-d388-4663-aa9c-40ff38ef00ac';
  const blockedPath = `public/portfolio/uploads/demo-project/image-${blockedRequestId}.png`;
  await assert.rejects(
    storage.commitUniqueMedia(upload(blockedPath)),
    (error) => error.statusCode === 503 && error.code === 'local_git_unpublished_changes',
  );
  assert.equal(existsSync(join(workRepository, blockedPath)), false);

  const rules = readFileSync(new URL('../firebase/firestore.rules', import.meta.url), 'utf8');
  assert.deepEqual(ownerIdentityFromRules(rules), {
    ownerEmail: 's.bao2115@gmail.com',
    ownerUid: 'BCjFGLXYssQCINHvA0itGYgCfmI3',
  });
  assert.throws(
    () => ownerIdentityFromRules("function isOwner() { return request.auth != null; }"),
    (error) => error.code === 'local_media_not_configured',
  );

  console.log('Local Git media adapter tests passed.');
} finally {
  rmSync(fixtureRoot, { force: true, recursive: true });
}
