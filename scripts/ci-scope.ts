/** Keep website-only changes out of Core builds without suppressing required checks. */
export function needsCore(paths: string[]): boolean {
  return paths.some(path => !path.startsWith('website/') && path !== '.github/workflows/deploy-website.yml');
}

if (import.meta.main) {
  const event = await Bun.file(process.env.GITHUB_EVENT_PATH!).json();
  async function git(...args: string[]) {
    const child = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'inherit' });
    const output = await new Response(child.stdout).text();
    if (await child.exited !== 0) throw new Error(`git ${args[0]} failed`);
    return output;
  }
  let base = event.before as string | undefined;
  if (event.pull_request) {
    base = (await git('merge-base', event.pull_request.base.sha, 'HEAD')).trim();
  }
  // New branches have no previous tree: conservatively run all Core checks.
  const core = !base || /^0+$/.test(base)
    ? true
    : needsCore((await git('diff', '--name-only', '--no-renames', '-z', base, 'HEAD')).split('\0').filter(Boolean));
  console.log(core ? 'Core checks required' : 'Website-only change: skipping Core builds');
  const output = process.env.GITHUB_OUTPUT!;
  await Bun.write(output, (await Bun.file(output).text()) + `core=${core}\n`);
}
