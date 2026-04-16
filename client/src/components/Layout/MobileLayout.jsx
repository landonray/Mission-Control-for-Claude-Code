import React, { useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { LayoutGrid, MessageSquare, FolderOpen, Settings, Eye, ShieldCheck } from 'lucide-react';
import styles from './MobileLayout.module.css';

const dashboardTabs = [
  { id: 'dashboard', path: '/', icon: LayoutGrid, label: 'Dashboard' },
  { id: 'settings', path: '/settings', icon: Settings, label: 'Settings' },
];

function getSessionTabs(sessionId) {
  return [
    { id: 'chat', path: `/session/${sessionId}`, icon: MessageSquare, label: 'Chat' },
    { id: 'files', path: `/session/${sessionId}/files`, icon: FolderOpen, label: 'Files' },
    { id: 'preview', path: `/session/${sessionId}/preview`, icon: Eye, label: 'Preview' },
    { id: 'quality', path: `/session/${sessionId}/quality`, icon: ShieldCheck, label: 'Quality' },
  ];
}

export default function MobileLayout({ children }) {
  const navigate = useNavigate();
  const location = useLocation();

  const sessionMatch = location.pathname.match(/^\/session\/([^/]+)/);
  const sessionId = sessionMatch ? sessionMatch[1] : null;
  const inSession = sessionId && sessionId !== 'active';

  const tabs = useMemo(() => {
    return inSession ? getSessionTabs(sessionId) : dashboardTabs;
  }, [inSession, sessionId]);

  return (
    <div className={styles.mobileLayout}>
      <div className={styles.content}>
        {children}
      </div>

      <nav className={styles.tabBar}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = location.pathname === tab.path;
          return (
            <button
              key={tab.id}
              className={`${styles.tab} ${isActive ? styles.active : ''}`}
              onClick={() => navigate(tab.path)}
            >
              <Icon size={20} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
