/**
 * Saved sign-ins, and the failure they used to be blamed for.
 *
 * WHAT HAPPENED
 * -------------
 * A run against http://localhost:7500 used a session captured at
 * http://localhost:7400 and died at the first navigation with "the saved
 * session has expired". The user had signed in twelve minutes earlier and
 * the session was perfectly good.
 *
 * A Playwright storage state holds two things with DIFFERENT scopes:
 *   cookies       scoped by domain - the port is irrelevant
 *   localStorage  scoped by ORIGIN - the port is part of it
 *
 * IOSense keeps its session in localStorage, so nothing was restored and the
 * app bounced to /login. These tests pin the distinction, because getting it
 * wrong sends people to re-enter credentials that were never the problem.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  explainSessionMismatch,
  originOf,
  readSavedSession,
  type SavedSession,
} from '../src/scenario/session';

let dir: string;

function writeState(name: string, body: unknown): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(body), 'utf8');
  return file;
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-session-'));
});

afterAll(() => {
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('readSavedSession', () => {
  it('reads the origins localStorage was captured for', () => {
    const file = writeState('a.json', {
      cookies: [{ name: 'mp', domain: 'localhost', path: '/' }],
      origins: [
        { origin: 'http://localhost:7400', localStorage: [{ name: 'urid', value: 'x' }] },
      ],
    });
    const saved = readSavedSession(file);
    expect(saved?.origins).toEqual(['http://localhost:7400']);
    expect(saved?.hasLocalStorage).toBe(true);
    expect(saved?.cookieDomains).toEqual(['localhost']);
  });

  it('reports no localStorage for a cookie-only session', () => {
    const file = writeState('cookies-only.json', {
      cookies: [{ name: 'sid', domain: 'app.test' }],
      origins: [],
    });
    expect(readSavedSession(file)?.hasLocalStorage).toBe(false);
  });

  it('survives a UTF-8 BOM', () => {
    // PowerShell's Out-File -Encoding utf8 writes one, and JSON.parse chokes.
    const file = path.join(dir, 'bom.json');
    fs.writeFileSync(file, '﻿' + JSON.stringify({ origins: [] }), 'utf8');
    expect(readSavedSession(file)).toBeDefined();
  });

  it('returns undefined rather than throwing on a missing or broken file', () => {
    expect(readSavedSession(path.join(dir, 'nope.json'))).toBeUndefined();
    const broken = path.join(dir, 'broken.json');
    fs.writeFileSync(broken, 'not json at all', 'utf8');
    expect(readSavedSession(broken)).toBeUndefined();
  });
});

describe('originOf', () => {
  it('includes the port, because that is the whole point', () => {
    expect(originOf('http://localhost:7500/login?x=1')).toBe('http://localhost:7500');
    expect(originOf('http://localhost:7400/')).toBe('http://localhost:7400');
  });

  it('returns undefined for something that is not a URL', () => {
    expect(originOf('localhost:7500')).toBeUndefined();
  });
});

describe('explainSessionMismatch', () => {
  const withLocalStorage = (origins: string[]): SavedSession => ({
    file: '.auth/app.auth.json',
    origins,
    cookieDomains: ['localhost'],
    hasLocalStorage: true,
    modifiedAt: Date.now(),
  });

  it('accepts a session captured at the same origin', () => {
    expect(
      explainSessionMismatch(withLocalStorage(['http://localhost:7500']), 'http://localhost:7500'),
    ).toBeUndefined();
  });

  it('THE REGRESSION: refuses a session captured on a different PORT', () => {
    const why = explainSessionMismatch(
      withLocalStorage(['http://localhost:7400']),
      'http://localhost:7500',
    );
    expect(why).toBeDefined();
    expect(why).toContain('http://localhost:7400');
    expect(why).toContain('http://localhost:7500');
    // The message must say the real cause, and must NOT claim expiry.
    expect(why).toContain('PORT');
    expect(why).toContain('localStorage');
    expect(why).toContain('not expired');
  });

  it('hands over the command that fixes it', () => {
    const why = explainSessionMismatch(
      withLocalStorage(['http://localhost:7400']),
      'http://localhost:7500',
    );
    expect(why).toContain('scenario login --base-url http://localhost:7500');
    expect(why).toContain('.auth/app.auth.json');
  });

  it('ALLOWS a cookie-only session on another port, because cookies ignore ports', () => {
    // Refusing here would block a perfectly working setup.
    const cookieOnly: SavedSession = {
      file: '.auth/c.auth.json',
      origins: [],
      cookieDomains: ['localhost'],
      hasLocalStorage: false,
      modifiedAt: Date.now(),
    };
    expect(explainSessionMismatch(cookieOnly, 'http://localhost:7500')).toBeUndefined();
  });

  it('distinguishes a different host from a different port', () => {
    const why = explainSessionMismatch(
      withLocalStorage(['http://staging.example.com']),
      'http://localhost:7500',
    );
    expect(why).toContain('Different origin');
    expect(why).not.toContain('Same host');
  });

  it('says nothing when the base URL will not parse', () => {
    // Not our problem to diagnose here; validation elsewhere handles it.
    expect(explainSessionMismatch(withLocalStorage(['http://x']), 'nonsense')).toBeUndefined();
  });

  it('accepts when any one of several captured origins matches', () => {
    expect(
      explainSessionMismatch(
        withLocalStorage(['http://localhost:7400', 'http://localhost:7500']),
        'http://localhost:7500',
      ),
    ).toBeUndefined();
  });
});
