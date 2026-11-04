import { translate } from './copy.js';

const SCENES = ['notes', 'tables', 'sites'];
const STATUS = ['todo', 'doing', 'done'];
const INITIAL_TASKS = [{ id: 'invite', status: 'todo' }, { id: 'demo', status: 'doing' }, { id: 'theme', status: 'done' }];
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function createDemo({ language = 'en' } = {}) {
  const $ = (id) => document.getElementById(id);
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const state = {
    language, scene: 'notes', view: 'board', mobileSiteView: 'site', day: 'thursday', draftDay: 'thursday', draftVisible: true,
    tasks: INITIAL_TASKS.map((task) => ({ ...task })), boardFilled: true, summary: null,
    guests: [{ id: 'first', key: 'initialName1' }, { id: 'second', key: 'initialName2' }],
    signup: { key: 'signupHint', values: {} },
    scenes: Object.fromEntries(SCENES.map((scene) => [scene, { step: 2, phase: 'idle', values: {} }])),
  };
  const t = (key, values) => translate(state.language, key, values);
  const guestName = (guest) => guest.key ? t(guest.key) : guest.name;
  const animations = new Set();
  const played = new Set();
  let job = null;
  let autoplay = false;
  let visible = false;
  let serial = 0;
  let dragId = null;
  const timings = { read: 850, write: 250, beat: 1300 };

  function animate(node, frames, options = {}) {
    if (!node || motion.matches || typeof node.animate !== 'function') return;
    const animation = node.animate(frames, { duration: 380, easing: 'cubic-bezier(.16,1,.3,1)', ...options });
    animations.add(animation);
    animation.finished.catch(() => {}).finally(() => animations.delete(animation));
    return animation;
  }
  function highlight(node) {
    animate(node, [{ backgroundColor: '#e0eaf7' }, { backgroundColor: 'transparent' }], { duration: 1100 });
  }
  function stop(announce = false) {
    const wasRunning = !!job;
    if (job) job.abort(); job = null; autoplay = false;
    for (const animation of animations) animation.cancel(); animations.clear();
    state.draftVisible = true; state.boardFilled = true;
    $('demo-stage').classList.remove('is-reading', 'is-building');
    if (announce && wasRunning) state.scenes[state.scene] = { ...state.scenes[state.scene], phase: 'paused', values: {} };
  }
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new DOMException('Aborted', 'AbortError'));
      const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, motion.matches ? Math.min(ms, 100) : ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  async function run(callback, automatic = false) {
    stop(); const controller = new AbortController(); job = controller; autoplay = automatic;
    renderControls();
    try { await callback(controller.signal); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
    finally { if (job === controller) { job = null; autoplay = false; $('demo-stage').classList.remove('is-reading', 'is-building'); renderControls(); } }
  }
  function phase(scene, step, value, values = {}) {
    state.scenes[scene] = { step, phase: value, values }; renderControls();
  }
  function valuesFor(scene) {
    const values = { ...state.scenes[scene].values };
    if (values.day) values.day = t(values.day);
    if (values.task) values.task = t(`task_${values.task}`);
    if (values.status) values.status = t(values.status);
    if (values.guestId) values.name = guestName(state.guests.find((guest) => guest.id === values.guestId) || { name: '' });
    return values;
  }
  function renderControls() {
    const current = state.scenes[state.scene];
    document.querySelectorAll('[data-step]').forEach((node, index) => {
      node.toggleAttribute('data-complete', index < current.step);
      if (index === current.step) node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current');
    });
    const prefix = { notes: 'note', tables: 'board', sites: 'site' }[state.scene];
    const keys = {
      idle: [`${prefix}IdleActor`, `${prefix}Idle`], changed: [`${prefix}ChangedActor`, `${prefix}Changed`],
      reading: [`${prefix}ReadingActor`, `${prefix}Reading`], written: [`${prefix}WrittenActor`, `${prefix}Written`],
      paused: ['pausedActor', 'paused'], writing: ['noteWritingActor', state.scene === 'sites' ? 'siteRequest' : 'noteWriting'],
      draft: ['noteDraftActor', state.scene === 'notes' ? 'noteDraft' : `${prefix}AutoWrite`],
      revised: [`${prefix}ChangedActor`, `${prefix}AutoChange`],
    }[current.phase];
    $('activity-actor').textContent = t(keys[0]); $('activity-message').textContent = t(keys[1], valuesFor(state.scene));
    $('activity-actor').parentElement.setAttribute('aria-live', autoplay ? 'off' : 'polite');
    $('play-demo').innerHTML = icon(autoplay ? 'pause' : 'play') + `<span>${t(autoplay ? 'pause' : played.has(state.scene) ? 'replay' : 'play')}</span>`;
    $('demo-action').innerHTML = `<span>${t(`${prefix}Action`)}</span>` + icon('arrow');
    $('demo-action').disabled = !!job;
    $('demo-stage').classList.toggle('is-reading', current.phase === 'reading' && !!job);
  }
  function renderNotes() {
    $('event-day').value = state.day;
    $('draft-copy').textContent = t('noteDraftCopy', { day: t(`noteDraftDay_${state.draftDay}`) });
    $('draft-credit').textContent = t(state.scenes.notes.phase === 'written' ? 'noteUpdatedCredit' : 'noteCredit');
    $('note-tip').textContent = t(state.day !== state.draftDay ? 'noteStale' : 'noteTip');
    $('note-draft').classList.toggle('draft-waiting', !state.draftVisible);
    $('note-draft').setAttribute('aria-hidden', String(!state.draftVisible));
    $('notes-save').textContent = t(state.day !== state.draftDay ? 'modified' : state.scenes.notes.phase === 'written' ? 'agentSaved' : 'saved');
    $('site-time').textContent = t('siteTime', { day: t(state.day) });
  }
  function taskSelect(task) {
    return `<select data-task-select="${task.id}" aria-label="${escape(t('taskStatus', { task: t(`task_${task.id}`) }))}">${STATUS.map((status) => `<option value="${status}" ${status === task.status ? 'selected' : ''}>${t(status)}</option>`).join('')}</select>`;
  }
  function renderBoard(movedId) {
    const oldRects = new Map([...$('board-grid').querySelectorAll('[data-task]')].map((node) => [node.dataset.task, node.getBoundingClientRect()]));
    const active = document.activeElement;
    const focusedTask = active?.dataset.taskSelect;
    const focusRoot = active?.closest('#table-panel') ? 'table-panel' : 'board-panel';
    $('board-grid').innerHTML = STATUS.map((status) => {
      const tasks = state.boardFilled ? state.tasks.filter((task) => task.status === status) : [];
      return `<div class="board-col" data-column="${status}" aria-label="${t(status)}"><div class="board-col-head"><span class="chip ${status}">${t(status)}</span><span class="board-count">${tasks.length}</span></div><div class="board-col-body">${tasks.map((task) => `<article class="kcard" draggable="true" data-task="${task.id}"><h3>${t(`task_${task.id}`)}</h3><p>${t(`detail_${task.id}`)}</p><div class="kcard-fields"><span>${icon('user')}${t(task.id === 'demo' ? 'youAI' : 'you')}</span>${taskSelect(task)}</div></article>`).join('')}${!tasks.length ? `<span class="column-empty">${t('emptyColumn')}</span>` : ''}</div></div>`;
    }).join('');
    $('task-rows').innerHTML = state.tasks.map((task) => `<tr><td>${t(`task_${task.id}`)}</td><td>${taskSelect(task)}</td><td>${t(task.id === 'demo' ? 'youAI' : 'you')}</td></tr>`).join('');
    // Control the live value as well as the default selected attribute (including restored controls).
    document.querySelectorAll('[data-task-select]').forEach((node) => { node.value = state.tasks.find((task) => task.id === node.dataset.taskSelect).status; });
    $('tables-save').textContent = t(state.scenes.tables.phase === 'written' ? 'agentSaved' : state.scenes.tables.phase === 'idle' ? 'saved' : 'modified');
    $('board-count').textContent = t('boardCount', { done: state.tasks.filter((task) => task.status === 'done').length });
    if (state.summary) {
      const remaining = state.summary.filter((task) => task.status !== 'done');
      $('board-summary').textContent = remaining.length ? t('boardSummary', { done: 3 - remaining.length, next: remaining.map((task) => t(`task_${task.id}`)).join(state.language === 'en' ? ', ' : '、') }) : t('boardAllDone');
    } else $('board-summary').textContent = t('boardSummaryInitial');
    if (focusedTask) $(focusRoot).querySelector(`[data-task-select="${focusedTask}"]`)?.focus({ preventScroll: true });
    if (movedId && !motion.matches) {
      for (const node of $('board-grid').querySelectorAll('[data-task]')) {
        const previous = oldRects.get(node.dataset.task); const next = node.getBoundingClientRect();
        if (!previous || (previous.x === next.x && previous.y === next.y)) continue;
        if (node.dataset.task === movedId) {
          // A temporary inert overlay crosses independently scrollable columns without clipping.
          const ghost = node.cloneNode(true);
          ghost.className = 'product-app kcard flying-card'; ghost.inert = true; ghost.setAttribute('aria-hidden', 'true');
          ghost.removeAttribute('data-task'); ghost.querySelectorAll('select').forEach((select) => select.removeAttribute('data-task-select'));
          Object.assign(ghost.style, { left: `${previous.left}px`, top: `${previous.top}px`, width: `${next.width}px` });
          $('demo-stage').append(ghost); node.classList.add('flight-target');
          const flight = animate(ghost, [
            { transform: 'translate(0,0)', boxShadow: '0 4px 14px rgba(35,32,25,.08)' },
            { transform: `translate(${next.left - previous.left}px,${next.top - previous.top}px)`, boxShadow: '0 12px 26px rgba(35,32,25,.13)' },
          ], { duration: 520 });
          const cleanup = () => { ghost.remove(); node.classList.remove('flight-target'); };
          if (flight) flight.finished.then(cleanup, cleanup); else cleanup();
        } else animate(node, [
          { transform: `translateY(${previous.y - next.y}px)` }, { transform: 'translateY(0)' },
        ], { duration: 400 });
      }
      highlight($('board-grid').querySelector(`[data-task="${movedId}"]`));
    }
  }
  function renderGuests(newId) {
    $('guest-rows').replaceChildren();
    for (const guest of state.guests) {
      const row = document.createElement('tr'); row.dataset.guest = guest.id;
      for (const value of [guestName(guest), t('signupSourceValue'), t('registered')]) {
        const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
      }
      row.lastElementChild.className = 'registration-status'; $('guest-rows').append(row);
      if (guest.id === newId) animate(row, [
        { opacity: .15, transform: 'translateY(-10px)', backgroundColor: '#dfeee6' },
        { opacity: 1, transform: 'translateY(0)', backgroundColor: 'transparent' },
      ], { duration: 650 });
    }
    $('guest-count').textContent = t('guestCount', { count: state.guests.length });
    const values = { ...state.signup.values };
    if (values.guestId) values.name = guestName(state.guests.find((guest) => guest.id === values.guestId) || { name: '' });
    $('signup-feedback').textContent = t(state.signup.key, values);
    $('signup-feedback').classList.toggle('success', state.signup.key === 'signupSuccess');
    $('guest-name').setAttribute('aria-invalid', String(['signupEmpty', 'signupDuplicate', 'signupFull'].includes(state.signup.key)));
    $('guest-name').setAttribute('aria-describedby', 'signup-feedback');
    if (newId) {
      const scroll = $('guest-rows').closest('.attendee-scroll'); scroll.scrollTop = scroll.scrollHeight;
      animate(document.querySelector('.writeback-link'), [{ color: '#347653', transform: 'translateX(-4px)' }, { color: '#6f6d66', transform: 'translateX(0)' }], { duration: 600 });
    }
  }
  function render() { renderNotes(); renderBoard(); renderGuests(); renderControls(); }
  function setSiteView(view) {
    state.mobileSiteView = view;
    document.querySelector('.site-composition').dataset.mobileView = view;
    document.querySelectorAll('[data-site-view]').forEach((node) => node.setAttribute('aria-pressed', String(node.dataset.siteView === view)));
  }
  function setView(view) {
    state.view = view;
    document.querySelectorAll('[data-view]').forEach((node) => {
      const selected = node.dataset.view === view; node.setAttribute('aria-selected', String(selected)); node.tabIndex = selected ? 0 : -1;
    });
    $('board-panel').hidden = view !== 'board'; $('table-panel').hidden = view !== 'table';
  }
  function reset(scene) {
    stop();
    state.scenes[scene] = { step: 2, phase: 'idle', values: {} };
    if (scene === 'notes') { state.day = 'thursday'; state.draftDay = 'thursday'; }
    if (scene === 'tables') { state.tasks = INITIAL_TASKS.map((task) => ({ ...task })); state.summary = null; setView('board'); }
    if (scene === 'sites') { state.guests = state.guests.slice(0, 2); state.signup = { key: 'signupHint', values: {} }; $('guest-name').value = ''; setSiteView('site'); }
    render();
  }
  function updateTask(id, status) {
    const task = state.tasks.find((task) => task.id === id);
    if (!task || !STATUS.includes(status) || task.status === status) return;
    stop(); played.add('tables'); task.status = status;
    phase('tables', 2, 'changed', { task: id, status }); renderBoard(id);
  }
  function addGuest(name, sample = false) {
    const normalized = name.trim().slice(0, 24);
    let error;
    if (!normalized) error = 'signupEmpty';
    else if (state.guests.some((guest) => guestName(guest).toLowerCase() === normalized.toLowerCase())) error = 'signupDuplicate';
    else if (state.guests.length >= 8) error = 'signupFull';
    if (error) { state.signup = { key: error, values: { name: normalized } }; renderGuests(); return false; }
    const guest = { id: `guest-${++serial}`, ...(sample ? { key: 'sampleName' } : { name: normalized }) };
    state.guests.push(guest); state.signup = { key: 'signupSuccess', values: { guestId: guest.id } };
    phase('sites', 2, 'changed', { guestId: guest.id }); setSiteView('table'); renderGuests(guest.id); $('guest-name').value = ''; return true;
  }
  async function read(signal) {
    const scene = state.scene;
    if (scene === 'notes') {
      const day = state.day; phase(scene, 3, 'reading', { day });
      await delay(timings.read, signal); state.draftDay = day; state.draftVisible = true;
      phase(scene, 3, 'written', { day }); renderNotes();
      animate($('draft-copy'), [{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: 420 }); highlight($('note-draft'));
    } else if (scene === 'tables') {
      const snapshot = state.tasks.map((task) => ({ ...task })); const done = snapshot.filter((task) => task.status === 'done').length;
      phase(scene, 3, 'reading', { done, remaining: 3 - done });
      await delay(timings.read, signal); state.summary = snapshot; phase(scene, 3, 'written'); renderBoard(); highlight($('board-summary'));
    } else {
      const count = state.guests.length; phase(scene, 3, 'reading', { count });
      await delay(timings.read, signal); phase(scene, 3, 'written', { count }); highlight($('activity-message'));
    }
    await delay(timings.write, signal);
  }
  function play() {
    const scene = state.scene; reset(scene); played.add(scene);
    run(async (signal) => {
      phase(scene, 0, 'writing');
      if (scene === 'notes') { state.draftVisible = false; renderNotes(); }
      if (scene === 'tables') { state.boardFilled = false; renderBoard(); }
      if (scene === 'sites') $('demo-stage').classList.add('is-building');
      await delay(timings.beat, signal);
      phase(scene, 1, 'draft'); state.draftVisible = true; state.boardFilled = true;
      if (scene === 'notes') { renderNotes(); highlight($('note-draft')); }
      if (scene === 'tables') {
        renderBoard(); [...$('board-grid').querySelectorAll('.kcard')].forEach((node, index) => animate(node, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }], { delay: index * 70 }));
      }
      $('demo-stage').classList.remove('is-building');
      await delay(timings.beat, signal);
      phase(scene, 2, 'revised');
      if (scene === 'notes') { state.day = 'friday'; renderNotes(); highlight($('event-day')); }
      if (scene === 'tables') { state.tasks.find((task) => task.id === 'demo').status = 'done'; renderBoard('demo'); }
      if (scene === 'sites') addGuest(t('sampleName'), true);
      await delay(timings.beat + 300, signal); await read(signal);
    }, true);
  }
  function setScene(scene) {
    if (!SCENES.includes(scene) || scene === state.scene) return;
    stop(true); state.scene = scene;
    document.querySelectorAll('[data-scene]').forEach((node) => {
      const selected = node.dataset.scene === scene; node.setAttribute('aria-selected', String(selected)); node.tabIndex = selected ? 0 : -1;
    });
    for (const name of SCENES) $(`${name}-scene`).hidden = name !== scene;
    render();
    if (!played.has(scene) && visible && !motion.matches) play();
    animate($(`${scene}-scene`), [{ opacity: .25, transform: 'translateY(5px)', filter: 'blur(2px)' }, { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' }], { duration: 350 });
  }

  for (const button of document.querySelectorAll('[data-scene],[data-scene-link]')) button.addEventListener('click', () => {
    const fromSidebar = !!button.dataset.sceneLink; setScene(button.dataset.scene || button.dataset.sceneLink);
    if (fromSidebar) $(`${state.scene}-tab`).focus({ preventScroll: true });
  });
  for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => { stop(true); played.add('tables'); setView(button.dataset.view); render(); });
  $('event-day').addEventListener('change', () => { stop(); played.add('notes'); state.day = $('event-day').value; phase('notes', 2, 'changed', { day: state.day }); renderNotes(); });
  $('tables-scene').addEventListener('change', (event) => { if (event.target.matches('[data-task-select]')) updateTask(event.target.dataset.taskSelect, event.target.value); });
  $('guest-name').addEventListener('input', () => { if (job) { stop(true); renderControls(); } played.add('sites'); });
  $('signup-form').addEventListener('submit', (event) => {
    event.preventDefault(); stop(true); played.add('sites');
    if (addGuest($('guest-name').value) && matchMedia('(max-width:700px)').matches) $('site-table-toggle').focus({ preventScroll: true });
    renderControls();
  });
  for (const button of document.querySelectorAll('[data-site-view]')) button.addEventListener('click', () => { stop(true); played.add('sites'); setSiteView(button.dataset.siteView); renderControls(); });
  $('demo-action').addEventListener('click', () => { played.add(state.scene); run(read); });
  $('reset-demo').addEventListener('click', () => { played.add(state.scene); reset(state.scene); });
  $('play-demo').addEventListener('click', () => { if (autoplay) { stop(true); render(); } else play(); });

  $('board-grid').addEventListener('dragstart', (event) => {
    const card = event.target.closest('[data-task]'); if (!card || event.target.closest('select')) { event.preventDefault(); return; }
    stop(true); played.add('tables'); renderControls(); dragId = card.dataset.task;
    event.dataTransfer.setData('text/plain', dragId); event.dataTransfer.effectAllowed = 'move'; card.classList.add('drag-source');
  });
  $('board-grid').addEventListener('dragover', (event) => {
    if (!dragId) return; const col = event.target.closest('[data-column]');
    if (col) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; document.querySelectorAll('.drop-into').forEach((node) => node.classList.toggle('drop-into', node === col)); col.classList.add('drop-into'); }
  });
  $('board-grid').addEventListener('drop', (event) => { event.preventDefault(); const col = event.target.closest('[data-column]'); if (col && dragId) updateTask(dragId, col.dataset.column); clearDrag(); });
  function clearDrag() { dragId = null; document.querySelectorAll('.drag-source,.drop-into').forEach((node) => node.classList.remove('drag-source', 'drop-into')); }
  $('board-grid').addEventListener('dragend', clearDrag);
  const observer = new IntersectionObserver((entries) => {
    visible = entries[0].isIntersecting;
    if (!visible && job) { stop(true); render(); }
    else if (visible && !played.has(state.scene) && !motion.matches) play();
  }, { threshold: .3 });
  observer.observe($('demo-stage'));
  document.addEventListener('visibilitychange', () => { if (document.hidden && job) { stop(true); render(); } });
  motion.addEventListener('change', () => { if (motion.matches) { stop(true); render(); } });
  render();
  return {
    setLanguage(language) { if (state.language !== language) stop(true); state.language = language; render(); },
  };
}
