import { test, expect } from 'bun:test';
test('CLI pairs with an authenticated server and rejects reused/expired codes', async () => {
 const p = Bun.spawn([process.execPath, new URL('./fixtures/device-onboarding.ts', import.meta.url).pathname], { stdout: 'pipe', stderr: 'pipe' });
 const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
 expect({ code, err }).toEqual({ code: 0, err: '' });
 expect(out).toContain('PASS: HTTP pairing');
}, 15000);
