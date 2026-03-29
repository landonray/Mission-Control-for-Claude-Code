import React, { createContext, useContext, useReducer, useEffect, useCallback, useRef } from 'react';
import { api } from '../utils/api';

const AppContext = createContext();

const initialState = {
  sessions: [],
  activeSessionId: null,
  presets: [],
  mcpServers: [],
  notificationSettings: null,
  connected: false,
  fileTree: null,
  fileTreePath: null,
  selectedFile: null,
  showFileBrowser: true,
};

function reducer(state, action) {
  switch (action.type) {
    case 'SET_SESSIONS':
      return { ...state, sessions: action.payload };
    case 'UPDATE_SESSION': {
      const sessions = state.sessions.map(s =>
        s.id === action.payload.id ? { ...s, ...action.payload } : s
      );
      if (!sessions.find(s => s.id === action.payload.id)) {
        sessions.unshift(action.payload);
      }
      return { ...state, sessions };
    }
    case 'SET_ACTIVE_SESSION':
      return { ...state, activeSessionId: action.payload };
    case 'SET_PRESETS':
      return { ...state, presets: action.payload };
    case 'SET_MCP_SERVERS':
      return { ...state, mcpServers: action.payload };
    case 'SET_NOTIFICATION_SETTINGS':
      return { ...state, notificationSettings: action.payload };
    case 'SET_CONNECTED':
      return { ...state, connected: action.payload };
    case 'SET_FILE_TREE':
      return { ...state, fileTree: action.payload.tree, fileTreePath: action.payload.path };
    case 'SET_SELECTED_FILE':
      return { ...state, selectedFile: action.payload };
    case 'TOGGLE_FILE_BROWSER':
      return { ...state, showFileBrowser: !state.showFileBrowser };
    default:
      return state;
  }
}

export function AppProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const fileTreePathRef = useRef(null);

  // Keep ref in sync with state
  fileTreePathRef.current = state.fileTreePath;

  const connectWebSocket = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

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
    } catch (e) {}
  }, []);

  const loadPresets = useCallback(async () => {
    try {
      const presets = await api.get('/api/presets');
      dispatch({ type: 'SET_PRESETS', payload: presets });
    } catch (e) {}
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

  const loadFileTree = useCallback(async (dirPath) => {
    try {
      const result = await api.get(`/api/files/tree?path=${encodeURIComponent(dirPath)}`);
      dispatch({ type: 'SET_FILE_TREE', payload: { tree: result.tree, path: result.path } });
    } catch (e) {}
  }, []);

  useEffect(() => {
    connectWebSocket();
    loadSessions();
    loadPresets();
    loadMcpServers();
    loadNotificationSettings();

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
    loadPresets,
    loadMcpServers,
    loadNotificationSettings,
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
