/**
 * "Nothing is answering there" - and what to do about it.
 *
 * When the address given does not connect, the useful answer is not "is the
 * app running?" but "it is not answering at THIS address - but something is
 * answering at THAT one". A dev server often moves ports (4200 taken, so
 * 4300), or listens on IPv6 loopback only (`::1`) where `127.0.0.1` refuses.
 *
 * SAFETY: this only ever probes the machine's own loopback addresses, and
 * only when the address the person gave was loopback too. It never scans
 * another host - a tool that port-scans whatever address it is handed is
 * not something to ship.
 */

import * as net from 'node:net';

/** Ports dev servers commonly use, most likely first. */
export const COMMON_DEV_PORTS: readonly number[] = [4200, 4300, 3000, 3001, 5173, 4173, 8080, 8000, 4000, 7200, 5000, 8081, 9000];

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}

export type PortProbe = (host: string, port: number) => Promise<boolean>;

/** Does something accept a TCP connection at host:port? */
export const probePort: PortProbe = (host, port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(700, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });

export interface RunningApp {
  /** An address to give the check. */
  url: string;
  /** Why this one is worth trying. */
  why: string;
}

/**
 * Find what IS answering on this machine, for an address that was not.
 * Empty when the address was not loopback (nothing is probed then).
 */
export async function findRunningApps(failedUrl: string, probe: PortProbe = probePort): Promise<RunningApp[]> {
  let u: URL;
  try {
    u = new URL(failedUrl);
  } catch {
    return [];
  }
  if (!isLoopbackHost(u.hostname)) return [];
  const failedPort = Number(u.port || (u.protocol === 'https:' ? 443 : 80));

  const ports = [failedPort, ...COMMON_DEV_PORTS.filter((p) => p !== failedPort)];
  const answers = await Promise.all(
    ports.map(async (port) => {
      const [v4, v6] = await Promise.all([probe('127.0.0.1', port), probe('::1', port)]);
      return { port, v4, v6 };
    }),
  );

  const found: RunningApp[] = [];
  for (const a of answers) {
    if (!a.v4 && !a.v6) continue;
    if (a.port === failedPort) {
      // The same port answers on a different loopback address than the one
      // that was tried: exactly the "listens on IPv6 only" case.
      const literal = a.v6 && !a.v4 ? `${u.protocol}//[::1]:${a.port}/` : `${u.protocol}//127.0.0.1:${a.port}/`;
      found.push({ url: literal, why: `the same port answers on ${a.v6 && !a.v4 ? 'IPv6 loopback (::1) only' : '127.0.0.1'}, not on "${u.hostname}"` });
    } else {
      found.push({ url: `${u.protocol}//localhost:${a.port}/`, why: `something is answering on port ${a.port}` });
    }
  }
  return found;
}

/** One plain sentence for a person, and a short form for the status line. */
export async function describeUnreachable(
  url: string,
  probe: PortProbe = probePort,
): Promise<{ message: string; short: string; found: RunningApp[] }> {
  const found = await findRunningApps(url, probe);
  if (found.length === 0) {
    return {
      found,
      short: `nothing is answering at ${url}`,
      message:
        `Nothing is answering at ${url}. Start the application first, then run the check again ` +
        '(use the exact address you open it at in your browser).',
    };
  }
  const list = found.map((f) => `${f.url} (${f.why})`).join('; ');
  return {
    found,
    short: `nothing answers at ${url}, but ${found[0]?.url} does`,
    message: `Nothing is answering at ${url}, but something is answering here: ${list}. Run the check with one of those addresses.`,
  };
}
