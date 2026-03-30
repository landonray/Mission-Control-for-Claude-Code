import React, { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import PreviewPanel from './PreviewPanel';

export default function MobilePreview() {
  const { id } = useParams();
  const { dispatch } = useApp();

  useEffect(() => {
    if (id) {
      dispatch({ type: 'SET_ACTIVE_SESSION', payload: id });
    }
  }, [id, dispatch]);

  return (
    <div style={{ height: '100%', overflow: 'hidden' }}>
      <PreviewPanel sessionId={id} />
    </div>
  );
}
