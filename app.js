'use strict';

/* ================= konfiguracja ================= */
const DBX_KEY = 'ylm3vfo6trq9j9e';
const PAGES_URL = 'https://the-prz3mas.github.io/vlaams-woorden/';
const DBX_FILE = '/vlaams-woorden/postepy.json'; // w App folder: Dropbox/Aplikacje/nl-leren/…
const INTERVALS = [0, 1, 2, 4, 8, 16, 32, 64]; // dni do kolejnej powtórki dla poziomu 0…7
const MASTERED = 4; // od tego poziomu słówko liczy się jako opanowane
const KEYS = { progress: 'vw.progress', auth: 'vw.auth', pkce: 'vw.pkce', ui: 'vw.ui' };
const MODES = { forms: 'Formy', meaning: 'Znaczenie' };

/* ================= pamięć lokalna ================= */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* prywatny tryb itp. */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

/* ================= daty ================= */
function isoDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoDay(new Date(y, m - 1, d + n));
}

/* ================= postępy ================= */
function emptyProgress() {
  return { version: 1, settings: { newPerDay: 10, updated: 0 }, cards: {} };
}
function normalizeProgress(p) {
  const e = emptyProgress();
  if (!p || typeof p !== 'object') return e;
  return {
    version: 1,
    settings: { ...e.settings, ...(p.settings || {}) },
    cards: p.cards && typeof p.cards === 'object' ? p.cards : {},
  };
}
/* Łączy dwie wersje postępów: dla każdego słówka wygrywa nowszy wpis. */
function mergeProgress(a, b) {
  a = normalizeProgress(a);
  b = normalizeProgress(b);
  const cards = { ...a.cards };
  for (const [k, v] of Object.entries(b.cards)) {
    if (!cards[k] || (v.updated || 0) > (cards[k].updated || 0)) cards[k] = v;
  }
  const settings = (b.settings.updated || 0) > (a.settings.updated || 0) ? b.settings : a.settings;
  return { version: 1, settings: { ...settings }, cards };
}
function differs(local, remote) {
  if ((local.settings.updated || 0) !== (remote.settings.updated || 0)) return true;
  return Object.entries(local.cards).some(([k, v]) => !remote.cards[k] || remote.cards[k].updated !== v.updated);
}

let progress = normalizeProgress(store.get(KEYS.progress, null));
function saveLocal() { store.set(KEYS.progress, progress); }

/* ================= sprawdzanie odpowiedzi ================= */
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFC').replace(/[’`´]/g, "'").replace(/\s+/g, ' ').trim();
}
/* "houden (van)" → houden | houden van | houden (van);  "hebben/zijn" → hebben | zijn */
function variants(answer) {
  const out = new Set();
  for (const part of String(answer).split('/')) {
    out.add(norm(part));
    out.add(norm(part.replace(/\(.*?\)/g, '')));
    out.add(norm(part.replace(/[()]/g, '')));
  }
  return out;
}
function isRight(input, answer) {
  const v = norm(input);
  return v !== '' && variants(answer).has(v);
}

/* ================= słówka i kolejka ================= */
let WORDS = [];
let GROUPS = {};
const cardKey = (w, mode) => `${w.id}:${mode}`;
const wordsFor = (group) => (group === 'all' ? WORDS : WORDS.filter((w) => w.groep === group));

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function stats(mode, group) {
  const t = isoDay();
  const ws = wordsFor(group);
  let due = 0, fresh = 0, mastered = 0;
  for (const w of ws) {
    const s = progress.cards[cardKey(w, mode)];
    if (!s) { fresh++; continue; }
    if (s.due <= t) due++;
    if (s.box >= MASTERED) mastered++;
  }
  const newToday = Object.entries(progress.cards)
    .filter(([k, s]) => k.endsWith(':' + mode) && s.first === t).length;
  const newAllowed = Math.max(0, Math.min(fresh, (progress.settings.newPerDay || 10) - newToday));
  return { total: ws.length, due, fresh, mastered, newAllowed };
}

function buildQueue(mode, group) {
  const t = isoDay();
  const ws = wordsFor(group);
  const due = ws.filter((w) => { const s = progress.cards[cardKey(w, mode)]; return s && s.due <= t; });
  const fresh = ws.filter((w) => !progress.cards[cardKey(w, mode)]).slice(0, stats(mode, group).newAllowed);
  return [...shuffle(due), ...shuffle(fresh)];
}

function grade(w, mode, ok) {
  const k = cardKey(w, mode);
  const t = isoDay();
  const s = progress.cards[k] ? { ...progress.cards[k] } : { box: 0, first: t, seen: 0, wrong: 0 };
  s.seen++;
  if (ok) s.box = Math.min(s.box + 1, INTERVALS.length - 1);
  else { s.wrong++; s.box = 0; }
  s.due = addDays(t, INTERVALS[s.box]);
  s.updated = Date.now();
  progress.cards[k] = s;
  saveLocal();
  scheduleSync();
}

/* ================= Dropbox (OAuth PKCE + pliki) ================= */
const Sync = { state: 'off', last: 0, error: '', busy: null, again: false, timer: 0 };
const isConnected = () => !!store.get(KEYS.auth, null)?.refresh;
const onPages = () => location.origin + location.pathname.replace(/index\.html$/, '') === PAGES_URL;

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const randomToken = (n = 48) => b64url(crypto.getRandomValues(new Uint8Array(n)));
async function pkceChallenge(verifier) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(d));
}
async function authorizeUrl(withRedirect) {
  const verifier = randomToken();
  const state = randomToken(16);
  store.set(KEYS.pkce, { verifier, state });
  const p = new URLSearchParams({
    client_id: DBX_KEY,
    response_type: 'code',
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
    token_access_type: 'offline',
  });
  if (withRedirect) { p.set('redirect_uri', PAGES_URL); p.set('state', state); }
  return 'https://www.dropbox.com/oauth2/authorize?' + p;
}
async function tokenRequest(params) {
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body: new URLSearchParams(params) });
  const j = await r.json().catch(() => ({}));
  return { r, j };
}
async function exchangeCode(code, withRedirect) {
  const pk = store.get(KEYS.pkce, null);
  if (!pk) throw new Error('brak danych logowania – kliknij „Połącz” jeszcze raz');
  const params = { code: code.trim(), grant_type: 'authorization_code', code_verifier: pk.verifier, client_id: DBX_KEY };
  if (withRedirect) params.redirect_uri = PAGES_URL;
  const { r, j } = await tokenRequest(params);
  if (!r.ok) throw new Error(j.error_description || j.error || 'HTTP ' + r.status);
  store.set(KEYS.auth, { refresh: j.refresh_token, access: j.access_token, exp: Date.now() + (j.expires_in || 14400) * 1000 });
  store.del(KEYS.pkce);
}
async function accessToken(force = false) {
  const a = store.get(KEYS.auth, null);
  if (!a?.refresh) throw new Error('nie połączono');
  if (!force && a.access && a.exp > Date.now() + 60000) return a.access;
  const { r, j } = await tokenRequest({ grant_type: 'refresh_token', refresh_token: a.refresh, client_id: DBX_KEY });
  if (!r.ok) {
    if (j.error === 'invalid_grant') { store.del(KEYS.auth); throw new Error('Dropbox odłączył aplikację – połącz ponownie'); }
    throw new Error(j.error_description || 'HTTP ' + r.status);
  }
  a.access = j.access_token;
  a.exp = Date.now() + (j.expires_in || 14400) * 1000;
  store.set(KEYS.auth, a);
  return a.access;
}
async function dbx(url, headers, body, retry = true) {
  const t = await accessToken();
  const r = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + t, ...headers }, body });
  if (r.status === 401 && retry) { await accessToken(true); return dbx(url, headers, body, false); }
  return r;
}
async function pullRemote() {
  const r = await dbx('https://content.dropboxapi.com/2/files/download', { 'Dropbox-API-Arg': JSON.stringify({ path: DBX_FILE }) });
  if (r.status === 409) {
    const j = await r.json().catch(() => ({}));
    if (String(j.error_summary || '').startsWith('path/not_found')) return null;
    throw new Error('Dropbox: ' + (j.error_summary || 'błąd 409'));
  }
  if (!r.ok) throw new Error('pobieranie: HTTP ' + r.status);
  return JSON.parse(await r.text()); // uszkodzony plik → błąd, nie nadpisujemy go
}
async function pushRemote(data) {
  const r = await dbx(
    'https://content.dropboxapi.com/2/files/upload',
    { 'Dropbox-API-Arg': JSON.stringify({ path: DBX_FILE, mode: 'overwrite', mute: true }), 'Content-Type': 'application/octet-stream' },
    JSON.stringify(data, null, 1),
  );
  if (!r.ok) throw new Error('zapis: HTTP ' + r.status);
}

function syncNow() {
  if (!isConnected()) { Sync.state = 'off'; renderSync(); return Promise.resolve(); }
  if (Sync.busy) { Sync.again = true; return Sync.busy; }
  Sync.busy = (async () => {
    if (!navigator.onLine) { Sync.state = 'offline'; return; }
    Sync.state = 'busy';
    renderSync();
    try {
      const remote = normalizeProgress(await pullRemote());
      progress = mergeProgress(progress, remote); // obejmuje też oceny dodane w trakcie
      saveLocal();
      if (differs(progress, remote)) await pushRemote(progress);
      Sync.state = 'ok';
      Sync.last = Date.now();
      Sync.error = '';
    } catch (e) {
      Sync.state = isConnected() ? 'error' : 'off';
      Sync.error = e.message;
    }
  })().finally(() => {
    Sync.busy = null;
    renderSync();
    if (view === 'home') renderHome();
    if (view === 'settings') renderSettings();
    if (Sync.again) { Sync.again = false; scheduleSync(); }
  });
  return Sync.busy;
}
function scheduleSync(delay = 2000) {
  clearTimeout(Sync.timer);
  Sync.timer = setTimeout(syncNow, delay);
}

async function handleRedirect() {
  const p = new URLSearchParams(location.search);
  if (!p.has('code') && !p.has('error')) return;
  history.replaceState(null, '', location.pathname);
  if (p.has('error')) { toast('Dropbox: ' + (p.get('error_description') || p.get('error'))); return; }
  const pk = store.get(KEYS.pkce, null);
  if (!pk || pk.state !== p.get('state')) { toast('Nieoczekiwana odpowiedź z Dropboxa – spróbuj połączyć ponownie.'); return; }
  try { await exchangeCode(p.get('code'), true); toast('Połączono z Dropboxem ✓'); }
  catch (e) { toast('Nie udało się połączyć: ' + e.message); }
}

/* ================= UI: pomocnicze ================= */
let view = 'home';
let session = null;
let UI = { mode: 'forms', group: 'all', ...store.get(KEYS.ui, {}) };
const app = typeof document !== 'undefined' ? document.getElementById('app') : null;
const $ = (sel) => app.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const saveUI = () => store.set(KEYS.ui, UI);
const perfLine = (w) => (w.vd ? `(${w.hulp}) ${w.vd}` : 'brak perfectum');
const formsLine = (w) => `${w.nl} – ${w.imp_ev} / ${w.imp_mv} – ${perfLine(w)}`;

function plural(n, one, few, many) {
  if (n === 1) return one;
  const d = n % 10, dd = n % 100;
  return d >= 2 && d <= 4 && !(dd >= 12 && dd <= 14) ? few : many;
}
let toastTimer = 0;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}
function syncLabel() {
  switch (Sync.state) {
    case 'busy': return ['busy', 'Synchronizuję…'];
    case 'ok': return ['ok', 'Dropbox ✓'];
    case 'error': return ['error', 'Błąd synchronizacji'];
    case 'offline': return ['busy', 'Offline'];
    default: return isConnected() ? ['', 'Dropbox'] : ['', 'Połącz Dropbox'];
  }
}
function renderSync() {
  const el = app && app.querySelector('#sync');
  if (!el) return;
  const [cls, label] = syncLabel();
  el.innerHTML = `<span class="dot ${cls}"></span>${esc(label)}`;
}
function groupOptions() {
  return `<option value="all">Wszystkie (${WORDS.length})</option>` +
    Object.entries(GROUPS).map(([id, label]) => {
      const n = WORDS.filter((w) => w.groep === id).length;
      return `<option value="${esc(id)}" ${UI.group === id ? 'selected' : ''}>${esc(label)} · ${n}</option>`;
    }).join('');
}
function levelDots(box) {
  const lvl = Math.min(box ?? -1, MASTERED) + 1;
  return '●'.repeat(Math.max(0, lvl)) + `<i>${'●'.repeat(MASTERED + 1 - Math.max(0, lvl))}</i>`;
}

/* ================= widok: start ================= */
function renderHome() {
  view = 'home';
  if (UI.group !== 'all' && !GROUPS[UI.group]) UI.group = 'all';
  const st = stats(UI.mode, UI.group);
  const todo = st.due + st.newAllowed;
  const pct = st.total ? Math.round((st.mastered / st.total) * 100) : 0;
  app.innerHTML = `
    <header class="bar">
      <h1>Woorden</h1>
      <button class="sync-pill" id="sync" data-act="settings"></button>
    </header>
    <section class="hero">
      <div class="hero-num">${st.due}</div>
      <div class="hero-label">${plural(st.due, 'powtórka', 'powtórki', 'powtórek')} na dziś</div>
      <div class="hero-sub">+ ${st.newAllowed} ${plural(st.newAllowed, 'nowe', 'nowe', 'nowych')} · opanowane ${st.mastered} z ${st.total}</div>
      <div class="meter" aria-label="Opanowane: ${pct}%"><span style="width:${pct}%"></span></div>
    </section>
    <div class="field">
      <span class="field-label">Tryb</span>
      <div class="seg">${Object.entries(MODES).map(([m, l]) =>
        `<button data-act="mode" data-v="${m}" aria-pressed="${m === UI.mode}">${l}</button>`).join('')}</div>
      <p class="hint">${UI.mode === 'forms'
        ? 'Widzisz bezokolicznik → wpisujesz imperfectum, hebben/zijn i voltooid deelwoord.'
        : 'Widzisz polskie znaczenie → wpisujesz holenderski bezokolicznik.'}</p>
    </div>
    <label class="field">
      <span class="field-label">Grupa</span>
      <select id="group">${groupOptions()}</select>
    </label>
    <button class="btn primary big" data-act="start" ${todo ? '' : 'disabled'}>
      ${todo ? `Zacznij · ${todo}` : 'Na dziś wszystko zrobione ✓'}
    </button>
    <button class="btn" data-act="practice">Trening dodatkowy <span style="font-weight:400;color:var(--muted)">(nie zmienia planu)</span></button>
    <nav class="links">
      <button data-act="list">Lista czasowników</button>
      <button data-act="settings">Ustawienia</button>
    </nav>`;
  renderSync();
}

/* ================= widok: sesja ================= */
function startSession(practice) {
  const queue = practice ? shuffle(wordsFor(UI.group)).slice(0, 15) : buildQueue(UI.mode, UI.group);
  if (!queue.length) { toast('Brak słówek do powtórki.'); return; }
  session = { mode: UI.mode, practice, queue, i: 0, seen: new Set(), firstOk: 0, unique: new Set(queue.map((w) => w.id)).size };
  renderCard();
}

function inputAttrs(name, last) {
  return `name="${name}" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" lang="nl" enterkeyhint="${last ? 'done' : 'next'}"`;
}

function renderCard() {
  view = 'session';
  const s = session;
  const w = s.queue[s.i];
  s.checked = false;
  s.hulp = null;
  const total = s.queue.length;
  const fields = s.mode === 'forms' ? `
      <label class="fld" data-f="ev"><span>Imperfectum · enkelvoud <em>(ik, hij)</em></span><input ${inputAttrs('ev')}><small class="sol"></small></label>
      <label class="fld" data-f="mv"><span>Imperfectum · meervoud <em>(wij)</em></span><input ${inputAttrs('mv', !w.vd)}><small class="sol"></small></label>
      ${w.vd ? `
      <div class="fld" data-f="hulp"><span>Hulpwerkwoord</span>
        <div class="seg"><button type="button" data-act="hulp" data-v="hebben" aria-pressed="false">hebben</button><button type="button" data-act="hulp" data-v="zijn" aria-pressed="false">zijn</button></div>
        <small class="sol"></small></div>
      <label class="fld" data-f="vd"><span>Voltooid deelwoord</span><input ${inputAttrs('vd', true)}><small class="sol"></small></label>`
      : '<p class="hint" style="text-align:center">Ten czasownik nie ma perfectum.</p>'}`
    : `<label class="fld" data-f="nl"><span>Po holendersku (bezokolicznik)</span><input ${inputAttrs('nl', true)}><small class="sol"></small></label>`;

  app.innerHTML = `
    <header class="bar">
      <button class="link" data-act="quit">← Zakończ</button>
      <span class="count">${s.practice ? 'trening · ' : ''}${s.i + 1} / ${total}</span>
    </header>
    <div class="meter thin"><span style="width:${(s.i / total) * 100}%"></span></div>
    <section class="prompt">
      ${s.mode === 'forms'
        ? `<div class="nl">${esc(w.nl)}</div><div class="pl">${esc(w.pl)}</div><span class="tag">${esc(GROUPS[w.groep] || '')}</span>`
        : `<div class="pl-big">${esc(w.pl)}</div>`}
    </section>
    <form id="ans" autocomplete="off" novalidate>
      ${fields}
      <div class="feedback" id="fb"></div>
      <div class="actions">
        <button type="button" class="btn" data-act="dunno">Nie wiem</button>
        <button type="submit" class="btn primary" id="go">Sprawdź</button>
      </div>
    </form>`;
  const first = $('#ans input');
  if (first) first.focus();
}

function check(dunno = false) {
  const s = session;
  const w = s.queue[s.i];
  const form = $('#ans');
  const val = (n) => form.elements[n].value;

  if (s.mode === 'forms' && w.vd && !dunno && !s.hulp) {
    const h = form.querySelector('[data-f="hulp"]');
    h.classList.add('need');
    toast('Wybierz hebben albo zijn');
    return;
  }

  const results = s.mode === 'forms'
    ? [['ev', val('ev'), w.imp_ev], ['mv', val('mv'), w.imp_mv],
       ...(w.vd ? [['hulp', s.hulp || '', w.hulp], ['vd', val('vd'), w.vd]] : [])]
    : [['nl', val('nl'), w.nl]];
  let ok = true;
  for (const [f, v, answer] of results) {
    const right = !dunno && isRight(v, answer);
    ok = ok && right;
    const el = form.querySelector(`[data-f="${f}"]`);
    el.classList.remove('need');
    el.classList.add(right ? 'ok' : 'bad');
    if (!right) el.querySelector('.sol').textContent = '→ ' + answer;
  }
  form.querySelectorAll('input').forEach((i) => { i.readOnly = true; });
  form.querySelectorAll('[data-act="hulp"], [data-act="dunno"]').forEach((b) => { b.disabled = true; });

  const fb = $('#fb');
  fb.className = 'feedback ' + (ok ? 'ok' : 'bad');
  fb.innerHTML = (ok ? 'Goed zo! ✓' : 'Jeszcze nie – to słówko wróci na końcu sesji.') +
    `<span class="full">${esc(formsLine(w))}<br>${esc(w.pl)}</span>`;

  if (!s.practice) grade(w, s.mode, ok);
  if (!s.seen.has(w.id)) { s.seen.add(w.id); if (ok) s.firstOk++; }
  if (!ok) s.queue.push(w);

  s.checked = true;
  const go = $('#go');
  go.textContent = 'Dalej →';
  go.focus();
}

function next() {
  session.i++;
  if (session.i >= session.queue.length) renderDone();
  else renderCard();
}

function renderDone() {
  view = 'done';
  const s = session;
  app.innerHTML = `
    <section class="done">
      <h2>${s.practice ? 'Koniec treningu' : 'Sesja zakończona'}</h2>
      <div class="hero-num">${s.firstOk}/${s.unique}</div>
      <p class="hint">dobrze za pierwszym razem</p>
      <button class="btn primary big" data-act="home">Wróć</button>
    </section>`;
  session = null;
  syncNow();
}

/* ================= widok: lista ================= */
function renderList(q = '') {
  view = 'list';
  app.innerHTML = `
    <header class="bar">
      <button class="link" data-act="home">← Wróć</button>
      <h2>Lista</h2>
      <span style="width:52px"></span>
    </header>
    <label class="field"><span class="field-label">Grupa</span><select id="group">${groupOptions()}</select></label>
    <input class="search" id="search" type="search" placeholder="Szukaj (nl lub pl)…" value="${esc(q)}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
    <ul class="list" id="rows"></ul>`;
  renderRows(q);
}
function renderRows(q) {
  const nq = norm(q);
  const ws = wordsFor(UI.group).filter((w) => !nq || norm(w.nl + ' ' + w.pl + ' ' + formsLine(w)).includes(nq));
  $('#rows').innerHTML = ws.length ? ws.map((w) => {
    const s = progress.cards[cardKey(w, 'forms')];
    return `<li>
      <div class="w">${esc(w.nl)}<span>${esc(w.pl)}</span></div>
      <div class="f">${esc(w.imp_ev)} / ${esc(w.imp_mv)} · ${esc(perfLine(w))}</div>
      <div class="lvl" title="Poziom w trybie Formy">${levelDots(s ? s.box : null)}</div>
    </li>`;
  }).join('') : '<li class="empty">Nic nie znaleziono.</li>';
}

/* ================= widok: ustawienia ================= */
function renderSettings() {
  view = 'settings';
  const connected = isConnected();
  const last = Sync.last ? new Date(Sync.last).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' }) : '–';
  app.innerHTML = `
    <header class="bar">
      <button class="link" data-act="home">← Wróć</button>
      <h2>Ustawienia</h2>
      <span style="width:52px"></span>
    </header>
    <section class="panel">
      <h3>Dropbox</h3>
      ${connected ? `
        <p>Połączono. Postępy zapisują się w <code>Dropbox/Aplikacje/nl-leren/vlaams-woorden/postepy.json</code> i są wspólne dla telefonu i komputera.</p>
        <p>Ostatnia synchronizacja: <b>${last}</b>${Sync.state === 'error' ? ` · <span style="color:var(--bad)">${esc(Sync.error)}</span>` : ''}</p>
        <div class="row">
          <button class="btn primary" data-act="sync">Synchronizuj teraz</button>
          <button class="btn" data-act="disconnect">Rozłącz</button>
        </div>` : `
        <p>Połącz, żeby postępy były wspólne na iPhonie i komputerze. Aplikacja widzi tylko swój folder <code>Aplikacje/nl-leren</code>.</p>
        ${onPages() ? '<button class="btn primary" data-act="connect">Połącz z Dropboxem</button>' : ''}
        <details ${onPages() ? '' : 'open'}>
          <summary>${onPages() ? 'Nie działa? Połącz ręcznie' : 'Połącz ręcznie'}</summary>
          <ol>
            <li><a id="manual" href="#" target="_blank" rel="noopener">Otwórz Dropbox</a> i kliknij „Zezwól”.</li>
            <li>Skopiuj kod, który pokaże Dropbox.</li>
            <li>Wklej go tutaj:</li>
          </ol>
          <div class="row">
            <input id="code" type="text" placeholder="kod z Dropboxa" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false">
            <button class="btn primary" data-act="manualCode">Połącz</button>
          </div>
        </details>`}
    </section>
    <section class="panel">
      <h3>Nauka</h3>
      <label class="field" style="margin:8px 0 0">
        <span class="field-label">Nowe słówka dziennie (na tryb)</span>
        <select id="newPerDay">${[5, 10, 15, 20, 30, 50].map((n) =>
          `<option ${n === progress.settings.newPerDay ? 'selected' : ''}>${n}</option>`).join('')}</select>
      </label>
    </section>
    <p class="hint" style="text-align:center">${WORDS.length} czasowników · poziom ${MASTERED}+ = opanowane</p>`;
  if (!connected) {
    authorizeUrl(false).then((url) => { const a = app.querySelector('#manual'); if (a) a.href = url; });
  }
}

/* ================= zdarzenia ================= */
const actions = {
  mode(b) { UI.mode = b.dataset.v; saveUI(); renderHome(); },
  start() { startSession(false); },
  practice() { startSession(true); },
  list() { renderList(); },
  settings() { renderSettings(); },
  home() { renderHome(); },
  quit() { session = null; renderHome(); syncNow(); },
  dunno() { if (session && !session.checked) check(true); },
  hulp(b) {
    if (!session || session.checked) return;
    session.hulp = b.dataset.v;
    const wrap = b.closest('.fld');
    wrap.classList.remove('need');
    wrap.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    const vd = $('#ans').elements.namedItem('vd');
    if (vd && !vd.value) vd.focus();
  },
  async connect() { location.href = await authorizeUrl(true); },
  async manualCode() {
    const code = $('#code').value;
    if (!code.trim()) { toast('Wklej kod z Dropboxa'); return; }
    try { await exchangeCode(code, false); toast('Połączono z Dropboxem ✓'); await syncNow(); renderSettings(); }
    catch (e) { toast('Nie udało się: ' + e.message); }
  },
  sync() { syncNow(); },
  disconnect() {
    if (!confirm('Odłączyć Dropbox na tym urządzeniu? Postępy zostaną w Dropboxie i na tym urządzeniu.')) return;
    store.del(KEYS.auth);
    Sync.state = 'off';
    renderSettings();
  },
};

function bindEvents() {
  app.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    e.preventDefault();
    actions[b.dataset.act]?.(b, e);
  });
  app.addEventListener('change', (e) => {
    if (e.target.id === 'group') {
      UI.group = e.target.value;
      saveUI();
      if (view === 'list') renderRows($('#search').value);
      else renderHome();
    }
    if (e.target.id === 'newPerDay') {
      progress.settings = { ...progress.settings, newPerDay: Number(e.target.value), updated: Date.now() };
      saveLocal();
      scheduleSync(500);
    }
  });
  app.addEventListener('input', (e) => {
    if (e.target.id === 'search') renderRows(e.target.value);
  });
  app.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!session) return;
    if (session.checked) { next(); return; }
    const inputs = [...e.target.querySelectorAll('input')];
    const idx = inputs.indexOf(document.activeElement);
    if (idx > -1 && idx < inputs.length - 1 && !inputs[idx + 1].value) { inputs[idx + 1].focus(); return; }
    check(false);
  });
  document.addEventListener('keydown', (e) => {
    // skróty na komputerze: h / z wybiera hulpwerkwoord, gdy kursor nie jest w polu tekstowym
    if (!session || session.checked || e.target.tagName === 'INPUT' || e.metaKey || e.ctrlKey) return;
    const v = e.key === 'h' ? 'hebben' : e.key === 'z' ? 'zijn' : null;
    const b = v && app.querySelector(`[data-act="hulp"][data-v="${v}"]`);
    if (b) actions.hulp(b);
  });
  document.addEventListener('visibilitychange', () => { syncNow(); });
  window.addEventListener('online', () => syncNow());
}

async function boot() {
  try {
    const r = await fetch('data/slowka.json', { cache: 'no-cache' });
    const data = await r.json();
    WORDS = data.werkwoorden;
    GROUPS = data.groepen || {};
  } catch {
    app.innerHTML = '<p class="loading">Nie udało się wczytać listy słówek.</p>';
    return;
  }
  bindEvents();
  await handleRedirect();
  renderHome();
  syncNow();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

if (app) boot();
