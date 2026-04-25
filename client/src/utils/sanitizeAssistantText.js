// Strip Claude Code sub-agent transcript markers ("[Tool: bash]\n\nTool result: ..." with
// inline "Assistant: ..." prose dividers) from assistant text. The sub-agent path emits
// these as a single text block, so our normal block-type filter doesn't catch them.
//
// Each transcript block has the shape:
//
//   [Tool: <name>]
//
//   Tool result: # <name> - <description>
//
//   Last <N> lines (full output: <N> lines, <M> tokens):
//   <output line 1>
//   ...
//
// or, when the command produced no output:
//
//   [Tool: <name>]
//
//   Tool result: # <name> - <description>
//
//   (no output)
//
// To find where a block ends we prefer boundary markers ("\nAssistant:" or the
// start of the next "\n[Tool: ..." block). The "Last N" count is only used as a
// fallback when no boundary exists (i.e. the transcript is at the end of the
// message and prose follows without an "Assistant:" divider).

const HEAD_WITH_OUTPUT = /^\[Tool:[^\]\n]{1,80}\][ \t]*\n+[ \t]*Tool result:[^\n]*\n+[ \t]*Last (\d+) lines \(full output:[^\n]*\):[ \t]*\n/;
const HEAD_NO_OUTPUT = /^\[Tool:[^\]\n]{1,80}\][ \t]*\n+[ \t]*Tool result:[^\n]*\n+[ \t]*\(no output\)[ \t]*\n?/;

function findBoundary(remaining, fromPos) {
  const a = remaining.indexOf('\nAssistant:', fromPos - 1);
  const t = remaining.indexOf('\n[Tool:', fromPos - 1);
  const candidates = [a, t].filter(x => x >= 0);
  if (candidates.length === 0) return -1;
  return Math.min(...candidates) + 1;
}

function stripTranscriptBlocks(text) {
  let result = '';
  let i = 0;
  while (i < text.length) {
    const next = text.indexOf('[Tool:', i);
    if (next === -1) {
      result += text.slice(i);
      break;
    }
    result += text.slice(i, next);
    const remaining = text.slice(next);

    const withOutput = remaining.match(HEAD_WITH_OUTPUT);
    if (withOutput) {
      const headEnd = withOutput[0].length;
      const n = parseInt(withOutput[1], 10);
      const boundary = findBoundary(remaining, headEnd);
      let blockEnd;
      if (boundary >= 0) {
        blockEnd = boundary;
      } else {
        let pos = headEnd;
        for (let k = 0; k < n; k++) {
          const nl = remaining.indexOf('\n', pos);
          if (nl === -1) { pos = remaining.length; break; }
          pos = nl + 1;
        }
        blockEnd = pos;
      }
      i = next + blockEnd;
      continue;
    }

    const noOutput = remaining.match(HEAD_NO_OUTPUT);
    if (noOutput) {
      const headEnd = noOutput[0].length;
      const boundary = findBoundary(remaining, headEnd);
      i = next + (boundary >= 0 ? boundary : headEnd);
      continue;
    }

    result += '[Tool:';
    i = next + '[Tool:'.length;
  }
  return result;
}

export function sanitizeAssistantText(text) {
  if (!text || typeof text !== 'string') return text;
  if (!text.includes('[Tool:') || !text.includes('Tool result:')) return text;

  const cleaned = stripTranscriptBlocks(text)
    .replace(/^Assistant:[ \t]*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned;
}
