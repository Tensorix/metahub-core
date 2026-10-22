import { expect, test } from 'bun:test';
import { needsCore } from './ci-scope';

test('website content, tooling and deployment do not require Core builds', () => {
  expect(needsCore(['website/public/index.html', 'website/check.ts', '.github/workflows/deploy-website.yml'])).toBe(false);
});
test('mixed changes and shared CI changes require Core builds', () => {
  for (const path of ['src/index.ts', 'bun.lock', '.github/workflows/ci.yml', 'scripts/ci-scope.ts', 'AGENTS.md']) {
    expect(needsCore(['website/public/index.html', path])).toBe(true);
  }
});
test('moves out of or into Core require checks when diff disables rename detection', () => {
  expect(needsCore(['src/old.ts', 'website/new.ts'])).toBe(true);
  expect(needsCore(['website/old.ts', 'src/new.ts'])).toBe(true);
});

test('real Git events: push ranges, PR merge base, new branch and missing base', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'metahub-ci-scope-'));
  const script = join(import.meta.dir, 'ci-scope.ts');
  async function git(...args: string[]) {
    const p = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    const output = await new Response(p.stdout).text();
    if (await p.exited !== 0) throw new Error(await new Response(p.stderr).text());
    return output.trim();
  }
  async function run(event: object) {
    await Bun.write(join(dir, 'event.json'), JSON.stringify(event));
    await Bun.write(join(dir, 'output'), '');
    const p = Bun.spawn([process.execPath, script], {
      cwd: dir, stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, GITHUB_EVENT_PATH: join(dir, 'event.json'), GITHUB_OUTPUT: join(dir, 'output') },
    });
    const code = await p.exited;
    return { code, output: await Bun.file(join(dir, 'output')).text() };
  }
  try {
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'CI test');
    await git('config', 'user.email', 'ci@example.invalid');
    await Bun.write(join(dir, 'core.ts'), 'initial');
    await git('add', 'core.ts');
    await git('commit', '-m', 'base');
    const base = await git('rev-parse', 'HEAD');
    await git('checkout', '-b', 'website');
    await Bun.write(join(dir, 'website/index.html'), 'hello');
    await git('add', 'website');
    await git('commit', '-m', 'website');
    expect(await run({ before: base })).toEqual({ code: 0, output: 'core=false\n' });
    await git('checkout', 'main');
    await Bun.write(join(dir, 'core.ts'), 'upstream change');
    await git('add', 'core.ts');
    await git('commit', '-m', 'upstream');
    const upstream = await git('rev-parse', 'HEAD');
    await git('checkout', 'website');
    expect(await run({ pull_request: { base: { sha: upstream } } })).toEqual({ code: 0, output: 'core=false\n' });
    expect(await run({ before: '0'.repeat(40) })).toEqual({ code: 0, output: 'core=true\n' });
    expect((await run({ before: '1'.repeat(40) })).code).not.toBe(0);
    await git('mv', 'core.ts', 'website/moved.ts');
    await git('commit', '-m', 'move Core into website');
    expect(await run({ before: base })).toEqual({ code: 0, output: 'core=true\n' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
