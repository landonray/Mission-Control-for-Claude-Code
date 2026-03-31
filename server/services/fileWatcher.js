const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const activeWatchers = new Map();

function watchDirectory(directory, onChange) {
  if (activeWatchers.has(directory)) {
    return activeWatchers.get(directory);
  }

  const watcher = chokidar.watch(directory, {
    ignored: [
      /(^|[\/\\])\../,
      /node_modules/,
      /\.git\//,
      /dist\//,
      /build\//
    ],
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 300,
      pollInterval: 100
    }
  });

  watcher.on('add', (filePath) => {
    onChange({ type: 'add', path: path.relative(directory, filePath), fullPath: filePath });
  });

  watcher.on('change', (filePath) => {
    onChange({ type: 'change', path: path.relative(directory, filePath), fullPath: filePath });
  });

  watcher.on('unlink', (filePath) => {
    onChange({ type: 'unlink', path: path.relative(directory, filePath), fullPath: filePath });
  });

  watcher.on('addDir', (dirPath) => {
    onChange({ type: 'addDir', path: path.relative(directory, dirPath), fullPath: dirPath });
  });

  watcher.on('unlinkDir', (dirPath) => {
    onChange({ type: 'unlinkDir', path: path.relative(directory, dirPath), fullPath: dirPath });
  });

  activeWatchers.set(directory, watcher);
  return watcher;
}

function unwatchDirectory(directory) {
  const watcher = activeWatchers.get(directory);
  if (watcher) {
    watcher.close();
    activeWatchers.delete(directory);
  }
}

function getDirectoryTree(dirPath, depth = 0, maxDepth = 5) {
  if (depth > maxDepth) return [];

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const result = [];

    const filtered = entries.filter(e => {
      const name = e.name;
      return !name.startsWith('.') &&
             name !== 'node_modules' &&
             name !== '__pycache__' &&
             name !== '.git';
    });

    filtered.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of filtered) {
      const fullPath = path.join(dirPath, entry.name);
      const node = {
        name: entry.name,
        path: fullPath,
        type: entry.isDirectory() ? 'directory' : 'file'
      };

      if (entry.isDirectory()) {
        node.children = getDirectoryTree(fullPath, depth + 1, maxDepth);
      } else {
        try {
          const stats = fs.statSync(fullPath);
          node.size = stats.size;
          node.modified = stats.mtime.toISOString();
        } catch (e) {}
      }

      result.push(node);
    }

    return result;
  } catch (e) {
    return [];
  }
}

function getFileContent(filePath) {
  try {
    const stats = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp'];
    const binaryExts = ['.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib'];

    if (imageExts.includes(ext)) {
      const data = fs.readFileSync(filePath);
      const base64 = data.toString('base64');
      const mimeTypes = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.webp': 'image/webp',
        '.ico': 'image/x-icon',
        '.bmp': 'image/bmp'
      };
      return {
        type: 'image',
        content: `data:${mimeTypes[ext] || 'image/png'};base64,${base64}`,
        size: stats.size,
        modified: stats.mtime.toISOString()
      };
    }

    if (binaryExts.includes(ext)) {
      return {
        type: 'binary',
        content: null,
        size: stats.size,
        modified: stats.mtime.toISOString()
      };
    }

    if (stats.size > 5 * 1024 * 1024) {
      return {
        type: 'text',
        content: '[File too large to display]',
        size: stats.size,
        modified: stats.mtime.toISOString(),
        truncated: true
      };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    return {
      type: ext === '.html' || ext === '.htm' ? 'html' : ext === '.md' ? 'markdown' : 'text',
      content,
      size: stats.size,
      modified: stats.mtime.toISOString(),
      extension: ext
    };
  } catch (e) {
    return { type: 'error', content: e.message };
  }
}

function getGitDiff(directory, options = {}) {
  try {
    let cmd;
    if (options.staged) {
      cmd = 'git diff --cached';
    } else if (options.branch && options.file) {
      cmd = `git diff ${options.branch} -- "${options.file}"`;
    } else if (options.branch) {
      cmd = `git diff ${options.branch}`;
    } else if (options.file) {
      cmd = `git diff -- "${options.file}"`;
    } else {
      cmd = 'git diff';
    }

    const result = execSync(cmd, {
      cwd: directory,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024
    });

    return result;
  } catch (e) {
    return '';
  }
}

function getGitStatus(directory) {
  try {
    const status = execSync('git status --porcelain', {
      cwd: directory,
      encoding: 'utf-8'
    });

    const branch = execSync('git branch --show-current', {
      cwd: directory,
      encoding: 'utf-8'
    }).trim();

    const files = status.split('\n').filter(Boolean).map(line => ({
      status: line.substring(0, 2).trim(),
      path: line.substring(3)
    }));

    return { branch, files };
  } catch (e) {
    return { branch: '', files: [] };
  }
}

function getGitBranches(directory) {
  try {
    const result = execSync('git branch -a', {
      cwd: directory,
      encoding: 'utf-8'
    });
    return result.split('\n')
      .filter(Boolean)
      .map(b => b.trim().replace(/^\* /, ''));
  } catch (e) {
    return [];
  }
}

function getBranchDiff(directory, baseBranch = 'main') {
  try {
    const currentBranch = execSync('git branch --show-current', {
      cwd: directory,
      encoding: 'utf-8'
    }).trim();

    const diff = execSync(`git diff ${baseBranch}...${currentBranch}`, {
      cwd: directory,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024
    });

    const diffStat = execSync(`git diff --stat ${baseBranch}...${currentBranch}`, {
      cwd: directory,
      encoding: 'utf-8'
    });

    return { diff, diffStat, baseBranch, currentBranch };
  } catch (e) {
    return { diff: '', diffStat: '', baseBranch, currentBranch: '' };
  }
}

/**
 * Get git pipeline status for a session's working directory.
 * Returns { branch, committed, merged, pushed } where each stage is 'done', 'pending', or 'unknown'.
 */
function getGitPipeline(directory) {
  const result = { branch: '', committed: 'unknown', merged: 'unknown', pushed: 'unknown' };
  if (!directory) return result;

  try {
    const resolved = directory.startsWith('~')
      ? path.join(require('os').homedir(), directory.slice(1))
      : directory;

    // Current branch
    const branch = execSync('git branch --show-current', {
      cwd: resolved, encoding: 'utf-8', timeout: 3000
    }).trim();
    result.branch = branch;

    // Stage 1: Committed? (clean working tree)
    const porcelain = execSync('git status --porcelain', {
      cwd: resolved, encoding: 'utf-8', timeout: 3000
    }).trim();
    result.committed = porcelain.length === 0 ? 'done' : 'pending';

    // Stage 2: Merged to main?
    const isMain = branch === 'main' || branch === 'master';
    if (isMain) {
      result.merged = 'done';
    } else {
      // Check if there are commits on this branch not on main/master
      try {
        const base = execSync('git rev-parse --verify main 2>/dev/null || git rev-parse --verify master 2>/dev/null', {
          cwd: resolved, encoding: 'utf-8', timeout: 3000, shell: true
        }).trim();
        if (base) {
          const baseName = execSync('git rev-parse --verify main 2>/dev/null && echo main || echo master', {
            cwd: resolved, encoding: 'utf-8', timeout: 3000, shell: true
          }).trim().split('\n').pop();
          const unmerged = execSync(`git log ${baseName}..HEAD --oneline`, {
            cwd: resolved, encoding: 'utf-8', timeout: 3000
          }).trim();
          result.merged = unmerged.length === 0 ? 'done' : 'pending';
        }
      } catch {
        result.merged = 'unknown';
      }
    }

    // Stage 3: Pushed to remote?
    try {
      const trackingBranch = isMain ? 'origin/main' : `origin/${branch}`;
      // Check if the remote ref exists
      execSync(`git rev-parse --verify ${trackingBranch} 2>/dev/null`, {
        cwd: resolved, encoding: 'utf-8', timeout: 3000, shell: true
      });
      // Check for unpushed commits
      const unpushed = execSync(`git log ${trackingBranch}..HEAD --oneline`, {
        cwd: resolved, encoding: 'utf-8', timeout: 3000
      }).trim();
      result.pushed = unpushed.length === 0 && result.committed === 'done' ? 'done' : 'pending';
    } catch {
      // No remote tracking branch — check if origin/master exists for main-branch fallback
      if (isMain) {
        try {
          execSync('git rev-parse --verify origin/master 2>/dev/null', {
            cwd: resolved, encoding: 'utf-8', timeout: 3000, shell: true
          });
          const unpushed = execSync('git log origin/master..HEAD --oneline', {
            cwd: resolved, encoding: 'utf-8', timeout: 3000
          }).trim();
          result.pushed = unpushed.length === 0 && result.committed === 'done' ? 'done' : 'pending';
        } catch {
          result.pushed = 'unknown';
        }
      } else {
        result.pushed = 'pending';
      }
    }

    return result;
  } catch (e) {
    return result;
  }
}

module.exports = {
  watchDirectory,
  unwatchDirectory,
  getDirectoryTree,
  getFileContent,
  getGitDiff,
  getGitStatus,
  getGitBranches,
  getBranchDiff,
  getGitPipeline
};
