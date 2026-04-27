import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROMPTS_DIR = path.join(__dirname, '..', '..', 'prompts', 'pipeline');

describe('default pipeline prompts', () => {
  it('has a non-empty default prompt for spec_refinement', () => {
    const content = fs.readFileSync(path.join(PROMPTS_DIR, 'spec_refinement.md'), 'utf8');
    expect(content.length).toBeGreaterThan(200);
    expect(content).toMatch(/refined spec/i);
  });

  it('has a non-empty default prompt for qa_design', () => {
    const content = fs.readFileSync(path.join(PROMPTS_DIR, 'qa_design.md'), 'utf8');
    expect(content.length).toBeGreaterThan(200);
    expect(content).toMatch(/test scenarios|qa plan/i);
  });

  it('has a non-empty default prompt for implementation_planning', () => {
    const content = fs.readFileSync(path.join(PROMPTS_DIR, 'implementation_planning.md'), 'utf8');
    expect(content.length).toBeGreaterThan(200);
    expect(content).toMatch(/build plan|chunks/i);
  });
});
