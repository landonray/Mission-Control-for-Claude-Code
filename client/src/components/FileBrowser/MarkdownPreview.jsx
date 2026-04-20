import React, { useMemo } from 'react';
import styles from './MarkdownPreview.module.css';

// Simple markdown to HTML renderer (no heavy dependencies)
export default function MarkdownPreview({ content }) {
  const html = useMemo(() => renderMarkdown(content), [content]);

  return (
    <div
      className={styles.markdown}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function renderMarkdown(text) {
  if (!text) return '';

  let html = escapeHtml(text);

  // Code blocks (fenced)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre class="md-code-block"><code>${code.trim()}</code></pre>`;
  });

  // Tables (must run before inline formatting)
  html = html.replace(/(^\|.+\|[ ]*\n\|[\s:|-]+\|[ ]*\n(\|.+\|[ ]*\n?)*)/gm, (tableBlock) => {
    const rows = tableBlock.trim().split('\n');
    if (rows.length < 2) return tableBlock;
    const parseRow = (row) => row.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    const headers = parseRow(rows[0]);
    // Parse alignment from separator row
    const separators = parseRow(rows[1]);
    const aligns = separators.map(s => {
      if (/^:-+:$/.test(s)) return 'center';
      if (/^-+:$/.test(s)) return 'right';
      return 'left';
    });
    let table = '<table class="md-table"><thead><tr>';
    headers.forEach((h, i) => {
      table += `<th style="text-align:${aligns[i] || 'left'}">${h}</th>`;
    });
    table += '</tr></thead><tbody>';
    for (let r = 2; r < rows.length; r++) {
      if (!rows[r].trim()) continue;
      const cells = parseRow(rows[r]);
      table += '<tr>';
      cells.forEach((c, i) => {
        table += `<td style="text-align:${aligns[i] || 'left'}">${c}</td>`;
      });
      table += '</tr>';
    }
    table += '</tbody></table>';
    return table;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');

  // Headers
  html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>');
  html = html.replace(/^####\s+(.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr />');
  html = html.replace(/^\*\*\*$/gm, '<hr />');

  // Blockquotes
  html = html.replace(/^&gt;\s+(.+)$/gm, '<blockquote>$1</blockquote>');

  // List items — tag by type so unordered and ordered lists can be wrapped separately
  html = html.replace(/^[\-\*]\s+(.+)$/gm, '<li data-list="ul">$1</li>');
  html = html.replace(/^\d+\.\s+(.+)$/gm, '<li data-list="ol">$1</li>');
  html = html.replace(/(<li data-list="ul">.*<\/li>\n?)+/g, (match) =>
    '<ul>' + match.replace(/ data-list="ul"/g, '') + '</ul>'
  );
  html = html.replace(/(<li data-list="ol">.*<\/li>\n?)+/g, (match) =>
    '<ol>' + match.replace(/ data-list="ol"/g, '') + '</ol>'
  );

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Auto-link raw URLs (but not ones already inside an href or <a> tag)
  html = html.replace(/(^|[^"'>])(https?:\/\/[^\s<]+)/g, (match, prefix, url) => {
    const trailingPunct = url.match(/[.,;:!?)]+$/);
    const cleanUrl = trailingPunct ? url.slice(0, -trailingPunct[0].length) : url;
    const suffix = trailingPunct ? trailingPunct[0] : '';
    return `${prefix}<a href="${cleanUrl}" target="_blank" rel="noopener">${cleanUrl}</a>${suffix}`;
  });

  // Images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width: 100%;" />');

  // Line breaks - convert double newlines to paragraphs
  html = html.replace(/\n\n/g, '</p><p>');
  html = '<p>' + html + '</p>';

  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/<p>(<h[1-6]>)/g, '$1');
  html = html.replace(/(<\/h[1-6]>)<\/p>/g, '$1');
  html = html.replace(/<p>(<pre)/g, '$1');
  html = html.replace(/(<\/pre>)<\/p>/g, '$1');
  html = html.replace(/<p>(<ul>)/g, '$1');
  html = html.replace(/(<\/ul>)<\/p>/g, '$1');
  html = html.replace(/<p>(<ol>)/g, '$1');
  html = html.replace(/(<\/ol>)<\/p>/g, '$1');
  html = html.replace(/<p>(<blockquote>)/g, '$1');
  html = html.replace(/(<\/blockquote>)<\/p>/g, '$1');
  html = html.replace(/<p>(<hr \/>)<\/p>/g, '$1');
  html = html.replace(/<p>(<table)/g, '$1');
  html = html.replace(/(<\/table>)<\/p>/g, '$1');

  return html;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
