import { translate } from './copy.js';
import { createDemo } from './demo.js';

let language = 'en';
try { language = localStorage.getItem('metahub-site-language') === 'zh' ? 'zh' : 'en'; } catch {}
const $ = (id) => document.getElementById(id);
let install = 'desktop';
let proof = 'documents';
let copyResult = '';
let copyRequest = 0;
const t = (key) => translate(language, key);
const demo = createDemo({ language });

function applyLanguage() {
  document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
  document.querySelectorAll('[data-i18n]').forEach((node) => { node.textContent = t(node.dataset.i18n); });
  document.querySelectorAll('[data-i18n-aria]').forEach((node) => node.setAttribute('aria-label', t(node.dataset.i18nAria)));
  document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder)));
  // Keep the locked slogan intact, with a deliberate phrase boundary in both languages.
  const heading = document.querySelector('.hero h1');
  if (language === 'en') {
    const emphasis = document.createElement('span');
    emphasis.className = 'hero-emphasis';
    emphasis.textContent = 'keep working';
    heading.replaceChildren(document.createTextNode('Where you and your AI'), document.createElement('br'), document.createTextNode(' '), emphasis, document.createTextNode('.'));
  } else {
    const emphasis = document.createElement('span');
    emphasis.className = 'hero-emphasis';
    emphasis.textContent = '接着往下做';
    const continuation = document.createElement('span');
    continuation.className = 'hero-continuation';
    continuation.append(emphasis, document.createTextNode('的地方。'));
    heading.replaceChildren(document.createTextNode('你和 AI '), continuation);
  }
  $('language').textContent = t('language');
  document.title = t('title');
  document.querySelector('meta[name="description"]').content = t('description');
  document.querySelector('meta[property="og:title"]').content = t('title');
  document.querySelector('meta[property="og:description"]').content = t('description');
  updateInstall(); updateProof(); demo.setLanguage(language);
}
function updateInstall() {
  document.querySelectorAll('[data-install]').forEach((node) => {
    const selected = node.dataset.install === install;
    node.setAttribute('aria-selected', String(selected)); node.tabIndex = selected ? 0 : -1;
  });
  $('install-panel').setAttribute('aria-labelledby', `install-${install}-tab`);
  $('install-description').textContent = t(install === 'desktop' ? 'installDesktop' : 'installCli');
  $('install-command').textContent = install === 'desktop' ? 'brew install --cask tensorix/tap/metahub-app' : 'bunx @tensorix/metahub init';
  $('install-dependency').textContent = install === 'desktop' ? 'Homebrew' : 'Bun';
  $('install-dependency').href = install === 'desktop' ? 'https://brew.sh' : 'https://bun.sh';
  $('copy-status').textContent = copyResult ? t(copyResult) : '';
}
function updateProof() {
  document.querySelectorAll('[data-proof]').forEach((node) => {
    const selected = node.dataset.proof === proof;
    node.setAttribute('aria-selected', String(selected)); node.tabIndex = selected ? 0 : -1;
  });
  $('proof-panel').setAttribute('aria-labelledby', `proof-${proof}-tab`);
  $('product-image').src = `/assets/${proof}-v0.5.4-en.png`;
  $('product-image').alt = t(proof === 'documents' ? 'screenshotNote' : 'screenshotTable');
}
$('language').addEventListener('click', () => {
  language = language === 'en' ? 'zh' : 'en';
  try { localStorage.setItem('metahub-site-language', language); } catch {}
  applyLanguage();
});
for (const node of document.querySelectorAll('[data-install]')) node.addEventListener('click', () => { install = node.dataset.install; copyRequest++; copyResult = ''; updateInstall(); });
for (const node of document.querySelectorAll('[data-proof]')) node.addEventListener('click', () => { proof = node.dataset.proof; updateProof(); });
// All tab groups share the same keyboard contract, including nested demo views.
for (const list of document.querySelectorAll('[role="tablist"]')) list.addEventListener('keydown', (event) => {
  const buttons = [...list.querySelectorAll('[role="tab"]')];
  let index = buttons.indexOf(document.activeElement); if (index < 0) return;
  if (event.key === 'ArrowRight') index = (index + 1) % buttons.length;
  else if (event.key === 'ArrowLeft') index = (index - 1 + buttons.length) % buttons.length;
  else if (event.key === 'Home') index = 0;
  else if (event.key === 'End') index = buttons.length - 1;
  else return;
  event.preventDefault(); buttons[index].click(); buttons[index].focus();
});
$('copy').addEventListener('click', async () => {
  const request = ++copyRequest;
  try { await navigator.clipboard.writeText($('install-command').textContent); if (request === copyRequest) copyResult = 'copied'; }
  catch { if (request === copyRequest) copyResult = 'copyError'; }
  updateInstall();
});
applyLanguage();
