import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  createComment,
  fetchComments,
  fetchProjectStats,
  setProjectLiked,
  storageMode,
} from '../lib/socialApi';

function initialStats(projects) {
  return Object.fromEntries(
    projects.map(({ slug }) => [slug, { likes: 0, comments: 0, liked: false }]),
  );
}

export default function useSocialFeed(projects) {
  const [stats, setStats] = useState(() => initialStats(projects));
  const [comments, setComments] = useState({});
  const [loadingComments, setLoadingComments] = useState({});
  const [pendingLikes, setPendingLikes] = useState({});
  const [status, setStatus] = useState('syncing');
  const [error, setError] = useState('');

  const slugs = useMemo(() => projects.map(({ slug }) => slug), [projects]);

  useEffect(() => {
    setStats((current) => Object.fromEntries(
      slugs.map((slug) => [
        slug,
        current[slug] || { likes: 0, comments: 0, liked: false },
      ]),
    ));
  }, [slugs]);

  const refreshStats = useCallback(async () => {
    try {
      const rows = await fetchProjectStats(slugs);
      setStats((current) => {
        const next = { ...current };
        rows.forEach((row) => {
          next[row.project_slug] = {
            likes: Number(row.like_count || 0),
            comments: Number(row.comment_count || 0),
            liked: Boolean(row.liked_by_me),
          };
        });
        return next;
      });
      setStatus('ready');
      setError('');
    } catch (requestError) {
      setStatus('error');
      setError(requestError.message || 'Social activity could not be loaded.');
    }
  }, [slugs]);

  useEffect(() => {
    refreshStats();
  }, [refreshStats]);

  useEffect(() => {
    const handleFocus = () => refreshStats();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [refreshStats]);

  const loadComments = useCallback(async (slug, force = false) => {
    if (!force && Object.prototype.hasOwnProperty.call(comments, slug)) return;

    setLoadingComments((current) => ({ ...current, [slug]: true }));
    try {
      const rows = await fetchComments(slug);
      setComments((current) => ({ ...current, [slug]: rows }));
      setError('');
    } catch (requestError) {
      setError(requestError.message || 'Comments could not be loaded.');
    } finally {
      setLoadingComments((current) => ({ ...current, [slug]: false }));
    }
  }, [comments]);

  const toggleLike = useCallback(async (slug) => {
    if (pendingLikes[slug]) return;

    const previous = stats[slug] || { likes: 0, comments: 0, liked: false };
    const shouldLike = !previous.liked;

    setPendingLikes((current) => ({ ...current, [slug]: true }));
    setStats((current) => ({
      ...current,
      [slug]: {
        ...(current[slug] || previous),
        liked: shouldLike,
        likes: Math.max(0, (current[slug] || previous).likes + (shouldLike ? 1 : -1)),
      },
    }));

    try {
      const saved = await setProjectLiked(slug, shouldLike);
      if (saved) {
        setStats((current) => ({
          ...current,
          [slug]: {
            ...(current[slug] || previous),
            liked: Boolean(saved.liked),
            likes: Number(saved.like_count || 0),
          },
        }));
      }
      setError('');
    } catch (requestError) {
      setStats((current) => ({ ...current, [slug]: previous }));
      setError(requestError.message || 'Your like could not be saved.');
    } finally {
      setPendingLikes((current) => ({ ...current, [slug]: false }));
    }
  }, [pendingLikes, stats]);

  const addComment = useCallback(async (slug, displayName, body) => {
    const comment = await createComment(slug, displayName, body);
    setComments((current) => ({
      ...current,
      [slug]: [comment, ...(current[slug] || [])],
    }));
    setStats((current) => ({
      ...current,
      [slug]: {
        ...(current[slug] || { likes: 0, comments: 0, liked: false }),
        comments: (current[slug]?.comments || 0) + 1,
      },
    }));
    setError('');
    return comment;
  }, []);

  const totals = useMemo(
    () =>
      Object.values(stats).reduce(
        (sum, item) => ({ likes: sum.likes + item.likes, comments: sum.comments + item.comments }),
        { likes: 0, comments: 0 },
      ),
    [stats],
  );

  return {
    stats,
    comments,
    loadingComments,
    pendingLikes,
    status,
    error,
    mode: storageMode,
    totals,
    refreshStats,
    loadComments,
    toggleLike,
    addComment,
  };
}
