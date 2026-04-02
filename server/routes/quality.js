const express = require('express');
const router = express.Router();
const { query } = require('../database');
const { generateHooksConfig, removeHooksConfig, getHooksStatus } = require('../services/hooksGenerator');

// ==========================================
// RULES MANAGEMENT
// ==========================================

// List all quality rules
router.get('/rules', async (req, res) => {
  const { rows: rules } = await query('SELECT * FROM quality_rules ORDER BY sort_order');
  res.json(rules);
});

// Get single rule
router.get('/rules/:id', async (req, res) => {
  const { rows } = await query('SELECT * FROM quality_rules WHERE id = $1', [req.params.id]);
  const rule = rows[0];
  if (!rule) return res.status(404).json({ error: 'Rule not found' });
  res.json(rule);
});

// Toggle rule enabled/disabled
router.post('/rules/:id/toggle', async (req, res) => {
  const { rows } = await query('SELECT * FROM quality_rules WHERE id = $1', [req.params.id]);
  const rule = rows[0];
  if (!rule) return res.status(404).json({ error: 'Rule not found' });

  const newEnabled = rule.enabled ? 0 : 1;
  await query('UPDATE quality_rules SET enabled = $1, updated_at = NOW() WHERE id = $2',
    [newEnabled, req.params.id]);

  // Regenerate hooks config
  const hookResult = await generateHooksConfig();

  res.json({ ...rule, enabled: newEnabled, hooksUpdated: hookResult.success });
});

// Toggle send_fail_to_agent
router.post('/rules/:id/send-fail-to-agent', async (req, res) => {
  const { rows } = await query('SELECT * FROM quality_rules WHERE id = $1', [req.params.id]);
  const rule = rows[0];
  if (!rule) return res.status(404).json({ error: 'Rule not found' });

  const newValue = rule.send_fail_to_agent ? 0 : 1;
  await query('UPDATE quality_rules SET send_fail_to_agent = $1, updated_at = NOW() WHERE id = $2',
    [newValue, req.params.id]);

  res.json({ ...rule, send_fail_to_agent: newValue });
});

// Toggle send_fail_requires_spec
router.post('/rules/:id/send-fail-requires-spec', async (req, res) => {
  const { rows } = await query('SELECT * FROM quality_rules WHERE id = $1', [req.params.id]);
  const rule = rows[0];
  if (!rule) return res.status(404).json({ error: 'Rule not found' });

  const newValue = rule.send_fail_requires_spec ? 0 : 1;
  await query('UPDATE quality_rules SET send_fail_requires_spec = $1, updated_at = NOW() WHERE id = $2',
    [newValue, req.params.id]);

  res.json({ ...rule, send_fail_requires_spec: newValue });
});

// Update rule severity
router.put('/rules/:id/severity', async (req, res) => {
  const { severity } = req.body;
  if (!['low', 'medium', 'high'].includes(severity)) {
    return res.status(400).json({ error: 'Severity must be low, medium, or high' });
  }

  await query('UPDATE quality_rules SET severity = $1, updated_at = NOW() WHERE id = $2',
    [severity, req.params.id]);

  const { rows } = await query('SELECT * FROM quality_rules WHERE id = $1', [req.params.id]);
  const rule = rows[0];
  if (!rule) return res.status(404).json({ error: 'Rule not found' });

  await generateHooksConfig();
  res.json(rule);
});

// Update rule prompt/script (customize)
router.put('/rules/:id/customize', async (req, res) => {
  const { prompt, script } = req.body;

  const updates = [];
  const values = [];
  let paramIdx = 1;

  if (prompt !== undefined) {
    updates.push(`prompt = $${paramIdx++}`);
    values.push(prompt);
  }
  if (script !== undefined) {
    updates.push(`script = $${paramIdx++}`);
    values.push(script);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  updates.push('updated_at = NOW()');
  values.push(req.params.id);

  await query(`UPDATE quality_rules SET ${updates.join(', ')} WHERE id = $${paramIdx}`, values);

  const { rows } = await query('SELECT * FROM quality_rules WHERE id = $1', [req.params.id]);
  const rule = rows[0];
  if (!rule) return res.status(404).json({ error: 'Rule not found' });

  await generateHooksConfig();
  res.json(rule);
});

// Bulk enable/disable all rules
router.post('/rules/bulk-toggle', async (req, res) => {
  const { enabled } = req.body;
  await query('UPDATE quality_rules SET enabled = $1, updated_at = NOW()',
    [enabled ? 1 : 0]);

  await generateHooksConfig();
  const { rows: rules } = await query('SELECT * FROM quality_rules ORDER BY sort_order');
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
router.post('/hooks/install', async (req, res) => {
  try {
    const result = await generateHooksConfig();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove all mission-control hooks
router.post('/hooks/uninstall', async (req, res) => {
  try {
    const result = await removeHooksConfig();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// QUALITY RESULTS (callback endpoint)
// ==========================================

// Receive quality check results from hooks
router.post('/results', async (req, res) => {
  const { session_id, rule_id, rule_name, result, severity, details, file_path } = req.body;

  if (!rule_id || !result) {
    return res.status(400).json({ error: 'rule_id and result are required' });
  }

  try {
    await query(`
      INSERT INTO quality_results (session_id, rule_id, rule_name, result, severity, details, file_path, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `, [
      session_id || null,
      rule_id,
      rule_name || rule_id,
      result,
      severity || 'medium',
      details || null,
      file_path || null
    ]);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get quality results for a session
router.get('/results/session/:sessionId', async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;

  const { rows: results } = await query(`
    SELECT * FROM quality_results
    WHERE session_id = $1
    ORDER BY timestamp DESC
    LIMIT $2
  `, [req.params.sessionId, limit]);

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
router.get('/results/scorecard/:sessionId', async (req, res) => {
  const { rows: results } = await query(`
    SELECT qr.*, qrl.name as display_name, qrl.description as rule_description, qrl.severity as rule_severity
    FROM quality_results qr
    LEFT JOIN quality_rules qrl ON qr.rule_id = qrl.id
    WHERE qr.session_id = $1
    AND qr.id IN (
      SELECT MAX(id) FROM quality_results WHERE session_id = $2 GROUP BY rule_id
    )
    ORDER BY
      CASE qr.severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
      qr.timestamp DESC
  `, [req.params.sessionId, req.params.sessionId]);

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
router.get('/analytics', async (req, res) => {
  const days = parseInt(req.query.days) || 30;

  // Most triggered rules
  const { rows: mostTriggered } = await query(`
    SELECT rule_id, rule_name, COUNT(*) as count,
      SUM(CASE WHEN result = 'pass' THEN 1 ELSE 0 END) as passes,
      SUM(CASE WHEN result = 'fail' THEN 1 ELSE 0 END) as fails
    FROM quality_results
    WHERE timestamp >= NOW() - MAKE_INTERVAL(days => $1)
    GROUP BY rule_id, rule_name
    ORDER BY count DESC
  `, [days]);

  // Most blocking rules (most fails)
  const { rows: mostBlocking } = await query(`
    SELECT rule_id, rule_name, COUNT(*) as fail_count, severity
    FROM quality_results
    WHERE result = 'fail' AND timestamp >= NOW() - MAKE_INTERVAL(days => $1)
    GROUP BY rule_id, rule_name, severity
    ORDER BY fail_count DESC
    LIMIT 10
  `, [days]);

  // Pass rate trend (daily)
  const { rows: dailyTrend } = await query(`
    SELECT DATE(timestamp) as date,
      COUNT(*) as total,
      SUM(CASE WHEN result = 'pass' THEN 1 ELSE 0 END) as passes,
      SUM(CASE WHEN result = 'fail' THEN 1 ELSE 0 END) as fails,
      ROUND(CAST(SUM(CASE WHEN result = 'pass' THEN 1 ELSE 0 END) AS FLOAT) / COUNT(*) * 100) as pass_rate
    FROM quality_results
    WHERE timestamp >= NOW() - MAKE_INTERVAL(days => $1)
    GROUP BY DATE(timestamp)
    ORDER BY date ASC
  `, [days]);

  // Overall stats
  const { rows: overallRows } = await query(`
    SELECT
      COUNT(*) as total_checks,
      SUM(CASE WHEN result = 'pass' THEN 1 ELSE 0 END) as total_passes,
      SUM(CASE WHEN result = 'fail' THEN 1 ELSE 0 END) as total_fails,
      COUNT(DISTINCT session_id) as sessions_checked
    FROM quality_results
    WHERE timestamp >= NOW() - MAKE_INTERVAL(days => $1)
  `, [days]);
  const overall = overallRows[0];

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
router.get('/results', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  const ruleId = req.query.rule_id;
  const result = req.query.result;

  let paramIdx = 1;
  let sql = 'SELECT * FROM quality_results WHERE 1=1';
  const params = [];

  if (ruleId) {
    sql += ` AND rule_id = $${paramIdx++}`;
    params.push(ruleId);
  }
  if (result) {
    sql += ` AND result = $${paramIdx++}`;
    params.push(result);
  }

  sql += ` ORDER BY timestamp DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
  params.push(limit, offset);

  const { rows: results } = await query(sql, params);
  res.json(results);
});

module.exports = router;
