import { expect, test } from 'bun:test';
import { mobileScope } from './mobile-ci-scope';

test('documentation changes skip both gates even on candidate branches', () => {
  expect(mobileScope(['docs/mobile.md', 'apps/mobile/README.md'], 'push', 'refs/heads/main'))
    .toEqual({ checks: false, native: false });
});
test('PR JavaScript changes run checks; native configuration also builds', () => {
  expect(mobileScope(['apps/mobile/src/app/index.tsx'], 'pull_request', '')).toEqual({ checks: true, native: false });
  for (const path of ['apps/mobile/bun.lock', 'apps/mobile/app.json', 'apps/mobile/package.json', 'apps/mobile/metro.config.js']) {
    expect(mobileScope([path], 'pull_request', '')).toEqual({ checks: true, native: true });
  }
});
test('candidate pushes build mobile and shared source changes', () => {
  for (const ref of ['feat/mobile', 'dev', 'main']) {
    expect(mobileScope(['src/core/query.ts'], 'push', `refs/heads/${ref}`)).toEqual({ checks: true, native: true });
  }
  expect(mobileScope(['src/core/query.ts'], 'push', 'refs/heads/topic')).toEqual({ checks: true, native: false });
});
test('manual runs always build and unrelated sources skip', () => {
  expect(mobileScope([], 'workflow_dispatch', '')).toEqual({ checks: true, native: true });
  expect(mobileScope(['website/index.html', 'apps/desktop/package.json'], 'pull_request', '')).toEqual({ checks: false, native: false });
});
