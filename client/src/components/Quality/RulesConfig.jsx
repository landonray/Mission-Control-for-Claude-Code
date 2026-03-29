import React, { useState, useEffect } from 'react';
import { api } from '../../utils/api';
import {
  Shield, ShieldCheck, ShieldAlert, ShieldX,
  ChevronDown, ChevronRight, Edit2, Save, X,
  Terminal, MessageSquare, Bot, Zap, Download, Trash2,
  ToggleLeft, ToggleRight
} from 'lucide-react';
import styles from './RulesConfig.module.css';

const hookTypeIcons = {
  command: Terminal,
  prompt: MessageSquare,
  agent: Bot,
};

const hookTypeLabels = {
  command: 'Command',
  prompt: 'Prompt',
  agent: 'Agent',
};

const severityColors = {
  high: 'var(--error)',
  medium: 'var(--warning)',
  low: 'var(--text-muted)',
};

const categoryLabels = {
  correctness: 'Correctness',
  organization: 'Organization',
  completeness: 'Completeness',
  quality: 'Code Quality',
  process: 'Process',
  safety: 'Safety',
  visual: 'Visual',
};

export default function RulesConfig() {
  const [rules, setRules] = useState([]);
  const [hooksStatus, setHooksStatus] = useState(null);
  const [expandedRule, setExpandedRule] = useState(null);
  const [editingRule, setEditingRule] = useState(null);
  const [editForm, setEditForm] = useState({ prompt: '', script: '' });
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    loadRules();
    loadHooksStatus();
  }, []);

  const loadRules = async () => {
    try {
      const data = await api.get('/api/quality/rules');
      setRules(data);
    } catch (e) {}
    setLoading(false);
  };

  const loadHooksStatus = async () => {
    try {
      const data = await api.get('/api/quality/hooks/status');
      setHooksStatus(data);
    } catch (e) {}
  };

  const toggleRule = async (ruleId) => {
    try {
      await api.post(`/api/quality/rules/${ruleId}/toggle`);
      await loadRules();
      await loadHooksStatus();
    } catch (e) {}
  };

  const updateSeverity = async (ruleId, severity) => {
    try {
      await api.put(`/api/quality/rules/${ruleId}/severity`, { severity });
      await loadRules();
    } catch (e) {}
  };

  const startEditing = (rule) => {
    setEditingRule(rule.id);
    setEditForm({
      prompt: rule.prompt || '',
      script: rule.script || '',
    });
  };

  const saveCustomization = async (ruleId) => {
    try {
      await api.put(`/api/quality/rules/${ruleId}/customize`, editForm);
      setEditingRule(null);
      await loadRules();
    } catch (e) {
      alert(e.message);
    }
  };

  const installHooks = async () => {
    setInstalling(true);
    try {
      await api.post('/api/quality/hooks/install');
      await loadHooksStatus();
    } catch (e) {
      alert(e.message);
    }
    setInstalling(false);
  };

  const uninstallHooks = async () => {
    if (!confirm('Remove all quality hooks from Claude Code?')) return;
    try {
      await api.post('/api/quality/hooks/uninstall');
      await loadHooksStatus();
    } catch (e) {
      alert(e.message);
    }
  };

  const toggleAll = async (enabled) => {
    try {
      await api.post('/api/quality/rules/bulk-toggle', { enabled });
      await loadRules();
      await loadHooksStatus();
    } catch (e) {}
  };

  // Group rules by category
  const grouped = {};
  for (const rule of rules) {
    const cat = rule.category || 'other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(rule);
  }

  const enabledCount = rules.filter(r => r.enabled).length;

  return (
    <div className={styles.container}>
      {/* Header with hooks status */}
      <div className={styles.header}>
        <div>
          <h3><Shield size={18} /> Quality Rules Engine</h3>
          <p className={styles.subtitle}>
            {enabledCount} of {rules.length} rules active
          </p>
        </div>
        <div className={styles.headerActions}>
          {hooksStatus && (
            <span className={`${styles.hooksBadge} ${hooksStatus.installed ? styles.installed : styles.notInstalled}`}>
              {hooksStatus.installed
                ? <><ShieldCheck size={14} /> Hooks installed ({hooksStatus.ruleCount})</>
                : <><ShieldX size={14} /> Hooks not installed</>
              }
            </span>
          )}
          <button className="btn btn-primary btn-sm" onClick={installHooks} disabled={installing}>
            <Download size={14} /> {installing ? 'Installing...' : 'Install Hooks'}
          </button>
          {hooksStatus?.installed && (
            <button className="btn btn-ghost btn-sm" onClick={uninstallHooks}>
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Bulk actions */}
      <div className={styles.bulkActions}>
        <button className="btn btn-ghost btn-sm" onClick={() => toggleAll(true)}>
          <ToggleRight size={14} /> Enable All
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => toggleAll(false)}>
          <ToggleLeft size={14} /> Disable All
        </button>
      </div>

      {/* Rules grouped by category */}
      {Object.entries(grouped).map(([category, categoryRules]) => (
        <div key={category} className={styles.category}>
          <h4 className={styles.categoryTitle}>
            {categoryLabels[category] || category}
          </h4>

          {categoryRules.map(rule => {
            const HookIcon = hookTypeIcons[rule.hook_type] || Terminal;
            const isExpanded = expandedRule === rule.id;
            const isEditing = editingRule === rule.id;

            return (
              <div
                key={rule.id}
                className={`${styles.ruleCard} ${rule.enabled ? '' : styles.disabled}`}
              >
                <div className={styles.ruleHeader}>
                  <button
                    className={styles.expandBtn}
                    onClick={() => setExpandedRule(isExpanded ? null : rule.id)}
                  >
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>

                  <div className={styles.ruleInfo}>
                    <div className={styles.ruleName}>{rule.name}</div>
                    <div className={styles.ruleMeta}>
                      <span className={styles.hookBadge}>
                        <HookIcon size={10} /> {hookTypeLabels[rule.hook_type]}
                      </span>
                      <span className={styles.timingBadge}>
                        <Zap size={10} /> {rule.fires_on}
                      </span>
                    </div>
                  </div>

                  <select
                    className={styles.severitySelect}
                    value={rule.severity}
                    onChange={e => updateSeverity(rule.id, e.target.value)}
                    style={{ borderColor: severityColors[rule.severity] }}
                  >
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>

                  <button
                    className={`${styles.toggleBtn} ${rule.enabled ? styles.on : styles.off}`}
                    onClick={() => toggleRule(rule.id)}
                    title={rule.enabled ? 'Disable' : 'Enable'}
                  >
                    <span className={styles.toggleTrack}>
                      <span className={styles.toggleThumb} />
                    </span>
                  </button>
                </div>

                {isExpanded && (
                  <div className={styles.ruleBody}>
                    <p className={styles.ruleDescription}>{rule.description}</p>

                    {!isEditing ? (
                      <div className={styles.ruleContent}>
                        {rule.prompt && (
                          <div className={styles.promptSection}>
                            <div className={styles.sectionLabel}>Prompt</div>
                            <pre className={styles.promptText}>{rule.prompt}</pre>
                          </div>
                        )}
                        {rule.script && (
                          <div className={styles.promptSection}>
                            <div className={styles.sectionLabel}>Script</div>
                            <pre className={styles.promptText}>{rule.script}</pre>
                          </div>
                        )}
                        <button className="btn btn-ghost btn-sm" onClick={() => startEditing(rule)}>
                          <Edit2 size={12} /> Customize
                        </button>
                      </div>
                    ) : (
                      <div className={styles.editSection}>
                        {rule.prompt !== null && (
                          <div className={styles.editField}>
                            <label>Prompt</label>
                            <textarea
                              className="input"
                              value={editForm.prompt}
                              onChange={e => setEditForm(f => ({ ...f, prompt: e.target.value }))}
                              rows={8}
                            />
                          </div>
                        )}
                        {rule.script !== null && (
                          <div className={styles.editField}>
                            <label>Script</label>
                            <textarea
                              className="input"
                              value={editForm.script}
                              onChange={e => setEditForm(f => ({ ...f, script: e.target.value }))}
                              rows={8}
                              style={{ fontFamily: 'monospace', fontSize: 12 }}
                            />
                          </div>
                        )}
                        <div className={styles.editActions}>
                          <button className="btn btn-primary btn-sm" onClick={() => saveCustomization(rule.id)}>
                            <Save size={12} /> Save
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setEditingRule(null)}>
                            <X size={12} /> Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
