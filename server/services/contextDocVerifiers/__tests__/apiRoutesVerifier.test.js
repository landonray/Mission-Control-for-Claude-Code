import { describe, it, expect } from 'vitest';

const verifier = await import('../apiRoutesVerifier.js');

describe('apiRoutesVerifier.parseRouteMounts', () => {
  it('extracts every app.use(/api/...) registration', () => {
    const content = `
      app.use('/api/sessions', require('./routes/sessions'));
      app.use('/api/projects', require('./routes/projects'));
      app.use('/api/mcp-tokens', require('./routes/mcpTokens'));
    `;
    const mounts = verifier.parseRouteMounts(content);
    expect(mounts).toEqual([
      { mount: '/api/sessions', file: 'sessions' },
      { mount: '/api/projects', file: 'projects' },
      { mount: '/api/mcp-tokens', file: 'mcpTokens' },
    ]);
  });

  it('ignores non-api app.use calls (static, middleware)', () => {
    const content = `
      app.use(express.static(clientDist));
      app.use('/api/sessions', require('./routes/sessions'));
      app.use(cors());
    `;
    expect(verifier.parseRouteMounts(content)).toEqual([
      { mount: '/api/sessions', file: 'sessions' },
    ]);
  });
});

describe('apiRoutesVerifier.parseRouteFile', () => {
  it('extracts every router.<method>(path, ...) call', () => {
    const content = `
      router.get('/', handler);
      router.post('/create', async (req, res) => {});
      router.put('/:id', handler);
      router.delete('/:id/cleanup', handler);
      router.patch('/:id', handler);
    `;
    const routes = verifier.parseRouteFile(content);
    expect(routes).toEqual([
      { method: 'GET', path: '/' },
      { method: 'POST', path: '/create' },
      { method: 'PUT', path: '/:id' },
      { method: 'DELETE', path: '/:id/cleanup' },
      { method: 'PATCH', path: '/:id' },
    ]);
  });

  it('skips non-router method calls (e.g., app.get used in tests)', () => {
    const content = `
      router.get('/yes', x);
      something.post('/no', y);
    `;
    expect(verifier.parseRouteFile(content)).toEqual([
      { method: 'GET', path: '/yes' },
    ]);
  });
});

describe('apiRoutesVerifier.joinMountAndRoute', () => {
  it('returns the mount alone when route is "/"', () => {
    expect(verifier.joinMountAndRoute('/api/sessions', '/')).toBe('/api/sessions');
  });

  it('joins absolute route paths cleanly', () => {
    expect(verifier.joinMountAndRoute('/api/sessions', '/:id')).toBe('/api/sessions/:id');
  });

  it('handles empty route as the mount alone', () => {
    expect(verifier.joinMountAndRoute('/api/sessions', '')).toBe('/api/sessions');
  });
});

describe('apiRoutesVerifier.extract', () => {
  it('returns empty + notes when index.js is missing', async () => {
    const result = await verifier.extract('/does/not/exist');
    expect(result.category).toBe('API endpoints');
    expect(result.items).toEqual([]);
    expect(result.notes).toMatch(/not found/);
  });
});
