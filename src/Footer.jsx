import Icon from './components/Icon';

function Footer({ mode, status }) {
  const syncLabel = mode === 'cloud' ? 'Cloud social feed' : 'Local preview data';

  return (
    <footer className="footer shell">
      <div className="footer-line" />
      <div className="footer-content">
        <div>
          <a className="footer-wordmark" href="#profile">Sydney Bao</a>
          <p>Designed and built with curiosity.</p>
        </div>
        <div className="footer-links">
          <a href="mailto:s.bao2115@gmail.com">Email</a>
          <a href="https://linkedin.com/in/sydney-bao" target="_blank" rel="noreferrer">LinkedIn</a>
          <a href="https://github.com/SydneyBao" target="_blank" rel="noreferrer">GitHub</a>
          <a href="https://gemini-chatbot-iota-five.vercel.app/" target="_blank" rel="noreferrer">
            Ask my AI <Icon name="arrowUpRight" size={14} />
          </a>
        </div>
      </div>
      <div className="footer-meta">
        <span>© {new Date().getFullYear()} Sydney Bao</span>
        <span className={`sync-state is-${status}`} title={syncLabel}>
          <i /> {syncLabel}
        </span>
      </div>
    </footer>
  );
}

export default Footer;
