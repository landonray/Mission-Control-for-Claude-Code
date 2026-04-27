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

    it('includes the chunk body and references the refined spec + qa plan for stage 4', () => {
      const task = builder.buildStageTask({
        stage: 4,
        pipelineName: 'Add pagination',
        refinedSpecPath: 'docs/specs/add-pagination-refined.md',
        qaPlanPath: 'docs/specs/add-pagination-qa-plan.md',
        chunk: {
          index: 2,
          name: 'API route',
          body: 'Add GET /users with pagination params.',
          files: 'server/routes/users.js',
          qaScenarios: 'pagination smoke test',
          dependencies: '1',
          complexity: 'small',
        },
      });
      expect(task).toContain('Chunk 2');
      expect(task).toContain('API route');
      expect(task).toContain('Add GET /users with pagination params.');
      expect(task).toContain('server/routes/users.js');
      expect(task).toContain('docs/specs/add-pagination-refined.md');
      expect(task).toContain('docs/specs/add-pagination-qa-plan.md');
    });

    it('builds a stage 5 task that points at the QA plan and code, with output path', () => {
      const task = builder.buildStageTask({
        stage: 5,
        pipelineName: 'Add pagination',
        refinedSpecPath: 'docs/specs/add-pagination-refined.md',
        qaPlanPath: 'docs/specs/add-pagination-qa-plan.md',
        outputPath: 'docs/specs/add-pagination-qa-report.md',
        iteration: 1,
      });
      expect(task).toContain('docs/specs/add-pagination-qa-plan.md');
      expect(task).toContain('docs/specs/add-pagination-qa-report.md');
      expect(task).toMatch(/Overall: pass/);
    });

    it('builds a stage 6 task that references the refined spec and the QA report', () => {
      const task = builder.buildStageTask({
        stage: 6,
        pipelineName: 'Add pagination',
        refinedSpecPath: 'docs/specs/add-pagination-refined.md',
        qaReportPath: 'docs/specs/add-pagination-qa-report.md',
        outputPath: 'docs/specs/add-pagination-code-review.md',
      });
      expect(task).toContain('docs/specs/add-pagination-refined.md');
      expect(task).toContain('docs/specs/add-pagination-qa-report.md');
      expect(task).toContain('docs/specs/add-pagination-code-review.md');
      expect(task).toMatch(/Blockers: 0/);
    });

    it('builds a stage 7 task pointing at QA failures and code review blockers', () => {
      const task = builder.buildStageTask({
        stage: 7,
        pipelineName: 'Add pagination',
        refinedSpecPath: 'docs/specs/add-pagination-refined.md',
        qaReportPath: 'docs/specs/add-pagination-qa-report.md',
        codeReviewPath: 'docs/specs/add-pagination-code-review.md',
        iteration: 2,
      });
      expect(task).toContain('docs/specs/add-pagination-qa-report.md');
      expect(task).toContain('docs/specs/add-pagination-code-review.md');
      expect(task).toMatch(/Fix Cycle/i);
    });
  });

  describe('outputPathFor', () => {
    it('produces the canonical output path per stage', () => {
      expect(builder.outputPathFor(1, 'add-pagination')).toBe('docs/specs/add-pagination-refined.md');
      expect(builder.outputPathFor(2, 'add-pagination')).toBe('docs/specs/add-pagination-qa-plan.md');
      expect(builder.outputPathFor(3, 'add-pagination')).toBe('docs/specs/add-pagination-build-plan.md');
      expect(builder.outputPathFor(5, 'add-pagination')).toBe('docs/specs/add-pagination-qa-report.md');
      expect(builder.outputPathFor(6, 'add-pagination')).toBe('docs/specs/add-pagination-code-review.md');
    });

    it('returns null for stages without a tracked output document (4 and 7)', () => {
      expect(builder.outputPathFor(4, 'add-pagination')).toBe(null);
      expect(builder.outputPathFor(7, 'add-pagination')).toBe(null);
    });
  });

  describe('sessionTypeForStage', () => {
    it('maps every stage to a session type', () => {
      expect(builder.sessionTypeForStage(1)).toBe('spec_refinement');
      expect(builder.sessionTypeForStage(2)).toBe('qa_design');
      expect(builder.sessionTypeForStage(3)).toBe('implementation_planning');
      expect(builder.sessionTypeForStage(4)).toBe('implementation');
      expect(builder.sessionTypeForStage(5)).toBe('qa_execution');
      expect(builder.sessionTypeForStage(6)).toBe('code_review');
      expect(builder.sessionTypeForStage(7)).toBe('implementation');
    });
  });
});
