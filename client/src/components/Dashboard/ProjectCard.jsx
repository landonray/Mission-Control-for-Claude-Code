import React from 'react';
import { Folder, Globe, Clock, Plane, Server } from 'lucide-react';
import styles from './ProjectCard.module.css';

const iconMap = { globe: Globe, clock: Clock, plane: Plane, server: Server, folder: Folder };

export default function ProjectCard({ project, onClick, disabled }) {
  const Icon = (project.preset?.icon && iconMap[project.preset.icon]) || Folder;
  const displayName = project.preset?.name || project.name;

  return (
    <button
      className={styles.card}
      onClick={onClick}
      disabled={disabled}
      title={project.path}
    >
      <Icon size={24} />
      <span className={styles.name}>{displayName}</span>
      <span className={styles.path}>{project.path}</span>
    </button>
  );
}
