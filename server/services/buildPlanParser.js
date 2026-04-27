'use strict';

const CHUNK_HEADER_RE = /^##\s+Chunk\s+(\d+)\s*:\s*(.+?)\s*$/i;
const META_RE = /^-\s*([^:]+?)\s*:\s*(.*)$/;

const FIELD_KEYS = {
  files: 'files',
  'qa scenarios': 'qaScenarios',
  dependencies: 'dependencies',
  complexity: 'complexity',
};

function parseBuildPlan(text) {
  if (!text || typeof text !== 'string') {
    throw new Error('Build plan is empty');
  }

  const lines = text.split('\n');
  const chunks = [];
  let current = null;
  let inMetaBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(CHUNK_HEADER_RE);
    if (headerMatch) {
      if (current) chunks.push(finalizeChunk(current));
      current = {
        index: parseInt(headerMatch[1], 10),
        name: headerMatch[2].trim(),
        files: '',
        qaScenarios: '',
        dependencies: '',
        complexity: '',
        bodyLines: [],
      };
      inMetaBlock = true;
      continue;
    }

    if (!current) continue; // skip preamble

    if (inMetaBlock) {
      const metaMatch = line.match(META_RE);
      if (metaMatch) {
        const key = metaMatch[1].trim().toLowerCase();
        const value = metaMatch[2].trim();
        if (FIELD_KEYS[key]) {
          current[FIELD_KEYS[key]] = key === 'complexity' ? value.toLowerCase() : value;
          continue;
        }
      }
      // Blank line separates the metadata block from the body. Anything
      // that isn't a `- key: value` line ends the metadata block.
      if (line.trim() === '') {
        inMetaBlock = false;
        continue;
      }
      // A non-blank, non-metadata line ends the metadata block too. Treat
      // this line as the start of the body.
      inMetaBlock = false;
      current.bodyLines.push(line);
      continue;
    }

    current.bodyLines.push(line);
  }

  if (current) chunks.push(finalizeChunk(current));

  if (chunks.length === 0) {
    throw new Error('Build plan contains no chunks. Expected at least one "## Chunk N: ..." header.');
  }

  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].index !== i + 1) {
      throw new Error(
        `Build plan chunk numbering is out of order or non-sequential. Expected chunk ${i + 1}, got chunk ${chunks[i].index}.`
      );
    }
  }

  return chunks;
}

function finalizeChunk(chunk) {
  const body = chunk.bodyLines.join('\n').trim();
  return {
    index: chunk.index,
    name: chunk.name,
    files: chunk.files,
    qaScenarios: chunk.qaScenarios,
    dependencies: chunk.dependencies,
    complexity: chunk.complexity,
    body,
  };
}

module.exports = { parseBuildPlan };
