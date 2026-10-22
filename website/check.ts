import { resolve, sep, dirname } from 'node:path';

const root = resolve(import.meta.dir, 'public');
const files = [...new Bun.Glob('**/*').scanSync({ cwd: root, onlyFiles: true })];
const errors: string[] = [];
let references = 0;
async function checkReference(ref: string, source: string) {
  if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) return;
  const pathname = decodeURIComponent(ref.split(/[?#]/)[0]!);
  const target = resolve(pathname.startsWith('/') ? root : dirname(source), `.${pathname.startsWith('/') ? pathname : `/${pathname}`}`);
  if (target !== root && !target.startsWith(root + sep)) {
    errors.push(`Reference escapes public directory: ${ref}`);
    return;
  }
  const file = pathname.endsWith('/') ? resolve(target, 'index.html') : target;
  references++;
  if (!await Bun.file(file).exists()) errors.push(`Missing ${ref} referenced by ${source}`);
}
for (const relative of files) {
  const path = resolve(root, relative);
  if (/\.(html|css)$/.test(relative)) {
    const content = await Bun.file(path).text();
    const pattern = relative.endsWith('.html') ? /(?:src|href)=["']([^"']+)["']/g : /url\(["']?([^\s)"']+)["']?\)/g;
    for (const match of content.matchAll(pattern)) await checkReference(match[1]!, path);
  }
  if (relative.endsWith('.js')) {
    const result = await Bun.build({ entrypoints: [path], target: 'browser', write: false });
    if (!result.success) errors.push(`Invalid JavaScript ${relative}: ${result.logs.join('\n')}`);
  }
}
// The tab switcher constructs these URLs dynamically.
for (const view of ['documents', 'tables']) {
  await checkReference(`/assets/${view}-v0.5.4-en.png`, resolve(root, 'app.js'));
}
for (const required of ['index.html', '404.html', '_headers', 'robots.txt', 'sitemap.xml', 'assets/Manrope-LICENSE.txt']) {
  if (!files.includes(required)) errors.push(`Missing required file: ${required}`);
}
if (errors.length) throw new Error(errors.join('\n'));
console.log(`Website checked: ${files.length} files, ${references} local references, JavaScript compiled.`);
