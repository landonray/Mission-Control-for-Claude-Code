import React, { useState, useEffect, useCallback } from 'react';
import { useApp } from '../../context/AppContext';
import { api } from '../../utils/api';
import FileTree from './FileTree';
import FilePreview from './FilePreview';
import DiffViewer from './DiffViewer';
import { FolderOpen, GitBranch, Search, FileText, GitCompare } from 'lucide-react';
import styles from './FileBrowser.module.css';

export default function FileBrowser({ directory }) {
  const { fileTree, fileTreePath, loadFileTree, sendWsMessage, selectedFile, dispatch } = useApp();
  const [searchFilter, setSearchFilter] = useState('');
  const [view, setView] = useState('tree'); // 'tree' | 'preview' | 'diff' | 'branch-diff'
  const [fileContent, setFileContent] = useState(null);
  const [diffData, setDiffData] = useState(null);
  const [branchDiffData, setBranchDiffData] = useState(null);
  const [gitStatus, setGitStatus] = useState(null);
  const [branches, setBranches] = useState([]);
  const [selectedBranch, setSelectedBranch] = useState('main');

  const dir = directory || fileTreePath;

  useEffect(() => {
    if (dir) {
      loadFileTree(dir);
      loadGitStatus(dir);
      loadBranches(dir);
      // Watch directory for changes
      sendWsMessage({ type: 'watch_directory', path: dir });
    }
  }, [dir]);

  const loadGitStatus = async (dirPath) => {
    try {
      const status = await api.get(`/api/files/git/status?path=${encodeURIComponent(dirPath)}`);
      setGitStatus(status);
    } catch (e) {}
  };

  const loadBranches = async (dirPath) => {
    try {
      const result = await api.get(`/api/files/git/branches?path=${encodeURIComponent(dirPath)}`);
      setBranches(result.branches || []);
    } catch (e) {}
  };

  const handleFileSelect = useCallback(async (filePath) => {
    dispatch({ type: 'SET_SELECTED_FILE', payload: filePath });
    try {
      const content = await api.get(`/api/files/content?path=${encodeURIComponent(filePath)}`);
      setFileContent(content);
      setView('preview');
    } catch (e) {
      setFileContent({ type: 'error', content: e.message });
      setView('preview');
    }
  }, [dispatch]);

  const handleShowDiff = useCallback(async (filePath) => {
    try {
      const result = await api.get(`/api/files/git/diff?path=${encodeURIComponent(dir)}&file=${encodeURIComponent(filePath)}`);
      setDiffData({ fileName: filePath, diff: result.diff });
      setView('diff');
    } catch (e) {}
  }, [dir]);

  const handleShowAllDiffs = useCallback(async () => {
    try {
      const result = await api.get(`/api/files/git/diff?path=${encodeURIComponent(dir)}`);
      setDiffData({ fileName: 'All Changes', diff: result.diff });
      setView('diff');
    } catch (e) {}
  }, [dir]);

  const handleShowBranchDiff = useCallback(async () => {
    try {
      const result = await api.get(`/api/files/git/branch-diff?path=${encodeURIComponent(dir)}&base=${encodeURIComponent(selectedBranch)}`);
      setBranchDiffData(result);
      setView('branch-diff');
    } catch (e) {}
  }, [dir, selectedBranch]);

  // Get modified file paths from git status
  const modifiedFiles = new Set(
    (gitStatus?.files || []).map(f => f.path)
  );

  return (
    <div className={styles.browser}>
      <div className={styles.header}>
        <h2><FolderOpen size={14} /> Files</h2>
        <div className={styles.headerActions}>
          {gitStatus?.branch && (
            <span className={styles.branch}>
              <GitBranch size={12} /> {gitStatus.branch}
            </span>
          )}
        </div>
      </div>

      {/* Search / Filter */}
      <div className={styles.search}>
        <Search size={14} />
        <input
          type="text"
          placeholder="Filter files..."
          value={searchFilter}
          onChange={e => setSearchFilter(e.target.value)}
        />
      </div>

      {/* View tabs */}
      <div className={styles.viewTabs}>
        <button
          className={`${styles.viewTab} ${view === 'tree' || view === 'preview' ? styles.activeViewTab : ''}`}
          onClick={() => setView('tree')}
        >
          <FileText size={12} /> Tree
        </button>
        <button
          className={`${styles.viewTab} ${view === 'diff' ? styles.activeViewTab : ''}`}
          onClick={handleShowAllDiffs}
        >
          <GitCompare size={12} /> Diff
        </button>
        <button
          className={`${styles.viewTab} ${view === 'branch-diff' ? styles.activeViewTab : ''}`}
          onClick={handleShowBranchDiff}
        >
          <GitBranch size={12} /> Branch
        </button>
      </div>

      {/* Branch selector for branch diff */}
      {view === 'branch-diff' && (
        <div className={styles.branchSelector}>
          <span>Compare with:</span>
          <select
            className="input"
            value={selectedBranch}
            onChange={e => setSelectedBranch(e.target.value)}
            style={{ padding: '4px 8px', fontSize: 12 }}
          >
            {branches.map(b => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
          <button className="btn btn-sm btn-secondary" onClick={handleShowBranchDiff}>
            Compare
          </button>
        </div>
      )}

      {/* Content area */}
      <div className={styles.content}>
        {(view === 'tree') && (
          <FileTree
            tree={fileTree || []}
            filter={searchFilter}
            modifiedFiles={modifiedFiles}
            onSelect={handleFileSelect}
            onDiff={handleShowDiff}
          />
        )}

        {view === 'preview' && fileContent && (
          <div className={styles.previewWrapper}>
            <button className="btn btn-ghost btn-sm" onClick={() => setView('tree')} style={{ marginBottom: 8 }}>
              Back to tree
            </button>
            <FilePreview
              content={fileContent}
              filePath={selectedFile}
            />
          </div>
        )}

        {view === 'diff' && diffData && (
          <DiffViewer
            fileName={diffData.fileName}
            diff={diffData.diff}
          />
        )}

        {view === 'branch-diff' && branchDiffData && (
          <div>
            <div className={styles.branchDiffHeader}>
              <span>{branchDiffData.currentBranch} vs {branchDiffData.baseBranch}</span>
            </div>
            {branchDiffData.diffStat && (
              <pre className={styles.diffStat}>{branchDiffData.diffStat}</pre>
            )}
            <DiffViewer fileName="Branch Comparison" diff={branchDiffData.diff} />
          </div>
        )}

        {!fileTree && view === 'tree' && (
          <div className="empty-state" style={{ padding: '24px 16px' }}>
            <FolderOpen size={24} />
            <p style={{ fontSize: 13 }}>No directory loaded</p>
          </div>
        )}
      </div>
    </div>
  );
}
