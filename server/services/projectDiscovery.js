import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../database.js';

const CONFIG_FILENAME = '.mission-control.yaml';

const DEFAULT_CONFIG = {
  project: {},
  evals: { folders: [] },
  quality_rules: { enabled: [], disabled: [] }
};

/**
 * Walk up the directory tree looking for .mission-control.yaml.
 * Returns the directory path where found, or null.
 */
function findProjectRoot(startDir) {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  while (true) {
    const configPath = path.join(current, CONFIG_FILENAME);
    if (fs.existsSync(configPath)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current || current === root) {
      return null;
    }
    current = parent;
  }
}

/**
 * Walk up the directory tree looking for a .git directory (the git repo root).
 * Returns the directory path where found, or null.
 */
function findGitRoot(startDir) {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  while (true) {
    const gitPath = path.join(current, '.git');
    if (fs.existsSync(gitPath)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current || current === root) {
      return null;
    }
    current = parent;
  }
}

/**
 * Create a default .mission-control.yaml at the given directory.
 * Returns true if the file was created, false if it already exists or creation failed.
 */
function createDefaultConfig(projectRoot) {
  const configPath = path.join(projectRoot, CONFIG_FILENAME);
  if (fs.existsSync(configPath)) return false;

  try {
    const content = yaml.dump(DEFAULT_CONFIG, { flowLevel: -1, lineWidth: 120 });
    fs.writeFileSync(configPath, content, 'utf8');
    return true;
  } catch (err) {
    console.warn('Failed to create default .mission-control.yaml:', err.message);
    return false;
  }
}

/**
 * Read and parse .mission-control.yaml from a project root directory.
 * Returns config with defaults for missing fields.
 */
function loadProjectConfig(projectRoot) {
  const configPath = path.join(projectRoot, CONFIG_FILENAME);
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw) || {};
    return {
      project: parsed.project || {},
      evals: {
        folders: (parsed.evals && parsed.evals.folders) || [],
        ...parsed.evals,
      },
      quality_rules: {
        enabled: (parsed.quality_rules && parsed.quality_rules.enabled) || [],
        disabled: (parsed.quality_rules && parsed.quality_rules.disabled) || [],
        ...parsed.quality_rules,
      }
    };
  } catch (err) {
    // File doesn't exist or can't be read — return defaults
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Resolve a project from a working directory:
 * 1. Find project root (walk up for .mission-control.yaml)
 * 2. Load config from disk
 * 3. Check DB for existing project by root_path, create if not found
 * Returns project object with config attached, or null if no config file found.
 */
async function resolveProject(workingDirectory) {
  if (!workingDirectory) return null;

  let projectRoot = findProjectRoot(workingDirectory);

  // If no .mission-control.yaml exists but we're inside a git repo,
  // auto-create a default config so project linking and quality rules work.
  if (!projectRoot) {
    const gitRoot = findGitRoot(workingDirectory);
    if (!gitRoot) return null;
    createDefaultConfig(gitRoot);
    projectRoot = gitRoot;
  }

  const config = loadProjectConfig(projectRoot);
  const projectName = config.project.name || path.basename(projectRoot);

  // Check DB for existing project
  const existing = await query(
    'SELECT * FROM projects WHERE root_path = $1',
    [projectRoot]
  );

  if (existing.rows.length > 0) {
    const project = existing.rows[0];
    project.config = config;
    return project;
  }

  // Create new project
  const id = uuidv4();
  const result = await query(
    `INSERT INTO projects (id, name, root_path, created_at, settings)
     VALUES ($1, $2, $3, NOW(), $4)
     RETURNING *`,
    [id, projectName, projectRoot, JSON.stringify({})]
  );

  const project = result.rows[0];
  project.config = config;
  return project;
}

/**
 * Fetch a project by ID from the DB and attach config from disk.
 */
async function getProject(projectId) {
  const result = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (result.rows.length === 0) return null;

  const project = result.rows[0];
  try {
    project.config = loadProjectConfig(project.root_path);
  } catch {
    project.config = { ...DEFAULT_CONFIG };
  }
  return project;
}

/**
 * Update the settings JSONB for a project.
 */
async function updateProjectSettings(projectId, settings) {
  // Merge new settings into existing JSONB instead of overwriting,
  // so callers can update one key without wiping others.
  const result = await query(
    'UPDATE projects SET settings = COALESCE(settings, \'{}\'::jsonb) || $1::jsonb WHERE id = $2 RETURNING *',
    [JSON.stringify(settings), projectId]
  );
  if (result.rows.length === 0) return null;

  const project = result.rows[0];
  try {
    project.config = loadProjectConfig(project.root_path);
  } catch {
    project.config = { ...DEFAULT_CONFIG };
  }
  return project;
}

export {
  findProjectRoot,
  findGitRoot,
  createDefaultConfig,
  loadProjectConfig,
  resolveProject,
  getProject,
  updateProjectSettings,
  CONFIG_FILENAME,
  DEFAULT_CONFIG
};
