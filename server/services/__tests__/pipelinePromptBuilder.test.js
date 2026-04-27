import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const builder = require('../pipelinePromptBuilder');

describe('pipelinePromptBuilder', () => {
  describe('buildStagePrompt', () => {
    it('combines the stage prompt with global instructions and rejection feedback if present', () => {
      const result = builder.buildStagePrompt({
        stagePrompt: 'You are stage 1.',
        rejectionFeedback: null,
      });
      expect(result).toContain('You are stage 1.');
      expect(result).toContain('Do not spawn sub-agents');
      expect(result).not.toContain('Your previous output was rejected');
    });

    it('includes rejection feedback when provided', () => {
      const result = builder.buildStagePrompt({
        stagePrompt: 'You are stage 1.',
        rejectionFeedback: 'Make it shorter and add error handling.',
      });
      expect(result).toContain('Your previous output was rejected');
      expect(result).toContain('Make it shorter and add error handling.');
    });
  });

  describe('buildStageTask', () => {
    it('includes the spec input and output path for stage 1', () => {
      const task = builder.buildStageTask({
        stage: 1,
        pipelineName: 'Add pagination',
        specInput: 'We need pagination on the users page.',
        outputPath: 'docs/specs/add-pagination-refined.md',
      });
      expect(task).toContain('Raw spec from the user');
      expect(task).toContain('We need pagination on the users page.');
      expect(task).toContain('docs/specs/add-pagination-refined.md');
    });

    it('includes the refined spec path for stage 2', () => {
      const task = builder.buildStageTask({
        stage: 2,
        pipelineName: 'Add pagination',
        refinedSpecPath: 'docs/specs/add-pagination-refined.md',
        outputPath: 'docs/specs/add-pagination-qa-plan.md',
      });
      expect(task).toContain('docs/specs/add-pagination-refined.md');
      expect(task).toContain('docs/specs/add-pagination-qa-plan.md');
    });

    it('includes both refined spec and qa plan paths for stage 3', () => {
      const task = builder.buildStageTask({
        stage: 3,
        pipelineName: 'Add pagination',
        refinedSpecPath: 'docs/specs/add-pagination-refined.md',
        qaPlanPath: 'docs/specs/add-pagination-qa-plan.md',
        outputPath: 'docs/specs/add-pagination-build-plan.md',
      });
      expect(task).toContain('docs/specs/add-pagination-refined.md');
      expect(task).toContain('docs/specs/add-pagination-qa-plan.md');
      expect(task).toContain('docs/specs/add-pagination-build-plan.md');
    });
  });

  describe('outputPathFor', () => {
    it('produces the canonical output path per stage', () => {
      expect(builder.outputPathFor(1, 'add-pagination')).toBe('docs/specs/add-pagination-refined.md');
      expect(builder.outputPathFor(2, 'add-pagination')).toBe('docs/specs/add-pagination-qa-plan.md');
      expect(builder.outputPathFor(3, 'add-pagination')).toBe('docs/specs/add-pagination-build-plan.md');
    });
  });
});
