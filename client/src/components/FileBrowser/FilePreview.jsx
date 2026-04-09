import React, { useState } from 'react';
import { getExtensionLanguage, formatFileSize } from '../../utils/format';
import CodePreview from './CodePreview';
import CodeEditor from './CodeEditor';
import MarkdownPreview from './MarkdownPreview';
import { Image, FileText, File, AlertCircle, Pencil } from 'lucide-react';
import styles from './FilePreview.module.css';

export default function FilePreview({ content, filePath, onFileSaved }) {
  const [editing, setEditing] = useState(false);

  if (!content) return null;

  const fileName = filePath?.split('/').pop() || 'unknown';
  const ext = filePath ? '.' + filePath.split('.').pop() : '';
  const isEditable = content.type === 'text' || content.type === 'markdown' || content.type === 'html';

  const renderContent = () => {
    switch (content.type) {
      case 'image':
        return (
          <div className={styles.imageContainer}>
            <img src={content.content} alt={fileName} className={styles.image} />
          </div>
        );

      case 'html':
        return (
          <div className={styles.htmlContainer}>
            <div className={styles.previewLabel}>HTML Preview</div>
            <iframe
              srcDoc={content.content}
              className={styles.iframe}
              sandbox="allow-scripts"
              title="HTML Preview"
            />
            <details className={styles.sourceToggle}>
              <summary>View Source</summary>
              <CodePreview code={content.content} language="html" />
            </details>
          </div>
        );

      case 'markdown':
        return (
          <div className={styles.markdownContainer}>
            <MarkdownPreview content={content.content} />
            <details className={styles.sourceToggle}>
              <summary>View Source</summary>
              <CodePreview code={content.content} language="markdown" />
            </details>
          </div>
        );

      case 'text':
        return (
          <CodePreview
            code={content.content}
            language={getExtensionLanguage(content.extension || ext)}
          />
        );

      case 'binary':
        return (
          <div className={styles.binaryMessage}>
            <File size={32} />
            <p>Binary file ({formatFileSize(content.size)})</p>
            <p className={styles.muted}>Cannot display binary files</p>
          </div>
        );

      case 'error':
        return (
          <div className={styles.errorMessage}>
            <AlertCircle size={24} />
            <p>{content.content}</p>
          </div>
        );

      default:
        return <pre className={styles.raw}>{content.content}</pre>;
    }
  };

  return (
    <div className={styles.preview}>
      <div className={styles.header}>
        <span className={styles.fileName}>{fileName}</span>
        {content.size != null && (
          <span className={styles.fileSize}>{formatFileSize(content.size)}</span>
        )}
        {content.modified && (
          <span className={styles.modified}>
            Modified: {new Date(content.modified).toLocaleString()}
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
            code={content.content}
            filePath={filePath}
            onSave={(newContent) => {
              content.content = newContent;
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
