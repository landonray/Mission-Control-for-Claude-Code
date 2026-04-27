import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../../utils/api.js';
import DecisionCard from './DecisionCard.jsx';
import PipelineApprovalCard from './PipelineApprovalCard.jsx';

export default function DecisionsList({ projectId, groupByProject = false, onChange }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const wsRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const url = projectId
        ? `/api/decisions/pending?project_id=${projectId}`
        : '/api/decisions/pending';
      const data = await api.get(url);
      const list = data?.items || [];
      setItems(list);
      if (onChange) onChange(list.length);
    } catch {
      // best effort
    } finally {
      setLoading(false);
    }
  }, [projectId, onChange]);

  useEffect(() => { load(); }, [load]);

  // Live updates: subscribe to the generic decisions_changed event so both
  // planning escalations and pipeline status changes refresh the list.
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    wsRef.current = ws;
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'decisions_changed' || data.type === 'pipeline_status_changed') {
          load();
        }
      } catch { /* ignore non-JSON pings */ }
    };
    return () => { try { ws.close(); } catch { /* noop */ } };
  }, [load]);

  if (loading) return <div>Loading…</div>;
  if (items.length === 0) {
    return (
      <div style={{ color: 'var(--text-muted)', padding: 16 }}>
        No decisions waiting for you. Planning escalations and pipeline stages awaiting approval will appear here.
      </div>
    );
  }

  const renderItem = (item) => {
    if (item.kind === 'pipeline_stage') {
      return <PipelineApprovalCard key={item.id} item={item} onResolved={load} />;
    }
    // 'planning' (default) — preserve the existing card's prop shape by
    // passing the inner planning payload as `item`.
    return <DecisionCard key={item.id} item={{ ...item.planning, project_name: item.project_name }} onResolved={load} />;
  };

  if (!groupByProject) {
    return <div>{items.map(renderItem)}</div>;
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
    items: g.items.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
    oldest: Math.min(...g.items.map((i) => new Date(i.created_at).getTime())),
  })).sort((a, b) => a.oldest - b.oldest);

  return (
    <div>
      {orderedGroups.map((g) => (
        <section key={g.project_id} style={{ marginBottom: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{g.project_name} ({g.items.length})</h3>
          {g.items.map(renderItem)}
        </section>
      ))}
    </div>
  );
}
