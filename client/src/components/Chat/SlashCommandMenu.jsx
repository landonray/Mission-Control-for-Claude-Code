import React, { useState, useEffect, useRef, useCallback, forwardRef, useImperativeHandle } from 'react';
import { api } from '../../utils/api';
import { Zap } from 'lucide-react';
import styles from './SlashCommandMenu.module.css';

const SlashCommandMenu = forwardRef(function SlashCommandMenu({ input, onSelect, visible }, ref) {
  const [commands, setCommands] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuElRef = useRef(null);

  // Load commands on mount and when menu becomes visible
  useEffect(() => {
    if (visible) {
      api.get('/api/slash-commands').then(res => {
        setCommands(res.commands);
      }).catch(() => {});
    }
  }, [visible]);

  // Filter commands based on input
  useEffect(() => {
    if (!visible || !input.startsWith('/')) {
      setFiltered([]);
      return;
    }
    const query = input.slice(1).toLowerCase();
    const matches = commands.filter(cmd =>
      cmd.name.toLowerCase().includes(query)
    );
    setFiltered(matches);
    setSelectedIndex(0);
  }, [input, commands, visible]);

  // Scroll selected item into view
  useEffect(() => {
    if (menuElRef.current && filtered.length > 0) {
      const items = menuElRef.current.querySelectorAll('[data-item]');
      if (items[selectedIndex]) {
        items[selectedIndex].scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex, filtered]);

  // Expose handleKeyDown to parent via ref
  useImperativeHandle(ref, () => ({
    handleKeyDown(e) {
      if (!visible || filtered.length === 0) return false;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(i => (i + 1) % filtered.length);
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(i => (i - 1 + filtered.length) % filtered.length);
        return true;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        onSelect(filtered[selectedIndex]);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        onSelect(null);
        return true;
      }
      return false;
    }
  }), [visible, filtered, selectedIndex, onSelect]);

  if (!visible || filtered.length === 0) return null;

  return (
    <div className={styles.menu} ref={menuElRef}>
      {filtered.map((cmd, i) => (
        <div
          key={cmd.id}
          data-item
          className={`${styles.item} ${i === selectedIndex ? styles.selected : ''}`}
          onMouseEnter={() => setSelectedIndex(i)}
          onMouseDown={(e) => {
            e.preventDefault(); // Prevent textarea blur
            onSelect(cmd);
          }}
        >
          <div className={styles.itemLeft}>
            <Zap size={14} className={styles.icon} />
            <span className={styles.name}>/{cmd.name}</span>
          </div>
          <span className={styles.message}>{cmd.message}</span>
        </div>
      ))}
    </div>
  );
});

export default SlashCommandMenu;
