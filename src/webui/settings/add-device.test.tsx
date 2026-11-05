/** @jsxImportSource preact */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { test, expect, afterEach, afterAll } from 'bun:test';
import { render } from 'preact';
import { act } from 'preact/test-utils';
import { AddDeviceModal, enrollmentOrigin } from './modals.tsx';
import { api } from '../api.ts';
GlobalRegistrator.register();
const original = api.newPairingCode;
const host = document.createElement('div');
document.body.append(host);
afterEach(() => { act(() => render(null, host)); api.newPairingCode = original; });
afterAll(() => { host.remove(); GlobalRegistrator.unregister(); });
const click = async (text: string) => act(async () => {
 const b = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === text);
 expect(b).toBeDefined(); b!.click();
});
const change = async (id: string, value: string, type = 'change') => act(async () => {
 const el = host.querySelector<HTMLInputElement>(id)!; el.value = value; el.dispatchEvent(new Event(type, { bubbles: true }));
});
async function mount(environment: 'server' | 'desktop' | 'shell', onClosed = () => {}) {
 await act(async () => render(<AddDeviceModal buckets={[]} getConfig={async () => null} environment={environment} onClosed={onClosed} />, host));
}
test('invitation address accepts remote roots and rejects unsafe or local roots', () => {
 for (const url of ['https://example.com', 'http://192.168.1.2:7777', 'http://[2001:db8::1]:7777']) expect(enrollmentOrigin(url)).toBe(url);
 for (const url of ['file:///tmp', 'http://localhost', 'http://127.1', 'http://0.0.0.0', 'http://[::1]', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?token=x', 'https://exa$mple.com', 'https://exa`mple.com']) expect(enrollmentOrigin(url)).toBeNull();
});
test('server pairing is explicit, survives tabs, and refreshes on unmount', async () => {
 let calls = 0, closed = 0;
 api.newPairingCode = async () => { calls++; return { code: 'abc123', exp: Date.now() + 60000 }; };
 await mount('server', () => closed++);
 expect(host.querySelector<HTMLSelectElement>('#enroll-method')!.value).toBe('server');
 expect(calls).toBe(0);
 await change('#enroll-server', 'https://example.com', 'input');
 await click('电脑 / 命令行'); await click('生成接入命令');
 expect(calls).toBe(1); expect(host.textContent).toContain("mh config device add --url 'https://example.com' --code 'abc123'");
 await click('手机'); await click('电脑 / 命令行');
 expect(host.textContent).toContain('abc123'); expect(calls).toBe(1);
 await act(async () => render(null, host)); expect(closed).toBe(1);
});
test('unavailable environments explain server restrictions and empty buckets', async () => {
 for (const environment of ['desktop', 'shell'] as const) {
  await mount(environment);
  expect(host.textContent).toContain('尚未连接存储桶');
  await change('#enroll-method', 'server');
  expect(host.textContent).toContain(environment === 'desktop' ? '仅允许本机访问' : '没有可供连接的服务器');
  expect(host.querySelector('svg image')).toBeNull();
  await act(async () => render(null, host));
 }
});
test('failed generation can retry and expired code cannot be copied', async () => {
 await mount('server'); await change('#enroll-server', 'https://example.com', 'input'); await click('电脑 / 命令行');
 api.newPairingCode = async () => { throw new Error('offline'); };
 await click('生成接入命令'); expect(host.textContent).toContain('offline');
 api.newPairingCode = async () => ({ code: 'expired', exp: Date.now() - 1000 });
 await click('生成接入命令'); expect(host.textContent).toContain('已过期');
 expect(Array.from(host.querySelectorAll('button')).some(b => b.textContent?.includes('复制命令'))).toBe(false);
});

test('bucket invitation switches between native app, validated PWA and CLI without changing enrollment data', async () => {
 const config = { endpoint: 'https://storage.example.com', bucket: 'fixture', region: 'test', accessKeyId: 'test-id', secretAccessKey: 'test-secret', encrypt: true };
 await act(async () => render(<AddDeviceModal buckets={[{ url: 'fixture', name: 'Fixture' }]} getConfig={async () => config} environment="desktop" onClosed={() => {}} />, host));
 await act(async () => { await Bun.sleep(0); });
 const link = () => host.querySelector('.enroll-cmd')?.textContent;
 const native = link();
 expect(native).toStartWith('metahub://connect?enroll=');
 const token = native!.split('?enroll=')[1]!;
 await change('#phone-enroll-target', 'web');
 await change('#enroll-shell', 'http://localhost', 'input');
 expect(link()).toBeUndefined();
 await change('#enroll-shell', 'https://phone.example.com', 'input');
 expect(link()).toBe('https://phone.example.com/#enroll=' + token);
 await click('电脑 / 命令行');
 expect(host.textContent).toContain('mh config backup connect --enroll ' + token);
 localStorage.removeItem('mh_shell_base');
});
