import React from 'react';
import styles from './CodePreview.module.css';

// Simple syntax highlighting without heavy dependencies
// Falls back to plain text rendering with line numbers
export default function CodePreview({ code, language }) {
  if (!code) return null;

  const lines = code.split('\n');

  return (
    <div className={styles.container}>
      <div className={styles.languageBadge}>{language}</div>
      <pre className={styles.code}>
        <table className={styles.table}>
          <tbody>
            {lines.map((line, i) => (
              <tr key={i} className={styles.line}>
                <td className={styles.lineNumber}>{i + 1}</td>
                <td className={styles.lineContent}>
                  {highlightLine(line, language)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </pre>
    </div>
  );
}

function highlightLine(line, language) {
  // Basic keyword highlighting
  const keywords = {
    javascript: /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|default|new|this|async|await|try|catch|throw|typeof|instanceof)\b/g,
    typescript: /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|default|new|this|async|await|try|catch|throw|typeof|instanceof|interface|type|enum|implements|extends)\b/g,
    python: /\b(def|class|import|from|return|if|elif|else|for|while|try|except|finally|raise|with|as|lambda|yield|pass|break|continue|and|or|not|in|is|True|False|None)\b/g,
    go: /\b(func|package|import|return|if|else|for|range|switch|case|default|var|const|type|struct|interface|map|chan|go|defer|select)\b/g,
    rust: /\b(fn|let|mut|pub|use|mod|struct|enum|impl|trait|match|if|else|for|while|loop|return|self|Self|super|crate|async|await|where)\b/g,
    html: /(<\/?[\w-]+|\/?>)/g,
    css: /\b(color|background|border|margin|padding|display|flex|grid|position|width|height|font|text|overflow)\b/g,
  };

  const commentPattern = /\/\/.*$|#.*$|\/\*.*?\*\//g;
  const stringPattern = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
  const numberPattern = /\b(\d+\.?\d*)\b/g;

  // Simple approach: return as-is for now with basic structure
  // A full syntax highlighter would be much more complex
  let result = escapeHtml(line);

  // Highlight strings
  result = result.replace(/(&quot;(?:[^&]|&(?!quot;))*?&quot;|&#x27;(?:[^&]|&(?!#x27;))*?&#x27;)/g,
    '<span style="color: var(--success)">$1</span>');

  // Highlight comments
  result = result.replace(/(\/\/.*$)/g, '<span style="color: var(--text-muted); font-style: italic">$1</span>');
  result = result.replace(/(#.*$)/g, '<span style="color: var(--text-muted); font-style: italic">$1</span>');

  // Highlight numbers
  result = result.replace(/\b(\d+\.?\d*)\b/g, '<span style="color: var(--warning)">$1</span>');

  return <span dangerouslySetInnerHTML={{ __html: result }} />;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}
