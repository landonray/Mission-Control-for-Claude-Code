import React, { useState } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../utils/api';
import { Plus, Trash2, Edit2, Power, PowerOff, Server, Save, X } from 'lucide-react';
import styles from './McpManager.module.css';

export default function McpManager() {
  const { mcpServers, loadMcpServers } = useApp();
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({
    name: '', command: '', args: '', env: '', auto_connect: false,
  });

  const startEdit = (server) => {
    setEditing(server ? server.id : 'new');
    setForm(server ? {
      name: server.name,
      command: server.command,
      args: server.args || '',
      env: server.env || '',
      auto_connect: !!server.auto_connect,
    } : {
      name: '', command: '', args: '', env: '', auto_connect: false,
    });
  };

  const handleSave = async () => {
    try {
      const data = {
        ...form,
        args: form.args ? JSON.parse(form.args) : null,
        env: form.env ? JSON.parse(form.env) : null,
      };

      if (editing === 'new') {
        await api.post('/api/mcp', data);
      } else {
        await api.put(`/api/mcp/${editing}`, data);
      }
      await loadMcpServers();
      setEditing(null);
    } catch (err) {
      alert(err.message);
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this MCP server?')) return;
    try {
      await api.delete(`/api/mcp/${id}`);
      await loadMcpServers();
    } catch (err) {
      alert(err.message);
    }
  };

  const toggleAutoConnect = async (id) => {
    try {
      await api.post(`/api/mcp/${id}/toggle-auto-connect`);
      await loadMcpServers();
    } catch (err) {
      alert(err.message);
    }
  };

  return (
    <div className={styles.manager}>
      <div className={styles.header}>
        <h3>MCP Servers</h3>
        <button className="btn btn-primary btn-sm" onClick={() => startEdit(null)}>
          <Plus size={14} /> Add Server
        </button>
      </div>

      <div className={styles.list}>
        {mcpServers.map(server => (
          <div key={server.id} className={styles.serverItem}>
            <Server size={18} className={styles.serverIcon} />
            <div className={styles.serverInfo}>
              <div className={styles.serverHeader}>
                <span className={styles.serverName}>{server.name}</span>
                <span className={`${styles.statusBadge} ${server.status === 'connected' ? styles.connected : ''}`}>
                  {server.status === 'connected' ? <Power size={10} /> : <PowerOff size={10} />}
                  {server.status || 'disconnected'}
                </span>
              </div>
              <span className={styles.serverCommand}>{server.command}</span>
            </div>
            <div className={styles.serverActions}>
              <button
                className={`btn btn-ghost btn-sm ${server.auto_connect ? styles.autoOn : ''}`}
                onClick={() => toggleAutoConnect(server.id)}
                title={server.auto_connect ? 'Auto-connect ON' : 'Auto-connect OFF'}
              >
                {server.auto_connect ? <Power size={14} /> : <PowerOff size={14} />}
              </button>
              <button className="btn btn-ghost btn-icon btn-sm" onClick={() => startEdit(server)}>
                <Edit2 size={14} />
              </button>
              <button className="btn btn-ghost btn-icon btn-sm" onClick={() => handleDelete(server.id)}>
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}

        {mcpServers.length === 0 && (
          <div className="empty-state" style={{ padding: '24px 16px' }}>
            <Server size={24} />
            <p>No MCP servers configured</p>
          </div>
        )}
      </div>

      {editing && (
        <div className={styles.editOverlay} onClick={e => e.target === e.currentTarget && setEditing(null)}>
          <div className={styles.editPanel}>
            <div className={styles.editHeader}>
              <h4>{editing === 'new' ? 'Add MCP Server' : 'Edit MCP Server'}</h4>
              <button className="btn btn-ghost btn-icon" onClick={() => setEditing(null)}>
                <X size={16} />
              </button>
            </div>
            <div className={styles.editForm}>
              <div className={styles.field}>
                <label>Name</label>
                <input className="input" value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="My MCP Server" />
              </div>
              <div className={styles.field}>
                <label>Command</label>
                <input className="input" value={form.command}
                  onChange={e => setForm(f => ({ ...f, command: e.target.value }))}
                  placeholder="npx @modelcontextprotocol/server" />
              </div>
              <div className={styles.field}>
                <label>Arguments (JSON array)</label>
                <input className="input" value={form.args}
                  onChange={e => setForm(f => ({ ...f, args: e.target.value }))}
                  placeholder='["--port", "3001"]' />
              </div>
              <div className={styles.field}>
                <label>Environment Variables (JSON object)</label>
                <input className="input" value={form.env}
                  onChange={e => setForm(f => ({ ...f, env: e.target.value }))}
                  placeholder='{"API_KEY": "..."}' />
              </div>
              <div className={styles.toggleRow}>
                <label className="toggle">
                  <input type="checkbox" checked={form.auto_connect}
                    onChange={e => setForm(f => ({ ...f, auto_connect: e.target.checked }))} />
                  <span className="toggle-slider" />
                </label>
                <span>Auto-connect on session start</span>
              </div>
              <button className="btn btn-primary" onClick={handleSave} style={{ width: '100%' }}>
                <Save size={14} /> Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
