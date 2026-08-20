import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './components/Icon';
import Timeline from './components/Timeline';

function formatCount(value) {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatTime(value) {
  const date = new Date(value);
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const absoluteSeconds = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  if (absoluteSeconds < 60) return formatter.format(seconds, 'second');
  if (absoluteSeconds < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
  if (absoluteSeconds < 86400) return formatter.format(Math.round(seconds / 3600), 'hour');
  if (absoluteSeconds < 604800) return formatter.format(Math.round(seconds / 86400), 'day');
  return date.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}

const INTERACTIVE_TARGETS = [
  'a[href]',
  'button',
  'input',
  'textarea',
  'select',
  'option',
  'video',
  'audio',
  'iframe',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="link"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="textbox"]',
  '[role="combobox"]',
].join(', ');

const SEEDED_COMMENT_ID_PATTERN = /^demo-\d{8}-comment-/i;

function isInteractiveTarget(target) {
  return target instanceof Element && Boolean(target.closest(INTERACTIVE_TARGETS));
}

function Comment({ comment }) {
  const displayName = comment.display_name || 'Guest';
  const initial = displayName.replace(/^@+/, '').slice(0, 1).toUpperCase() || 'G';
  const isSample = SEEDED_COMMENT_ID_PATTERN.test(String(comment.id || ''));

  return (
    <li className="comment">
      <span className="comment-avatar" aria-hidden="true">{initial}</span>
      <div>
        <p>
          <strong>{displayName}</strong>
          {isSample && (
            <span aria-label="Sample comment" className="comment-sample-badge">Sample</span>
          )}{' '}
          <span>{comment.body}</span>
        </p>
        <time dateTime={comment.created_at}>{formatTime(comment.created_at)}</time>
      </div>
    </li>
  );
}

function projectMediaItems(project) {
  const fallbackAlt = project.alt || `${project.title} project preview`;
  const items = (Array.isArray(project.mediaItems) ? project.mediaItems : [])
    .map((item) => {
      const value = typeof item === 'string' ? { url: item } : item;
      const url = String(value?.url || '').trim();
      if (!url) return null;
      const typeHint = String(value.type || value.kind || '').toLowerCase();
      return {
        url,
        alt: value.alt || fallbackAlt,
        type: typeHint === 'video' || /\.(?:mp4|mov|m4v|webm|ogv)(?:$|[?#])/i.test(url)
          ? 'video'
          : 'image',
      };
    })
    .filter(Boolean);

  if (items.length > 0) return items;
  const legacyUrls = [project.thumbnail, project.media]
    .filter((url, itemIndex, urls) => url && urls.indexOf(url) === itemIndex)
    .map((url) => ({
      url,
      alt: fallbackAlt,
      type: /\.(?:mp4|mov|m4v|webm|ogv)(?:$|[?#])/i.test(url) ? 'video' : 'image',
    }));
  return legacyUrls.length > 0
    ? legacyUrls
    : [{ url: '/portfolio/posters/sydney-ai-assistant.webp', alt: fallbackAlt, type: 'image' }];
}

function ProjectModal({ project, index, total, onClose, onNavigate, social }) {
  const overlayRef = useRef(null);
  const closeButtonRef = useRef(null);
  const commentInputRef = useRef(null);
  const paginationRef = useRef(null);
  const swipeStartRef = useRef(null);
  const [displayName, setDisplayName] = useState(() => {
    try {
      return window.localStorage.getItem('sydney-portfolio-comment-name') || '';
    } catch {
      return '';
    }
  });
  const [commentBody, setCommentBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [formError, setFormError] = useState('');
  const [shared, setShared] = useState(false);
  const [heartBurst, setHeartBurst] = useState(false);
  const [mediaIndex, setMediaIndex] = useState(0);

  const mediaItems = useMemo(() => projectMediaItems(project), [project]);
  const activeMedia = mediaItems[mediaIndex] || mediaItems[0];

  const navigateMedia = useCallback((direction) => {
    setMediaIndex((current) => (
      (current + direction + mediaItems.length) % mediaItems.length
    ));
  }, [mediaItems.length]);

  const projectStats = social.stats[project.slug] || { likes: 0, comments: 0, liked: false };
  const projectComments = social.comments[project.slug] || [];
  const loadingComments = social.loadingComments[project.slug];

  useEffect(() => {
    social.loadComments(project.slug, true);
    setCommentBody('');
    setFormError('');
    setMediaIndex(0);
  }, [project.slug]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const activeDot = paginationRef.current?.querySelector('[aria-current="true"]');
    activeDot?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [mediaIndex]);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const appRoot = document.querySelector('#root');
    const previousAriaHidden = appRoot?.getAttribute('aria-hidden');
    const wasInert = appRoot?.inert;

    document.body.classList.add('modal-open');
    appRoot?.setAttribute('aria-hidden', 'true');
    if (appRoot) appRoot.inert = true;
    closeButtonRef.current?.focus();

    const handleKeyDown = (event) => {
      const isInteractive = isInteractiveTarget(event.target);

      if (event.key === 'Escape') onClose();
      if (!isInteractive && event.key === 'ArrowLeft') {
        event.preventDefault();
        if (mediaItems.length > 1) navigateMedia(-1);
        else onNavigate(-1);
      }
      if (!isInteractive && event.key === 'ArrowRight') {
        event.preventDefault();
        if (mediaItems.length > 1) navigateMedia(1);
        else onNavigate(1);
      }
      if (event.key === 'Tab') {
        const focusable = [...overlayRef.current.querySelectorAll(
          'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), video[controls]',
        )].filter((element) => element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
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
  }, [mediaItems.length, navigateMedia, onClose, onNavigate]);

  const handleTouchStart = (event) => {
    if (isInteractiveTarget(event.target)) return;
    const touch = event.changedTouches[0];
    swipeStartRef.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchEnd = (event) => {
    const swipeStart = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!swipeStart || mediaItems.length < 2) return;
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - swipeStart.x;
    const deltaY = touch.clientY - swipeStart.y;
    if (Math.abs(deltaX) >= 46 && Math.abs(deltaX) > Math.abs(deltaY)) {
      navigateMedia(deltaX > 0 ? -1 : 1);
    }
  };

  const handleLike = async () => {
    if (!projectStats.liked) {
      setHeartBurst(true);
      window.setTimeout(() => setHeartBurst(false), 650);
    }
    await social.toggleLike(project.slug);
  };

  const handleDoubleClick = (event) => {
    if (isInteractiveTarget(event.target)) return;
    if (!projectStats.liked && !social.pendingLikes[project.slug]) handleLike();
  };

  const handleCommentSubmit = async (event) => {
    event.preventDefault();
    const cleanBody = commentBody.trim();
    const cleanName = displayName.trim() || 'Guest';

    if (!cleanBody) return;
    if (cleanBody.length > 500) {
      setFormError('Keep your comment under 500 characters.');
      return;
    }

    setPosting(true);
    setFormError('');
    try {
      await social.addComment(project.slug, cleanName, cleanBody);
      setCommentBody('');
      try {
        window.localStorage.setItem('sydney-portfolio-comment-name', cleanName);
      } catch {
        // A private browser can block preference storage after the cloud write succeeds.
      }
      if (!displayName.trim()) setDisplayName(cleanName);
    } catch (error) {
      setFormError(error.message || 'Your comment could not be posted.');
    } finally {
      setPosting(false);
    }
  };

  const handleShare = async () => {
    const url = `${window.location.origin}${window.location.pathname}#project-${project.slug}`;

    try {
      if (navigator.share) {
        await navigator.share({ title: `${project.title} — Sydney Bao`, url });
      } else {
        await navigator.clipboard.writeText(url);
        setShared(true);
        window.setTimeout(() => setShared(false), 1600);
      }
    } catch (error) {
      if (error.name !== 'AbortError') setFormError('The project link could not be copied.');
    }
  };

  return createPortal(
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`project-title-${project.slug}`}
      ref={overlayRef}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        className="modal-close"
        onClick={onClose}
        ref={closeButtonRef}
        type="button"
        aria-label="Close project"
      >
        <Icon name="close" size={27} />
      </button>

      {total > 1 && (
        <>
          <button
            className="modal-nav modal-nav-previous"
            onClick={() => onNavigate(-1)}
            type="button"
            aria-label="Previous project"
          >
            <Icon name="arrowLeft" size={28} />
          </button>
          <button
            className="modal-nav modal-nav-next"
            onClick={() => onNavigate(1)}
            type="button"
            aria-label="Next project"
          >
            <Icon name="arrowRight" size={28} />
          </button>
        </>
      )}

      <article
        className="post-modal"
      >
        <div
          className="post-media"
          style={{ '--project-accent': project.accent }}
          onDoubleClick={handleDoubleClick}
          onTouchEnd={handleTouchEnd}
          onTouchStart={handleTouchStart}
        >
          {activeMedia.type === 'video' ? (
            <video
              aria-label={activeMedia.alt}
              controls
              key={activeMedia.url}
              playsInline
              poster={project.thumbnail}
              preload="metadata"
              src={activeMedia.url}
            />
          ) : (
            <img draggable="false" key={activeMedia.url} src={activeMedia.url} alt={activeMedia.alt} />
          )}

          {mediaItems.length > 1 && (
            <>
              <button
                aria-label="Previous project media"
                className="media-nav media-nav-previous"
                onClick={() => navigateMedia(-1)}
                type="button"
              >
                <Icon name="arrowLeft" size={22} />
              </button>
              <button
                aria-label="Next project media"
                className="media-nav media-nav-next"
                onClick={() => navigateMedia(1)}
                type="button"
              >
                <Icon name="arrowRight" size={22} />
              </button>
              <div
                className="media-pagination"
                aria-label="Choose project media"
                ref={paginationRef}
                role="group"
              >
                {mediaItems.map((item, itemIndex) => (
                  <button
                    aria-current={itemIndex === mediaIndex ? 'true' : undefined}
                    aria-label={`Show media ${itemIndex + 1} of ${mediaItems.length}`}
                    className={itemIndex === mediaIndex ? 'is-active' : ''}
                    key={`${item.url}-${itemIndex}`}
                    onClick={() => setMediaIndex(itemIndex)}
                    type="button"
                  />
                ))}
              </div>
            </>
          )}

          <span className="media-position" aria-live="polite">
            {String(mediaIndex + 1).padStart(2, '0')} / {String(mediaItems.length).padStart(2, '0')}
          </span>
          <span className="media-hint">Double-click to like</span>
          {heartBurst && (
            <span className="heart-burst" aria-hidden="true">
              <Icon name="heart" filled size={88} />
            </span>
          )}
        </div>

        <div className="post-rail">
          <header className="post-header">
            <span className="mini-avatar"><img src="/icon.png" alt="" /></span>
            <div>
              <strong>sydneybao</strong>
              <span>{project.role}</span>
            </div>
            <span className="post-number">#{String(index + 1).padStart(2, '0')}</span>
          </header>

          <div className="post-scroll">
            <section className="post-caption">
              <p className="post-eyebrow">{project.eyebrow}</p>
              <h2 id={`project-title-${project.slug}`}>{project.title}</h2>
              <p className="post-description">{project.caption}</p>

              <ul className="project-highlights" aria-label="Project highlights">
                {project.highlights.map((highlight) => (
                  <li key={highlight}><Icon name="check" size={13} /> {highlight}</li>
                ))}
              </ul>

              <div className="tech-stack" aria-label="Technologies used">
                {project.tech.map((item) => <span key={item}>{item}</span>)}
              </div>

              {project.links.length > 0 && (
                <div className="project-links">
                  {project.links.map((link) => (
                    <a key={link.url} href={link.url} target="_blank" rel="noreferrer">
                      {link.label} <Icon name="arrowUpRight" size={15} />
                    </a>
                  ))}
                </div>
              )}
            </section>

            <section className="comments-section" aria-labelledby={`comments-title-${project.slug}`}>
              <div className="comments-heading">
                <h3 id={`comments-title-${project.slug}`}>Conversation</h3>
                <span>{projectStats.comments}</span>
              </div>

              {loadingComments ? (
                <div className="comments-loading" role="status">
                  <i /><i /><i />
                  <span className="visually-hidden">Loading comments</span>
                </div>
              ) : projectComments.length > 0 ? (
                <ul className="comment-list">
                  {projectComments.map((comment) => <Comment comment={comment} key={comment.id} />)}
                </ul>
              ) : (
                <div className="empty-comments">
                  <span><Icon name="comment" size={22} /></span>
                  <p><strong>Start the conversation</strong></p>
                  <p>Ask about the build, share feedback, or just say hello.</p>
                </div>
              )}
            </section>
          </div>

          <div className="post-controls">
            <div className="social-actions">
              <button
                className={`social-action like-action ${projectStats.liked ? 'is-liked' : ''}`}
                onClick={handleLike}
                disabled={social.pendingLikes[project.slug]}
                type="button"
                aria-label={projectStats.liked ? 'Unlike project' : 'Like project'}
                aria-pressed={projectStats.liked}
              >
                <Icon name="heart" filled={projectStats.liked} size={26} />
              </button>
              <button
                className="social-action"
                onClick={() => commentInputRef.current?.focus()}
                type="button"
                aria-label="Write a comment"
              >
                <Icon name="comment" size={25} />
              </button>
              <button className="social-action" onClick={handleShare} type="button" aria-label="Share project">
                <Icon name={shared ? 'check' : 'send'} size={24} />
              </button>
            </div>

            <p className="like-count">
              <strong>{formatCount(projectStats.likes)} {projectStats.likes === 1 ? 'like' : 'likes'}</strong>
              <span>{social.mode === 'cloud' ? 'Synced across visitors' : 'Local preview'}</span>
            </p>

            {(formError || social.error) && <p className="social-error" role="alert">{formError || social.error}</p>}

            <form className="comment-form" onSubmit={handleCommentSubmit}>
              <div className="comment-identity">
                <label htmlFor={`comment-name-${project.slug}`}>Name</label>
                <input
                  id={`comment-name-${project.slug}`}
                  maxLength="32"
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Guest"
                  value={displayName}
                />
              </div>
              <div className="comment-message">
                <label className="visually-hidden" htmlFor={`comment-body-${project.slug}`}>Comment</label>
                <input
                  id={`comment-body-${project.slug}`}
                  maxLength="500"
                  onChange={(event) => setCommentBody(event.target.value)}
                  placeholder="Add a comment..."
                  ref={commentInputRef}
                  value={commentBody}
                />
              </div>
              <button disabled={posting || !commentBody.trim()} type="submit">
                {posting ? 'Posting…' : 'Post'}
              </button>
            </form>
            <p className="comment-note">Comments are public. Please don&apos;t share sensitive information.</p>
          </div>
        </div>
      </article>
    </div>,
    document.body,
  );
}

function Portfolio({
  activeFilter,
  onFilterChange,
  onViewChange,
  projects,
  social,
  timelineEntries,
  view,
}) {
  const [selectedProjectSlug, setSelectedProjectSlug] = useState(null);

  const filteredProjects = useMemo(
    () => activeFilter === 'all'
      ? projects
      : projects.filter((project) => project.categories.includes(activeFilter)),
    [activeFilter, projects],
  );
  const availableProjectSlugs = useMemo(
    () => new Set(projects.map(({ slug }) => slug)),
    [projects],
  );

  const setProjectHash = useCallback((slug) => {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#project-${slug}`,
    );
  }, []);

  const modalProjects = view === 'timeline' ? projects : filteredProjects;
  const selectedIndex = selectedProjectSlug
    ? modalProjects.findIndex(({ slug }) => slug === selectedProjectSlug)
    : -1;

  const openModal = useCallback((slug) => {
    setSelectedProjectSlug(slug);
    setProjectHash(slug);
  }, [setProjectHash]);

  const closeModal = useCallback(() => {
    setSelectedProjectSlug(null);
    if (window.location.hash.startsWith('#project-')) {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}#projects`,
      );
    }
  }, []);

  const navigateModal = useCallback((direction) => {
    if (selectedIndex < 0 || modalProjects.length === 0) return;
    const next = (selectedIndex + direction + modalProjects.length) % modalProjects.length;
    const nextSlug = modalProjects[next].slug;
    setSelectedProjectSlug(nextSlug);
    setProjectHash(nextSlug);
  }, [modalProjects, selectedIndex, setProjectHash]);

  useEffect(() => {
    if (
      view === 'projects'
      && selectedProjectSlug
      && !filteredProjects.some(({ slug }) => slug === selectedProjectSlug)
    ) {
      setSelectedProjectSlug(null);
    }
  }, [filteredProjects, selectedProjectSlug, view]);

  useEffect(() => {
    const syncViewWithHash = () => {
      const { hash } = window.location;
      if (hash === '#timeline') {
        setSelectedProjectSlug(null);
        onViewChange('timeline');
        return;
      }
      if (hash === '#projects') {
        setSelectedProjectSlug(null);
        onViewChange('projects');
        return;
      }
      if (hash.startsWith('#project-')) {
        const slug = hash.replace('#project-', '');
        if (!projects.some((project) => project.slug === slug)) {
          setSelectedProjectSlug(null);
          onViewChange('projects');
          return;
        }
        if (!filteredProjects.some((project) => project.slug === slug)) onFilterChange('all');
        onViewChange('projects');
        setSelectedProjectSlug(slug);
        return;
      }
      setSelectedProjectSlug(null);
    };

    syncViewWithHash();
    window.addEventListener('hashchange', syncViewWithHash);
    return () => window.removeEventListener('hashchange', syncViewWithHash);
  }, [filteredProjects, onFilterChange, onViewChange, projects]);

  const selectView = useCallback((nextView) => {
    setSelectedProjectSlug(null);
    onViewChange(nextView);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#${nextView}`,
    );
  }, [onViewChange]);

  const handleTabKeyDown = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabOrder = ['projects', 'timeline'];
    const currentView = event.currentTarget.id === 'portfolio-timeline-tab'
      ? 'timeline'
      : 'projects';
    const currentIndex = tabOrder.indexOf(currentView);
    const nextView = event.key === 'Home'
      ? tabOrder[0]
      : event.key === 'End'
        ? tabOrder.at(-1)
        : tabOrder[(
          currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabOrder.length
        ) % tabOrder.length];
    selectView(nextView);
    document.querySelector(`#portfolio-${nextView}-tab`)?.focus();
  };

  const openRelatedProject = useCallback((slug) => {
    if (!projects.some((project) => project.slug === slug)) return;
    onFilterChange('all');
    onViewChange('projects');
    setSelectedProjectSlug(slug);
    setProjectHash(slug);
  }, [onFilterChange, onViewChange, projects, setProjectHash]);

  const activeLabel = activeFilter === 'all'
    ? 'All projects'
    : `${activeFilter === 'ai' ? 'AI + ML' : activeFilter[0].toUpperCase() + activeFilter.slice(1)} projects`;

  return (
    <section className="projects shell" id="projects" aria-labelledby="portfolio-heading">
      <h2 className="visually-hidden" id="portfolio-heading">Portfolio</h2>
      <div className="projects-tabbar">
        <div aria-label="Portfolio views" className="projects-tabs" role="tablist">
          <button
            aria-controls="portfolio-projects-panel"
            aria-selected={view === 'projects'}
            className={`projects-tab ${view === 'projects' ? 'is-active' : ''}`}
            id="portfolio-projects-tab"
            onClick={() => selectView('projects')}
            onKeyDown={handleTabKeyDown}
            role="tab"
            tabIndex={view === 'projects' ? 0 : -1}
            type="button"
          >
            <Icon name="grid" size={14} />
            <span>Projects</span>
          </button>
          <button
            aria-controls="portfolio-timeline-panel"
            aria-selected={view === 'timeline'}
            className={`projects-tab ${view === 'timeline' ? 'is-active' : ''}`}
            id="portfolio-timeline-tab"
            onClick={() => selectView('timeline')}
            onKeyDown={handleTabKeyDown}
            role="tab"
            tabIndex={view === 'timeline' ? 0 : -1}
            type="button"
          >
            <Icon name="activity" size={15} />
            <span>Timeline</span>
          </button>
        </div>
        <p aria-live="polite">
          {view === 'projects' ? `${activeLabel} · ${filteredProjects.length}` : 'LinkedIn archive'}
        </p>
      </div>

      <div
        aria-labelledby="portfolio-projects-tab"
        hidden={view !== 'projects'}
        id="portfolio-projects-panel"
        role="tabpanel"
        tabIndex={0}
      >
        <div className="project-grid">
          {filteredProjects.map((project, index) => {
            const projectStats = social.stats[project.slug] || { likes: 0, comments: 0, liked: false };
            return (
              <button
                className="project-tile"
                key={project.slug}
                onClick={() => openModal(project.slug)}
                type="button"
                aria-label={`Open ${project.title}. ${projectStats.likes} likes and ${projectStats.comments} comments.`}
                aria-haspopup="dialog"
              >
                <img src={project.thumbnail} alt="" loading={index === 0 ? 'eager' : 'lazy'} />
                <span className="tile-shade" />
                <span className="tile-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="tile-copy">
                  <span>{project.eyebrow}</span>
                  <strong>{project.title}</strong>
                </span>
                <span className="tile-stats" aria-hidden="true">
                  <span><Icon name="heart" filled size={20} /> {formatCount(projectStats.likes)}</span>
                  <span><Icon name="comment" filled size={19} /> {formatCount(projectStats.comments)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div
        aria-labelledby="portfolio-timeline-tab"
        hidden={view !== 'timeline'}
        id="portfolio-timeline-panel"
        role="tabpanel"
        tabIndex={0}
      >
        <Timeline
          availableProjectSlugs={availableProjectSlugs}
          entries={timelineEntries}
          onOpenProject={openRelatedProject}
        />
      </div>

      {selectedIndex >= 0 && modalProjects[selectedIndex] && (
        <ProjectModal
          project={modalProjects[selectedIndex]}
          index={selectedIndex}
          total={modalProjects.length}
          onClose={closeModal}
          onNavigate={navigateModal}
          social={social}
        />
      )}
    </section>
  );
}

export default Portfolio;
