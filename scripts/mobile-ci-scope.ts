/** Mobile gates stay visible even when documentation is the only change. */
export function mobileScope(paths: string[], event: string, ref: string) {
  paths = paths.filter(path => !/\.md$/i.test(path));
  const relevant = paths.some(path =>
    /^(apps\/mobile\/|src\/)/.test(path) && !/\.md$/.test(path) ||
    /^(package\.json|bun\.lock|bunfig\.toml)$/.test(path) ||
    path === '.github/workflows/mobile.yml' || path.startsWith('scripts/mobile-ci-scope'));
  const nativeConfig = paths.some(path =>
    /^apps\/mobile\/(package\.json|bun\.lock|app\.(json|config\.[cm]?[jt]s)|metro\.config\.[cm]?[jt]s|babel\.config\.[cm]?[jt]s)$/.test(path) ||
    /^apps\/mobile\/(plugins|assets|scripts)\//.test(path) ||
    path === '.github/workflows/mobile.yml');
  const manual = event === 'workflow_dispatch';
  const candidate = event === 'push' && /^refs\/heads\/(feat\/mobile|dev|main)$/.test(ref);
  return { checks: manual || relevant, native: manual || nativeConfig || (candidate && relevant) };
}

if (import.meta.main) {
  async function git(...args: string[]) {
    const child = Bun.spawn(['git', ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' });
    const result = await new Response(child.stdout).text();
    if (await child.exited !== 0) throw new Error(`git ${args[0]} failed`);
    return result.trim();
  }
  const event = await Bun.file(process.env.GITHUB_EVENT_PATH!).json();
  let base = event.before as string | undefined;
  if (event.pull_request) base = await git('merge-base', event.pull_request.base.sha, 'HEAD');
  // Initial branch pushes compare against the empty tree (not every file in the repo).
  if (!base || /^0+$/.test(base)) base = await git('hash-object', '-t', 'tree', '--stdin');
  const paths = (await git('diff', '--name-only', '--no-renames', '-z', base, 'HEAD')).split('\0').filter(Boolean);
  const scope = mobileScope(paths, process.env.GITHUB_EVENT_NAME ?? '', process.env.GITHUB_REF ?? '');
  console.log(JSON.stringify(scope));
  const output = process.env.GITHUB_OUTPUT!;
  await Bun.write(output, (await Bun.file(output).text()) + `checks=${scope.checks}\nnative=${scope.native}\n`);
}
