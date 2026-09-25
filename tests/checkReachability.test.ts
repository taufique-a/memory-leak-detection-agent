/**
 * "Nothing is answering there" - and what to tell the person.
 *
 * The rules that matter: only this machine's loopback is ever probed (never
 * whatever host the person typed), the same port answering on another
 * loopback address is called out as such, and a real refused port and a
 * real listening server both behave as described.
 */

import * as http from 'node:http';
import * as net from 'node:net';

import { COMMON_DEV_PORTS, describeUnreachable, findRunningApps, isLoopbackHost, probePort, type PortProbe } from '../src/check/reachability';

function fakeProbe(open: Array<[string, number]>): { probe: PortProbe; calls: Array<[string, number]> } {
  const calls: Array<[string, number]> = [];
  return {
    calls,
    probe: async (host, port) => {
      calls.push([host, port]);
      return open.some(([h, p]) => h === host && p === port);
    },
  };
}

describe('loopback only', () => {
  it('recognises loopback names', () => {
    for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]', 'app.localhost']) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ['example.com', '10.0.0.5', '192.168.1.10', 'localhost.evil.com']) expect(isLoopbackHost(h)).toBe(false);
  });

  it('never probes anything for an address that is not loopback', async () => {
    const { probe, calls } = fakeProbe([['127.0.0.1', 4200]]);
    expect(await findRunningApps('http://intranet.corp:4200/', probe)).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('what is answering', () => {
  it('points at another port when something else is up', async () => {
    const { probe } = fakeProbe([['::1', 4300]]);
    const found = await findRunningApps('http://localhost:4200/', probe);
    expect(found.map((f) => f.url)).toEqual(['http://localhost:4300/']);
    expect(found[0]?.why).toMatch(/port 4300/);
  });

  it('calls out the same port answering on IPv6 loopback only', async () => {
    const { probe } = fakeProbe([['::1', 4200]]);
    const found = await findRunningApps('http://localhost:4200/', probe);
    expect(found[0]?.url).toBe('http://[::1]:4200/');
    expect(found[0]?.why).toMatch(/IPv6 loopback/);
  });

  it('checks the failed port and every common dev port, on both loopback addresses', async () => {
    const { probe, calls } = fakeProbe([]);
    await findRunningApps('http://localhost:9999/', probe);
    const ports = new Set(calls.map(([, p]) => p));
    expect(ports.has(9999)).toBe(true);
    for (const p of COMMON_DEV_PORTS) expect(ports.has(p)).toBe(true);
    expect(new Set(calls.map(([h]) => h))).toEqual(new Set(['127.0.0.1', '::1']));
  });

  it('says plainly to start the app when nothing at all answers', async () => {
    const d = await describeUnreachable('http://localhost:4200/', fakeProbe([]).probe);
    expect(d.found).toEqual([]);
    expect(d.message).toMatch(/Nothing is answering at http:\/\/localhost:4200\/\. Start the application first/);
  });

  it('names the address that does answer', async () => {
    const d = await describeUnreachable('http://localhost:4200/', fakeProbe([['127.0.0.1', 4300]]).probe);
    expect(d.message).toMatch(/something is answering here: http:\/\/localhost:4300\//);
    expect(d.short).toMatch(/but http:\/\/localhost:4300\/ does/);
  });
});

describe('the real probe', () => {
  it('sees a listening server and a refused port', async () => {
    const server = http.createServer((_q, r) => r.end('x'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const open = (server.address() as net.AddressInfo).port;
    expect(await probePort('127.0.0.1', open)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await probePort('127.0.0.1', open)).toBe(false);
  });
});
