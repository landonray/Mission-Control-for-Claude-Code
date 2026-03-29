import React from 'react';
import { ShieldAlert, Check, X } from 'lucide-react';
import styles from './PermissionPrompt.module.css';

export default function PermissionPrompt({ permission, onApprove, onDeny }) {
  return (
    <div className={styles.prompt}>
      <div className={styles.icon}>
        <ShieldAlert size={20} />
      </div>
      <div className={styles.content}>
        <h4>Permission Required</h4>
        <p>{permission.tool || permission.message || 'Claude wants to perform an action'}</p>
        {permission.description && (
          <pre className={styles.details}>{permission.description}</pre>
        )}
      </div>
      <div className={styles.actions}>
        <button className="btn btn-success btn-sm" onClick={onApprove}>
          <Check size={14} /> Approve
        </button>
        <button className="btn btn-danger btn-sm" onClick={onDeny}>
          <X size={14} /> Deny
        </button>
      </div>
    </div>
  );
}
