import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { copy, translate } from './public/copy.js';
import { createDemo } from './public/demo.js';

const html = await Bun.file(new URL('./public/index.html', import.meta.url)).text();
const settle = () => new Promise((resolve) => setTimeout(resolve, 240));
let window: Window;
let demo: ReturnType<typeof createDemo>;
let originalGlobals: Map<string, PropertyDescriptor | undefined>;
const node = (id: string) => window.document.getElementById(id)!;
const click = (id: string) => (node(id) as any).click();
const change = (id: string, value: string) => {
  (node(id) as any).value = value;
  node(id).dispatchEvent(new window.Event('change', { bubbles: true }));
};

beforeEach(() => {
  window = new Window({ url: 'http://localhost/' });
  window.document.write(html);
  const globals = {
    document: window.document,
    matchMedia: (query: string) => ({ matches: query.includes('prefers-reduced-motion'), addEventListener() {} }),
    IntersectionObserver: class { observe() {} disconnect() {} },
  };
  originalGlobals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  demo = createDemo({ language: 'en' });
});

afterEach(() => {
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe('production website demo', () => {
  test('every locale has identical keys and interpolation contracts', () => {
    expect(Object.keys(copy.en).sort()).toEqual(Object.keys(copy.zh).sort());
    for (const key of Object.keys(copy.en)) {
      const slots = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
      expect(slots(copy.en[key])).toEqual(slots(copy.zh[key]));
    }
    for (const match of html.matchAll(/data-i18n(?:-aria|-placeholder)?="([^"]+)"/g)) {
      expect(() => translate('en', match[1])).not.toThrow();
      expect(() => translate('zh', match[1])).not.toThrow();
    }
  });

  test('drafts change only after a re-read; revision interrupts a stale read', async () => {
    change('event-day', 'friday');
    expect(node('draft-copy').textContent).toContain('Thursday');
    click('demo-action');
    expect(node('activity-message').textContent).toContain('Friday');
    change('event-day', 'monday');
    await settle();
    expect(node('draft-copy').textContent).toContain('Thursday');
    click('demo-action'); await settle();
    expect(node('draft-copy').textContent).toContain('next Monday');
    expect(node('site-time').textContent).toContain('Next Monday');
  });

  test('switching scenes cancels old writes and retains edits across languages', async () => {
    change('event-day', 'friday'); click('demo-action'); click('tables-tab');
    await settle(); click('notes-tab');
    expect((node('event-day') as any).value).toBe('friday');
    expect(node('draft-copy').textContent).toContain('Thursday');
    demo.setLanguage('zh');
    expect((node('event-day') as any).value).toBe('friday');
    expect(node('draft-copy').textContent).toContain('周四');
    click('demo-action'); await settle();
    expect(node('draft-copy').textContent).toContain('周五');
  });

  test('board/table views share status and summaries use the latest snapshot', async () => {
    click('tables-tab');
    const select = window.document.querySelector('#board-grid [data-task-select="demo"]')! as any;
    select.value = 'done'; select.dispatchEvent(new window.Event('change', { bubbles: true }));
    click('table-tab');
    expect((window.document.querySelector('#task-rows [data-task-select="demo"]') as any).value).toBe('done');
    expect(node('board-count').textContent).toBe('2 of 3 done');
    click('demo-action'); await settle();
    expect(node('board-summary').textContent).toContain('Next: Send the invitation');
    demo.setLanguage('zh');
    expect(node('board-summary').textContent).toContain('发出活动邀请');
    expect(node('board-count').textContent).toBe('2 / 3 已完成');
    click('reset-demo'); expect(node('board-count').textContent).toBe('1 / 3 已完成');
  });

  test('registration uses text, prevents duplicates and survives language changes', async () => {
    click('sites-tab');
    const input = node('guest-name') as any;
    input.value = '<img src=x onerror=1>';
    node('signup-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    expect(node('guest-rows').querySelectorAll('tr')).toHaveLength(3);
    expect(node('guest-rows').querySelector('img')).toBeNull();
    expect(node('guest-rows').textContent).toContain('<img src=x onerror=1>');
    input.value = '<img src=x onerror=1>';
    node('signup-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    expect(node('guest-rows').querySelectorAll('tr')).toHaveLength(3);
    expect(node('signup-feedback').textContent).toContain('already on the list');
    demo.setLanguage('zh');
    expect(node('guest-rows').textContent).toContain('<img src=x onerror=1>');
    expect(node('guest-rows').textContent).toContain('小陈');
    expect(node('signup-feedback').textContent).toContain('已经在名单里');
    click('demo-action'); await settle();
    expect(node('activity-message').textContent).toContain('3 位参加者');
    click('reset-demo'); expect(node('guest-rows').querySelectorAll('tr')).toHaveLength(2);
  });

  test('reset during a read cannot resurrect the previous result', async () => {
    change('event-day', 'friday'); click('demo-action'); click('reset-demo');
    await settle();
    expect((node('event-day') as any).value).toBe('thursday');
    expect(node('draft-copy').textContent).toContain('Thursday');
    expect(node('activity-actor').textContent).toBe('Your turn');
    expect((node('demo-action') as any).disabled).toBe(false);
  });
});
