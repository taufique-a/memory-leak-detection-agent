/**
 * Creating an ngOnDestroy, which is the change that actually helps.
 *
 * The old generator appended two statements to a hook that already
 * existed. Measured against IOSense that fixed nothing: all 30
 * broken-destroy$ components lack an ngOnDestroy entirely, so every single
 * finding came back "manual fix required" - a correct answer and a useless
 * one.
 *
 * This generator creates the hook, which means four coordinated edits to a
 * file somebody else wrote. Getting any of them wrong produces code that
 * does not compile, so these tests care about two things above all:
 *
 *   the output PARSES, every time
 *   it REFUSES anything it cannot reason about, rather than guessing
 */

import * as ts from 'typescript';

import { addOnDestroyWithUnsubscribe, isFailure } from '../src/fix/addOnDestroy';

function parses(source: string): boolean {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.Latest, true);
  return ((file as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics ?? []).length === 0;
}

function apply(source: string, className = 'DemoComponent'): string {
  const result = addOnDestroyWithUnsubscribe(source, 'demo.component.ts', className);
  if (isFailure(result)) throw new Error(`expected a change, got: ${result.reason}`);
  expect(parses(result.newContent)).toBe(true);
  return result.newContent;
}

function refuse(source: string, className = 'DemoComponent'): string {
  const result = addOnDestroyWithUnsubscribe(source, 'demo.component.ts', className);
  if (!isFailure(result)) throw new Error('expected a refusal, got a change');
  return result.reason;
}

const SIMPLE = `import { Component, OnInit } from '@angular/core';
import { interval } from 'rxjs';

@Component({ selector: 'app-demo', template: '' })
export class DemoComponent implements OnInit {
  value = 0;

  constructor(private service: DataService) {}

  ngOnInit(): void {
    this.service.values$.subscribe((v) => (this.value = v));
    interval(1000).subscribe(() => this.service.poll());
  }
}
`;

describe('the four edits it has to get right', () => {
  const out = apply(SIMPLE);

  it('imports OnDestroy alongside what was already imported', () => {
    expect(out).toContain(`import { Component, OnInit, OnDestroy } from '@angular/core';`);
  });

  it('imports Subscription from the existing rxjs import', () => {
    expect(out).toContain(`import { interval, Subscription } from 'rxjs';`);
  });

  it('extends the implements clause rather than replacing it', () => {
    expect(out).toContain('export class DemoComponent implements OnInit, OnDestroy {');
  });

  it('wraps every subscribe and adds the hook', () => {
    expect((out.match(/this\.subscriptions\.add\(/g) ?? []).length).toBe(2);
    expect(out).toContain('private readonly subscriptions = new Subscription();');
    expect(out).toContain('ngOnDestroy(): void {');
    expect(out).toContain('this.subscriptions.unsubscribe();');
  });

  it('changes nothing else', () => {
    // The constructor, the field and the existing hook survive untouched.
    expect(out).toContain('constructor(private service: DataService) {}');
    expect(out).toContain('value = 0;');
    expect(out).toContain('ngOnInit(): void {');
  });
});

describe('imports it has to create rather than extend', () => {
  it('adds an rxjs import when the file has none', () => {
    const out = apply(`import { Component, OnInit } from '@angular/core';

@Component({ selector: 'app-demo', template: '' })
export class DemoComponent implements OnInit {
  value = 0;
  ngOnInit(): void {
    this.service.values$.subscribe((v) => (this.value = v));
  }
}
`);
    expect(out).toContain(`import { Subscription } from 'rxjs';`);
  });

  it('adds an implements clause when the class has none', () => {
    const out = apply(`import { Component } from '@angular/core';
import { Subscription } from 'rxjs';

@Component({ selector: 'app-demo', template: '' })
export class DemoComponent {
  value = 0;
  start(): void {
    this.service.values$.subscribe((v) => (this.value = v));
  }
}
`);
    expect(out).toContain('export class DemoComponent implements OnDestroy {');
  });

  it('extends an existing extends clause without breaking it', () => {
    const out = apply(`import { Component } from '@angular/core';
import { Subscription } from 'rxjs';

@Component({ selector: 'app-demo', template: '' })
export class DemoComponent extends BaseComponent implements OnInit {
  value = 0;
  ngOnInit(): void {
    this.service.values$.subscribe((v) => (this.value = v));
  }
}
`);
    expect(out).toContain('extends BaseComponent implements OnInit, OnDestroy {');
  });

  it('does not import a name that is already imported', () => {
    const out = apply(`import { Component, OnDestroy, OnInit } from '@angular/core';
import { Subscription } from 'rxjs';

@Component({ selector: 'app-demo', template: '' })
export class DemoComponent implements OnInit {
  ngOnInit(): void {
    this.service.values$.subscribe(() => {});
  }
}
`);
    expect((out.match(/OnDestroy/g) ?? []).length).toBeGreaterThan(0);
    expect(out).toContain(`import { Component, OnDestroy, OnInit } from '@angular/core';`);
  });

  it('picks a field name that is not already taken', () => {
    // Shadowing an existing member would change behaviour silently.
    const out = apply(`import { Component } from '@angular/core';
import { Subscription } from 'rxjs';

@Component({ selector: 'app-demo', template: '' })
export class DemoComponent {
  subscriptions: string[] = [];
  start(): void {
    this.service.values$.subscribe(() => {});
  }
}
`);
    expect(out).toContain('subscriptions: string[] = [];');
    expect(out).toContain('private readonly subscriptions2 = new Subscription();');
    expect(out).toContain('this.subscriptions2.add(');
  });
});

describe('what it refuses, and why', () => {
  it('REFUSES when the class already has an ngOnDestroy', () => {
    expect(
      refuse(`import { Component, OnDestroy } from '@angular/core';
@Component({ selector: 'app-demo', template: '' })
export class DemoComponent implements OnDestroy {
  start(): void { this.service.values$.subscribe(() => {}); }
  ngOnDestroy(): void {}
}
`),
    ).toContain('already has an ngOnDestroy');
  });

  it('REFUSES a subscribe inside a nested callback', () => {
    /**
     * `this` inside a nested function may not be the component at all, so
     * wrapping the call in this.subscriptions.add() could reference the
     * wrong object - or nothing.
     */
    expect(
      refuse(`import { Component } from '@angular/core';
@Component({ selector: 'app-demo', template: '' })
export class DemoComponent {
  start(): void {
    this.ready$.pipe(first()).subscribe(() => {
      this.service.values$.subscribe(() => {});
    });
  }
}
`),
    ).toContain('nested callback');
  });

  it('leaves a subscription that is already stored somewhere', () => {
    // Something is already managing it; wrapping would double-handle.
    expect(
      refuse(`import { Component } from '@angular/core';
@Component({ selector: 'app-demo', template: '' })
export class DemoComponent {
  private sub;
  start(): void {
    this.sub = this.service.values$.subscribe(() => {});
  }
}
`),
    ).toContain('No unmanaged subscribe');
  });

  it('REFUSES a file that is not Angular', () => {
    expect(
      refuse(`export class DemoComponent {
  start(): void { this.service.values$.subscribe(() => {}); }
}
`),
    ).toContain('@angular/core');
  });

  it('REFUSES when the named class is not in the file', () => {
    expect(refuse(SIMPLE, 'SomeOtherComponent')).toContain('Could not find class');
  });

  it('REFUSES an empty class', () => {
    expect(
      refuse(`import { Component } from '@angular/core';
@Component({ selector: 'app-demo', template: '' })
export class DemoComponent {}
`),
    ).toContain('nothing to clean up');
  });
});

describe('output quality', () => {
  it('parses after every shape it accepts', () => {
    const shapes = [
      SIMPLE,
      SIMPLE.replace('implements OnInit ', ''),
      SIMPLE.replace(/\n/g, '\r\n'),
      SIMPLE.replace('  value = 0;\n', ''),
      `import { Component } from '@angular/core';\n@Component({selector:'a',template:''})\nexport class DemoComponent { go() { this.x$.subscribe(() => {}); } }\n`,
    ];
    for (const shape of shapes) {
      const result = addOnDestroyWithUnsubscribe(shape, 'demo.component.ts', 'DemoComponent');
      if (isFailure(result)) continue;
      expect(parses(result.newContent)).toBe(true);
    }
  });

  it('keeps the file it was given when it refuses', () => {
    // A refusal must not be a half-edit.
    const result = addOnDestroyWithUnsubscribe(
      `import { Component, OnDestroy } from '@angular/core';
@Component({ selector: 'app-demo', template: '' })
export class DemoComponent implements OnDestroy {
  start(): void { this.x$.subscribe(() => {}); }
  ngOnDestroy(): void {}
}
`,
      'demo.component.ts',
      'DemoComponent',
    );
    expect(isFailure(result)).toBe(true);
    expect(result).not.toHaveProperty('newContent');
  });

  it('notes HTTP-looking subscriptions rather than silently including them', () => {
    const result = addOnDestroyWithUnsubscribe(
      `import { Component } from '@angular/core';
@Component({ selector: 'app-demo', template: '' })
export class DemoComponent {
  load(): void {
    this.http.get('/api/x').subscribe(() => {});
  }
}
`,
      'demo.component.ts',
      'DemoComponent',
    );
    if (isFailure(result)) throw new Error(result.reason);
    expect(result.notes.join(' ')).toContain('HTTP');
  });

  it('reports how many it wrapped, for the diff summary', () => {
    const result = addOnDestroyWithUnsubscribe(SIMPLE, 'demo.component.ts', 'DemoComponent');
    if (isFailure(result)) throw new Error(result.reason);
    expect(result.wrapped).toBe(2);
  });
});

describe('line endings and diffs, which reviewers actually look at', () => {
  const CRLF = SIMPLE.split('\n').join('\r\n');

  it('REGRESSION: keeps a CRLF file pure CRLF', () => {
    /**
     * The IOSense component this was first run against has 259 CRLF lines.
     * Inserting LF into it left the file mixed, which shows as noise in
     * every future diff and churns under core.autocrlf.
     */
    const result = addOnDestroyWithUnsubscribe(CRLF, 'demo.component.ts', 'DemoComponent');
    if (isFailure(result)) throw new Error(result.reason);

    expect(result.newContent.match(/(?<!\r)\n/g)).toBeNull();
    expect((result.newContent.match(/\r\n/g) ?? []).length).toBeGreaterThan(
      (CRLF.match(/\r\n/g) ?? []).length,
    );
    expect(parses(result.newContent)).toBe(true);
  });

  it('leaves an LF file as LF', () => {
    const result = addOnDestroyWithUnsubscribe(SIMPLE, 'demo.component.ts', 'DemoComponent');
    if (isFailure(result)) throw new Error(result.reason);
    expect(result.newContent).not.toContain('\r');
  });
});
