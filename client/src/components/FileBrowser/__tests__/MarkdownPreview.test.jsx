// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import MarkdownPreview from '../MarkdownPreview';

vi.mock('../MarkdownPreview.module.css', () => ({
  default: new Proxy({}, { get: (_, name) => name }),
}));

describe('MarkdownPreview', () => {
  describe('table rendering', () => {
    it('renders a basic markdown table', () => {
      const md = [
        '| Name | Status |',
        '|---|---|',
        '| Alpha | Yes |',
        '| Beta | No |',
      ].join('\n');

      const { container } = render(<MarkdownPreview content={md} />);
      const table = container.querySelector('table.md-table');
      expect(table).toBeTruthy();
      expect(table.querySelectorAll('th')).toHaveLength(2);
      expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
      expect(table.querySelector('th').textContent).toBe('Name');
    });

    it('renders a table with three columns', () => {
      const md = [
        '| Eval Type | Have It? | Notes |',
        '|---|---|---|',
        '| Exact match | No | Missing |',
        '| LLM Judge | Yes | Strong |',
      ].join('\n');

      const { container } = render(<MarkdownPreview content={md} />);
      const table = container.querySelector('table.md-table');
      expect(table.querySelectorAll('th')).toHaveLength(3);
      expect(table.querySelectorAll('tbody tr')).toHaveLength(2);
    });

    it('respects column alignment', () => {
      const md = [
        '| Left | Center | Right |',
        '|:---|:---:|---:|',
        '| a | b | c |',
      ].join('\n');

      const { container } = render(<MarkdownPreview content={md} />);
      const ths = container.querySelectorAll('th');
      expect(ths[0].style.textAlign).toBe('left');
      expect(ths[1].style.textAlign).toBe('center');
      expect(ths[2].style.textAlign).toBe('right');
    });

    it('renders table alongside other markdown content', () => {
      const md = [
        '# Heading',
        '',
        'Some text before.',
        '',
        '| Col | Val |',
        '|---|---|',
        '| A | 1 |',
        '',
        'Some text after.',
      ].join('\n');

      const { container } = render(<MarkdownPreview content={md} />);
      expect(container.querySelector('h1').textContent).toBe('Heading');
      expect(container.querySelector('table.md-table')).toBeTruthy();
      expect(container.textContent).toContain('Some text before.');
      expect(container.textContent).toContain('Some text after.');
    });

    it('does not wrap table in paragraph tags', () => {
      const md = [
        '| A | B |',
        '|---|---|',
        '| 1 | 2 |',
      ].join('\n');

      const { container } = render(<MarkdownPreview content={md} />);
      const table = container.querySelector('table');
      expect(table.parentElement.tagName).not.toBe('P');
    });
  });

  describe('other markdown features still work', () => {
    it('renders headers', () => {
      const { container } = render(<MarkdownPreview content="# Hello" />);
      expect(container.querySelector('h1').textContent).toBe('Hello');
    });

    it('renders bold and italic', () => {
      const { container } = render(<MarkdownPreview content="**bold** and *italic*" />);
      expect(container.querySelector('strong').textContent).toBe('bold');
      expect(container.querySelector('em').textContent).toBe('italic');
    });

    it('renders code blocks', () => {
      const md = '```js\nconst x = 1;\n```';
      const { container } = render(<MarkdownPreview content={md} />);
      expect(container.querySelector('pre.md-code-block')).toBeTruthy();
    });
  });
});
