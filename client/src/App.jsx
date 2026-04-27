import React from 'react';
import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout/Layout';
import MobileLayout from './components/Layout/MobileLayout';
import Dashboard from './components/Dashboard/Dashboard';
import SessionView from './components/Chat/SessionView';
import MobileFileBrowser from './components/FileBrowser/MobileFileBrowser';
import MobilePreview from './components/PreviewPanel/MobilePreview';
import MobileQuality from './components/Quality/MobileQuality';
import HistoryView from './components/History/HistoryView';
import SettingsView from './components/Settings/SettingsView';
import QualityHistory from './components/Quality/QualityHistory';
import ProjectDetail from './components/ProjectDetail/ProjectDetail';
import DecisionsDashboard from './pages/DecisionsDashboard.jsx';
import PipelineDetail from './components/Pipeline/PipelineDetail';
import { useMediaQuery } from './hooks/useMediaQuery';

export default function App() {
  const isMobile = useMediaQuery('(max-width: 768px)');

  if (isMobile) {
    return (
      <MobileLayout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/session/:id" element={<SessionView />} />
          <Route path="/session/:id/files" element={<MobileFileBrowser />} />
          <Route path="/session/:id/preview" element={<MobilePreview />} />
          <Route path="/session/:id/quality" element={<MobileQuality />} />
          <Route path="/files" element={<MobileFileBrowser />} />
          <Route path="/history" element={<HistoryView />} />
          <Route path="/settings" element={<SettingsView />} />
          <Route path="/quality-analytics" element={<QualityHistory />} />
          <Route path="/projects/:id" element={<ProjectDetail />} />
          <Route path="/decisions" element={<DecisionsDashboard />} />
          <Route path="/pipelines/:id" element={<PipelineDetail />} />
        </Routes>
      </MobileLayout>
    );
  }

  return (
    <Routes>
      <Route path="/" element={<Layout />} />
      <Route path="/session/:id" element={<Layout />} />
      <Route path="/files" element={<MobileFileBrowser />} />
      <Route path="/history" element={<HistoryView />} />
      <Route path="/settings" element={<SettingsView />} />
      <Route path="/quality-analytics" element={<QualityHistory />} />
      <Route path="/projects/:id" element={<ProjectDetail />} />
      <Route path="/decisions" element={<DecisionsDashboard />} />
      <Route path="/pipelines/:id" element={<PipelineDetail />} />
    </Routes>
  );
}
