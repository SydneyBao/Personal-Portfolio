import Icon from './components/Icon';
import { profileFilters } from './data/projects';

function compactNumber(value) {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function Home({ activeFilter, onFilterChange, profile, projects, social }) {
  const bioLines = profile.bio.split('\n').map((line) => line.trim()).filter(Boolean);

  return (
    <section className="profile shell" id="profile" aria-labelledby="profile-name">
      <div className="profile-main">
        <div className="avatar-wrap" aria-label="Sydney Bao profile image">
          <div className="avatar-ring">
            <div className="avatar">
              <img src="/icon.png" alt="Sydney Bao monogram" />
            </div>
          </div>
          <span className="availability-dot" title="Open to opportunities" />
        </div>

        <div className="profile-copy">
          <div className="profile-title-row">
            <div>
              <div className="handle-row">
                <h1 id="profile-name">{profile.handle}</h1>
                <span className="verified" aria-label="Verified portfolio">
                  <Icon name="check" size={12} />
                </span>
              </div>
            </div>

            <div className="profile-actions">
              <a className="button button-primary" href={profile.resumeUrl} target="_blank" rel="noreferrer">
                View résumé
                <Icon name="arrowUpRight" size={16} />
              </a>
            </div>
          </div>

          <dl className="profile-stats" aria-label="Profile statistics">
            <div>
              <dt>{projects.length}</dt>
              <dd>projects</dd>
            </div>
            <div>
              <dt>{compactNumber(social.totals.likes)}</dt>
              <dd>likes</dd>
            </div>
            <div>
              <dt>{compactNumber(social.totals.comments)}</dt>
              <dd>comments</dd>
            </div>
          </dl>

          <div className="bio">
            <p>
              <strong>{profile.displayName}</strong>
              {profile.pronouns && <span className="bio-pronouns">{profile.pronouns}</span>}
            </p>
            {bioLines.map((line) => <p key={line}>{line}</p>)}
            {profile.linkedinUrl && (
              <div className="bio-links">
                <a href={profile.linkedinUrl} target="_blank" rel="noreferrer">
                  <Icon name="link" size={15} /> {profile.linkedinLabel || profile.linkedinUrl}
                </a>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="profile-highlights" aria-label="Filter projects by specialty">
        {profileFilters.map((filter) => (
          <button
            className={`highlight ${activeFilter === filter.id ? 'is-active' : ''}`}
            key={filter.id}
            onClick={() => {
              onFilterChange(filter.id);
              document.querySelector('#projects')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
            type="button"
            aria-pressed={activeFilter === filter.id}
          >
            <span className="highlight-ring">
              <span className="highlight-icon">
                <Icon name={filter.icon} size={25} />
              </span>
            </span>
            <span>{filter.label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export default Home;
