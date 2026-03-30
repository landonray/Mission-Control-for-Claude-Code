import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useWebSocket } from '../../hooks/useWebSocket';
import { useApp } from '../../context/AppContext';
import { api } from '../../utils/api';
import MessageList from './MessageList';
import PermissionPrompt from './PermissionPrompt';
import SessionControls from './SessionControls';
import ContextIndicator from './ContextIndicator';
import QualityScorecard from '../Quality/QualityScorecard';
import { Send, Loader, RotateCcw, Pencil, Check, X, GitBranch, Paperclip, Upload, FileIcon, Image as ImageIcon, X as XIcon } from 'lucide-react';
import styles from './ChatInterface.module.css';

export default function ChatInterface({ sessionId }) {
  const { sessions, loadSessions } = useApp();
  const session = sessions.find(s => s.id === sessionId);
  const {
    messages, setMessages, status, errorMessage, pendingPermission,
    streamEvents, sendMessage, approvePermission, resuming
  } = useWebSocket(sessionId);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const nameInputRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const dragCounterRef = useRef(0);

  // Load existing messages
  useEffect(() => {
    async function loadMessages() {
      try {
        const result = await api.get(`/api/sessions/${sessionId}/messages`);
        setMessages(result.messages.map(m => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : null,
          attachments: m.attachments ? JSON.parse(m.attachments) : null,
        })));
      } catch (e) {}
      setLoading(false);
    }
    loadMessages();
  }, [sessionId]);

  const isEnded = status === 'ended';

  const handleFiles = useCallback(async (files) => {
    if (!files || files.length === 0) return;

    const fileArray = Array.from(files);

    // Validate file sizes (20MB max each)
    const oversized = fileArray.filter(f => f.size > 20 * 1024 * 1024);
    if (oversized.length > 0) {
      alert(`Files too large (max 20MB): ${oversized.map(f => f.name).join(', ')}`);
      return;
    }

    setUploading(true);
    try {
      const result = await api.uploadFiles(fileArray);
      setAttachments(prev => [...prev, ...result.files]);
    } catch (e) {
      alert(`Upload failed: ${e.message}`);
    }
    setUploading(false);

    // Focus textarea after upload
    textareaRef.current?.focus();
  }, []);

  const removeAttachment = useCallback((index) => {
    setAttachments(prev => {
      const removed = prev[index];
      // Delete from server
      if (removed) {
        api.delete(`/api/uploads/${removed.filename}`).catch(() => {});
      }
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const handleSend = () => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;

    // Build message content including attachment references
    let messageContent = text;
    if (attachments.length > 0) {
      const attachmentText = attachments.map(a => {
        if (a.isImage) {
          return `[Attached image: ${a.originalName}](${a.url})`;
        }
        return `[Attached file: ${a.originalName}](${a.url})`;
      }).join('\n');

      messageContent = attachments.length > 0 && text
        ? `${text}\n\n${attachmentText}`
        : attachmentText;
    }

    sendMessage(messageContent, attachments);
    setInput('');
    setAttachments([]);

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const startEditing = () => {
    setNameInput(session?.name || '');
    setEditingName(true);
    setTimeout(() => nameInputRef.current?.focus(), 0);
  };

  const saveName = async () => {
    const trimmed = nameInput.trim();
    if (trimmed && trimmed !== session?.name) {
      try {
        await api.put(`/api/sessions/${sessionId}/name`, { name: trimmed });
        await loadSessions();
      } catch (e) {}
    }
    setEditingName(false);
  };

  const cancelEditing = () => {
    setEditingName(false);
  };

  const handleNameKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveName();
    } else if (e.key === 'Escape') {
      cancelEditing();
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextareaChange = (e) => {
    setInput(e.target.value);
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  };

  const handleFileInputChange = (e) => {
    handleFiles(e.target.files);
    // Reset so the same file can be selected again
    e.target.value = '';
  };

  // Drag and drop handlers
  const handleDragEnter = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (e.dataTransfer.types.includes('Files')) {
      setDragOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current--;
    if (dragCounterRef.current === 0) {
      setDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setDragOver(false);

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      handleFiles(files);
    }
  }, [handleFiles]);

  // Paste handler for images
  const handlePaste = useCallback((e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const files = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      handleFiles(files);
    }
  }, [handleFiles]);

  const formatFileSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div
      className={`${styles.chat} ${dragOver ? styles.dragOver : ''}`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {dragOver && (
        <div className={styles.dragOverlay}>
          <Upload size={48} />
          <span>Drop files here to attach</span>
        </div>
      )}

      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          {editingName ? (
            <div className={styles.nameEdit}>
              <input
                ref={nameInputRef}
                className={styles.nameInput}
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onKeyDown={handleNameKeyDown}
                onBlur={saveName}
              />
              <button className="btn-ghost btn-icon" onMouseDown={e => { e.preventDefault(); saveName(); }}>
                <Check size={14} />
              </button>
              <button className="btn-ghost btn-icon" onMouseDown={e => { e.preventDefault(); cancelEditing(); }}>
                <X size={14} />
              </button>
            </div>
          ) : (
            <div className={styles.nameDisplay} onClick={startEditing}>
              <h2 className={styles.title}>{session?.name || 'Session'}</h2>
              <Pencil size={12} className={styles.editIcon} />
            </div>
          )}
          {session?.worktree_name && (
            <span className="badge" title="Worktree" style={{ gap: 4, display: 'inline-flex', alignItems: 'center' }}>
              <GitBranch size={10} />
              {session.worktree_name}
            </span>
          )}
          <span className={`badge badge-${status}`}>{status}</span>
        </div>
        <div className={styles.headerRight}>
          <ContextIndicator usage={session?.context_window_usage || 0} />
          <SessionControls sessionId={sessionId} status={status} session={session} />
        </div>
      </div>

      {/* Quality Scorecard */}
      <div style={{ padding: '0 16px', flexShrink: 0 }}>
        <QualityScorecard sessionId={sessionId} />
      </div>

      {/* Resume Indicator */}
      {resuming && (
        <div className={styles.resumeIndicator}>
          <RotateCcw size={14} className="animate-spin" />
          <span>Restoring session context…</span>
        </div>
      )}

      {/* Messages */}
      <MessageList messages={messages} loading={loading} streamEvents={streamEvents} />

      {/* Permission Prompt */}
      {pendingPermission && (
        <PermissionPrompt
          permission={pendingPermission}
          onApprove={() => approvePermission(true)}
          onDeny={() => approvePermission(false)}
        />
      )}

      {/* Attachment previews */}
      {attachments.length > 0 && (
        <div className={styles.attachmentBar}>
          {attachments.map((file, i) => (
            <div key={file.id} className={styles.attachmentPreview}>
              {file.isImage ? (
                <img src={file.url} alt={file.originalName} className={styles.attachmentThumb} />
              ) : (
                <div className={styles.attachmentFileIcon}>
                  <FileIcon size={20} />
                </div>
              )}
              <div className={styles.attachmentInfo}>
                <span className={styles.attachmentName}>{file.originalName}</span>
                <span className={styles.attachmentSize}>{formatFileSize(file.size)}</span>
              </div>
              <button
                className={styles.attachmentRemove}
                onClick={() => removeAttachment(i)}
                title="Remove"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input — always active for ended sessions (triggers resume) */}
      <div className={styles.inputArea}>
        <div className={styles.inputWrapper}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileInputChange}
            style={{ display: 'none' }}
            accept="image/*,.pdf,.txt,.md,.csv,.json,.js,.ts,.jsx,.tsx,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.css,.html,.xml,.yaml,.yml,.toml,.sh,.sql,.zip,.gz"
          />
          <button
            className={`btn-ghost btn-icon ${styles.attachBtn}`}
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            title="Attach files"
          >
            {uploading ? <Loader size={16} className="animate-spin" /> : <Paperclip size={16} />}
          </button>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={input}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              status === 'error'
                ? `Error: ${errorMessage || 'unknown error'}. Send a message to retry...`
                : isEnded
                  ? 'Type a message to resume this session...'
                  : 'Send a message... (Enter to send, Shift+Enter for new line)'
            }
            rows={1}
          />
          <button
            className={`btn btn-primary ${styles.sendBtn}`}
            onClick={handleSend}
            disabled={!input.trim() && attachments.length === 0}
          >
            {status === 'working' || resuming
              ? <Loader size={16} className="animate-spin" />
              : isEnded
                ? <RotateCcw size={16} />
                : <Send size={16} />
            }
          </button>
        </div>
      </div>
    </div>
  );
}
