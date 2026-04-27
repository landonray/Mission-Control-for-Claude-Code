import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../utils/api.js';
import DecisionCard from './DecisionCard.jsx';

export default function DecisionsList({ projectId, groupByProject = false, onChange }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const url = projectId
        ? `/api/planning/escalations?project_id=${projectId}`
        : '/api/planning/escalations';
      const data = await api.get(url);
      setItems(data || []);
      if (onChange) onChange((data || []).length);
    } catch {
      // best effort
    } finally {
      setLoading(false);
    }
  }, [projectId, onChange]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div>Loading…</div>;
  if (items.length === 0) {
    return (
      <div style={{ color: 'var(--text-muted)', padding: 16 }}>
        No decisions waiting for you. When the planning agent escalates a question, it will appear here.
      </div>
    );
  }

  if (!groupByProject) {
    return (
      <div>
        {items.map((item) => (
          <DecisionCard key={item.id} item={item} onResolved={load} />
        ))}
      </div>
    );
  }

  const groups = new Map();
  for (const item of items) {
    const key = item.project_id;
    if (!groups.has(key)) groups.set(key, { project_name: item.project_name || 'Unknown', items: [] });
    groups.get(key).items.push(item);
  }
  const orderedGroups = Array.from(groups.entries()).map(([id, g]) => ({
    project_id: id,
    project_name: g.project_name,
    items: g.items.slice().sort((a, b) => new Date(a.asked_at) - new Date(b.asked_at)),
    oldest: Math.min(...g.items.map((i) => new Date(i.asked_at).getTime())),
  })).sort((a, b) => a.oldest - b.oldest);

  return (
    <div>
      {orderedGroups.map((g) => (
        <section key={g.project_id} style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{g.project_name} ({g.items.length})</h3>
          {g.items.map((item) => (
            <DecisionCard key={item.id} item={item} onResolved={load} />
          ))}
        </section>
      ))}
    </div>
  );
}
