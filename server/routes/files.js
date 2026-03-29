const express = require('express');
const router = express.Router();
const { getDirectoryTree, getFileContent, getGitDiff, getGitStatus, getGitBranches, getBranchDiff } = require('../services/fileWatcher');
const path = require('path');

// Get directory tree
router.get('/tree', (req, res) => {
  const dir = req.query.path;
  if (!dir) {
    return res.status(400).json({ error: 'path query parameter required' });
  }

  const resolvedPath = dir.replace(/^~/, process.env.HOME || '');
  const maxDepth = parseInt(req.query.depth) || 5;

  try {
    const tree = getDirectoryTree(resolvedPath, 0, maxDepth);
    res.json({ path: resolvedPath, tree });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get file content
router.get('/content', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) {
    return res.status(400).json({ error: 'path query parameter required' });
  }

  const resolvedPath = filePath.replace(/^~/, process.env.HOME || '');

  try {
    const content = getFileContent(resolvedPath);
    res.json(content);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get git status for a directory
router.get('/git/status', (req, res) => {
  const dir = req.query.path;
  if (!dir) {
    return res.status(400).json({ error: 'path query parameter required' });
  }

  const resolvedPath = dir.replace(/^~/, process.env.HOME || '');

  try {
    const status = getGitStatus(resolvedPath);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get git diff
router.get('/git/diff', (req, res) => {
  const dir = req.query.path;
  if (!dir) {
    return res.status(400).json({ error: 'path query parameter required' });
  }

  const resolvedPath = dir.replace(/^~/, process.env.HOME || '');
  const options = {};
  if (req.query.staged === 'true') options.staged = true;
  if (req.query.branch) options.branch = req.query.branch;
  if (req.query.file) options.file = req.query.file;

  try {
    const diff = getGitDiff(resolvedPath, options);
    res.json({ diff });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get git branches
router.get('/git/branches', (req, res) => {
  const dir = req.query.path;
  if (!dir) {
    return res.status(400).json({ error: 'path query parameter required' });
  }

  const resolvedPath = dir.replace(/^~/, process.env.HOME || '');

  try {
    const branches = getGitBranches(resolvedPath);
    res.json({ branches });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get branch comparison diff
router.get('/git/branch-diff', (req, res) => {
  const dir = req.query.path;
  if (!dir) {
    return res.status(400).json({ error: 'path query parameter required' });
  }

  const resolvedPath = dir.replace(/^~/, process.env.HOME || '');
  const baseBranch = req.query.base || 'main';

  try {
    const result = getBranchDiff(resolvedPath, baseBranch);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
