import React, { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronRight, ChevronDown, File, Folder, FolderOpen, GitCompare } from 'lucide-react';
import { formatFileSize } from '../../utils/format';
import styles from './FileTree.module.css';

function FileTreeNode({ node, depth = 0, filter, modifiedFiles, onSelect, onDiff, expandedPaths, onToggleExpand }) {
  const isModified = modifiedFiles.has(node.path) || modifiedFiles.has(node.name);
  const isDirectory = node.type === 'directory';
  const expanded = isDirectory && (expandedPaths.has(node.path) || false);

  // Filter logic
  if (filter && !isDirectory) {
    if (!node.name.toLowerCase().includes(filter.toLowerCase())) {
      return null;
    }
  }

  if (filter && isDirectory && node.children) {
    const hasMatch = hasMatchingChild(node, filter);
    if (!hasMatch) return null;
  }

  const handleClick = () => {
    if (isDirectory) {
      onToggleExpand(node.path);
    } else {
      onSelect(node.path);
    }
  };

  return (
    <div>
      <div
        className={`${styles.node} ${isModified ? styles.modified : ''}`}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={handleClick}
      >
        {isDirectory ? (
          <>
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {expanded ? <FolderOpen size={14} className={styles.folderIcon} /> : <Folder size={14} className={styles.folderIcon} />}
          </>
        ) : (
          <>
            <span style={{ width: 14 }} />
            <File size={14} className={styles.fileIcon} />
          </>
        )}

        <span className={styles.name}>{node.name}</span>

        {isModified && (
          <span className={styles.modifiedDot} title="Modified" />
        )}

        {!isDirectory && node.size != null && (
          <span className={styles.size}>{formatFileSize(node.size)}</span>
        )}

        {isModified && !isDirectory && (
          <button
            className={styles.diffBtn}
            onClick={(e) => { e.stopPropagation(); onDiff(node.path); }}
            title="View diff"
          >
            <GitCompare size={12} />
          </button>
        )}
      </div>

      {isDirectory && expanded && node.children && (
        <div>
          {node.children.map((child, i) => (
            <FileTreeNode
              key={child.name + i}
              node={child}
              depth={depth + 1}
              filter={filter}
              modifiedFiles={modifiedFiles}
              onSelect={onSelect}
              onDiff={onDiff}
              expandedPaths={expandedPaths}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function hasMatchingChild(node, filter) {
  if (!node.children) return false;
  return node.children.some(child => {
    if (child.type === 'directory') return hasMatchingChild(child, filter);
    return child.name.toLowerCase().includes(filter.toLowerCase());
  });
}

function getStorageKey(sessionId) {
  return sessionId ? `file-tree-expanded-${sessionId}` : 'file-tree-expanded';
}

function loadExpandedPaths(sessionId) {
  try {
    const stored = sessionStorage.getItem(getStorageKey(sessionId));
    if (stored) {
      return new Set(JSON.parse(stored));
    }
  } catch (e) {}
  return new Set();
}

function saveExpandedPaths(sessionId, paths) {
  try {
    sessionStorage.setItem(getStorageKey(sessionId), JSON.stringify([...paths]));
  } catch (e) {}
}

export default function FileTree({ tree, filter, modifiedFiles, onSelect, onDiff, sessionId }) {
  const [expandedPaths, setExpandedPaths] = useState(() => loadExpandedPaths(sessionId));
  const prevSessionIdRef = useRef(sessionId);

  // Reload expanded paths when session changes
  useEffect(() => {
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId;
      setExpandedPaths(loadExpandedPaths(sessionId));
    }
  }, [sessionId]);

  const handleToggleExpand = useCallback((path) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      saveExpandedPaths(sessionId, next);
      return next;
    });
  }, [sessionId]);

  if (!tree || tree.length === 0) {
    return (
      <div className="empty-state" style={{ padding: '16px' }}>
        <p style={{ fontSize: 12 }}>No files found</p>
      </div>
    );
  }

  return (
    <div className={styles.tree}>
      {tree.map((node, i) => (
        <FileTreeNode
          key={node.name + i}
          node={node}
          depth={0}
          filter={filter}
          modifiedFiles={modifiedFiles}
          onSelect={onSelect}
          onDiff={onDiff}
          expandedPaths={expandedPaths}
          onToggleExpand={handleToggleExpand}
        />
      ))}
    </div>
  );
}
