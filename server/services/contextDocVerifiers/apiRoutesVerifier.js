/**
 * Extracts the canonical list of API endpoints by parsing
 * `server/index.js` for `app.use('/api/<base>', require('./routes/<file>'))`
 * mounts, then walking each route file for `router.<method>(path, ...)`
 * declarations.
 *
 * Returns one item per HTTP method+path. Used by the context-doc synthesis
 * pass to ground the doc in current code instead of trusting LLM
 * enumeration.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const INDEX_REL_PATH = 'server/index.js';
const ROUTES_DIR_REL = 'server/routes';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all'];

/**
 * Parse the Express index file for `app.use('/api/<base>', require('./routes/<file>'))`.
 * Returns array of { mount, file } where `file` is the basename without extension.
 */
function parseRouteMounts(indexContent) {
  const mounts = [];
  // Match: app.use('/api/foo', require('./routes/bar'))
  const pattern = /app\.use\(\s*['"](\/api\/[^'"]*)['"]\s*,\s*require\(\s*['"]\.\/routes\/([^'"]+)['"]/g;
  let match;
  while ((match = pattern.exec(indexContent)) !== null) {
    mounts.push({ mount: match[1], file: match[2] });
  }
  return mounts;
}

/**
 * Parse a route file's content for `router.<method>('<path>', ...)` calls.
 * Returns array of { method: 'GET', path: '/' }.
 */
function parseRouteFile(content) {
  const routes = [];
  const methodAlt = HTTP_METHODS.join('|');
  const pattern = new RegExp(`router\\.(${methodAlt})\\(\\s*['"]([^'"]+)['"]`, 'g');
  let match;
  while ((match = pattern.exec(content)) !== null) {
    routes.push({ method: match[1].toUpperCase(), path: match[2] });
  }
  return routes;
}

/**
 * Combine mount base path with the route's relative path. `/` becomes the
 * mount itself; `/foo` becomes `mount + /foo`.
 */
function joinMountAndRoute(mount, routePath) {
  if (routePath === '/' || routePath === '') return mount;
  if (routePath.startsWith('/')) return `${mount}${routePath}`;
  return `${mount}/${routePath}`;
}

async function extract(projectRoot) {
  const indexPath = path.join(projectRoot, INDEX_REL_PATH);
  if (!fs.existsSync(indexPath)) {
    return { category: 'API endpoints', items: [], notes: `${INDEX_REL_PATH} not found — skipping` };
  }
  const indexContent = await fs.promises.readFile(indexPath, 'utf8');
  const mounts = parseRouteMounts(indexContent);

  const items = [];
  const seen = new Set();

  for (const mount of mounts) {
    // Try common file extensions.
    let routeContent = null;
    let routeFilePath = null;
    for (const ext of ['.js', '.cjs', '.mjs']) {
      const candidate = path.join(projectRoot, ROUTES_DIR_REL, `${mount.file}${ext}`);
      if (fs.existsSync(candidate)) {
        routeContent = await fs.promises.readFile(candidate, 'utf8');
        routeFilePath = `${ROUTES_DIR_REL}/${mount.file}${ext}`;
        break;
      }
    }
    if (!routeContent) continue;

    const routes = parseRouteFile(routeContent);
    for (const r of routes) {
      const fullPath = joinMountAndRoute(mount.mount, r.path);
      const key = `${r.method} ${fullPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ name: key, description: `defined in ${routeFilePath}` });
    }
  }

  // Sort for deterministic output.
  items.sort((a, b) => a.name.localeCompare(b.name));

  return {
    category: 'API endpoints',
    items,
    notes: items.length === 0 ? `parsed ${INDEX_REL_PATH} but found no routes` : undefined,
  };
}

module.exports = { extract, parseRouteMounts, parseRouteFile, joinMountAndRoute, INDEX_REL_PATH, ROUTES_DIR_REL };
