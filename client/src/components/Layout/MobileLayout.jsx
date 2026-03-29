import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { LayoutGrid, MessageSquare, FolderOpen, Settings } from 'lucide-react';
import styles from './MobileLayout.module.css';

const tabs = [
  { path: '/', icon: LayoutGrid, label: 'Dashboard' },
  { path: '/session/active', icon: MessageSquare, label: 'Chat' },
  { path: '/files', icon: FolderOpen, label: 'Files' },
  { path: '/settings', icon: Settings, label: 'Settings' },
];

export default function MobileLayout({ children }) {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div className={styles.mobileLayout}>
      <div className={styles.content}>
        {children}
      </div>

      <nav className={styles.tabBar}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = location.pathname === tab.path ||
            (tab.path === '/session/active' && location.pathname.startsWith('/session'));
          return (
            <button
              key={tab.path}
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
