import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';
import {
  deleteTimelineEntryContent,
  deleteProjectContent,
  OWNER_EMAIL,
  restoreOwnerSession,
  saveProfileContent,
  saveProjectContent,
  saveTimelineEntryContent,
  sendOwnerPasswordReset,
  signInOwner,
  signOutOwner,
  slugifyProjectTitle,
  slugifyTimelineTitle,
} from '../lib/contentApi';
import { timelineKindOptions, timelineSources } from '../data/timeline';
import {
  clearPendingCapture,
  createPendingCapture,
  loadLatestPendingCapture,
  loadPendingCapture,
  savePendingCapture,
} from '../lib/pendingCapture';

const MAX_MEDIA_ITEMS = 12;
const MAX_UPLOAD_BYTES = 3 * 1024 * 1024;
const MEDIA_STATUS_POLL_INTERVAL_MS = 5000;
const MEDIA_STATUS_TIMEOUT_MS = 20 * 60 * 1000;
const CAPTURE_STATUS_TIMEOUT_MS = 40 * 60 * 1000;
const FALLBACK_THUMBNAIL = '/portfolio/posters/sydney-ai-assistant.webp';
const TIMELINE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TIMELINE_MONTH_PATTERN = /^(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])$/;
const TIMELINE_MAX_HIGHLIGHTS = 12;
const TIMELINE_MAX_HIGHLIGHT_LENGTH = 240;
const TIMELINE_MAX_YEARS = 25;
const TIMELINE_KINDS = new Set(
  timelineKindOptions.filter(({ id }) => id !== 'all').map(({ id }) => id),
);
const MEDIA_ENDPOINTS = {
  upload: ['/api/media-upload', '/.netlify/functions/media-upload'],
  capture: ['/api/capture-project', '/.netlify/functions/capture-project'],
  status: ['/api/media-status', '/.netlify/functions/media-status'],
};
let mediaRowSequence = 0;

function linesToList(value) {
  return value.split(/\n|,/).map((item) => item.trim()).filter(Boolean);
}

function linksToText(links = []) {
  return links.map((link) => `${link.label} | ${link.url}`).join('\n');
}

function textToLinks(value) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [label, ...urlParts] = line.split('|');
      const url = urlParts.join('|').trim();
      return { label: label.trim() || 'Visit project', url };
    })
    .filter((link) => /^https?:\/\//i.test(link.url));
}

function inferMediaType(url = '', explicitType = '') {
  const typeHint = String(explicitType).toLowerCase();
  if (typeHint === 'video' || typeHint.startsWith('video/')) return 'video';
  return /\.(?:mp4|mov|m4v|webm|ogv)(?:$|[?#])/i.test(url) ? 'video' : 'image';
}

function withMediaRowKey(item) {
  mediaRowSequence += 1;
  return { ...item, clientKey: `media-row-${mediaRowSequence}` };
}

function allowedMediaUrl(url) {
  return /^https:\/\//i.test(url) || url.startsWith('/portfolio/');
}

function imageThumbnail(thumbnail, mediaItems) {
  const value = String(thumbnail || '').trim();
  const matchingItem = mediaItems.find((item) => item.url === value);
  const safeValue = value
    && matchingItem?.type !== 'video'
    && inferMediaType(value) !== 'video'
    ? value
    : '';
  return safeValue || mediaItems.find(({ type }) => type === 'image')?.url || FALLBACK_THUMBNAIL;
}

function normalizeMediaItem(item, fallbackAlt = '') {
  const value = typeof item === 'string' ? { url: item } : item;
  const url = String(
    value?.publicUrl
      || value?.url
      || value?.secure_url
      || value?.downloadUrl
      || value?.src
      || value?.path
      || value?.screenshotUrl
      || '',
  ).trim();
  if (!url) return null;

  return {
    url,
    alt: String(value.alt || value.description || fallbackAlt).trim(),
    type: inferMediaType(url, value.type || value.kind || value.mimeType || value.resource_type),
  };
}

function normalizeProjectMedia(project) {
  const fallbackAlt = project?.alt || `${project?.title || 'Project'} preview`;
  const mediaItems = (Array.isArray(project?.mediaItems) ? project.mediaItems : [])
    .map((item) => normalizeMediaItem(item, fallbackAlt))
    .filter(Boolean)
    .map(withMediaRowKey);

  if (mediaItems.length > 0) return mediaItems;
  return [project?.thumbnail, project?.media]
    .filter((url, index, urls) => url && urls.indexOf(url) === index)
    .map((url) => withMediaRowKey(normalizeMediaItem(url, fallbackAlt)));
}

function mediaItemsFromResponse(payload, fallbackAlt) {
  const value = payload?.data || payload;
  let candidates;

  if (Array.isArray(value)) candidates = value;
  else if (Array.isArray(value?.mediaItems)) candidates = value.mediaItems;
  else if (Array.isArray(value?.items)) candidates = value.items;
  else if (Array.isArray(value?.assets)) candidates = value.assets;
  else if (Array.isArray(value?.files)) candidates = value.files;
  else if (Array.isArray(value?.media)) candidates = value.media;
  else if (value?.cover || value?.walkthrough) candidates = [value.cover, value.walkthrough].filter(Boolean);
  else if (value?.coverPath || value?.coverUrl || value?.walkthroughPath || value?.walkthroughUrl) {
    candidates = [
      {
        path: value.coverUrl || value.coverPath,
        alt: `${fallbackAlt} cover`,
        type: 'image',
      },
      {
        path: value.walkthroughUrl || value.walkthroughPath,
        alt: `${fallbackAlt} walkthrough`,
        type: value.walkthroughType,
      },
    ].filter(({ path }) => path);
  } else candidates = [value];

  return candidates
    .map((item) => normalizeMediaItem(item, fallbackAlt))
    .filter(Boolean);
}

function uploadedPublicUrl(payload) {
  const value = payload?.data || payload;
  return String(
    value?.publicUrl
      || value?.media?.url
      || value?.mediaItems?.[0]?.url
      || '',
  ).trim();
}

async function readMediaResponse(response) {
  const rawBody = await response.text();
  let payload = {};

  if (rawBody) {
    try {
      payload = JSON.parse(rawBody);
    } catch {
      if (!response.ok) {
        const error = new Error(rawBody);
        error.status = response.status;
        throw error;
      }
      if (/^\s*<!doctype html|^\s*<html/i.test(rawBody)) {
        throw new Error('The media API is not available. Restart the local dev server or redeploy the site functions, then try again.');
      }
      throw new Error('The media service returned an invalid response.');
    }
  }

  if (!response.ok) {
    const error = new Error(
      payload?.error?.message || payload?.error || payload?.message || 'Media request failed.',
    );
    error.status = response.status;
    error.code = payload?.error?.code || payload?.code || '';
    throw error;
  }
  return payload;
}

async function requestOwnerMedia(action, options) {
  const endpoints = MEDIA_ENDPOINTS[action];

  for (let index = 0; index < endpoints.length; index += 1) {
    const response = await fetch(endpoints[index], options);
    if (response.status === 404 && index < endpoints.length - 1) continue;
    return { payload: await readMediaResponse(response), status: response.status };
  }

  throw new Error('The media service is not available.');
}

function isTransientMediaError(error) {
  if (error?.name === 'AbortError') return false;
  if (Number(error?.status) >= 500) return true;
  return error instanceof TypeError;
}

async function requestOwnerUpload(options) {
  try {
    return await requestOwnerMedia('upload', options);
  } catch (error) {
    if (!isTransientMediaError(error)) throw error;
    await waitForPoll(500, options.signal);
    return requestOwnerMedia('upload', options);
  }
}

function createRequestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('This browser cannot create a secure upload request. Update it and try again.');
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function captureStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function abortError() {
  const error = new Error('The media operation was cancelled.');
  error.name = 'AbortError';
  return error;
}

function waitForPoll(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }

    const handleAbort = () => {
      window.clearTimeout(timeout);
      reject(abortError());
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

async function waitForMediaReadiness({
  idToken,
  onPending,
  paths,
  signal,
  slug,
  timeoutMessage = 'Deployment is taking longer than twenty minutes. The media was not added to this draft yet; try again after the current deployment finishes.',
  timeoutMs = MEDIA_STATUS_TIMEOUT_MS,
}) {
  const uniquePaths = [...new Set(paths)];
  if (uniquePaths.length === 0 || uniquePaths.some((path) => !path.startsWith(`/portfolio/uploads/${slug}/`))) {
    throw new Error('The media service returned an unexpected deployment path.');
  }

  const pollController = new AbortController();
  const handleAbort = () => pollController.abort();
  if (signal.aborted) handleAbort();
  else signal.addEventListener('abort', handleAbort, { once: true });
  const deadline = Date.now() + timeoutMs;
  const deadlineTimer = window.setTimeout(() => pollController.abort(), timeoutMs);
  try {
    while (Date.now() < deadline) {
      if (pollController.signal.aborted) throw abortError();
      let response;
      try {
        response = await requestOwnerMedia('status', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${idToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ slug, paths: uniquePaths }),
          signal: pollController.signal,
        });
      } catch (error) {
        if (!isTransientMediaError(error)) throw error;
        onPending?.({ checkingAgain: true });
        const remaining = deadline - Date.now();
        if (remaining > 0) {
          await waitForPoll(
            Math.min(MEDIA_STATUS_POLL_INTERVAL_MS, remaining),
            pollController.signal,
          );
        }
        continue;
      }
      const { payload, status } = response;

      if (status === 200 && payload?.ready === true) return payload;
      if (status !== 202 || payload?.ready !== false) {
        throw new Error('The media service returned an unexpected deployment status.');
      }
      onPending?.(payload);

      const remaining = deadline - Date.now();
      if (remaining > 0) {
        await waitForPoll(
          Math.min(MEDIA_STATUS_POLL_INTERVAL_MS, remaining),
          pollController.signal,
        );
      }
    }
  } catch (error) {
    if (!signal.aborted && pollController.signal.aborted) {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    window.clearTimeout(deadlineTimer);
    signal.removeEventListener('abort', handleAbort);
  }

  throw new Error(timeoutMessage);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const [, base64 = ''] = String(reader.result || '').split(',', 2);
      resolve(base64);
    });
    reader.addEventListener('error', () => reject(new Error(`Could not read ${file.name}.`)));
    reader.readAsDataURL(file);
  });
}

function profileToDraft(profile) {
  return {
    displayName: String(profile?.displayName || ''),
    handle: String(profile?.handle || ''),
    pronouns: String(profile?.pronouns || ''),
    bio: String(profile?.bio || ''),
    linkedinLabel: String(profile?.linkedinLabel || ''),
    linkedinUrl: String(profile?.linkedinUrl || ''),
    resumeUrl: String(profile?.resumeUrl || ''),
  };
}

function profileSavePayload(draft, resumeUrl = draft.resumeUrl) {
  return {
    displayName: draft.displayName.trim(),
    handle: draft.handle.trim(),
    pronouns: draft.pronouns.trim(),
    bio: draft.bio.trim(),
    linkedinLabel: draft.linkedinLabel.trim(),
    linkedinUrl: draft.linkedinUrl.trim(),
    resumeUrl: String(resumeUrl || '').trim(),
  };
}

function projectToDraft(project, fallbackOrder = 0) {
  const mediaItems = normalizeProjectMedia(project);
  return {
    slug: project?.slug || '',
    title: project?.title || '',
    eyebrow: project?.eyebrow || '',
    role: project?.role || '',
    caption: project?.caption || '',
    thumbnail: imageThumbnail(project?.thumbnail, mediaItems),
    media: project?.media || '',
    mediaItems,
    alt: project?.alt || '',
    categories: (project?.categories || ['web']).join(', '),
    tech: (project?.tech || []).join(', '),
    highlights: (project?.highlights || []).join('\n'),
    links: linksToText(project?.links),
    accent: project?.accent || '#138c84',
    order: project?.order ?? fallbackOrder,
  };
}

function timelineToDraft(entry) {
  const kind = String(entry?.kind || 'work');
  return {
    id: String(entry?.id || ''),
    kind,
    title: String(entry?.title || ''),
    organization: String(entry?.organization || ''),
    dateLabel: String(entry?.dateLabel || ''),
    startDate: String(entry?.startDate || ''),
    sortDate: String(entry?.sortDate || entry?.startDate || ''),
    years: (Array.isArray(entry?.years) ? entry.years : []).join(', '),
    description: String(entry?.description || ''),
    highlights: (Array.isArray(entry?.highlights) ? entry.highlights : []).join('\n'),
    relatedProjectSlug: String(entry?.relatedProjectSlug || ''),
    externalUrl: String(entry?.externalUrl || ''),
    externalLabel: String(entry?.externalLabel || ''),
    sourceUrl: String(entry?.sourceUrl || timelineSources[kind] || ''),
  };
}

function timelineHighlights(value) {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function timelineYears(value) {
  const tokens = value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (tokens.some((item) => !/^\d{4}$/.test(item))) return null;
  const years = [...new Set(tokens.map(Number))].sort((left, right) => left - right);
  if (years.some((year) => year < 1900 || year > 2100)) return null;
  return years;
}

function isSafeTimelineUrl(value) {
  if (!value) return true;
  if (value.length > 1000) return false;
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

function SignInForm({ onSignedIn }) {
  const [email, setEmail] = useState(OWNER_EMAIL);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const session = await signInOwner(email, password);
      setPassword('');
      onSignedIn(session);
    } catch (requestError) {
      setError(requestError.message || 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await sendOwnerPasswordReset(email);
      setNotice('Password reset email sent.');
    } catch (requestError) {
      setError(requestError.message || 'The reset email could not be sent.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-signin">
      <span className="admin-signin-icon"><Icon name="user" size={28} /></span>
      <p className="admin-eyebrow">Owner access</p>
      <h2>Sign in to edit</h2>
      <p className="admin-intro">Update your bio and publish projects without touching the codebase.</p>

      <form onSubmit={handleSubmit}>
        <label htmlFor="owner-email">Email</label>
        <input
          autoComplete="username"
          id="owner-email"
          onChange={(event) => setEmail(event.target.value)}
          type="email"
          value={email}
        />
        <label htmlFor="owner-password">Password</label>
        <input
          autoComplete="current-password"
          id="owner-password"
          onChange={(event) => setPassword(event.target.value)}
          type="password"
          value={password}
        />
        {error && <p className="admin-error" role="alert">{error}</p>}
        {notice && <p className="admin-notice" role="status">{notice}</p>}
        <button className="admin-primary" disabled={busy || !password} type="submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <button className="admin-text-button" disabled={busy} onClick={handleReset} type="button">
          Forgot password?
        </button>
      </form>
    </div>
  );
}

function ProfileEditor({ onBusyChange, profile, onSaved }) {
  const [draft, setDraft] = useState(() => profileToDraft(profile));
  const [busy, setBusy] = useState(false);
  const [resumeBusy, setResumeBusy] = useState('');
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);
  const resumeInputRef = useRef(null);
  const mountedRef = useRef(true);
  const operationControllerRef = useRef(null);
  const editorLocked = busy || Boolean(resumeBusy);

  useEffect(() => {
    onBusyChange(editorLocked);
  }, [editorLocked, onBusyChange]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationControllerRef.current?.abort();
      onBusyChange(false);
    };
  }, [onBusyChange]);

  useEffect(() => setDraft(profileToDraft(profile)), [profile]);

  const update = (field) => (event) => {
    setDraft((current) => ({ ...current, [field]: event.target.value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    onBusyChange(true);
    setBusy(true);
    setMessage('');
    setMessageIsError(false);
    try {
      await saveProfileContent(profileSavePayload(draft));
      await onSaved();
      if (mountedRef.current) setMessage('Profile saved.');
    } catch (error) {
      if (mountedRef.current) {
        setMessageIsError(true);
        setMessage(error.message || 'The profile could not be saved.');
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  };

  const handleResumeUpload = async (event) => {
    const [file] = [...(event.target.files || [])];
    if (resumeInputRef.current) resumeInputRef.current.value = '';
    if (!file) return;

    const hasPdfExtension = /\.pdf$/i.test(file.name);
    const hasPdfMime = !file.type || file.type.toLowerCase() === 'application/pdf';
    if (!hasPdfExtension || !hasPdfMime) {
      setMessageIsError(true);
      setMessage('Choose a PDF résumé file.');
      return;
    }
    if (file.size < 1) {
      setMessageIsError(true);
      setMessage('The selected PDF is empty.');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setMessageIsError(true);
      setMessage('The résumé PDF is larger than the 3 MB upload limit.');
      return;
    }

    const controller = new AbortController();
    operationControllerRef.current = controller;
    onBusyChange(true);
    setResumeBusy('upload');
    setMessageIsError(false);
    setMessage('Uploading résumé…');

    try {
      const freshSession = await restoreOwnerSession();
      if (!freshSession?.idToken) {
        throw new Error('Your owner session expired. Sign in again before uploading a résumé.');
      }

      const contentBase64 = await fileToBase64(file);
      const uploadOptions = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${freshSession.idToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          slug: 'profile',
          kind: 'document',
          contentBase64,
          requestId: createRequestId(),
        }),
        signal: controller.signal,
      };
      const { payload } = await requestOwnerUpload(uploadOptions);
      const resumeUrl = uploadedPublicUrl(payload);
      if (!/^\/portfolio\/uploads\/profile\/document-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/.test(resumeUrl)) {
        throw new Error('The media service returned an unexpected résumé path.');
      }

      if (mountedRef.current) {
        setResumeBusy('readiness');
        setMessage('Résumé committed. Waiting for the portfolio deployment…');
      }
      await waitForMediaReadiness({
        idToken: freshSession.idToken,
        paths: [resumeUrl],
        signal: controller.signal,
        slug: 'profile',
        timeoutMessage: 'Résumé deployment is taking longer than twenty minutes. It was not added to your profile; try again after the current deployment finishes.',
        onPending: (statusPayload) => {
          if (!mountedRef.current) return;
          setMessage(statusPayload?.checkingAgain
            ? 'The résumé deployment status is temporarily unavailable. Checking again…'
            : 'Résumé deployment in progress…');
        },
      });

      if (!mountedRef.current) return;
      setDraft((current) => ({ ...current, resumeUrl }));
      setResumeBusy('saving');
      setMessage('Résumé is live. Saving it to your profile…');
      await saveProfileContent(profileSavePayload(draft, resumeUrl));
      await onSaved();
      if (mountedRef.current) {
        setMessage('Résumé uploaded and profile saved.');
      }
    } catch (error) {
      if (mountedRef.current && error.name !== 'AbortError') {
        setMessageIsError(true);
        setMessage(error.message || 'The résumé could not be uploaded.');
      }
    } finally {
      if (operationControllerRef.current === controller) operationControllerRef.current = null;
      if (mountedRef.current) {
        setResumeBusy('');
        onBusyChange(false);
      }
    }
  };

  return (
    <form className="admin-form" onSubmit={handleSubmit}>
      <div className="admin-section-heading">
        <div>
          <p className="admin-eyebrow">Profile</p>
          <h3>Edit your bio</h3>
        </div>
        <span>Changes publish immediately</span>
      </div>

      <div className="admin-field-grid">
        <label>
          Display name
          <input disabled={editorLocked} maxLength="60" onChange={update('displayName')} required value={draft.displayName} />
        </label>
        <label>
          Pronouns
          <input disabled={editorLocked} maxLength="30" onChange={update('pronouns')} value={draft.pronouns} />
        </label>
      </div>
      <label>
        Handle
        <input disabled={editorLocked} maxLength="40" onChange={update('handle')} required value={draft.handle} />
      </label>
      <label>
        Bio
        <textarea disabled={editorLocked} maxLength="500" onChange={update('bio')} rows="5" required value={draft.bio} />
        <small>Use a new line to create another paragraph.</small>
      </label>
      <div className="admin-field-grid">
        <label>
          LinkedIn label
          <input disabled={editorLocked} maxLength="80" onChange={update('linkedinLabel')} value={draft.linkedinLabel} />
        </label>
        <label>
          LinkedIn URL
          <input disabled={editorLocked} onChange={update('linkedinUrl')} type="url" value={draft.linkedinUrl} />
        </label>
      </div>

      <section aria-labelledby="admin-resume-title" className="admin-resume-section">
        <div className="admin-resume-copy">
          <p className="admin-eyebrow">Document</p>
          <h4 id="admin-resume-title">Résumé PDF</h4>
          <p>Upload a PDF up to 3 MB. It is added to your profile only after the new file is live.</p>
          {draft.resumeUrl && (
            <a href={draft.resumeUrl} rel="noreferrer" target="_blank">View current résumé</a>
          )}
        </div>
        <div className="admin-resume-actions">
          <input
            accept=".pdf,application/pdf"
            className="admin-file-input"
            disabled={editorLocked}
            hidden
            onChange={handleResumeUpload}
            ref={resumeInputRef}
            type="file"
          />
          <button
            className="admin-secondary"
            disabled={editorLocked}
            onClick={() => resumeInputRef.current?.click()}
            type="button"
          >
            {resumeBusy === 'upload' && 'Uploading…'}
            {resumeBusy === 'readiness' && 'Deploying…'}
            {resumeBusy === 'saving' && 'Saving…'}
            {!resumeBusy && (draft.resumeUrl ? 'Replace résumé' : 'Upload résumé')}
          </button>
        </div>
      </section>

      {message && (
        <p className={messageIsError ? 'admin-error' : 'admin-save-message'} role={messageIsError ? 'alert' : 'status'}>
          {message}
        </p>
      )}
      <button className="admin-primary" disabled={editorLocked} type="submit">
        {busy ? 'Saving…' : 'Save profile'}
      </button>
    </form>
  );
}

function ProjectEditor({ onBusyChange, projects, onSaved }) {
  const [selectedSlug, setSelectedSlug] = useState(() => {
    const restoredCapture = loadLatestPendingCapture(captureStorage());
    if (!restoredCapture) return '__new__';
    return projects.some(({ slug }) => slug === restoredCapture.slug)
      ? restoredCapture.slug
      : '__new__';
  });
  const selectedProject = useMemo(
    () => projects.find(({ slug }) => slug === selectedSlug),
    [projects, selectedSlug],
  );
  const [draft, setDraft] = useState(() => projectToDraft(selectedProject, projects.length));
  const [busy, setBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState(null);
  const [mediaBusy, setMediaBusy] = useState('');
  const [message, setMessage] = useState('');
  const [captureUrl, setCaptureUrl] = useState('');
  const [pendingCapture, setPendingCapture] = useState(null);
  const fileInputRef = useRef(null);
  const deleteCancelRef = useRef(null);
  const mountedRef = useRef(true);
  const operationControllerRef = useRef(null);
  const isExisting = Boolean(selectedProject);
  const editorLocked = busy || deleteBusy || Boolean(mediaBusy);
  const activePendingCapture = pendingCapture?.slug === draft.slug.trim()
    ? pendingCapture
    : null;

  useEffect(() => {
    onBusyChange(editorLocked);
  }, [editorLocked, onBusyChange]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationControllerRef.current?.abort();
      onBusyChange(false);
    };
  }, [onBusyChange]);

  useEffect(() => {
    const nextDraft = projectToDraft(selectedProject, projects.length);
    const restoredCapture = nextDraft.slug
      ? loadPendingCapture(captureStorage(), nextDraft.slug)
      : loadLatestPendingCapture(captureStorage());
    if (!nextDraft.slug && restoredCapture) nextDraft.slug = restoredCapture.slug;
    setDraft(nextDraft);
    setPendingCapture(restoredCapture);
    setCaptureUrl(restoredCapture?.url || '');
    setDeleteConfirmation(false);
    setMessage(restoredCapture
      ? 'A capture is still pending. Use Check capture to resume it without starting another request.'
      : '');
  }, [projects, selectedProject]);

  useEffect(() => {
    if (deleteConfirmation) deleteCancelRef.current?.focus();
  }, [deleteConfirmation]);

  useEffect(() => {
    if (isExisting) return;
    const slug = draft.slug.trim();
    if (!slug) return;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      setPendingCapture(null);
      return;
    }
    const restoredCapture = loadPendingCapture(captureStorage(), slug);
    setPendingCapture(restoredCapture);
    if (restoredCapture) {
      setCaptureUrl(restoredCapture.url);
      setMessage('A capture is still pending. Use Check capture to resume it without starting another request.');
    }
  }, [draft.slug, isExisting]);

  const update = (field) => (event) => {
    setDeleteNotice(null);
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setDraft((current) => {
      const next = { ...current, [field]: value };
      if (field === 'title' && !isExisting && !activePendingCapture) {
        next.slug = slugifyProjectTitle(value);
      }
      return next;
    });
  };

  const updateMediaItem = (index, field) => (event) => {
    const value = event.target.value;
    setDraft((current) => ({
      ...current,
      mediaItems: current.mediaItems.map((item, itemIndex) => (
        itemIndex === index ? { ...item, [field]: value } : item
      )),
    }));
  };

  const moveMediaItem = (index, direction) => {
    setDraft((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.mediaItems.length) return current;
      const mediaItems = [...current.mediaItems];
      [mediaItems[index], mediaItems[nextIndex]] = [mediaItems[nextIndex], mediaItems[index]];
      return { ...current, mediaItems };
    });
  };

  const removeMediaItem = (index) => {
    setDraft((current) => ({
      ...current,
      mediaItems: current.mediaItems.filter((_, itemIndex) => itemIndex !== index),
    }));
  };

  const appendMediaItems = (incomingItems, { replaceThumbnail = false } = {}) => {
    setDraft((current) => {
      const mediaItems = [...current.mediaItems];
      incomingItems.forEach((item) => {
        if (mediaItems.length < MAX_MEDIA_ITEMS && !mediaItems.some(({ url }) => url === item.url)) {
          mediaItems.push(withMediaRowKey(item));
        }
      });
      const firstItem = mediaItems[0];
      const capturedCover = incomingItems.find(({ type }) => type === 'image')?.url;
      return {
        ...current,
        mediaItems,
        thumbnail: imageThumbnail(
          replaceThumbnail && capturedCover ? capturedCover : current.thumbnail,
          mediaItems,
        ),
        media: current.media || firstItem?.url || '',
        alt: current.alt || firstItem?.alt || '',
      };
    });
  };

  const addMediaUrl = () => {
    if (draft.mediaItems.length >= MAX_MEDIA_ITEMS) {
      setMessage(`Projects can include up to ${MAX_MEDIA_ITEMS} media items.`);
      return;
    }
    setDraft((current) => ({
      ...current,
      mediaItems: [
        ...current.mediaItems,
        withMediaRowKey({
          url: '',
          alt: current.alt || `${current.title || 'Project'} preview`,
          type: 'image',
        }),
      ],
    }));
  };

  const validMediaSlug = () => {
    const slug = draft.slug.trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      setMessage('Add a valid project title and slug before uploading or capturing media.');
      return '';
    }
    return slug;
  };

  const handleUpload = async (event) => {
    const files = [...(event.target.files || [])];
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (files.length === 0) return;

    const slug = validMediaSlug();
    if (!slug) return;
    if (draft.mediaItems.length + files.length > MAX_MEDIA_ITEMS) {
      setMessage(`Projects can include up to ${MAX_MEDIA_ITEMS} media items.`);
      return;
    }

    const unsupportedFile = files.find((file) => (
      !file.type.startsWith('image/') && !file.type.startsWith('video/')
    ));
    if (unsupportedFile) {
      setMessage(`${unsupportedFile.name} is not an image or video.`);
      return;
    }
    const oversizedFile = files.find((file) => file.size > MAX_UPLOAD_BYTES);
    if (oversizedFile) {
      setMessage(`${oversizedFile.name} is larger than the 3 MB upload limit.`);
      return;
    }

    const controller = new AbortController();
    operationControllerRef.current = controller;
    onBusyChange(true);
    setMediaBusy('upload');
    setMessage('');
    const fallbackAlt = draft.alt.trim() || `${draft.title.trim() || 'Project'} preview`;
    const uploadedItems = [];
    try {
      const freshSession = await restoreOwnerSession();
      if (!freshSession?.idToken) throw new Error('Your owner session expired. Sign in again before uploading media.');
      let stoppedError = null;
      for (const file of files) {
        const requestId = createRequestId();
        try {
          const kind = file.type.startsWith('video/') ? 'video' : 'image';
          const contentBase64 = await fileToBase64(file);
          const uploadOptions = {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${freshSession.idToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ slug, kind, contentBase64, requestId }),
            signal: controller.signal,
          };
          const { payload } = await requestOwnerUpload(uploadOptions);
          const responseItems = mediaItemsFromResponse(payload, fallbackAlt);
          if (responseItems.length === 0) throw new Error(`${file.name} uploaded without returning a media URL.`);
          uploadedItems.push(...responseItems);
          if (mountedRef.current) {
            setMessage(`${uploadedItems.length} of ${files.length} ${files.length === 1 ? 'file' : 'files'} committed. Waiting for deployment…`);
          }
        } catch (error) {
          stoppedError = error;
          break;
        }
      }

      if (uploadedItems.length === 0) throw stoppedError || new Error('The media could not be uploaded.');
      if (mountedRef.current) setMediaBusy('upload-readiness');
      await waitForMediaReadiness({
        idToken: freshSession.idToken,
        paths: uploadedItems.map(({ url }) => url),
        signal: controller.signal,
        slug,
        onPending: (payload) => {
          if (!mountedRef.current) return;
          if (payload?.checkingAgain) {
            setMessage('The deployment status is temporarily unavailable. Checking again…');
            return;
          }
          const readyCount = (payload?.items || [])
            .filter((item) => item.githubReady && item.publicReady).length;
          setMessage(`Deployment in progress: ${readyCount} of ${uploadedItems.length} media ${uploadedItems.length === 1 ? 'item is' : 'items are'} live…`);
        },
      });

      if (!mountedRef.current) return;
      appendMediaItems(uploadedItems);
      setMessage(stoppedError
        ? `${uploadedItems.length} ${uploadedItems.length === 1 ? 'item is' : 'items are'} live and ready to publish. Another upload stopped: ${stoppedError.message}`
        : `${uploadedItems.length} media ${uploadedItems.length === 1 ? 'item is' : 'items are'} live. Publish to save the new carousel order.`);
    } catch (error) {
      if (mountedRef.current && error.name !== 'AbortError') {
        setMessage(error.message || 'The media could not be uploaded.');
      }
    } finally {
      if (operationControllerRef.current === controller) operationControllerRef.current = null;
      if (mountedRef.current) {
        setMediaBusy('');
        onBusyChange(false);
      }
    }
  };

  const handleDiscardPendingCapture = () => {
    if (!activePendingCapture || editorLocked) return;
    const storage = captureStorage();
    const storedCapture = loadPendingCapture(storage, activePendingCapture.slug);
    const discarded = !storedCapture || clearPendingCapture(
      storage,
      activePendingCapture.slug,
      activePendingCapture.requestId,
    );
    if (!discarded) {
      setMessage('The pending capture changed in another tab. Reopen the editor before discarding it.');
      return;
    }

    setPendingCapture((current) => (
      current?.slug === activePendingCapture.slug
      && current?.requestId === activePendingCapture.requestId
        ? null
        : current
    ));
    setCaptureUrl(activePendingCapture.url);
    setMessage('Pending capture discarded. Your project media was not changed.');
  };

  const handleCapture = async () => {
    if (operationControllerRef.current) return;
    const slug = validMediaSlug();
    if (!slug) return;
    const storedCapture = loadPendingCapture(captureStorage(), slug);
    let captureRequest = activePendingCapture || storedCapture;
    let recoveryWasSaved = Boolean(storedCapture);
    const wasResuming = Boolean(captureRequest);
    const url = captureRequest?.url || captureUrl.trim();
    if (draft.mediaItems.length > MAX_MEDIA_ITEMS - 2) {
      setMessage('Make room for the captured cover and walkthrough before starting a capture.');
      return;
    }
    if (!captureRequest && !/^https:\/\//i.test(url)) {
      setMessage('Enter the project’s full HTTPS URL before capturing it.');
      return;
    }

    const controller = new AbortController();
    operationControllerRef.current = controller;
    onBusyChange(true);
    setMediaBusy(captureRequest ? 'capture-check' : 'capture');
    setMessage('');
    try {
      const freshSession = await restoreOwnerSession();
      if (!freshSession?.idToken) throw new Error('Your owner session expired. Sign in again before capturing media.');
      const fallbackAlt = draft.alt.trim() || `${draft.title.trim() || 'Project'} preview`;
      if (captureRequest && !recoveryWasSaved) {
        recoveryWasSaved = savePendingCapture(captureStorage(), captureRequest);
      }

      if (!captureRequest) {
        const { payload, status } = await requestOwnerMedia('capture', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${freshSession.idToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ slug, url }),
          signal: controller.signal,
        });
        const capturedItems = mediaItemsFromResponse(payload, fallbackAlt);
        if (status !== 202 || capturedItems.length === 0) {
          throw new Error(payload?.message || 'The capture was queued without returning recovery details.');
        }
        captureRequest = createPendingCapture({
          slug,
          url,
          requestId: payload?.requestId,
          mediaItems: capturedItems,
        });
        recoveryWasSaved = savePendingCapture(captureStorage(), captureRequest);
        if (mountedRef.current) setPendingCapture(captureRequest);
      } else if (mountedRef.current) {
        setPendingCapture(captureRequest);
        setCaptureUrl(captureRequest.url);
      }

      const capturedItems = captureRequest.mediaItems.map((item) => ({
        ...item,
        alt: item.type === 'image' ? `${fallbackAlt} cover` : `${fallbackAlt} walkthrough`,
      }));
      if (mountedRef.current) {
        setMediaBusy('capture-readiness');
        setMessage(recoveryWasSaved
          ? `${wasResuming ? 'Resuming saved capture' : 'Capture queued'}. Waiting for GitHub and the portfolio deployment…`
          : 'Capture queued, but this browser could not save its recovery details. Keep this editor open while it finishes.');
      }
      await waitForMediaReadiness({
        idToken: freshSession.idToken,
        paths: capturedItems.map(({ url: mediaUrl }) => mediaUrl),
        signal: controller.signal,
        slug,
        timeoutMessage: 'Capture is still processing after forty minutes. Its recovery details remain saved; use Check capture later.',
        timeoutMs: CAPTURE_STATUS_TIMEOUT_MS,
        onPending: (statusPayload) => {
          if (!mountedRef.current) return;
          if (statusPayload?.checkingAgain) {
            setMessage('The capture status is temporarily unavailable. Checking again…');
            return;
          }
          const readyCount = (statusPayload?.items || [])
            .filter((item) => item.githubReady && item.publicReady).length;
          setMessage(`Capture is processing: ${readyCount} of ${capturedItems.length} carousel ${capturedItems.length === 1 ? 'item is' : 'items are'} live…`);
        },
      });

      if (!mountedRef.current) return;
      appendMediaItems(capturedItems, { replaceThumbnail: true });
      clearPendingCapture(captureStorage(), slug, captureRequest.requestId);
      setPendingCapture(null);
      setMessage(`${capturedItems.length} captured ${capturedItems.length === 1 ? 'item is' : 'items are'} live. Publish to save the carousel.`);
      setCaptureUrl('');
    } catch (error) {
      if (mountedRef.current && error.name !== 'AbortError') {
        if (error.code === 'capture_failed' && captureRequest) {
          clearPendingCapture(captureStorage(), slug, captureRequest.requestId);
          setPendingCapture(null);
          setMessage(`${error.message || 'The capture workflow failed.'} The failed request was cleared so you can retry.`);
        } else {
          const recoveryMessage = captureRequest && recoveryWasSaved
            ? ' The pending request remains saved; use Check capture to resume it.'
            : (captureRequest
              ? ' Keep this editor open: the browser could not save the pending request for recovery.'
              : '');
          setMessage(`${error.message || 'The project URL could not be captured.'}${recoveryMessage}`);
        }
      }
    } finally {
      if (operationControllerRef.current === controller) operationControllerRef.current = null;
      if (mountedRef.current) {
        setMediaBusy('');
        onBusyChange(false);
      }
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setDeleteNotice(null);
    if (mediaBusy) {
      setMessage('Wait for the media request to finish before publishing.');
      return;
    }
    const slug = draft.slug.trim();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      setMessage('Use lowercase letters, numbers, and hyphens for the slug.');
      return;
    }
    if (draft.mediaItems.length < 1 || draft.mediaItems.length > MAX_MEDIA_ITEMS) {
      setMessage(`Add between 1 and ${MAX_MEDIA_ITEMS} carousel items before publishing.`);
      return;
    }
    if (draft.mediaItems.some(({ url }) => !url.trim())) {
      setMessage('Finish or remove empty media rows before publishing.');
      return;
    }
    const fallbackAlt = draft.alt.trim() || `${draft.title.trim()} project preview`;
    const mediaItems = draft.mediaItems
      .map((item) => normalizeMediaItem(item, fallbackAlt))
      .filter(Boolean);
    if (mediaItems.length < 1 || mediaItems.length > MAX_MEDIA_ITEMS) {
      setMessage(`Add between 1 and ${MAX_MEDIA_ITEMS} valid carousel items before publishing.`);
      return;
    }
    const mediaValues = [draft.thumbnail, draft.media, ...mediaItems.map(({ url }) => url)]
      .map((value) => String(value || '').trim())
      .filter(Boolean);
    if (mediaValues.some((value) => !allowedMediaUrl(value))) {
      setMessage('Media must use an HTTPS URL or a root-relative /portfolio/ path.');
      return;
    }

    onBusyChange(true);
    setBusy(true);
    setMessage('');
    try {
      const project = {
        slug,
        title: draft.title.trim(),
        eyebrow: draft.eyebrow.trim(),
        role: draft.role.trim(),
        caption: draft.caption.trim(),
        thumbnail: imageThumbnail(draft.thumbnail, mediaItems),
        media: (draft.media || mediaItems[0]?.url || FALLBACK_THUMBNAIL).trim(),
        mediaItems,
        alt: fallbackAlt,
        categories: linesToList(draft.categories),
        tech: linesToList(draft.tech),
        highlights: linesToList(draft.highlights),
        links: textToLinks(draft.links),
        accent: draft.accent,
        order: Number(draft.order) || 0,
      };
      await saveProjectContent(project);
      await onSaved();
      setSelectedSlug(slug);
      setMessage('Project published.');
    } catch (error) {
      setMessage(error.message || 'The project could not be saved.');
    } finally {
      setBusy(false);
      onBusyChange(false);
    }
  };

  const selectProject = (slug) => {
    setDeleteConfirmation(false);
    setDeleteNotice(null);
    setSelectedSlug(slug);
  };

  const handleDelete = async () => {
    if (!selectedProject || editorLocked) return;
    const { slug, title } = selectedProject;
    let projectWasDeleted = false;

    onBusyChange(true);
    setDeleteBusy(true);
    setDeleteNotice(null);
    setMessage('');
    try {
      await deleteProjectContent(slug);
      projectWasDeleted = true;
      const savedCapture = loadPendingCapture(captureStorage(), slug);
      if (savedCapture) {
        clearPendingCapture(captureStorage(), slug, savedCapture.requestId);
      }
      setDeleteConfirmation(false);
      setSelectedSlug('__new__');
      await onSaved();
      setDeleteNotice({
        error: false,
        text: `${title} was deleted from the portfolio.`,
      });
    } catch (error) {
      setDeleteNotice({
        error: true,
        text: projectWasDeleted
          ? `${title} was deleted, but the portfolio could not refresh. Reload the page to see the change.`
          : (error.message || 'The project could not be deleted.'),
      });
    } finally {
      setDeleteBusy(false);
      onBusyChange(false);
    }
  };

  return (
    <form className="admin-form" onSubmit={handleSubmit}>
      <div className="admin-section-heading">
        <div>
          <p className="admin-eyebrow">Projects</p>
          <h3>{isExisting ? 'Edit a project' : 'Add a project'}</h3>
        </div>
        <div className="admin-section-actions">
          {isExisting && (
            <button
              className="admin-danger"
              disabled={editorLocked}
              onClick={() => {
                setDeleteNotice(null);
                setDeleteConfirmation(true);
              }}
              type="button"
            >
              Delete project
            </button>
          )}
          <button
            className="admin-secondary"
            disabled={editorLocked}
            onClick={() => selectProject('__new__')}
            type="button"
          >
            New project
          </button>
        </div>
      </div>

      <label>
        Choose project
        <select disabled={editorLocked} onChange={(event) => selectProject(event.target.value)} value={selectedSlug}>
          <option value="__new__">+ New project</option>
          {projects.map((project) => (
            <option key={project.slug} value={project.slug}>{project.title}</option>
          ))}
        </select>
      </label>

      {deleteConfirmation && selectedProject && (
        <section
          aria-labelledby="admin-delete-project-title"
          className="admin-delete-confirmation"
          role="group"
        >
          <div>
            <strong id="admin-delete-project-title">Delete “{selectedProject.title}”?</strong>
            <p>The project will disappear from the portfolio. Uploaded media, likes, and comments will remain stored.</p>
          </div>
          <div className="admin-delete-actions">
            <button
              className="admin-secondary"
              disabled={editorLocked}
              onClick={() => setDeleteConfirmation(false)}
              ref={deleteCancelRef}
              type="button"
            >
              Cancel
            </button>
            <button
              className="admin-danger admin-danger-solid"
              disabled={editorLocked}
              onClick={handleDelete}
              type="button"
            >
              {deleteBusy ? 'Deleting…' : 'Yes, delete project'}
            </button>
          </div>
        </section>
      )}

      <div className="admin-field-grid">
        <label>
          Title
          <input disabled={editorLocked} maxLength="80" onChange={update('title')} required value={draft.title} />
        </label>
        <label>
          Slug
          <input
            disabled={editorLocked}
            maxLength="64"
            onChange={update('slug')}
            readOnly={isExisting || Boolean(activePendingCapture)}
            required
            value={draft.slug}
          />
        </label>
      </div>
      <div className="admin-field-grid">
        <label>
          Category line
          <input disabled={editorLocked} maxLength="80" onChange={update('eyebrow')} placeholder="Full-stack · Productivity" required value={draft.eyebrow} />
        </label>
        <label>
          Role / year
          <input disabled={editorLocked} maxLength="100" onChange={update('role')} placeholder="Personal project · 2026" required value={draft.role} />
        </label>
      </div>
      <label>
        Description
        <textarea disabled={editorLocked} maxLength="900" onChange={update('caption')} required rows="4" value={draft.caption} />
      </label>

      <label>
        Cover image URL
        <input disabled={editorLocked} onChange={update('thumbnail')} placeholder="https://… or /portfolio/poster.webp" value={draft.thumbnail} />
        <small>Paste an HTTPS image URL, or keep an existing /portfolio path.</small>
      </label>
      <label>
        Full media URL
        <input disabled={editorLocked} onChange={update('media')} placeholder="https://… or /portfolio/demo.gif" value={draft.media} />
        <small>This remains as a fallback for older content; the carousel below controls the project modal.</small>
      </label>
      <label>
        Image description
        <input disabled={editorLocked} maxLength="180" onChange={update('alt')} value={draft.alt} />
      </label>

      <fieldset className="admin-media-section" disabled={editorLocked}>
        <legend className="visually-hidden">Project carousel media</legend>
        <div className="admin-media-heading">
          <div>
            <h4>Project carousel</h4>
            <p>Drag-free ordering keeps the gallery accessible: use the arrow buttons to arrange each slide.</p>
          </div>
          <span>{draft.mediaItems.length} / {MAX_MEDIA_ITEMS}</span>
        </div>

        {draft.mediaItems.length > 0 ? (
          <div className="admin-media-list">
            {draft.mediaItems.map((item, itemIndex) => (
              <div className="admin-media-item" key={item.clientKey}>
                <div className="admin-media-preview" aria-hidden="true">
                  {item.type === 'image' && item.url ? (
                    <img alt="" src={item.url} />
                  ) : (
                    <span>{item.type === 'video' ? 'Video' : String(itemIndex + 1).padStart(2, '0')}</span>
                  )}
                </div>
                <div className="admin-media-fields">
                  <label>
                    Media URL
                    <input
                      disabled={editorLocked}
                      onChange={updateMediaItem(itemIndex, 'url')}
                      placeholder="https://… or /portfolio/media.webp"
                      value={item.url}
                    />
                  </label>
                  <label>
                    Description
                    <input
                      disabled={editorLocked}
                      maxLength="180"
                      onChange={updateMediaItem(itemIndex, 'alt')}
                      placeholder="Describe what this slide shows"
                      value={item.alt}
                    />
                  </label>
                  <label className="admin-media-type">
                    Type
                    <select disabled={editorLocked} onChange={updateMediaItem(itemIndex, 'type')} value={item.type}>
                      <option value="image">Image</option>
                      <option value="video">Video</option>
                    </select>
                  </label>
                </div>
                <div className="admin-media-actions" aria-label={`Reorder carousel item ${itemIndex + 1}`} role="group">
                  <button
                    aria-label="Move media earlier"
                    disabled={editorLocked || itemIndex === 0}
                    onClick={() => moveMediaItem(itemIndex, -1)}
                    type="button"
                  >
                    <Icon name="arrowLeft" size={17} />
                  </button>
                  <button
                    aria-label="Move media later"
                    disabled={editorLocked || itemIndex === draft.mediaItems.length - 1}
                    onClick={() => moveMediaItem(itemIndex, 1)}
                    type="button"
                  >
                    <Icon name="arrowRight" size={17} />
                  </button>
                  <button
                    aria-label="Remove media"
                    className="admin-media-remove"
                    disabled={editorLocked}
                    onClick={() => removeMediaItem(itemIndex)}
                    type="button"
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="admin-media-empty">No carousel items yet. Add a URL, upload a file, or capture a live project.</p>
        )}

        <div className="admin-media-toolbar">
          <button
            className="admin-secondary"
            disabled={editorLocked}
            onClick={addMediaUrl}
            type="button"
          >
            Add media URL
          </button>
          <input
            accept="image/*,video/*"
            className="admin-file-input"
            hidden
            multiple
            onChange={handleUpload}
            ref={fileInputRef}
            type="file"
          />
          <button
            className="admin-secondary"
            disabled={editorLocked}
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            {mediaBusy.startsWith('upload')
              ? (mediaBusy === 'upload-readiness' ? 'Deploying…' : 'Uploading…')
              : 'Upload files'}
          </button>
          <small>Images or videos, up to 3 MB each.</small>
        </div>

        <div className="admin-capture-row">
          <label>
            Capture a live project
            <input
              disabled={editorLocked || Boolean(activePendingCapture)}
              onChange={(event) => setCaptureUrl(event.target.value)}
              placeholder="https://your-project.example"
              type="url"
              value={captureUrl}
            />
            {activePendingCapture && (
              <small>Checking resumes the saved request; it will not start a duplicate capture.</small>
            )}
          </label>
          <div className="admin-capture-actions">
            <button
              className="admin-secondary"
              disabled={editorLocked || (!activePendingCapture && !captureUrl.trim())}
              onClick={handleCapture}
              type="button"
            >
              {mediaBusy.startsWith('capture')
                ? (mediaBusy === 'capture-readiness'
                  ? 'Processing…'
                  : (mediaBusy === 'capture-check' ? 'Checking…' : 'Capturing…'))
                : (activePendingCapture ? 'Check capture' : 'Capture site')}
            </button>
            {activePendingCapture && (
              <button
                className="admin-text-button"
                disabled={editorLocked}
                onClick={handleDiscardPendingCapture}
                type="button"
              >
                Discard pending capture
              </button>
            )}
          </div>
        </div>
      </fieldset>

      <div className="admin-field-grid">
        <label>
          Filters
          <input disabled={editorLocked} onChange={update('categories')} placeholder="web, ai, mobile" value={draft.categories} />
        </label>
        <label>
          Accent color
          <input disabled={editorLocked} onChange={update('accent')} type="color" value={draft.accent} />
        </label>
      </div>
      <label>
        Technologies
        <input disabled={editorLocked} onChange={update('tech')} placeholder="React, Firebase, Vite" value={draft.tech} />
      </label>
      <label>
        Highlights
        <textarea disabled={editorLocked} onChange={update('highlights')} placeholder="One highlight per line" rows="3" value={draft.highlights} />
      </label>
      <label>
        Links
        <textarea disabled={editorLocked} onChange={update('links')} placeholder="Visit live project | https://example.com" rows="3" value={draft.links} />
        <small>One per line in “Label | URL” format.</small>
      </label>
      <div className="admin-field-grid admin-field-grid-compact">
        <label>
          Display order
          <input disabled={editorLocked} min="0" onChange={update('order')} type="number" value={draft.order} />
        </label>
      </div>
      {deleteNotice && (
        <p className={deleteNotice.error ? 'admin-error' : 'admin-save-message'} role={deleteNotice.error ? 'alert' : 'status'}>
          {deleteNotice.text}
        </p>
      )}
      {message && <p className="admin-save-message" role="status">{message}</p>}
      <button className="admin-primary" disabled={editorLocked} type="submit">
        {busy ? 'Publishing…' : 'Publish project'}
      </button>
    </form>
  );
}

function timelineSavePayload(draft, entries, projects, isExisting) {
  const id = draft.id.trim();
  const title = draft.title.trim();
  const organization = draft.organization.trim();
  const dateLabel = draft.dateLabel.trim();
  const startDate = draft.startDate.trim();
  const sortDate = draft.sortDate.trim();
  const description = draft.description.trim();
  const highlights = timelineHighlights(draft.highlights);
  const relatedProjectSlug = draft.relatedProjectSlug.trim();
  const externalUrl = draft.externalUrl.trim();
  const externalLabel = draft.externalLabel.trim();
  const sourceUrl = draft.sourceUrl.trim();
  const years = timelineYears(draft.years);

  if (!TIMELINE_ID_PATTERN.test(id) || id.length > 64) {
    throw new Error('Use lowercase letters, numbers, and hyphens for the timeline ID.');
  }
  if (!isExisting && entries.some((entry) => entry.id === id)) {
    throw new Error('That timeline ID is already in use. Choose the existing milestone to update it.');
  }
  if (!TIMELINE_KINDS.has(draft.kind)) {
    throw new Error('Choose a valid milestone type.');
  }
  if (!title || title.length > 120) {
    throw new Error('Add a title no longer than 120 characters.');
  }
  if (organization.length > 120) {
    throw new Error('Keep the organization under 120 characters.');
  }
  if (!dateLabel || dateLabel.length > 80) {
    throw new Error('Add a display date no longer than 80 characters.');
  }
  if (!TIMELINE_MONTH_PATTERN.test(startDate) || !TIMELINE_MONTH_PATTERN.test(sortDate)) {
    throw new Error('Choose valid start and sort months.');
  }
  if (sortDate.localeCompare(startDate) < 0) {
    throw new Error('The sort month cannot come before the start month.');
  }
  if (!years || years.length < 1 || years.length > TIMELINE_MAX_YEARS) {
    throw new Error(`Add between 1 and ${TIMELINE_MAX_YEARS} valid four-digit years.`);
  }
  if (!years.includes(Number(startDate.slice(0, 4))) || !years.includes(Number(sortDate.slice(0, 4)))) {
    throw new Error('Filter years must include both the start year and sort year.');
  }
  if (description.length > 1200) {
    throw new Error('Keep the description under 1,200 characters.');
  }
  if (
    highlights.length > TIMELINE_MAX_HIGHLIGHTS
    || highlights.some((highlight) => highlight.length > TIMELINE_MAX_HIGHLIGHT_LENGTH)
  ) {
    throw new Error(
      `Use up to ${TIMELINE_MAX_HIGHLIGHTS} highlights, each under ${TIMELINE_MAX_HIGHLIGHT_LENGTH} characters.`,
    );
  }
  if (
    relatedProjectSlug
    && !projects.some((project) => project.slug === relatedProjectSlug)
  ) {
    throw new Error('Choose an available related project or select none.');
  }
  if (!isSafeTimelineUrl(externalUrl) || !sourceUrl || !isSafeTimelineUrl(sourceUrl)) {
    throw new Error('Timeline links must be full HTTPS URLs without embedded credentials.');
  }
  if (externalLabel.length > 80) {
    throw new Error('Keep the external link label under 80 characters.');
  }
  if (Boolean(externalUrl) !== Boolean(externalLabel)) {
    throw new Error('Add both an external URL and its link label, or leave both blank.');
  }

  return {
    id,
    kind: draft.kind,
    title,
    organization,
    dateLabel,
    startDate,
    sortDate,
    years,
    description,
    highlights,
    relatedProjectSlug,
    externalUrl,
    externalLabel,
    sourceUrl,
  };
}

function TimelineEditor({ entries = [], onBusyChange, onSaved, projects = [] }) {
  const [selectedId, setSelectedId] = useState('__new__');
  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.id === selectedId),
    [entries, selectedId],
  );
  const [draft, setDraft] = useState(() => timelineToDraft());
  const [busyAction, setBusyAction] = useState('');
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);
  const [message, setMessage] = useState(null);
  const deleteCancelRef = useRef(null);
  const mountedRef = useRef(true);
  const isExisting = Boolean(selectedEntry);
  const editorLocked = Boolean(busyAction);
  const missingRelatedProject = Boolean(
    draft.relatedProjectSlug
    && !projects.some((project) => project.slug === draft.relatedProjectSlug),
  );

  useEffect(() => {
    onBusyChange(editorLocked);
  }, [editorLocked, onBusyChange]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      onBusyChange(false);
    };
  }, [onBusyChange]);

  useEffect(() => {
    setDraft(timelineToDraft(selectedEntry));
    setDeleteConfirmation(false);
  }, [selectedEntry]);

  useEffect(() => {
    if (deleteConfirmation) deleteCancelRef.current?.focus();
  }, [deleteConfirmation]);

  const update = (field) => (event) => {
    const value = event.target.value;
    setMessage(null);
    setDraft((current) => {
      const next = { ...current, [field]: value };
      if (
        field === 'title'
        && !isExisting
        && (!current.id || current.id === slugifyTimelineTitle(current.title))
      ) {
        next.id = slugifyTimelineTitle(value);
      }
      if (field === 'kind') {
        const currentDefaultSource = timelineSources[current.kind] || '';
        if (!current.sourceUrl || current.sourceUrl === currentDefaultSource) {
          next.sourceUrl = timelineSources[value] || '';
        }
      }
      if (field === 'startDate') {
        if (!current.sortDate || current.sortDate === current.startDate) next.sortDate = value;
        if (!current.years.trim() && value) next.years = value.slice(0, 4);
      }
      return next;
    });
  };

  const selectEntry = (id) => {
    setMessage(null);
    setDeleteConfirmation(false);
    setSelectedId(id);
    if (id === '__new__') setDraft(timelineToDraft());
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setMessage(null);

    let entry;
    try {
      entry = timelineSavePayload(draft, entries, projects, isExisting);
    } catch (error) {
      setMessage({ error: true, text: error.message });
      return;
    }

    onBusyChange(true);
    setBusyAction('saving');
    let entryWasSaved = false;
    try {
      await saveTimelineEntryContent(entry);
      entryWasSaved = true;
      await onSaved();
      if (!mountedRef.current) return;
      setSelectedId(entry.id);
      setMessage({
        error: false,
        text: isExisting ? 'Timeline milestone updated.' : 'Timeline milestone published.',
      });
    } catch (error) {
      if (!mountedRef.current) return;
      setMessage({
        error: true,
        text: entryWasSaved
          ? 'The milestone was saved, but the portfolio could not refresh. Reload the page to see it.'
          : (error.message || 'The timeline milestone could not be saved.'),
      });
    } finally {
      if (mountedRef.current) {
        setBusyAction('');
        onBusyChange(false);
      }
    }
  };

  const handleDelete = async () => {
    if (!selectedEntry || editorLocked) return;
    const { id, title } = selectedEntry;
    let entryWasDeleted = false;

    onBusyChange(true);
    setBusyAction('deleting');
    setMessage(null);
    try {
      await deleteTimelineEntryContent(id);
      entryWasDeleted = true;
      setDeleteConfirmation(false);
      setSelectedId('__new__');
      await onSaved();
      if (!mountedRef.current) return;
      setMessage({ error: false, text: `${title} was removed from the timeline.` });
    } catch (error) {
      if (!mountedRef.current) return;
      setMessage({
        error: true,
        text: entryWasDeleted
          ? `${title} was removed, but the portfolio could not refresh. Reload the page to see the change.`
          : (error.message || 'The timeline milestone could not be deleted.'),
      });
    } finally {
      if (mountedRef.current) {
        setBusyAction('');
        onBusyChange(false);
      }
    }
  };

  return (
    <form className="admin-form" onSubmit={handleSubmit}>
      <div className="admin-section-heading">
        <div>
          <p className="admin-eyebrow">Timeline</p>
          <h3>{isExisting ? 'Edit a milestone' : 'Add a milestone'}</h3>
        </div>
        <div className="admin-section-actions">
          {isExisting && (
            <button
              className="admin-danger"
              disabled={editorLocked}
              onClick={() => {
                setMessage(null);
                setDeleteConfirmation(true);
              }}
              type="button"
            >
              Delete milestone
            </button>
          )}
          <button
            className="admin-secondary"
            disabled={editorLocked}
            onClick={() => selectEntry('__new__')}
            type="button"
          >
            New milestone
          </button>
        </div>
      </div>

      <label>
        Choose milestone
        <select
          disabled={editorLocked}
          onChange={(event) => selectEntry(event.target.value)}
          value={selectedId}
        >
          <option value="__new__">+ New milestone</option>
          {entries.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.dateLabel} — {entry.title}{entry.organization ? ` · ${entry.organization}` : ''}
            </option>
          ))}
        </select>
      </label>

      {deleteConfirmation && selectedEntry && (
        <section
          aria-labelledby="admin-delete-timeline-title"
          className="admin-delete-confirmation"
          role="group"
        >
          <div>
            <strong id="admin-delete-timeline-title">Delete “{selectedEntry.title}”?</strong>
            <p>The milestone will disappear from the public timeline. Related projects will not be deleted.</p>
          </div>
          <div className="admin-delete-actions">
            <button
              className="admin-secondary"
              disabled={editorLocked}
              onClick={() => setDeleteConfirmation(false)}
              ref={deleteCancelRef}
              type="button"
            >
              Cancel
            </button>
            <button
              className="admin-danger admin-danger-solid"
              disabled={editorLocked}
              onClick={handleDelete}
              type="button"
            >
              {busyAction === 'deleting' ? 'Deleting…' : 'Yes, delete milestone'}
            </button>
          </div>
        </section>
      )}

      <div className="admin-field-grid">
        <label>
          Title
          <input
            disabled={editorLocked}
            maxLength="120"
            onChange={update('title')}
            required
            value={draft.title}
          />
        </label>
        <label>
          Timeline ID
          <input
            disabled={editorLocked}
            maxLength="64"
            onChange={update('id')}
            pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
            readOnly={isExisting}
            required
            value={draft.id}
          />
          <small>Generated from the title. It cannot change after publishing.</small>
        </label>
      </div>

      <div className="admin-field-grid">
        <label>
          Type
          <select disabled={editorLocked} onChange={update('kind')} required value={draft.kind}>
            {timelineKindOptions.filter(({ id }) => id !== 'all').map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </label>
        <label>
          Organization
          <input
            disabled={editorLocked}
            maxLength="120"
            onChange={update('organization')}
            placeholder="Company, school, or organization"
            value={draft.organization}
          />
        </label>
      </div>

      <label>
        Display date
        <input
          disabled={editorLocked}
          maxLength="80"
          onChange={update('dateLabel')}
          placeholder="Jun 2026 — Present"
          required
          value={draft.dateLabel}
        />
        <small>This is the date visitors see on the timeline.</small>
      </label>

      <div className="admin-field-grid">
        <label>
          Start month
          <input
            disabled={editorLocked}
            onChange={update('startDate')}
            required
            type="month"
            value={draft.startDate}
          />
        </label>
        <label>
          Sort month
          <input
            disabled={editorLocked}
            onChange={update('sortDate')}
            required
            type="month"
            value={draft.sortDate}
          />
          <small>Controls where this milestone appears, newest first.</small>
        </label>
      </div>

      <label>
        Filter years
        <input
          disabled={editorLocked}
          onChange={update('years')}
          placeholder="2024, 2025, 2026"
          required
          value={draft.years}
        />
        <small>Comma-separated years when this milestone should appear in the year filters.</small>
      </label>

      <label>
        Description
        <textarea
          disabled={editorLocked}
          maxLength="1200"
          onChange={update('description')}
          placeholder="A concise summary of the milestone"
          rows="4"
          value={draft.description}
        />
      </label>

      <label>
        Highlights
        <textarea
          disabled={editorLocked}
          onChange={update('highlights')}
          placeholder="One highlight per line"
          rows="4"
          value={draft.highlights}
        />
        <small>
          Up to {TIMELINE_MAX_HIGHLIGHTS} highlights, one per line and no more than{' '}
          {TIMELINE_MAX_HIGHLIGHT_LENGTH} characters each.
        </small>
      </label>

      <label>
        Related project
        <select
          disabled={editorLocked}
          onChange={update('relatedProjectSlug')}
          value={draft.relatedProjectSlug}
        >
          <option value="">No related project</option>
          {missingRelatedProject && (
            <option disabled value={draft.relatedProjectSlug}>
              Missing project · {draft.relatedProjectSlug}
            </option>
          )}
          {projects.map((project) => (
            <option key={project.slug} value={project.slug}>{project.title}</option>
          ))}
        </select>
        <small>Adds an “Open project post” button when that project is available.</small>
      </label>

      <fieldset className="admin-timeline-links" disabled={editorLocked}>
        <legend>Links</legend>
        <div className="admin-field-grid">
          <label>
            External URL
            <input
              onChange={update('externalUrl')}
              placeholder="https://example.com"
              type="url"
              value={draft.externalUrl}
            />
          </label>
          <label>
            External link label
            <input
              maxLength="80"
              onChange={update('externalLabel')}
              placeholder="View project"
              value={draft.externalLabel}
            />
          </label>
        </div>
        <label>
          Source URL
          <input
            onChange={update('sourceUrl')}
            placeholder="https://www.linkedin.com/in/..."
            required
            type="url"
            value={draft.sourceUrl}
          />
          <small>Link to LinkedIn or another public source for this milestone.</small>
        </label>
      </fieldset>

      {message && (
        <p
          className={message.error ? 'admin-error' : 'admin-save-message'}
          role={message.error ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      )}
      <button className="admin-primary" disabled={editorLocked} type="submit">
        {busyAction === 'saving'
          ? 'Publishing…'
          : (isExisting ? 'Update milestone' : 'Publish milestone')}
      </button>
    </form>
  );
}

function AdminPanel({
  initialSession,
  onClose,
  onContentUpdated,
  onSessionChange,
  profile,
  projects,
  timelineEntries = [],
}) {
  const closeRef = useRef(null);
  const editorBusyRef = useRef(false);
  const [session, setSession] = useState(initialSession || null);
  const [authReady, setAuthReady] = useState(false);
  const [section, setSection] = useState('profile');
  const [editorBusy, setEditorBusy] = useState(false);

  const handleSessionChange = useCallback((nextSession) => {
    const normalizedSession = nextSession || null;
    setSession(normalizedSession);
    onSessionChange?.(normalizedSession);
  }, [onSessionChange]);

  const handleEditorBusyChange = useCallback((value) => {
    const nextValue = Boolean(value);
    editorBusyRef.current = nextValue;
    setEditorBusy(nextValue);
  }, []);

  const requestClose = useCallback(() => {
    if (!editorBusyRef.current) onClose();
  }, [onClose]);

  useEffect(() => {
    let active = true;
    restoreOwnerSession()
      .then((saved) => {
        if (active) handleSessionChange(saved);
      })
      .catch(() => {
        if (active) handleSessionChange(null);
      })
      .finally(() => {
        if (active) setAuthReady(true);
      });
    return () => { active = false; };
  }, [handleSessionChange]);

  useEffect(() => {
    const appRoot = document.querySelector('#root');
    const previouslyFocused = document.activeElement;
    const wasInert = appRoot?.inert;
    const previousAriaHidden = appRoot?.getAttribute('aria-hidden');
    document.body.classList.add('modal-open');
    if (appRoot) {
      appRoot.inert = true;
      appRoot.setAttribute('aria-hidden', 'true');
    }
    closeRef.current?.focus();

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.body.classList.remove('modal-open');
      if (appRoot) {
        appRoot.inert = wasInert;
        if (previousAriaHidden === null) appRoot.removeAttribute('aria-hidden');
        else appRoot.setAttribute('aria-hidden', previousAriaHidden);
      }
      previouslyFocused?.focus?.();
    };
  }, [requestClose]);

  const panel = (
    <div className="admin-overlay" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <section aria-labelledby="admin-title" aria-modal="true" className="admin-panel" role="dialog">
        <header className="admin-header">
          <a
            aria-disabled={editorBusy}
            className="admin-brand"
            href="#profile"
            onClick={(event) => {
              event.preventDefault();
              requestClose();
            }}
          >
            <span><img alt="" src="/icon.png" /></span>
            <div><strong id="admin-title">Portfolio studio</strong><small>Owner dashboard</small></div>
          </a>
          <button aria-label="Close editor" className="admin-close" disabled={editorBusy} onClick={requestClose} ref={closeRef} type="button">
            <Icon name="close" size={23} />
          </button>
        </header>

        {!authReady ? (
          <div className="admin-loading" role="status">Checking your session…</div>
        ) : !session ? (
          <SignInForm onSignedIn={handleSessionChange} />
        ) : (
          <div className="admin-workspace">
            <aside aria-label="Portfolio editor sections" className="admin-sidebar">
              <div>
                <p>Signed in as</p>
                <strong>{session.email}</strong>
              </div>
              <button aria-current={section === 'profile' ? 'page' : undefined} className={section === 'profile' ? 'is-active' : ''} disabled={editorBusy} onClick={() => setSection('profile')} type="button">
                <Icon name="user" size={18} /> Profile
              </button>
              <button aria-current={section === 'projects' ? 'page' : undefined} className={section === 'projects' ? 'is-active' : ''} disabled={editorBusy} onClick={() => setSection('projects')} type="button">
                <Icon name="grid" size={18} /> Projects
              </button>
              <button aria-current={section === 'timeline' ? 'page' : undefined} className={section === 'timeline' ? 'is-active' : ''} disabled={editorBusy} onClick={() => setSection('timeline')} type="button">
                <Icon name="activity" size={18} /> Timeline
              </button>
              <button
                className="admin-signout"
                disabled={editorBusy}
                onClick={() => {
                  signOutOwner();
                  handleSessionChange(null);
                }}
                type="button"
              >
                Sign out
              </button>
            </aside>
            <div className="admin-editor">
              {section === 'profile' && (
                <ProfileEditor
                  onBusyChange={handleEditorBusyChange}
                  onSaved={onContentUpdated}
                  profile={profile}
                />
              )}
              {section === 'projects' && (
                <ProjectEditor
                  onBusyChange={handleEditorBusyChange}
                  onSaved={onContentUpdated}
                  projects={projects}
                />
              )}
              {section === 'timeline' && (
                <TimelineEditor
                  entries={timelineEntries}
                  onBusyChange={handleEditorBusyChange}
                  onSaved={onContentUpdated}
                  projects={projects}
                />
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );

  return createPortal(panel, document.body);
}

export default AdminPanel;
