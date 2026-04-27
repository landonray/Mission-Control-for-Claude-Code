import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let envPath = path.resolve(__dirname, '../../../../../../.env');
if (!existsSync(envPath)) {
  envPath = path.resolve(__dirname, '../../../../../.env');
}
dotenv.config({ path: envPath, override: true });

const require = createRequire(import.meta.url);
const crypto = require('crypto');
const fsModule = require('fs');

let query, initializeDb, repo, mcpTools, runtime;

const TEST_PROJECT_ID = `test-mcp-${crypto.randomBytes(4).toString('hex')}`;
const TEST_ROOT = `/tmp/mcp-test-${TEST_PROJECT_ID}`;

beforeAll(async () => {
  ({ query, initializeDb } = require('../../database'));
  repo = require('../pipelineRepo');
  runtime = require('../pipelineRuntime');
  mcpTools = require('../mcpTools');
  await initializeDb();
  await query(
    `INSERT INTO projects (id, name, root_path) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [TEST_PROJECT_ID, 'mcp test project', TEST_ROOT]
  );

  // Stub the orchestrator so the MCP tools don't try to spawn real sessions or
  // create git branches.
  runtime.start();
  const orch = runtime.getOrchestrator();
  orch.createAndStart = async ({ projectId, name, specInput }) => {
    const p = await repo.createPipeline({ projectId, name, specInput });
    await repo.updateStatus(p.id, { status: 'running', currentStage: 1 });
    return await repo.getPipeline(p.id);
  };
  orch.approveCurrentStage = async () => undefined;
  orch.rejectCurrentStage = async () => undefined;
});

describe('pipeline MCP tools', () => {
  beforeEach(async () => {
    await query('DELETE FROM pipelines WHERE project_id = $1', [TEST_PROJECT_ID]);
  });

  describe('mc_start_pipeline', () => {
    it('creates and starts a pipeline', async () => {
      const result = await mcpTools.startPipelineTool({
        project_id: TEST_PROJECT_ID,
        name: 'Add foo',
        spec: 'Build a foo widget.',
      });
      expect(result).toMatchObject({ status: 'running', current_stage: 1 });
      expect(result.pipeline_id).toBeDefined();
      expect(result.branch_name).toMatch(/pipeline-add-foo/);
    });

    it('errors without project_id', async () => {
      await expect(mcpTools.startPipelineTool({ name: 'X', spec: 'y' })).rejects.toThrow(/project_id/i);
    });

    it('errors without spec or spec_file', async () => {
      await expect(mcpTools.startPipelineTool({ project_id: TEST_PROJECT_ID, name: 'X' }))
        .rejects.toThrow(/spec or spec_file is required/i);
    });

    it('errors with unknown project', async () => {
      await expect(mcpTools.startPipelineTool({ project_id: 'no-such-project', name: 'X', spec: 'y' }))
        .rejects.toThrow(/Project not found/i);
    });

    describe('spec_file parameter', () => {
      let existsSpy, readSpy;

      afterEach(() => {
        existsSpy?.mockRestore();
        readSpy?.mockRestore();
      });

      it('happy path — reads file content and passes it to createAndStart', async () => {
        existsSpy = vi.spyOn(fsModule, 'existsSync').mockReturnValue(true);
        readSpy = vi.spyOn(fsModule, 'readFileSync').mockReturnValue('file content');

        const result = await mcpTools.startPipelineTool({
          project_id: TEST_PROJECT_ID,
          name: 'File pipeline',
          spec_file: 'docs/specs/feature.md',
        });

        expect(result).toMatchObject({ status: 'running', current_stage: 1 });
        expect(readSpy).toHaveBeenCalledWith(
          expect.stringContaining('docs/specs/feature.md'),
          'utf8'
        );
      });

      it('both spec and spec_file → error', async () => {
        await expect(
          mcpTools.startPipelineTool({
            project_id: TEST_PROJECT_ID,
            name: 'X',
            spec: 'raw text',
            spec_file: 'docs/spec.md',
          })
        ).rejects.toThrow(/Provide either spec or spec_file, not both/i);
      });

      it('neither spec nor spec_file → error', async () => {
        await expect(
          mcpTools.startPipelineTool({ project_id: TEST_PROJECT_ID, name: 'X' })
        ).rejects.toThrow(/spec or spec_file is required/i);
      });

      it('directory traversal via ../../../etc/passwd → traversal error', async () => {
        await expect(
          mcpTools.startPipelineTool({
            project_id: TEST_PROJECT_ID,
            name: 'X',
            spec_file: '../../../etc/passwd',
          })
        ).rejects.toThrow(/spec_file must be within the project directory/i);
      });

      it('prefix collision — path starts with root_path but not root_path+slash → traversal error', async () => {
        // e.g. root_path = /tmp/mcp-test-abc, evil resolves to /tmp/mcp-test-abcevil/secret.md
        const evilBasename = path.basename(TEST_ROOT) + 'evil';
        const evilSpecFile = '../' + evilBasename + '/secret.md';

        await expect(
          mcpTools.startPipelineTool({
            project_id: TEST_PROJECT_ID,
            name: 'X',
            spec_file: evilSpecFile,
          })
        ).rejects.toThrow(/spec_file must be within the project directory/i);
      });

      it('absolute path input → traversal error (path.resolve correctly rejects it)', async () => {
        // path.resolve(root_path, '/etc/passwd') = '/etc/passwd', which does not
        // start with root_path + '/' — only works correctly with path.resolve, not path.join
        await expect(
          mcpTools.startPipelineTool({
            project_id: TEST_PROJECT_ID,
            name: 'X',
            spec_file: '/etc/passwd',
          })
        ).rejects.toThrow(/spec_file must be within the project directory/i);
      });

      it('file not found → error message includes the original spec_file value', async () => {
        existsSpy = vi.spyOn(fsModule, 'existsSync').mockReturnValue(false);

        await expect(
          mcpTools.startPipelineTool({
            project_id: TEST_PROJECT_ID,
            name: 'X',
            spec_file: 'docs/nonexistent.md',
          })
        ).rejects.toThrow(/spec_file not found: docs\/nonexistent\.md/);
      });

      it('empty file — tool layer passes it through; createAndStart is invoked with specInput=""', async () => {
        existsSpy = vi.spyOn(fsModule, 'existsSync').mockReturnValue(true);
        readSpy = vi.spyOn(fsModule, 'readFileSync').mockReturnValue('');

        const orch = runtime.getOrchestrator();
        const createAndStartSpy = vi.spyOn(orch, 'createAndStart');

        try {
          await mcpTools.startPipelineTool({
            project_id: TEST_PROJECT_ID,
            name: 'Empty spec',
            spec_file: 'docs/empty.md',
          });
        } catch (_) {
          // The repo/orchestrator layer may reject an empty spec_input — that is expected and allowed.
        }

        expect(createAndStartSpy).toHaveBeenCalledWith(
          expect.objectContaining({ specInput: '' })
        );
        createAndStartSpy.mockRestore();
      });
    });
  });

  describe('mc_get_pipeline_status', () => {
    it('returns pipeline state with outputs, chunks, and escalations', async () => {
      const p = await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'X', specInput: 's' });
      await repo.updateStatus(p.id, { status: 'running', currentStage: 4 });
      await repo.recordStageOutput({ pipelineId: p.id, stage: 1, iteration: 1, outputPath: 'docs/specs/x-refined.md' });
      await repo.createChunks(p.id, [
        { index: 1, name: 'a', body: 'b', files: '', qaScenarios: '', dependencies: '', complexity: 'small' },
      ]);
      await repo.createEscalation({ pipelineId: p.id, stage: 4, summary: 'oops' });

      const result = await mcpTools.getPipelineStatusTool({ pipeline_id: p.id });
      expect(result.status).toBe('running');
      expect(result.current_stage).toBe(4);
      expect(result.outputs).toHaveLength(1);
      expect(result.chunks).toHaveLength(1);
      expect(result.escalations).toHaveLength(1);
    });

    it('errors for unknown pipeline', async () => {
      await expect(mcpTools.getPipelineStatusTool({ pipeline_id: 'no-such-pipeline' }))
        .rejects.toThrow(/not found/i);
    });
  });

  describe('mc_approve_stage and mc_reject_stage', () => {
    it('approve calls runtime.approveAndBroadcast', async () => {
      const spy = vi.spyOn(runtime, 'approveAndBroadcast').mockResolvedValue(undefined);
      const p = await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'Y', specInput: 's' });
      const result = await mcpTools.approveStageTool({ pipeline_id: p.id });
      expect(spy).toHaveBeenCalledWith(p.id);
      expect(result.ok).toBe(true);
      spy.mockRestore();
    });

    it('reject without feedback errors', async () => {
      await expect(mcpTools.rejectStageTool({ pipeline_id: 'p1' })).rejects.toThrow(/feedback/i);
    });

    it('reject with feedback calls runtime.rejectAndBroadcast', async () => {
      const spy = vi.spyOn(runtime, 'rejectAndBroadcast').mockResolvedValue(undefined);
      const p = await repo.createPipeline({ projectId: TEST_PROJECT_ID, name: 'Y', specInput: 's' });
      const result = await mcpTools.rejectStageTool({ pipeline_id: p.id, feedback: 'too vague' });
      expect(spy).toHaveBeenCalledWith(p.id, 'too vague');
      expect(result.ok).toBe(true);
      spy.mockRestore();
    });
  });

  describe('TOOL_DEFINITIONS', () => {
    it('registers the four pipeline tools', () => {
      const names = mcpTools.TOOL_DEFINITIONS.map((t) => t.name);
      expect(names).toContain('mc_start_pipeline');
      expect(names).toContain('mc_get_pipeline_status');
      expect(names).toContain('mc_approve_stage');
      expect(names).toContain('mc_reject_stage');
    });

    it('mc_start_pipeline schema: required is [project_id, name] and both spec and spec_file are in properties', () => {
      const tool = mcpTools.TOOL_DEFINITIONS.find((t) => t.name === 'mc_start_pipeline');
      expect(tool.inputSchema.required).toEqual(['project_id', 'name']);
      expect(tool.inputSchema.properties).toHaveProperty('spec');
      expect(tool.inputSchema.properties).toHaveProperty('spec_file');
    });
  });
});
