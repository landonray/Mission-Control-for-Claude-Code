import React, { useState } from 'react';
import { getExtensionLanguage, formatFileSize } from '../../utils/format';
import CodePreview from './CodePreview';
import CodeEditor from './CodeEditor';
import MarkdownPreview from './MarkdownPreview';
import { Image, FileText, File, AlertCircle, Pencil } from 'lucide-react';
import styles from './FilePreview.module.css';

export default function FilePreview({ content, filePath, onFileSaved }) {
  const [editing, setEditing] = useState(false);
  const [localContent, setLocalContent] = useState(null);

  if (!content) return null;

  // Use locally-saved content if available, otherwise use prop
  const displayContent = localContent !== null ? { ...content, content: localContent } : content;
  const fileName = filePath?.split('/').pop() || 'unknown';
  const ext = filePath ? '.' + filePath.split('.').pop() : '';
  const isEditable = content.type === 'text' || content.type === 'markdown' || content.type === 'html';

  const renderContent = () => {
    switch (displayContent.type) {
      case 'image':
        return (
          <div className={styles.imageContainer}>
            <img src={displayContent.content} alt={fileName} className={styles.image} />
          </div>
        );

      case 'html':
        return (
          <div className={styles.htmlContainer}>
            <div className={styles.previewLabel}>HTML Preview</div>
            <iframe
              srcDoc={displayContent.content}
              className={styles.iframe}
              sandbox="allow-scripts"
              title="HTML Preview"
            />
            <details className={styles.sourceToggle}>
              <summary>View Source</summary>
              <CodePreview code={displayContent.content} language="html" />
            </details>
          </div>
        );

      case 'markdown':
        return (
          <div className={styles.markdownContainer}>
            <MarkdownPreview content={displayContent.content} />
            <details className={styles.sourceToggle}>
              <summary>View Source</summary>
              <CodePreview code={displayContent.content} language="markdown" />
            </details>
          </div>
        );

      case 'text':
        return (
          <CodePreview
            code={displayContent.content}
            language={getExtensionLanguage(displayContent.extension || ext)}
          />
        );

      case 'binary':
        return (
          <div className={styles.binaryMessage}>
            <File size={32} />
            <p>Binary file ({formatFileSize(displayContent.size)})</p>
            <p className={styles.muted}>Cannot display binary files</p>
          </div>
        );

      case 'error':
        return (
          <div className={styles.errorMessage}>
            <AlertCircle size={24} />
            <p>{displayContent.content}</p>
          </div>
        );

      default:
        return <pre className={styles.raw}>{displayContent.content}</pre>;
    }
  };

  return (
    <div className={styles.preview}>
      <div className={styles.header}>
        <span className={styles.fileName}>{fileName}</span>
        {displayContent.size != null && (
          <span className={styles.fileSize}>{formatFileSize(displayContent.size)}</span>
        )}
        {displayContent.modified && (
          <span className={styles.modified}>
            Modified: {new Date(displayContent.modified).toLocaleString()}
          </span>
        )}
        {isEditable && !editing && (
          <button
            className={`btn btn-sm btn-ghost ${styles.editButton}`}
            onClick={() => setEditing(true)}
          >
            <Pencil size={12} /> Edit
          </button>
        )}
      </div>
      <div className={editing ? styles.bodyEditing : styles.body}>
        {editing ? (
          <CodeEditor
            code={displayContent.content}
            filePath={filePath}
            onSave={(newContent) => {
              setLocalContent(newContent);
              setEditing(false);
              if (onFileSaved) onFileSaved();
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          renderContent()
        )}
      </div>
    </div>
  );
}
