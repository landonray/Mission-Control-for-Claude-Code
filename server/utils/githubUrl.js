// Parse a GitHub repo reference from common URL/shorthand formats.
// Returns { owner, repo } or null if unrecognized.
function parseGithubRepo(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const patterns = [
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    /^github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    /^([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  ];

  const nameRe = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
  for (const re of patterns) {
    const m = trimmed.match(re);
    if (m && nameRe.test(m[1]) && nameRe.test(m[2])) {
      return { owner: m[1], repo: m[2] };
    }
  }
  return null;
}

module.exports = { parseGithubRepo };
