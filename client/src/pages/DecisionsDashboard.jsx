import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import DecisionsList from '../components/Decisions/DecisionsList.jsx';

export default function DecisionsDashboard() {
  return (
    <div style={{ padding: '24px', maxWidth: 900, margin: '0 auto' }}>
      <div style={{ marginBottom: 16 }}>
        <Link to="/" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-muted)' }}>
          <ArrowLeft size={14} /> Back
        </Link>
      </div>
      <h1>Decisions</h1>
      <p style={{ color: 'var(--text-muted)', marginBottom: 24 }}>
        Pending decisions from planning sessions across all projects, grouped by project. Oldest projects appear first.
      </p>
      <DecisionsList groupByProject />
    </div>
  );
}
