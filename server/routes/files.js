const express = require('express');
const router = express.Router();
const { getDirectoryTree, getFileContent, getGitDiff, getGitStatus, getGitBranches, getBranchDiff } = require('../services/fileWatcher');
const path = require('path');
const { execSync, exec } = require('child_process');

// Resolve a user-supplied path and validate it stays within the home directory.
function safeResolvePath(inputPath) {
  const home = process.env.HOME || '/tmp';
  const resolved = path.resolve(inputPath.replace(/^~/, home));
  if (resolved !== home && !resolved.startsWith(home + '/')) {
    return null;
  }
  return resolved;
}

// Get directory tree
router.get('/tree', (req, res) => {
  const dir = req.query.path;
  if (!dir) {
    return res.status(400).json({ error: 'path query parameter required' });
  }

  const resolvedPath = safeResolvePath(dir);
  if (!resolvedPath) {
    return res.status(403).json({ error: 'Access denied: path outside home directory' });
  }
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

  const resolvedPath = safeResolvePath(filePath);
  if (!resolvedPath) {
    return res.status(403).json({ error: 'Access denied: path outside home directory' });
  }

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

  const resolvedPath = safeResolvePath(dir);
  if (!resolvedPath) {
    return res.status(403).json({ error: 'Access denied: path outside home directory' });
  }

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

  const resolvedPath = safeResolvePath(dir);
  if (!resolvedPath) {
    return res.status(403).json({ error: 'Access denied: path outside home directory' });
  }
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

  const resolvedPath = safeResolvePath(dir);
  if (!resolvedPath) {
    return res.status(403).json({ error: 'Access denied: path outside home directory' });
  }

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

  const resolvedPath = safeResolvePath(dir);
  if (!resolvedPath) {
    return res.status(403).json({ error: 'Access denied: path outside home directory' });
  }
  const baseBranch = req.query.base || 'main';

  try {
    const result = getBranchDiff(resolvedPath, baseBranch);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check if native folder picker (osascript) is available
router.get('/picker-available', (req, res) => {
  try {
    execSync('which osascript', { stdio: 'pipe' });
    res.json({ available: true });
  } catch {
    res.json({ available: false });
  }
});

// Open native folder picker dialog (macOS only)
router.post('/pick-directory', (req, res) => {
  exec(
    `osascript -e 'POSIX path of (choose folder with prompt "Select project folder:")'`,
    { timeout: 30000 },
    (err, stdout) => {
      if (err) {
        return res.status(400).json({ error: 'Picker cancelled or unavailable' });
      }
      // osascript returns path with trailing newline, strip it
      const selectedPath = stdout.trim().replace(/\/$/, '');
      res.json({ path: selectedPath });
    }
  );
});

module.exports = router;
