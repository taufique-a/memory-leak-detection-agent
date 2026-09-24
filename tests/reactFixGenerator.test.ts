/**
 * `proposeReactFix` - the refusal logic, and the listener-fix shape.
 *
 * The real leak this generator actually fixes is proven end to end in
 * reactFixVerified.test.ts (a real browser, a real generated patch written
 * back to a real file). What belongs here is everything that does NOT need
 * a browser: every reason this must refuse rather than guess, and a
 * precise check on the second fix shape (addEventListener) that the real
 * end-to-end test does not happen to exercise.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { proposeReactFix } from '../src/fix/react/proposeFix';
import type { GenericCorrelatedFinding } from '../src/core/correlation/correlateGeneric';
import type { AppEntity } from '../src/core/framework/types';

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'react-fix-'));
  cleanup.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return root;
}

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

function finding(over: Partial<GenericCorrelatedFinding> = {}): GenericCorrelatedFinding {
  return {
    constructorName: 'Payload',
    countDelta: 5,
    bytesDelta: 1000,
    retainingExplanation: 'x',
    outcome: 'none',
    correlationNote: 'x',
    confidence: 'HIGH',
    rationale: [],
    action: 'RECOMMENDED CHANGE',
    actionReason: 'x',
    ...over,
  };
}

function entity(over: Partial<AppEntity> = {}): AppEntity {
  return {
    name: 'Widget',
    file: 'src/Widget.jsx',
    line: 3,
    role: 'view',
    frameworkKind: 'FunctionComponent',
    routes: [],
    routed: false,
    teardown: { hook: 'useEffect cleanup return', present: false },
    resourceCount: 1,
    ...over,
  };
}

describe('proposeReactFix - refusals', () => {
  it('refuses below HIGH confidence', () => {
    const root = project({ 'src/Widget.jsx': 'function Widget() { return null; }' });
    const result = proposeReactFix(finding({ confidence: 'MEDIUM' }), entity(), { projectRoot: root });
    expect(result?.safety).toBe('manual-only');
    expect(result?.rationale).toMatch(/below HIGH/);
  });

  it('refuses a class component with no componentDidMount - nothing to pair teardown with', () => {
    const root = project({ 'src/Widget.jsx': 'class Widget extends React.Component {}' });
    const result = proposeReactFix(finding(), entity({ frameworkKind: 'ClassComponent' }), { projectRoot: root });
    expect(result?.safety).toBe('manual-only');
    expect(result?.title).toMatch(/componentWillUnmount/);
    expect(result?.rationale).toMatch(/no componentDidMount/);
  });

  it('returns undefined when the file does not exist', () => {
    const root = project({});
    const result = proposeReactFix(finding(), entity({ file: 'src/Missing.jsx' }), { projectRoot: root });
    expect(result).toBeUndefined();
  });

  it('refuses when the named component cannot be found in the file as written', () => {
    const root = project({ 'src/Widget.jsx': 'function SomethingElse() { return null; }' });
    const result = proposeReactFix(finding(), entity(), { projectRoot: root });
    expect(result?.safety).toBe('manual-only');
    expect(result?.rationale).toMatch(/could not be found/);
  });

  it('refuses when the component has no useEffect missing a cleanup at all', () => {
    const root = project({
      'src/Widget.jsx': `
        function Widget() {
          useEffect(() => { return () => {}; }, []);
          return null;
        }
      `,
    });
    const result = proposeReactFix(finding(), entity(), { projectRoot: root });
    expect(result?.safety).toBe('manual-only');
    expect(result?.rationale).toMatch(/No useEffect without a cleanup return/);
  });

  it('refuses when more than one useEffect is missing a cleanup - picking the right one needs a person', () => {
    const root = project({
      'src/Widget.jsx': `
        function Widget() {
          useEffect(() => { setInterval(() => {}, 1000); }, []);
          useEffect(() => { window.addEventListener('resize', onResize); }, []);
          return null;
        }
      `,
    });
    const result = proposeReactFix(finding(), entity(), { projectRoot: root });
    expect(result?.safety).toBe('manual-only');
    expect(result?.rationale).toMatch(/2 separate useEffect/);
  });

  it('refuses when the one effect starts two different resources - a partial fix would mislead', () => {
    const root = project({
      'src/Widget.jsx': `
        function Widget() {
          useEffect(() => {
            var id = setInterval(() => {}, 1000);
            window.addEventListener('resize', onResize);
          }, []);
          return null;
        }
      `,
    });
    const result = proposeReactFix(finding(), entity(), { projectRoot: root });
    expect(result?.safety).toBe('manual-only');
    expect(result?.rationale).toMatch(/exactly one recognised resource/);
  });

  it('refuses an inline arrow handed to addEventListener - it cannot be matched by reference to remove it', () => {
    const root = project({
      'src/Widget.jsx': `
        function Widget() {
          useEffect(() => {
            window.addEventListener('resize', () => {});
          }, []);
          return null;
        }
      `,
    });
    const result = proposeReactFix(finding(), entity(), { projectRoot: root });
    expect(result?.safety).toBe('manual-only');
  });
});

describe('proposeReactFix - the timer shape', () => {
  it('generates a correct, minimal, valid clearInterval cleanup', () => {
    const root = project({
      'src/Widget.jsx': `function Widget() {
  useEffect(() => {
    var id = setInterval(() => {}, 1000);
  }, []);
  return null;
}
`,
    });
    const result = proposeReactFix(finding(), entity(), { projectRoot: root });

    expect(result?.safety).toBe('additive');
    expect(result?.newContent).toContain('clearInterval(id)');
    expect(result?.diff).toContain('clearInterval');
    // Purely additive: every original line survives untouched.
    const before = fs.readFileSync(path.join(root, 'src/Widget.jsx'), 'utf8');
    for (const line of before.split('\n')) {
      if (line.trim() !== '') expect(result?.newContent).toContain(line);
    }
    expect(() => new Function(result?.newContent as string)).not.toThrow();
  });

  it('uses clearTimeout for setTimeout, not clearInterval', () => {
    const root = project({
      'src/Widget.jsx': `function Widget() {
  useEffect(() => {
    var id = setTimeout(() => {}, 1000);
  }, []);
  return null;
}
`,
    });
    const result = proposeReactFix(finding(), entity(), { projectRoot: root });
    expect(result?.newContent).toContain('clearTimeout(id)');
    expect(result?.newContent).not.toContain('clearInterval');
  });
});

describe('proposeReactFix - the listener shape', () => {
  it('generates a correct removeEventListener cleanup with a named handler', () => {
    const root = project({
      'src/Widget.jsx': `function onResize() {}
function Widget() {
  useEffect(() => {
    window.addEventListener('resize', onResize);
  }, []);
  return null;
}
`,
    });
    const result = proposeReactFix(finding(), entity(), { projectRoot: root });

    expect(result?.safety).toBe('additive');
    expect(result?.newContent).toContain("window.removeEventListener('resize', onResize)");
    expect(() => new Function(result?.newContent as string)).not.toThrow();
  });

  it('matches the target expression exactly, including a non-window target', () => {
    const root = project({
      'src/Widget.jsx': `function Widget() {
  useEffect(() => {
    document.addEventListener('click', onClick);
  }, []);
  return null;
}
function onClick() {}
`,
    });
    const result = proposeReactFix(finding(), entity(), { projectRoot: root });
    expect(result?.newContent).toContain("document.removeEventListener('click', onClick)");
  });
});

describe('proposeReactFix - class components (componentWillUnmount)', () => {
  const cls = (): AppEntity => entity({ frameworkKind: 'ClassComponent', teardown: { hook: 'componentWillUnmount', present: false } });

  it('adds componentWillUnmount clearing a timer stored on the instance', () => {
    const root = project({
      'src/Widget.jsx': `class Widget extends React.Component {
  componentDidMount() {
    this.timer = setInterval(() => this.tick(), 1000);
  }

  render() {
    return null;
  }
}
`,
    });
    const result = proposeReactFix(finding(), cls(), { projectRoot: root });
    expect(result?.safety).toBe('additive');
    expect(result?.title).toBe('Add the missing componentWillUnmount in Widget');
    expect(result?.newContent).toContain('componentWillUnmount() {\n    clearInterval(this.timer);\n  }');
    const before = fs.readFileSync(path.join(root, 'src/Widget.jsx'), 'utf8');
    for (const line of before.split('\n')) {
      if (line.trim() !== '') expect(result?.newContent).toContain(line);
    }
    expect(() => new Function('var React = { Component: function () {} };\n' + (result?.newContent as string))).not.toThrow();
  });

  it('adds componentWillUnmount removing a this.<handler> listener with the same reference', () => {
    const root = project({
      'src/Widget.jsx': `class Widget extends React.Component {
  componentDidMount() {
    window.addEventListener('resize', this.onResize)
  }
  render() { return null }
}
`,
    });
    const result = proposeReactFix(finding(), cls(), { projectRoot: root });
    expect(result?.safety).toBe('additive');
    // No semicolons in the source, none added.
    expect(result?.newContent).toContain("window.removeEventListener('resize', this.onResize)\n");
  });

  it('refuses when the timer handle is a local variable componentWillUnmount cannot reach', () => {
    const root = project({
      'src/Widget.jsx': `class Widget extends React.Component {
  componentDidMount() {
    const id = setInterval(() => {}, 1000);
  }
}
`,
    });
    const result = proposeReactFix(finding(), cls(), { projectRoot: root });
    expect(result?.safety).toBe('manual-only');
    expect(result?.rationale).toMatch(/local variable/);
  });

  it('refuses when componentWillUnmount already exists', () => {
    const root = project({
      'src/Widget.jsx': `class Widget extends React.Component {
  componentDidMount() { this.timer = setInterval(() => {}, 1000); }
  componentWillUnmount() { console.log('bye'); }
}
`,
    });
    const result = proposeReactFix(finding(), cls(), { projectRoot: root });
    expect(result?.safety).toBe('manual-only');
    expect(result?.rationale).toMatch(/already has a componentWillUnmount/);
  });

  it('refuses when componentDidMount starts two resources', () => {
    const root = project({
      'src/Widget.jsx': `class Widget extends React.Component {
  componentDidMount() {
    this.timer = setInterval(() => {}, 1000);
    window.addEventListener('resize', this.onResize);
  }
}
`,
    });
    const result = proposeReactFix(finding(), cls(), { projectRoot: root });
    expect(result?.safety).toBe('manual-only');
    expect(result?.rationale).toMatch(/exactly one recognised resource/);
  });

  it('refuses an inline arrow listener in componentDidMount', () => {
    const root = project({
      'src/Widget.jsx': `class Widget extends React.Component {
  componentDidMount() {
    window.addEventListener('resize', () => this.setState({}));
  }
}
`,
    });
    const result = proposeReactFix(finding(), cls(), { projectRoot: root });
    expect(result?.safety).toBe('manual-only');
  });
});

describe('proposeReactFix - observers, sockets, workers, frames and subscriptions', () => {
  const effect = (body: string): string => `function Widget() {
  useEffect(() => {
${body}
  }, []);
  return null;
}
`;

  it.each([
    ['const obs = new ResizeObserver(onResize);', 'obs.disconnect()'],
    ['const obs = new MutationObserver(onChange);', 'obs.disconnect()'],
    ['const ws = new WebSocket(url);', 'ws.close()'],
    ['const w = new Worker(url);', 'w.terminate()'],
    ['const frame = requestAnimationFrame(draw);', 'cancelAnimationFrame(frame)'],
    ['const sub = prices$.subscribe(setPrice);', 'sub.unsubscribe()'],
  ])('%s -> return () => { %s; }', (line, release) => {
    const root = project({ 'src/Widget.jsx': effect(`    ${line}`) });
    const result = proposeReactFix(finding(), entity(), { projectRoot: root });
    expect(result?.safety).toBe('additive');
    expect(result?.newContent).toContain(`return () => { ${release}; };`);
    expect(() => new Function(result?.newContent as string)).not.toThrow();
  });

  it('refuses a subscription next to a timer - releasing one would be a partial fix', () => {
    const root = project({ 'src/Widget.jsx': effect('    const id = setInterval(tick, 1000);\n    source$.subscribe(update);') });
    expect(proposeReactFix(finding(), entity(), { projectRoot: root })?.safety).toBe('manual-only');
  });

  it('in a class: this.observer = new ResizeObserver -> componentWillUnmount disconnects it', () => {
    const root = project({
      'src/Widget.jsx': `class Widget extends React.Component {
  componentDidMount() {
    this.observer = new ResizeObserver(this.onResize);
  }
}
`,
    });
    const result = proposeReactFix(finding(), entity({ frameworkKind: 'ClassComponent' }), { projectRoot: root });
    expect(result?.newContent).toContain('componentWillUnmount() {\n    this.observer.disconnect();\n  }');
    expect(result?.rationale).toContain('creates an observer');
  });

  it('in a class: an observer kept in a local variable is refused, like a local timer', () => {
    const root = project({
      'src/Widget.jsx': `class Widget extends React.Component {
  componentDidMount() {
    const observer = new ResizeObserver(this.onResize);
  }
}
`,
    });
    const result = proposeReactFix(finding(), entity({ frameworkKind: 'ClassComponent' }), { projectRoot: root });
    expect(result?.safety).toBe('manual-only');
    expect(result?.rationale).toMatch(/local variable/);
  });
});

describe('proposeReactFix - found via a const arrow component', () => {
  it('also works when the component is declared as a const arrow function', () => {
    const root = project({
      'src/Widget.jsx': `const Widget = () => {
  useEffect(() => {
    var id = setInterval(() => {}, 1000);
  }, []);
  return null;
};
`,
    });
    const result = proposeReactFix(finding(), entity(), { projectRoot: root });
    expect(result?.safety).toBe('additive');
    expect(result?.newContent).toContain('clearInterval(id)');
  });
});
