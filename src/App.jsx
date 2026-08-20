import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import './App.css';
import AdminPanel from './components/AdminPanel';
import Footer from './Footer';
import Home from './Home';
import NavigationBar from './Navbar';
import Portfolio from './Portfolio';
import usePortfolioContent from './hooks/usePortfolioContent';
import { restoreOwnerSession } from './lib/contentApi';
import useSocialFeed from './hooks/useSocialFeed';

function App() {
  const [activeFilter, setActiveFilter] = useState('all');
  const [portfolioView, setPortfolioView] = useState(() => (
    typeof window !== 'undefined' && window.location.hash === '#timeline'
      ? 'timeline'
      : 'projects'
  ));
  const [adminOpen, setAdminOpen] = useState(false);
  const [ownerSession, setOwnerSession] = useState(null);
  const sessionChangeSequence = useRef(0);
  const content = usePortfolioContent();
  const social = useSocialFeed(content.projects);
  const openAdmin = useCallback(() => setAdminOpen(true), []);
  const closeAdmin = useCallback(() => setAdminOpen(false), []);
  const handleFilterChange = useCallback((filter) => {
    setActiveFilter(filter);
    setPortfolioView('projects');
    if (typeof window !== 'undefined' && window.location.hash === '#timeline') {
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}#projects`,
      );
    }
  }, []);
  const handleOwnerSessionChange = useCallback((session) => {
    sessionChangeSequence.current += 1;
    setOwnerSession(session || null);
  }, []);

  useEffect(() => {
    let active = true;
    const restoreSequence = sessionChangeSequence.current;
    restoreOwnerSession()
      .then((session) => {
        if (active && restoreSequence === sessionChangeSequence.current) {
          setOwnerSession(session);
        }
      })
      .catch(() => {
        if (active && restoreSequence === sessionChangeSequence.current) {
          setOwnerSession(null);
        }
      });
    return () => { active = false; };
  }, []);

  return (
    <div className="app">
      <NavigationBar isOwnerSignedIn={Boolean(ownerSession)} onOpenAdmin={openAdmin} />
      <main>
        <Home
          activeFilter={activeFilter}
          onFilterChange={handleFilterChange}
          profile={content.profile}
          projects={content.projects}
          social={social}
        />
        <Portfolio
          activeFilter={activeFilter}
          onFilterChange={handleFilterChange}
          onViewChange={setPortfolioView}
          projects={content.projects}
          social={social}
          timelineEntries={content.timelineEntries}
          view={portfolioView}
        />
      </main>
      <Footer mode={social.mode} status={social.status} />
      <div className="ambient ambient-one" aria-hidden="true" />
      <div className="ambient ambient-two" aria-hidden="true" />
      {adminOpen && (
        <AdminPanel
          initialSession={ownerSession}
          onClose={closeAdmin}
          onContentUpdated={content.refresh}
          onSessionChange={handleOwnerSessionChange}
          profile={content.profile}
          projects={content.projects}
          timelineEntries={content.timelineEntries}
        />
      )}
    </div>
  );
}

export default App;
