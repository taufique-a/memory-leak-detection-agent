/**
 * Detecting whether an application requires signing in.
 *
 * No browser here - `detectAuthRequirement` only needs `.url()` and
 * `.evaluate()`, so a fake page proves the logic without paying for Chrome.
 * The real-browser proof lives in urlDiscovery.test.ts, alongside real
 * framework detection.
 */

import { detectAuthRequirement, type AuthProbePage } from '../src/core/discovery/auth';

function page(url: string, hasPasswordField: boolean): AuthProbePage {
  return {
    url: () => url,
    evaluate: async <T>(): Promise<T> => hasPasswordField as unknown as T,
  };
}

describe('detectAuthRequirement', () => {
  it('says not required, with a stated limitation, when neither signal fires', async () => {
    const result = await detectAuthRequirement(page('http://x/dashboard', false));
    expect(result.required).toBe(false);
    expect(result.evidence).toEqual([]);
    expect(result.limitation).toMatch(/checks only the one URL/);
  });

  it('treats a login-looking address as required', async () => {
    const result = await detectAuthRequirement(page('http://x/login', false));
    expect(result.required).toBe(true);
    expect(result.evidence).toEqual([
      { kind: 'runtime-global', detail: 'the page address after loading', value: 'http://x/login' },
    ]);
  });

  it('treats a password field on the page as required, even at a normal-looking address', async () => {
    const result = await detectAuthRequirement(page('http://x/', true));
    expect(result.required).toBe(true);
    expect(result.evidence).toEqual([
      { kind: 'dom-marker', detail: 'a password field is present on the page' },
    ]);
  });

  it('reports both signals when both fire, rather than stopping at the first', async () => {
    const result = await detectAuthRequirement(page('http://x/signin', true));
    expect(result.required).toBe(true);
    expect(result.evidence).toHaveLength(2);
  });

  it('does not fail when evaluate throws - a not-ready page is not evidence either way', async () => {
    const flaky: AuthProbePage = {
      url: () => 'http://x/',
      evaluate: async () => {
        throw new Error('execution context destroyed');
      },
    };
    const result = await detectAuthRequirement(flaky);
    expect(result.required).toBe(false);
  });
});
