import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { parseGithubRepo } = require('../utils/githubUrl');

describe('parseGithubRepo', () => {
  it('parses https github URLs', () => {
    expect(parseGithubRepo('https://github.com/landonray/command-center'))
      .toEqual({ owner: 'landonray', repo: 'command-center' });
  });

  it('parses https github URLs with .git suffix', () => {
    expect(parseGithubRepo('https://github.com/landonray/command-center.git'))
      .toEqual({ owner: 'landonray', repo: 'command-center' });
  });

  it('parses https github URLs with trailing slash', () => {
    expect(parseGithubRepo('https://github.com/landonray/command-center/'))
      .toEqual({ owner: 'landonray', repo: 'command-center' });
  });

  it('parses http github URLs', () => {
    expect(parseGithubRepo('http://github.com/landonray/command-center'))
      .toEqual({ owner: 'landonray', repo: 'command-center' });
  });

  it('parses ssh git remotes', () => {
    expect(parseGithubRepo('git@github.com:landonray/command-center.git'))
      .toEqual({ owner: 'landonray', repo: 'command-center' });
  });

  it('parses github.com without scheme', () => {
    expect(parseGithubRepo('github.com/landonray/command-center'))
      .toEqual({ owner: 'landonray', repo: 'command-center' });
  });

  it('parses owner/repo shorthand', () => {
    expect(parseGithubRepo('landonray/command-center'))
      .toEqual({ owner: 'landonray', repo: 'command-center' });
  });

  it('trims whitespace', () => {
    expect(parseGithubRepo('  landonray/command-center  '))
      .toEqual({ owner: 'landonray', repo: 'command-center' });
  });

  it('handles repos with dots, hyphens, and underscores', () => {
    expect(parseGithubRepo('https://github.com/some-org/my_repo.js'))
      .toEqual({ owner: 'some-org', repo: 'my_repo.js' });
  });

  it('rejects empty input', () => {
    expect(parseGithubRepo('')).toBeNull();
    expect(parseGithubRepo('   ')).toBeNull();
    expect(parseGithubRepo(null)).toBeNull();
    expect(parseGithubRepo(undefined)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(parseGithubRepo(123)).toBeNull();
    expect(parseGithubRepo({})).toBeNull();
  });

  it('rejects non-github URLs', () => {
    expect(parseGithubRepo('https://gitlab.com/owner/repo')).toBeNull();
    expect(parseGithubRepo('https://bitbucket.org/owner/repo')).toBeNull();
  });

  it('rejects urls with injection characters', () => {
    expect(parseGithubRepo('owner/repo; rm -rf /')).toBeNull();
    expect(parseGithubRepo('owner/repo && ls')).toBeNull();
    expect(parseGithubRepo('owner/repo"$(whoami)')).toBeNull();
    expect(parseGithubRepo('owner/repo with spaces')).toBeNull();
  });

  it('rejects paths with extra segments', () => {
    expect(parseGithubRepo('https://github.com/owner/repo/pulls')).toBeNull();
    expect(parseGithubRepo('owner/repo/subpath')).toBeNull();
  });

  it('rejects names starting or ending with special chars', () => {
    expect(parseGithubRepo('-owner/repo')).toBeNull();
    expect(parseGithubRepo('owner/-repo')).toBeNull();
    expect(parseGithubRepo('owner/repo-')).toBeNull();
  });
});
