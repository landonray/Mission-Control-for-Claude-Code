import React, { createContext, useContext, useReducer, useEffect, useCallback, useRef } from 'react';
import { api } from '../utils/api';

const AppContext = createContext();

const initialState = {
  sessions: [],
  activeSessionId: null,
  mcpServers: [],
  notificationSettings: null,
  generalSettings: null,
  pickerAvailable: false,
  connected: false,
  fileTree: null,
  fileTreePath: null,
  selectedFile: null,
  showFileBrowser: true,
  rightPanelMode: 'files',
  previewUrls: {},
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_SESSIONS': {
      const incoming = action.payload;
      const existingMap = new Map(state.sessions.map(s => [s.id, s]));
      let anyChanged = incoming.length !== state.sessions.length;

      const merged = incoming.map(newSession => {
        const existing = existingMap.get(newSession.id);
        if (!existing) { anyChanged = true; return newSession; }
        const allKeys = new Set([...Object.keys(existing), ...Object.keys(newSession)]);
        for (const key of allKeys) {
          if (existing[key] !== newSession[key]) {
            console.log(`[SET_SESSIONS] ${newSession.id.slice(0,8)} changed: ${key}`, existing[key], '→', newSession[key]);
            anyChanged = true;
            return newSession;
          }
        }
        return existing;
      });

      if (!anyChanged) return state;
      return { ...state, sessions: merged };
    }
    case 'UPDATE_SESSION': {
      const payload = action.payload;
      let found = false;
      let changed = false;

      const sessions = state.sessions.map(s => {
        if (s.id !== payload.id) return s;
        found = true;
        const changedKeys = Object.keys(payload).filter(k => s[k] !== payload[k]);
        if (changedKeys.length === 0) return s;
        console.log(`[UPDATE_SESSION] ${payload.id.slice(0,8)} changed:`, changedKeys.map(k => `${k}: ${s[k]} → ${payload[k]}`));
        changed = true;
        return { ...s, ...payload };
      });

      if (!found) {
        return { ...state, sessions: [payload, ...sessions] };
      }
      if (!changed) return state;
      return { ...state, sessions };
    }
    case 'SET_ACTIVE_SESSION':
      return { ...state, activeSessionId: action.payload };
    case 'SET_MCP_SERVERS':
      return { ...state, mcpServers: action.payload };
    case 'SET_NOTIFICATION_SETTINGS':
      return { ...state, notificationSettings: action.payload };
    case 'SET_GENERAL_SETTINGS':
      return { ...state, generalSettings: action.payload };
    case 'SET_PICKER_AVAILABLE':
      return { ...state, pickerAvailable: action.payload };
    case 'SET_CONNECTED':
      return { ...state, connected: action.payload };
    case 'SET_FILE_TREE':
      return { ...state, fileTree: action.payload.tree, fileTreePath: action.payload.path };
    case 'SET_SELECTED_FILE':
      return { ...state, selectedFile: action.payload };
    case 'TOGGLE_FILE_BROWSER':
      return { ...state, showFileBrowser: !state.showFileBrowser };
    case 'SET_RIGHT_PANEL_MODE':
      return { ...state, rightPanelMode: action.payload };
    case 'SET_PREVIEW_URL':
      return { ...state, previewUrls: { ...state.previewUrls, [action.payload.sessionId]: action.payload.url } };
    default:
      return state;
  }
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const fileTreePathRef = useRef(null);
  const activeSessionIdRef = useRef(null);

  // Keep refs in sync with state
  fileTreePathRef.current = state.fileTreePath;
  activeSessionIdRef.current = state.activeSessionId;

  const connectWebSocket = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.hostname + ':3000';
    const authToken = import.meta.env.VITE_MC_AUTH_TOKEN;
    const wsUrl = authToken
      ? `${protocol}//${wsHost}/ws?token=${authToken}`
      : `${protocol}//${wsHost}/ws`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      dispatch({ type: 'SET_CONNECTED', payload: true });
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleWsMessage(data);
      } catch (e) {}
    };

    ws.onclose = () => {
      dispatch({ type: 'SET_CONNECTED', payload: false });
      reconnectTimeoutRef.current = setTimeout(connectWebSocket, 3000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, []);

  const handleWsMessage = useCallback((data) => {
    switch (data.type) {
      case 'sessions_status':
        if (data.sessions) {
          data.sessions.forEach(s => {
            dispatch({ type: 'UPDATE_SESSION', payload: s });
          });
        }
        break;
      case 'session_status':
        // Update global sessions list so components see status changes immediately
        if (data.sessionId && data.status) {
          dispatch({ type: 'UPDATE_SESSION', payload: { id: data.sessionId, status: data.status } });
        }
        // Also handled by session-specific listeners
        break;
      case 'session_name_updated':
        if (data.sessionId && data.name) {
          dispatch({ type: 'UPDATE_SESSION', payload: { id: data.sessionId, name: data.name } });
        }
        break;
      case 'stream_event':
      case 'user_message':
      case 'session_ended':
      case 'session_paused':
      case 'session_resumed':
      case 'error':
      case 'permission_response':
        // These are handled by session-specific listeners
        break;
      case 'file_change':
        // Refresh file tree on file changes (use ref for latest value)
        if (fileTreePathRef.current) {
          loadFileTree(fileTreePathRef.current);
        }
        break;
      case 'dev_server_detected':
        dispatch({ type: 'SET_PREVIEW_URL', payload: { sessionId: data.sessionId, url: data.url } });
        // Only auto-switch to preview tab if this is the active session
        if (data.sessionId === activeSessionIdRef.current) {
          dispatch({ type: 'SET_RIGHT_PANEL_MODE', payload: 'preview' });
        }
        break;
    }
  }, []);

  const sendWsMessage = useCallback((msg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      const sessions = await api.get('/api/sessions');
      dispatch({ type: 'SET_SESSIONS', payload: sessions });
    } catch (e) {
      console.error('[loadSessions] Failed:', e.message);
    }
  }, []);

  const loadMcpServers = useCallback(async () => {
    try {
      const servers = await api.get('/api/mcp');
      dispatch({ type: 'SET_MCP_SERVERS', payload: servers });
    } catch (e) {}
  }, []);

  const loadNotificationSettings = useCallback(async () => {
    try {
      const settings = await api.get('/api/notifications/settings');
      dispatch({ type: 'SET_NOTIFICATION_SETTINGS', payload: settings });
    } catch (e) {}
  }, []);

  const loadGeneralSettings = useCallback(async () => {
    try {
      const settings = await api.get('/api/settings/general');
      dispatch({ type: 'SET_GENERAL_SETTINGS', payload: settings });
    } catch (e) {}
  }, []);

  const loadPickerAvailable = useCallback(async () => {
    try {
      const { available } = await api.get('/api/files/picker-available');
      dispatch({ type: 'SET_PICKER_AVAILABLE', payload: available });
    } catch (e) {}
  }, []);

  const loadFileTree = useCallback(async (dirPath) => {
    try {
      const result = await api.get(`/api/files/tree?path=${encodeURIComponent(dirPath)}`);
      dispatch({ type: 'SET_FILE_TREE', payload: { tree: result.tree, path: result.path } });
    } catch (e) {}
  }, []);

  // Reload sessions whenever WebSocket (re)connects — proves server is up
  useEffect(() => {
    if (state.connected) {
      loadSessions();
    }
  }, [state.connected, loadSessions]);

  useEffect(() => {
    connectWebSocket();
    loadSessions();
    loadMcpServers();
    loadNotificationSettings();
    loadGeneralSettings();
    loadPickerAvailable();

    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    };
  }, []);

  const value = {
    ...state,
    dispatch,
    sendWsMessage,
    loadSessions,
    loadMcpServers,
    loadNotificationSettings,
    loadGeneralSettings,
    loadFileTree,
    ws: wsRef
  };

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within AppProvider');
  }
  return context;
}
