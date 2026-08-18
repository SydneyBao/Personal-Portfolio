import { useCallback, useEffect, useMemo, useState } from 'react';
import { projects as defaultProjects } from '../data/projects';
import { defaultProfile } from '../data/profile';
import { fetchPortfolioContent, normalizeProfileContent } from '../lib/contentApi';
import { suppressedProjectSlugs } from '../lib/projectVisibility';

const FALLBACK_MEDIA = '/portfolio/posters/sydney-ai-assistant.webp';

function inferMediaType(url = '', explicitType = '') {
  const typeHint = String(explicitType).toLowerCase();
  if (typeHint === 'video' || typeHint.startsWith('video/')) return 'video';
  return /\.(?:mp4|mov|m4v|webm|ogv)(?:$|[?#])/i.test(url) ? 'video' : 'image';
}

function normalizeMediaItems(project, fallbackAlt) {
  const source = Array.isArray(project.mediaItems) ? project.mediaItems : [];
  const items = source
    .map((item) => {
      const value = typeof item === 'string' ? { url: item } : item;
      const url = String(value?.url || '').trim();
      if (!url) return null;
      return {
        url,
        alt: String(value.alt || fallbackAlt).trim(),
        type: inferMediaType(url, value.type || value.kind || value.mimeType),
      };
    })
    .filter(Boolean);

  if (items.length > 0) return items;
  const legacyUrls = [project.thumbnail, project.media].filter(
    (url, index, urls) => url && urls.indexOf(url) === index,
  );
  if (legacyUrls.length === 0) legacyUrls.push(FALLBACK_MEDIA);
  return legacyUrls.map((url) => ({ url, alt: fallbackAlt, type: inferMediaType(url) }));
}

function normalizeThumbnail(thumbnail, mediaItems) {
  const value = String(thumbnail || '').trim();
  const matchingItem = mediaItems.find((item) => item.url === value);
  const safeValue = value
    && matchingItem?.type !== 'video'
    && inferMediaType(value) !== 'video'
    ? value
    : '';
  return safeValue || mediaItems.find(({ type }) => type === 'image')?.url || FALLBACK_MEDIA;
}

function normalizeProject(project, fallbackOrder = 0) {
  const title = project.title || 'Untitled project';
  const alt = project.alt || `${title} preview`;
  const mediaItems = normalizeMediaItems(project, alt);
  const media = project.media || mediaItems[0]?.url || project.thumbnail || FALLBACK_MEDIA;

  return {
    slug: project.slug,
    title,
    eyebrow: project.eyebrow || 'Project',
    role: project.role || 'Personal project',
    caption: project.caption || '',
    thumbnail: normalizeThumbnail(project.thumbnail, mediaItems),
    media,
    mediaItems,
    alt,
    categories: Array.isArray(project.categories) ? project.categories : ['web'],
    tech: Array.isArray(project.tech) ? project.tech : [],
    highlights: Array.isArray(project.highlights) ? project.highlights : [],
    links: Array.isArray(project.links) ? project.links : [],
    accent: project.accent || '#138c84',
    order: Number.isFinite(Number(project.order)) ? Number(project.order) : fallbackOrder,
    status: project.status || 'published',
    revision: Number(project.revision || 0),
    createdAt: project.createdAt || '',
  };
}

function mergeProjects(remoteProjects, deletedProjectSlugs) {
  const remoteBySlug = new Map(remoteProjects.map((project) => [project.slug, project]));
  const suppressedSlugs = suppressedProjectSlugs(remoteProjects, deletedProjectSlugs);
  const defaults = defaultProjects
    .filter(({ slug }) => !suppressedSlugs.has(slug))
    .map((project, index) => {
      const remoteProject = remoteBySlug.get(project.slug);
      const mergedProject = {
        ...project,
        ...remoteProject,
        slug: project.slug,
      };

      // An older saved document should keep using its saved legacy media instead of
      // inheriting the static project's newer gallery array.
      if (remoteProject && !Object.prototype.hasOwnProperty.call(remoteProject, 'mediaItems')) {
        delete mergedProject.mediaItems;
      }

      return normalizeProject(mergedProject, index);
    });
  const defaultSlugs = new Set(defaultProjects.map(({ slug }) => slug));
  const additions = remoteProjects
    .filter(({ slug }) => !defaultSlugs.has(slug) && !suppressedSlugs.has(slug))
    .map((project, index) => normalizeProject(project, defaultProjects.length + index));

  return [...defaults, ...additions]
    .filter((project) => project.status === 'published')
    .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title));
}

export default function usePortfolioContent() {
  const [remoteProfile, setRemoteProfile] = useState(null);
  const [remoteProjects, setRemoteProjects] = useState([]);
  const [deletedProjectSlugs, setDeletedProjectSlugs] = useState([]);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    setStatus('loading');
    try {
      const content = await fetchPortfolioContent();
      setRemoteProfile(content.profile);
      setRemoteProjects(content.projects);
      setDeletedProjectSlugs(content.deletedProjectSlugs || []);
      setError('');
      setStatus('ready');
    } catch (requestError) {
      setError(requestError.message || 'Saved portfolio content could not be loaded.');
      setStatus('fallback');
      throw requestError;
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => {
      // Static content remains available when Firebase content cannot be reached.
    });
  }, [refresh]);

  const profile = useMemo(
    () => normalizeProfileContent({ ...defaultProfile, ...(remoteProfile || {}) }),
    [remoteProfile],
  );
  const projects = useMemo(
    () => mergeProjects(remoteProjects, deletedProjectSlugs),
    [deletedProjectSlugs, remoteProjects],
  );

  return { profile, projects, status, error, refresh };
}
