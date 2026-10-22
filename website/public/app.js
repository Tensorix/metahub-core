let language = 'en';
try { language = localStorage.getItem('metahub-site-language') === 'zh' ? 'zh' : 'en'; } catch {}
let view = 'documents';
let install = 'cli';
const $ = (selector) => document.querySelector(selector);
const captions = {
 documents: {en:'Markdown that feels natural. Edit in blocks or go straight to the source.',zh:'自然顺手的 Markdown 编辑体验，自由切换块视图与源码。'},
 tables: {en:'Typed tables for real work. Connect records, documents, and the details that matter.',zh:'为实际工作而建的数据表，将记录、文档与重要细节关联起来。'}
};
function updateView(){
 document.querySelectorAll('[data-view]').forEach(button=>{const selected=button.dataset.view===view;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;});
 $('#product-image').src=`/assets/${view}-v0.5.4-en.png`;
 $('#product-image').alt=view==='documents'?'metahub document editor showing an architecture overview, document sidebar, and Markdown content':'metahub typed table with select, multi-select, checkbox, and date columns';
 $('#product-panel').setAttribute('aria-labelledby',`${view}-tab`);
 $('#view-name').textContent=view;
 $('#view-caption').textContent=captions[view][language];
}
function updateInstall(){
 document.querySelectorAll('[data-install]').forEach(button=>{const selected=button.dataset.install===install;button.setAttribute('aria-selected',String(selected));button.tabIndex=selected?0:-1;});
 $('#install-panel').setAttribute('aria-labelledby',`${install}-tab`);
 $('#install-command').textContent=install==='cli'?'bunx @tensorix/metahub init':'brew install --cask tensorix/tap/metahub-app';
 $('#install-description').textContent=install==='cli'?(language==='en'?'Run with Bun. Your knowledge base starts here.':'通过 Bun 运行，从这里创建你的知识库。'):(language==='en'?'Install the desktop app with Homebrew on macOS.':'在 macOS 上通过 Homebrew 安装桌面应用。');
 $('#install-note').innerHTML=install==='cli'?(language==='en'?'Requires <a href="https://bun.sh">Bun</a>. Prefer a standalone binary?':'需要安装 <a href="https://bun.sh">Bun</a>。也可以直接下载独立可执行文件。'):(language==='en'?'Requires <a href="https://brew.sh">Homebrew</a>. Other platforms and builds below.':'需要安装 <a href="https://brew.sh">Homebrew</a>。其他平台与构建版本见下方。');
 $('#copy-status').textContent='';
}
function updateLanguage(){
 document.documentElement.lang=language==='en'?'en':'zh-CN';
 document.querySelectorAll('[data-en][data-zh]').forEach(el=>el.innerHTML=el.dataset[language]);
 $('#language').textContent=language==='en'?'中文':'EN';
 $('#language').setAttribute('aria-label',language==='en'?'Switch to Chinese':'Switch to English');
 $('#copy').setAttribute('aria-label',language==='en'?'Copy installation command':'复制安装命令');
 document.title=language==='en'?'metahub — A home for your AI’s memory':'metahub — 让 AI 的记忆，有处安放';
 updateView();updateInstall();
}
$('#language').addEventListener('click',()=>{language=language==='en'?'zh':'en';try{localStorage.setItem('metahub-site-language',language)}catch{}updateLanguage()});
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{view=button.dataset.view;updateView()}));
document.querySelectorAll('[data-install]').forEach(button=>button.addEventListener('click',()=>{install=button.dataset.install;updateInstall()}));
document.querySelectorAll('[role="tablist"]').forEach(list=>list.addEventListener('keydown',event=>{
 const buttons=[...list.querySelectorAll('[role="tab"]')];let index=buttons.indexOf(document.activeElement);
 if(index<0)return;
 if(event.key==='ArrowRight')index=(index+1)%buttons.length;else if(event.key==='ArrowLeft')index=(index-1+buttons.length)%buttons.length;else if(event.key==='Home')index=0;else if(event.key==='End')index=buttons.length-1;else return;
 event.preventDefault();buttons[index].click();buttons[index].focus();
}));
$('#copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('#install-command').textContent);$('#copy-status').textContent=language==='en'?'Copied. Paste it into your terminal.':'已复制，可以粘贴到终端运行。'}catch{$('#copy-status').textContent=language==='en'?'Copy unavailable. Select the command and copy it manually.':'无法自动复制，请选中上方命令手动复制。'}});
updateLanguage();
