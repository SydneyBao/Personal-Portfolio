import { useMemo, useState } from 'react';
import { timelineEntries, timelineKindOptions } from '../data/timeline';

const kindLabels = Object.fromEntries(
  timelineKindOptions
    .filter(({ id }) => id !== 'all')
    .map(({ id, label }) => [id, label]),
);

function EntryActions({ availableProjectSlugs, entry, onOpenProject }) {
  const hasRelatedProject = Boolean(
    entry.relatedProjectSlug && availableProjectSlugs.has(entry.relatedProjectSlug),
  );

  return (
    <div className="timeline-entry-actions">
      {hasRelatedProject && typeof onOpenProject === 'function' && (
        <button
          className="timeline-entry-action timeline-entry-action-primary"
          onClick={() => onOpenProject(entry.relatedProjectSlug)}
          type="button"
        >
          Open project post
        </button>
      )}
      {hasRelatedProject && typeof onOpenProject !== 'function' && (
        <a className="timeline-entry-action timeline-entry-action-primary" href="#projects">
          Find project post
        </a>
      )}
      {entry.externalUrl && (
        <a
          className="timeline-entry-action"
          href={entry.externalUrl}
          rel="noreferrer"
          target="_blank"
        >
          {entry.externalLabel || 'Open link'}
          <span aria-hidden="true"> ↗</span>
        </a>
      )}
      <a
        className="timeline-entry-source"
        href={entry.sourceUrl}
        rel="noreferrer"
        target="_blank"
      >
        View on LinkedIn
        <span aria-hidden="true"> ↗</span>
      </a>
    </div>
  );
}

function TimelineEntry({ availableProjectSlugs, entry, onOpenProject }) {
  const titleId = `timeline-entry-${entry.id}`;

  return (
    <li className="timeline-entry" data-kind={entry.kind}>
      <span className="timeline-entry-marker" aria-hidden="true" />
      <article aria-labelledby={titleId} className="timeline-entry-card">
        <details>
          <summary className="timeline-entry-summary">
            <span className="timeline-entry-summary-copy">
              <span className="timeline-entry-meta">
                <span className="timeline-entry-kind">{kindLabels[entry.kind]}</span>
                <time dateTime={entry.startDate}>{entry.dateLabel}</time>
              </span>
              <span className="timeline-entry-title" id={titleId} role="heading" aria-level="3">
                {entry.title}
              </span>
              {entry.organization && (
                <span className="timeline-entry-organization">{entry.organization}</span>
              )}
            </span>
            <span className="timeline-entry-expand" aria-hidden="true">+</span>
          </summary>

          <div className="timeline-entry-details">
            {entry.description && <p>{entry.description}</p>}
            {entry.highlights?.length > 0 && (
              <ul className="timeline-entry-highlights">
                {entry.highlights.map((highlight) => (
                  <li key={highlight}>{highlight}</li>
                ))}
              </ul>
            )}
            <EntryActions
              availableProjectSlugs={availableProjectSlugs}
              entry={entry}
              onOpenProject={onOpenProject}
            />
          </div>
        </details>
      </article>
    </li>
  );
}

function countForKind(kind) {
  if (kind === 'all') return timelineEntries.length;
  return timelineEntries.filter((entry) => entry.kind === kind).length;
}

function countForYear(year, kind) {
  return timelineEntries.filter((entry) => (
    (kind === 'all' || entry.kind === kind) && entry.years.includes(year)
  )).length;
}

function Timeline({ availableProjectSlugs = new Set(), onOpenProject }) {
  const [activeKind, setActiveKind] = useState('all');
  const [activeYear, setActiveYear] = useState('all');

  const years = useMemo(() => (
    [...new Set(timelineEntries.flatMap((entry) => entry.years))]
      .sort((left, right) => right - left)
  ), []);

  const filteredEntries = useMemo(() => timelineEntries.filter((entry) => (
    (activeKind === 'all' || entry.kind === activeKind)
    && (activeYear === 'all' || entry.years.includes(activeYear))
  )), [activeKind, activeYear]);

  const selectKind = (kind) => {
    setActiveKind(kind);
    if (
      activeYear !== 'all'
      && !timelineEntries.some((entry) => (
        entry.years.includes(activeYear) && (kind === 'all' || entry.kind === kind)
      ))
    ) {
      setActiveYear('all');
    }
  };

  const resetFilters = () => {
    setActiveKind('all');
    setActiveYear('all');
  };

  return (
    <section className="timeline" aria-labelledby="timeline-heading">
      <header className="timeline-header">
        <p className="timeline-eyebrow">Beyond the grid</p>
        <h2 id="timeline-heading">A timeline of building, learning, and leading</h2>
        <p>
          Explore experience, research, projects, recognition, and community work.
          Select any milestone to see more.
        </p>
      </header>

      <div className="timeline-controls">
        <div aria-labelledby="timeline-kind-label" className="timeline-control-group" role="group">
          <p className="timeline-control-label" id="timeline-kind-label">Filter by type</p>
          <div className="timeline-filter-scroller">
            {timelineKindOptions.map((option) => (
              <button
                aria-pressed={activeKind === option.id}
                className="timeline-filter-chip"
                data-active={activeKind === option.id ? 'true' : undefined}
                key={option.id}
                onClick={() => selectKind(option.id)}
                type="button"
              >
                {option.label}
                <span aria-hidden="true">{countForKind(option.id)}</span>
              </button>
            ))}
          </div>
        </div>

        <div aria-labelledby="timeline-year-label" className="timeline-control-group" role="group">
          <p className="timeline-control-label" id="timeline-year-label">Jump to a year</p>
          <div className="timeline-year-scroller">
            <button
              aria-pressed={activeYear === 'all'}
              className="timeline-year-chip"
              data-active={activeYear === 'all' ? 'true' : undefined}
              onClick={() => setActiveYear('all')}
              type="button"
            >
              All years
            </button>
            {years.map((year) => {
              const count = countForYear(year, activeKind);
              return (
                <button
                  aria-label={`${year}, ${count} ${count === 1 ? 'milestone' : 'milestones'}`}
                  aria-pressed={activeYear === year}
                  className="timeline-year-chip"
                  data-active={activeYear === year ? 'true' : undefined}
                  disabled={count === 0}
                  key={year}
                  onClick={() => setActiveYear(year)}
                  type="button"
                >
                  {year}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <p className="timeline-result-count" aria-live="polite">
        {filteredEntries.length} {filteredEntries.length === 1 ? 'milestone' : 'milestones'}
      </p>

      {filteredEntries.length > 0 ? (
        <ol className="timeline-list">
          {filteredEntries.map((entry) => (
            <TimelineEntry
              availableProjectSlugs={availableProjectSlugs}
              entry={entry}
              key={entry.id}
              onOpenProject={onOpenProject}
            />
          ))}
        </ol>
      ) : (
        <div className="timeline-empty" role="status">
          <p>No milestones match those filters.</p>
          <button onClick={resetFilters} type="button">Show everything</button>
        </div>
      )}
    </section>
  );
}

export default Timeline;
