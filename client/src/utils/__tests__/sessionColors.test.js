import { describe, it, expect } from 'vitest';
import { colorForSessionType, badgeForSessionType, labelForSessionType } from '../sessionColors';

describe('sessionColors', () => {
  it('maps planning-family types to blue', () => {
    expect(colorForSessionType('planning')).toBe('blue');
    expect(colorForSessionType('spec_refinement')).toBe('blue');
    expect(colorForSessionType('implementation_planning')).toBe('blue');
  });

  it('maps qa_design to purple', () => {
    expect(colorForSessionType('qa_design')).toBe('purple');
  });

  it('maps implementation to green', () => {
    expect(colorForSessionType('implementation')).toBe('green');
  });

  it('maps qa_execution to orange', () => {
    expect(colorForSessionType('qa_execution')).toBe('orange');
  });

  it('maps code_review to yellow', () => {
    expect(colorForSessionType('code_review')).toBe('yellow');
  });

  it('maps extraction and eval_gatherer to gray', () => {
    expect(colorForSessionType('extraction')).toBe('gray');
    expect(colorForSessionType('eval_gatherer')).toBe('gray');
  });

  it('returns the manual color for unknown / null types', () => {
    expect(colorForSessionType(null)).toBe('manual');
    expect(colorForSessionType('something_new')).toBe('manual');
  });

  it('produces single-letter badges per type family', () => {
    expect(badgeForSessionType('planning')).toBe('P');
    expect(badgeForSessionType('spec_refinement')).toBe('P');
    expect(badgeForSessionType('implementation_planning')).toBe('P');
    expect(badgeForSessionType('qa_design')).toBe('Q');
    expect(badgeForSessionType('qa_execution')).toBe('Q');
    expect(badgeForSessionType('implementation')).toBe('I');
    expect(badgeForSessionType('code_review')).toBe('R');
    expect(badgeForSessionType('extraction')).toBe('E');
    expect(badgeForSessionType('eval_gatherer')).toBe('E');
    expect(badgeForSessionType(null)).toBe('M');
  });

  it('produces human-readable labels', () => {
    expect(labelForSessionType('spec_refinement')).toBe('Spec Refinement');
    expect(labelForSessionType('qa_design')).toBe('QA Design');
    expect(labelForSessionType('implementation_planning')).toBe('Implementation Planning');
  });
});
