import React, { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useApp } from '../../context/AppContext';
import QualityTab from './QualityTab';

export default function MobileQuality() {
  const { id } = useParams();
  const { dispatch } = useApp();

  useEffect(() => {
    if (id) {
      dispatch({ type: 'SET_ACTIVE_SESSION', payload: id });
    }
  }, [id, dispatch]);

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      <QualityTab sessionId={id} />
    </div>
  );
}
