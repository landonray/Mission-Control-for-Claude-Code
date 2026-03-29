import React, { useState } from 'react';
import { parseDiff } from '../../utils/format';
import { Columns, AlignJustify } from 'lucide-react';
import styles from './DiffViewer.module.css';

export default function DiffViewer({ fileName, diff }) {
  const [mode, setMode] = useState('inline'); // 'inline' | 'side-by-side'
  const files = parseDiff(diff);

  if (!diff || !diff.trim()) {
    return (
      <div className="empty-state" style={{ padding: '24px 16px' }}>
        <p style={{ fontSize: 13 }}>No changes to display</p>
      </div>
    );
  }

  return (
    <div className={styles.viewer}>
      <div className={styles.toolbar}>
        <span className={styles.fileName}>{fileName}</span>
        <div className={styles.modeToggle}>
          <button
            className={`${styles.modeBtn} ${mode === 'inline' ? styles.active : ''}`}
            onClick={() => setMode('inline')}
            title="Inline view"
          >
            <AlignJustify size={14} />
          </button>
          <button
            className={`${styles.modeBtn} ${mode === 'side-by-side' ? styles.active : ''}`}
            onClick={() => setMode('side-by-side')}
            title="Side-by-side view"
          >
            <Columns size={14} />
          </button>
        </div>
      </div>

      {files.map((file, fi) => (
        <div key={fi} className={styles.fileSection}>
          {files.length > 1 && (
            <div className={styles.fileHeader}>{file.fileName}</div>
          )}

          {file.hunks.map((hunk, hi) => (
            <div key={hi} className={styles.hunk}>
              <div className={styles.hunkHeader}>{hunk.header}</div>

              {mode === 'inline' ? (
                <InlineHunk hunk={hunk} />
              ) : (
                <SideBySideHunk hunk={hunk} />
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function InlineHunk({ hunk }) {
  return (
    <div className={styles.diffLines}>
      {hunk.lines.map((line, i) => (
        <div
          key={i}
          className={`${styles.diffLine} ${
            line.type === 'add' ? styles.addLine :
            line.type === 'remove' ? styles.removeLine :
            ''
          }`}
        >
          <span className={styles.linePrefix}>
            {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}
          </span>
          <span className={styles.lineText}>{line.content.substring(1)}</span>
        </div>
      ))}
    </div>
  );
}

function SideBySideHunk({ hunk }) {
  const leftLines = [];
  const rightLines = [];
  let li = 0, ri = 0;

  for (const line of hunk.lines) {
    if (line.type === 'remove') {
      leftLines.push(line);
    } else if (line.type === 'add') {
      rightLines.push(line);
    } else {
      // Pad shorter side
      while (leftLines.length < rightLines.length) {
        leftLines.push({ content: '', type: 'empty' });
      }
      while (rightLines.length < leftLines.length) {
        rightLines.push({ content: '', type: 'empty' });
      }
      leftLines.push(line);
      rightLines.push(line);
    }
  }

  // Final padding
  while (leftLines.length < rightLines.length) {
    leftLines.push({ content: '', type: 'empty' });
  }
  while (rightLines.length < leftLines.length) {
    rightLines.push({ content: '', type: 'empty' });
  }

  return (
    <div className={styles.sideBySide}>
      <div className={styles.sidePanel}>
        {leftLines.map((line, i) => (
          <div
            key={i}
            className={`${styles.diffLine} ${
              line.type === 'remove' ? styles.removeLine :
              line.type === 'empty' ? styles.emptyLine : ''
            }`}
          >
            <span className={styles.lineText}>{line.content.substring(1) || '\u00A0'}</span>
          </div>
        ))}
      </div>
      <div className={styles.sidePanel}>
        {rightLines.map((line, i) => (
          <div
            key={i}
            className={`${styles.diffLine} ${
              line.type === 'add' ? styles.addLine :
              line.type === 'empty' ? styles.emptyLine : ''
            }`}
          >
            <span className={styles.lineText}>{line.content.substring(1) || '\u00A0'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
