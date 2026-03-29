export function timeAgo(dateString) {
  if (!dateString) return 'never';

  const date = new Date(dateString);
  const now = new Date();
  const seconds = Math.floor((now - date) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;

  return date.toLocaleDateString();
}

export function formatDate(dateString) {
  if (!dateString) return '';
  return new Date(dateString).toLocaleString();
}

export function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function getContextHealthLevel(usage) {
  if (usage < 0.25) return 'light';
  if (usage < 0.5) return 'moderate';
  if (usage < 0.75) return 'heavy';
  return 'very-heavy';
}

export function getContextHealthLabel(usage) {
  const level = getContextHealthLevel(usage);
  return level.replace('-', ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function getExtensionLanguage(ext) {
  const map = {
    '.js': 'javascript',
    '.jsx': 'javascript',
    '.ts': 'typescript',
    '.tsx': 'typescript',
    '.py': 'python',
    '.rb': 'ruby',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.c': 'c',
    '.cpp': 'cpp',
    '.h': 'c',
    '.css': 'css',
    '.scss': 'scss',
    '.html': 'html',
    '.htm': 'html',
    '.xml': 'xml',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.md': 'markdown',
    '.sql': 'sql',
    '.sh': 'bash',
    '.bash': 'bash',
    '.zsh': 'bash',
    '.dockerfile': 'dockerfile',
    '.toml': 'toml',
    '.ini': 'ini',
    '.env': 'bash',
    '.swift': 'swift',
    '.kt': 'kotlin',
    '.lua': 'lua',
    '.r': 'r',
    '.php': 'php',
  };
  return map[ext?.toLowerCase()] || 'text';
}

export function parseDiff(diffText) {
  if (!diffText) return [];

  const files = [];
  const fileSections = diffText.split(/^diff --git/m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split('\n');
    const headerMatch = lines[0]?.match(/a\/(.*?) b\/(.*)/);
    const fileName = headerMatch ? headerMatch[2] : 'unknown';

    const hunks = [];
    let currentHunk = null;

    for (const line of lines) {
      if (line.startsWith('@@')) {
        if (currentHunk) hunks.push(currentHunk);
        currentHunk = { header: line, lines: [] };
      } else if (currentHunk) {
        let type = 'context';
        if (line.startsWith('+')) type = 'add';
        else if (line.startsWith('-')) type = 'remove';
        currentHunk.lines.push({ content: line, type });
      }
    }
    if (currentHunk) hunks.push(currentHunk);

    files.push({ fileName, hunks });
  }

  return files;
}
