import Icon from './components/Icon';

function NavigationBar({ isOwnerSignedIn, onOpenAdmin }) {
  return (
    <header className="topbar">
      <nav className="topbar-inner" aria-label="Primary navigation">
        <a className="brand" href="#profile" aria-label="Sydney Bao, back to profile">
          <span className="brand-mark">
            <img src="/icon.png" alt="" />
          </span>
          <span className="brand-copy">
            <strong>sydneybao</strong>
            <span>portfolio</span>
          </span>
        </a>

        <div className="topbar-links">
          <a href="#profile" className="topbar-link" aria-label="Profile">
            <Icon name="home" size={21} />
            <span>Profile</span>
          </a>
          <a href="#projects" className="topbar-link" aria-label="Projects">
            <Icon name="grid" size={20} />
            <span>Projects</span>
          </a>
          <button
            aria-label={isOwnerSignedIn ? 'Edit profile' : 'Sign in'}
            className="topbar-admin"
            onClick={onOpenAdmin}
            type="button"
          >
            <Icon name="user" size={18} />
            <span>{isOwnerSignedIn ? 'Edit profile' : 'Sign in'}</span>
          </button>
        </div>
      </nav>
    </header>
  );
}

export default NavigationBar;
