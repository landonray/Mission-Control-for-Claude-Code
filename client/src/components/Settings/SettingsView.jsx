import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import NotificationSettings from '../Notifications/NotificationSettings';
import McpManager from '../MCP/McpManager';
import RulesConfig from '../Quality/RulesConfig';
import { ArrowLeft, Sliders, Bell, Server, Shield, BarChart3, Settings } from 'lucide-react';
import GeneralSettings from './GeneralSettings';
import styles from './SettingsView.module.css';

const sections = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'quality', label: 'Quality Rules', icon: Shield },
  { id: 'quality-analytics', label: 'Quality Analytics', icon: BarChart3, route: '/quality-analytics' },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'mcp', label: 'MCP Servers', icon: Server },
];

export default function SettingsView() {
  const [activeSection, setActiveSection] = useState('general');
  const navigate = useNavigate();

  return (
    <div className={styles.settings}>
      <div className={styles.header}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>
          <ArrowLeft size={14} /> Back
        </button>
        <h1><Sliders size={20} /> Settings</h1>
      </div>

      <div className={styles.layout}>
        <nav className={styles.nav}>
          {sections.map(section => {
            const Icon = section.icon;
            return (
              <button
                key={section.id}
                className={`${styles.navItem} ${activeSection === section.id ? styles.activeNav : ''}`}
                onClick={() => section.route ? navigate(section.route) : setActiveSection(section.id)}
              >
                <Icon size={16} />
                <span>{section.label}</span>
              </button>
            );
          })}
        </nav>

        <div className={styles.content}>
          {activeSection === 'general' && <GeneralSettings />}
          {activeSection === 'quality' && <RulesConfig />}
          {activeSection === 'notifications' && <NotificationSettings />}
          {activeSection === 'mcp' && <McpManager />}
        </div>
      </div>
    </div>
  );
}
