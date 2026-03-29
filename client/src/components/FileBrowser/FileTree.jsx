import React, { useState, useMemo } from 'react';
import { ChevronRight, ChevronDown, File, Folder, FolderOpen, GitCompare } from 'lucide-react';
import { formatFileSize } from '../../utils/format';
import styles from './FileTree.module.css';

function FileTreeNode({ node, depth = 0, filter, modifiedFiles, onSelect, onDiff }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const isModified = modifiedFiles.has(node.path) || modifiedFiles.has(node.name);
  const isDirectory = node.type === 'directory';

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
      setExpanded(!expanded);
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

export default function FileTree({ tree, filter, modifiedFiles, onSelect, onDiff }) {
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
        />
      ))}
    </div>
  );
}
