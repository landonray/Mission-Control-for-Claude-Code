const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const { generateHooksConfig, removeHooksConfig, getHooksStatus } = require('../services/hooksGenerator');

// ==========================================
// RULES MANAGEMENT
// ==========================================

// List all quality rules
router.get('/rules', (req, res) => {
  const db = getDb();
  const rules = db.prepare('SELECT * FROM quality_rules ORDER BY sort_order').all();
  res.json(rules);
});

// Get single rule
router.get('/rules/:id', (req, res) => {
  const db = getDb();
  const rule = db.prepare('SELECT * FROM quality_rules WHERE id = ?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  res.json(rule);
});

// Toggle rule enabled/disabled
router.post('/rules/:id/toggle', (req, res) => {
  const db = getDb();
  const rule = db.prepare('SELECT * FROM quality_rules WHERE id = ?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });

  const newEnabled = rule.enabled ? 0 : 1;
  db.prepare('UPDATE quality_rules SET enabled = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(newEnabled, req.params.id);

  // Regenerate hooks config
  const hookResult = generateHooksConfig();

  res.json({ ...rule, enabled: newEnabled, hooksUpdated: hookResult.success });
});

// Update rule severity
router.put('/rules/:id/severity', (req, res) => {
  const db = getDb();
  const { severity } = req.body;
  if (!['low', 'medium', 'high'].includes(severity)) {
    return res.status(400).json({ error: 'Severity must be low, medium, or high' });
  }

  db.prepare('UPDATE quality_rules SET severity = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(severity, req.params.id);

  const rule = db.prepare('SELECT * FROM quality_rules WHERE id = ?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });

  generateHooksConfig();
  res.json(rule);
});

// Update rule prompt/script (customize)
router.put('/rules/:id/customize', (req, res) => {
  const db = getDb();
  const { prompt, script } = req.body;

  const updates = [];
  const values = [];

  if (prompt !== undefined) {
    updates.push('prompt = ?');
    values.push(prompt);
  }
  if (script !== undefined) {
    updates.push('script = ?');
    values.push(script);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  updates.push('updated_at = datetime(\'now\')');
  values.push(req.params.id);

  db.prepare(`UPDATE quality_rules SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const rule = db.prepare('SELECT * FROM quality_rules WHERE id = ?').get(req.params.id);
  if (!rule) return res.status(404).json({ error: 'Rule not found' });

  generateHooksConfig();
  res.json(rule);
});

// Bulk enable/disable all rules
router.post('/rules/bulk-toggle', (req, res) => {
  const db = getDb();
  const { enabled } = req.body;
  db.prepare('UPDATE quality_rules SET enabled = ?, updated_at = datetime(\'now\')')
    .run(enabled ? 1 : 0);

  generateHooksConfig();
  const rules = db.prepare('SELECT * FROM quality_rules ORDER BY sort_order').all();
  res.json(rules);
});

// ==========================================
// HOOKS MANAGEMENT
// ==========================================

// Get hooks installation status
router.get('/hooks/status', (req, res) => {
  res.json(getHooksStatus());
});

// Generate and install hooks
router.post('/hooks/install', (req, res) => {
  try {
    const result = generateHooksConfig();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove all mission-control hooks
router.post('/hooks/uninstall', (req, res) => {
  try {
    const result = removeHooksConfig();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// QUALITY RESULTS (callback endpoint)
// ==========================================

// Receive quality check results from hooks
router.post('/results', (req, res) => {
  const db = getDb();
  const { session_id, rule_id, rule_name, result, severity, details, file_path } = req.body;

  if (!rule_id || !result) {
    return res.status(400).json({ error: 'rule_id and result are required' });
  }

  try {
    db.prepare(`
      INSERT INTO quality_results (session_id, rule_id, rule_name, result, severity, details, file_path, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      session_id || null,
      rule_id,
      rule_name || rule_id,
      result,
      severity || 'medium',
      details || null,
      file_path || null
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get quality results for a session
router.get('/results/session/:sessionId', (req, res) => {
  const db = getDb();
  const limit = parseInt(req.query.limit) || 100;

  const results = db.prepare(`
    SELECT * FROM quality_results
    WHERE session_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(req.params.sessionId, limit);

  // Compute scorecard
  const passes = results.filter(r => r.result === 'pass').length;
  const fails = results.filter(r => r.result === 'fail').length;
  const total = results.length;

  res.json({
    results,
    scorecard: {
      total,
      passes,
      fails,
      passRate: total > 0 ? Math.round((passes / total) * 100) : 100
    }
  });
});

// Get latest quality results grouped by rule (for scorecard)
router.get('/results/scorecard/:sessionId', (req, res) => {
  const db = getDb();

  const results = db.prepare(`
    SELECT qr.*, qrl.name as display_name, qrl.description as rule_description, qrl.severity as rule_severity
    FROM quality_results qr
    LEFT JOIN quality_rules qrl ON qr.rule_id = qrl.id
    WHERE qr.session_id = ?
    AND qr.id IN (
      SELECT MAX(id) FROM quality_results WHERE session_id = ? GROUP BY rule_id
    )
    ORDER BY
      CASE qr.severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
      qr.timestamp DESC
  `).all(req.params.sessionId, req.params.sessionId);

  const passes = results.filter(r => r.result === 'pass').length;
  const fails = results.filter(r => r.result === 'fail').length;

  res.json({
    rules: results,
    summary: {
      total: results.length,
      passes,
      fails,
      passRate: results.length > 0 ? Math.round((passes / results.length) * 100) : 100
    }
  });
});

// ==========================================
// QUALITY ANALYTICS / HISTORY
// ==========================================

// Get aggregated analytics across all sessions
router.get('/analytics', (req, res) => {
  const db = getDb();
  const days = parseInt(req.query.days) || 30;

  // Most triggered rules
  const mostTriggered = db.prepare(`
    SELECT rule_id, rule_name, COUNT(*) as count,
      SUM(CASE WHEN result = 'pass' THEN 1 ELSE 0 END) as passes,
      SUM(CASE WHEN result = 'fail' THEN 1 ELSE 0 END) as fails
    FROM quality_results
    WHERE timestamp >= datetime('now', '-' || ? || ' days')
    GROUP BY rule_id
    ORDER BY count DESC
  `).all(days);

  // Most blocking rules (most fails)
  const mostBlocking = db.prepare(`
    SELECT rule_id, rule_name, COUNT(*) as fail_count, severity
    FROM quality_results
    WHERE result = 'fail' AND timestamp >= datetime('now', '-' || ? || ' days')
    GROUP BY rule_id
    ORDER BY fail_count DESC
    LIMIT 10
  `).all(days);

  // Pass rate trend (daily)
  const dailyTrend = db.prepare(`
    SELECT DATE(timestamp) as date,
      COUNT(*) as total,
      SUM(CASE WHEN result = 'pass' THEN 1 ELSE 0 END) as passes,
      SUM(CASE WHEN result = 'fail' THEN 1 ELSE 0 END) as fails,
      ROUND(CAST(SUM(CASE WHEN result = 'pass' THEN 1 ELSE 0 END) AS FLOAT) / COUNT(*) * 100) as pass_rate
    FROM quality_results
    WHERE timestamp >= datetime('now', '-' || ? || ' days')
    GROUP BY DATE(timestamp)
    ORDER BY date ASC
  `).all(days);

  // Overall stats
  const overall = db.prepare(`
    SELECT
      COUNT(*) as total_checks,
      SUM(CASE WHEN result = 'pass' THEN 1 ELSE 0 END) as total_passes,
      SUM(CASE WHEN result = 'fail' THEN 1 ELSE 0 END) as total_fails,
      COUNT(DISTINCT session_id) as sessions_checked
    FROM quality_results
    WHERE timestamp >= datetime('now', '-' || ? || ' days')
  `).get(days);

  res.json({
    overall: {
      ...overall,
      passRate: overall.total_checks > 0
        ? Math.round((overall.total_passes / overall.total_checks) * 100)
        : 100
    },
    mostTriggered,
    mostBlocking,
    dailyTrend
  });
});

// Get all results with pagination
router.get('/results', (req, res) => {
  const db = getDb();
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const ruleId = req.query.rule_id;
  const result = req.query.result;

  let query = 'SELECT * FROM quality_results WHERE 1=1';
  const params = [];

  if (ruleId) {
    query += ' AND rule_id = ?';
    params.push(ruleId);
  }
  if (result) {
    query += ' AND result = ?';
    params.push(result);
  }

  query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const results = db.prepare(query).all(...params);
  res.json(results);
});

module.exports = router;
