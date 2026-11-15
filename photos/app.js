(() => {
  'use strict';

  const C = window.WP_CONFIG;
  const qs = new URLSearchParams(location.search);
  const DEMO = !C.SCRIPT_URL || qs.has('demo');
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const store = {
    get(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } },
    set(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {} }
  };

  // ---- Keys: guest key comes from the QR link (?k=...), admin key from ?admin=...
  let KEY = qs.get('k') || store.get('wp_key');
  if (qs.get('k')) store.set('wp_key', qs.get('k'));
  // Anonymous random id for this phone, so a guest can later delete photos they uploaded.
  const DEVICE = store.get('wp_dev') || (() => {
    const a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    const id = [...a].map(b => b.toString(16).padStart(2, '0')).join('');
    store.set('wp_dev', id);
    return id;
  })();

  let ADMIN = qs.get('admin') || store.get('wp_admin');
  if (qs.has('admin')) {
    store.set('wp_admin', qs.get('admin'));
    qs.delete('admin');
    history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs : '') + location.hash);
  }

  const state = {
    items: [],            // newest first
    album: 'all',
    isAdmin: false,
    local: new Map(),     // id -> object URL for things uploaded from this phone
    view: [],             // currently filtered list
    rendered: 0,
    cols: [],
    colH: [],
    lbIndex: -1,
    uploading: 0,
    uploadMode: store.get('wp_mode') || 'direct',
    selecting: false,
    sel: new Set()
  };

  /* ================================================================ */
  /* API                                                              */
  /* ================================================================ */
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function api(body, tries = 4) {
    if (DEMO) return demoApi(body);
    let lastErr;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await fetch(C.SCRIPT_URL, {
          method: 'POST',
          body: JSON.stringify(Object.assign({}, body, { k: KEY, admin: ADMIN, device: DEVICE }))
        });
        const j = await r.json();
        if (j.ok) return j;
        lastErr = new Error(j.error || 'Something went wrong');
        if (/INVALID_KEY|too large|Only photos|Unknown album|Not allowed/.test(lastErr.message)) throw lastErr;
      } catch (e) {
        lastErr = e;
        if (/INVALID_KEY|too large|Only photos|Unknown album|Not allowed/.test(e.message)) throw e;
      }
      await sleep(800 * Math.pow(2, i) + Math.random() * 400);
    }
    throw lastErr;
  }

  /* ================================================================ */
  /* URLs for Drive files                                             */
  /* ================================================================ */
  function thumbUrl(it, w) {
    if (state.local.has(it.id)) return state.local.get(it.id);
    if (it.src) return it.src;
    return it.v
      ? `https://drive.google.com/thumbnail?id=${it.id}&sz=w${w}`
      : `https://lh3.googleusercontent.com/d/${it.id}=w${w}`;
  }
  function fullUrl(it) {
    if (it.src) return it.full || it.src;
    if (state.local.has(it.id) && !it.v) return state.local.get(it.id);
    const w = Math.min(2400, Math.round(Math.max(innerWidth, innerHeight) * (devicePixelRatio || 1)));
    return `https://lh3.googleusercontent.com/d/${it.id}=w${w}`;
  }
  function downloadUrl(it) {
    if (it.src) return it.full || it.src;
    return `https://drive.google.com/uc?export=download&id=${it.id}`;
  }

  /* ================================================================ */
  /* Boot                                                             */
  /* ================================================================ */
  async function init() {
    if (!KEY && !DEMO) return showLocked();
    try {
      const r = await api({ action: 'check' }, 2);
      state.isAdmin = !!r.admin;
    } catch (e) {
      if (/INVALID_KEY/.test(e.message)) { store.set('wp_key', ''); KEY = ''; return showLocked(true); }
    }
    showApp();
  }

  function showLocked(bad) {
    $('#locked').hidden = false;
    $('#codeErr').hidden = !bad;
    $('#codeForm').onsubmit = e => {
      e.preventDefault();
      const v = $('#codeInput').value.trim();
      if (!v) return;
      const u = new URL(location.href);
      u.searchParams.set('k', v);
      location.href = u.toString();
    };
  }

  function showApp() {
    $('#app').hidden = false;
    renderTabs();
    loadItems();
    setInterval(() => { if (document.visibilityState === 'visible') loadItems(true); }, 45000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') loadItems(true); });

    // Entry point: the QR code (…&qr=1) shows the landing cover; a shared link goes straight to Home.
    if (qs.has('qr')) {
      qs.delete('qr'); // so a forwarded copy of this URL opens Home, not the cover
      history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs : '') + location.hash);
    } else if (!location.hash) {
      history.replaceState(null, '', location.pathname + location.search + '#home');
    }
    renderCollage();
    route();
    loadAnnouncements();
    loadSchedule();
    renderNowCard();
    setInterval(() => { renderNowCard(); if (document.visibilityState === 'visible') loadAnnouncements(); }, 60000);
    $('#selToggle').hidden = !state.isAdmin;
    document.body.classList.toggle('is-admin', state.isAdmin);

    $$('[data-open-upload]').forEach(b => b.addEventListener('click', () => pickFiles()));
    // Phones fire "resize" whenever the address bar shrinks/grows while scrolling.
    // Only redraw the grid when the width actually changes the number of columns.
    window.addEventListener('resize', debounce(() => {
      if (state.cols.length && colCount() === state.cols.length) return;
      layout(true);
    }, 200));
    startPetals();
  }

  /* ================================================================ */
  /* Gallery                                                          */
  /* ================================================================ */
  async function loadItems(silent) {
    try {
      const { items } = await api({ action: 'list' }, silent ? 1 : 4);
      const known = new Set(state.items.map(i => i.id));
      const fresh = items.filter(i => !known.has(i.id));
      // keep things uploaded from this phone even if the server cache hasn't caught up
      const serverIds = new Set(items.map(i => i.id));
      const pendingMine = state.items.filter(i => state.local.has(i.id) && !serverIds.has(i.id));
      const next = pendingMine.concat(items);

      // Nothing changed → never touch the page.
      const sig = arr => arr.map(i => i.id).join(',');
      if (silent && sig(next) === sig(state.items)) return;

      // Someone is scrolling the album → don't redraw under their finger.
      // New photos show a small "↑ N new" pill; other changes wait for the next quiet refresh.
      const scrolling = document.body.classList.contains('view-album') && window.scrollY > 300;
      if (silent && (scrolling || state.selecting || !lb.hidden)) {
        if (fresh.length && scrolling) {
          const pill = $('#newPill');
          pill.textContent = `↑ ${fresh.length} new ${fresh.length === 1 ? 'photo' : 'photos'}`;
          pill.hidden = false;
          pill.onclick = () => { pill.hidden = true; state.items = next; refresh(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
        }
        return;
      }
      $('#newPill').hidden = true;
      state.items = next;
      refresh();
    } catch (e) {
      if (!silent) toast('Could not load the album. Pull to refresh in a moment.');
    } finally {
      $('#loading').hidden = true;
    }
  }

  let refresh = function () {
    renderCollage();
    renderTabs();
    updateStats();
    layout(true);
  };

  function updateStats() {
    if (!$('#stats')) return;
    const n = state.items.length;
    const guests = new Set(state.items.map(i => (i.g || '').toLowerCase()).filter(Boolean)).size;
    $('#stats').textContent = n
      ? `${n} ${n === 1 ? 'memory' : 'memories'} shared${guests > 1 ? ` by ${guests} guests` : ''}`
      : 'Be the first to share a memory';
  }

  function renderTabs() {
    const counts = {};
    state.items.forEach(i => { counts[i.a] = (counts[i.a] || 0) + 1; });
    const tabs = [{ id: 'all', label: 'All', when: state.items.length ? String(state.items.length) : '' }]
      .concat(C.ALBUMS.map(a => ({ id: a.id, label: a.label, when: counts[a.id] ? String(counts[a.id]) : a.when })));
    const nav = $('#tabs');
    nav.innerHTML = '';
    nav.hidden = true; // one album for guests: no function tabs
    state.album = 'all';
    return;
    tabs.forEach(t => {
      const b = document.createElement('button');
      b.className = 'tab';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(state.album === t.id));
      b.innerHTML = `${esc(t.label)}${t.when ? ` <small>${esc(t.when)}</small>` : ''}`;
      b.onclick = () => {
        if (state.album === t.id) return;
        state.album = t.id;
        renderTabs();
        layout(true);
        window.scrollTo(0, 0);
      };
      nav.appendChild(b);
    });
  }

  function colCount() {
    const w = $('#grid').clientWidth || innerWidth;
    return w < 560 ? 2 : w < 860 ? 3 : w < 1100 ? 4 : 5;
  }

  let sentinelObs;
  function layout(reset) {
    const grid = $('#grid');
    state.view = state.album === 'all' ? state.items : state.items.filter(i => i.a === state.album);
    $('#empty').hidden = state.view.length > 0;

    const n = colCount();
    if (reset || state.cols.length !== n) {
      grid.innerHTML = '';
      state.cols = [];
      state.colH = [];
      for (let i = 0; i < n; i++) {
        const c = document.createElement('div');
        c.className = 'col';
        grid.appendChild(c);
        state.cols.push(c);
        state.colH.push(0);
      }
      state.rendered = 0;
    }
    renderMore();

    if (sentinelObs) sentinelObs.disconnect();
    let s = $('#sentinel');
    if (!s) { s = document.createElement('div'); s.id = 'sentinel'; s.style.height = '1px'; $('#gallery').appendChild(s); }
    sentinelObs = new IntersectionObserver(([e]) => { if (e.isIntersecting) renderMore(); }, { rootMargin: '1200px' });
    sentinelObs.observe(s);
  }

  function renderMore() {
    const batch = state.view.slice(state.rendered, state.rendered + 40);
    if (!batch.length) return;
    const colW = state.cols[0].clientWidth || 180;
    const tw = colW * (devicePixelRatio || 1) > 500 ? 800 : 500;
    batch.forEach((it, k) => {
      const idx = state.rendered + k;
      const ratio = it.w && it.h ? it.h / it.w : 1.25;
      let c = 0;
      for (let i = 1; i < state.colH.length; i++) if (state.colH[i] < state.colH[c] - 0.05) c = i;
      state.colH[c] += ratio;
      state.cols[c].appendChild(tile(it, idx, ratio, tw));
    });
    state.rendered += batch.length;
  }

  function tile(it, idx, ratio, tw) {
    const b = document.createElement('button');
    b.className = 'tile';
    b.style.aspectRatio = `1 / ${ratio}`;
    b.style.animationDelay = `${Math.min(idx % 40, 12) * 30}ms`;
    b.setAttribute('aria-label', `${it.v ? 'Video' : 'Photo'}${it.g ? ' by ' + it.g : ''}`);

    const img = new Image();
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = '';
    let retried = false;
    img.onload = () => img.classList.add('ok');
    img.onerror = () => {
      if (!retried && !it.src) { retried = true; setTimeout(() => { const u = thumbUrl(it, tw); img.src = u + (u.includes('?') ? '&' : '?') + 'r=1'; }, 4000); return; }
      img.remove();
      $('.shimmer', b)?.remove();
      const ph = document.createElement('div');
      ph.className = 'vid-ph';
      ph.textContent = it.v ? 'Video is processing…' : 'Photo is processing…';
      b.appendChild(ph);
    };
    if (state.local.has(it.id) && it.v) {
      // local video preview: grab a frame
      const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'metadata';
      v.src = state.local.get(it.id) + '#t=0.1';
      v.style.cssText = 'width:100%;height:100%;object-fit:cover';
      b.appendChild(v);
    } else {
      img.src = thumbUrl(it, tw);
      b.appendChild(img);
      const sh = document.createElement('div');
      sh.className = 'shimmer';
      b.appendChild(sh);
    }
    if (it.v) b.insertAdjacentHTML('beforeend', '<span class="play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span>');
    if (it.g) b.insertAdjacentHTML('beforeend', `<span class="by">${esc(it.g)}</span>`);
    b.dataset.id = it.id;
    if (state.sel.has(it.id)) b.classList.add('sel');
    b.onclick = () => (state.selecting ? toggleSel(it.id, b) : openLightbox(idx));
    return b;
  }


  /* ================================================================ */
  /* Top collage: rows of photos that scroll slowly, looping forever   */
  /* ================================================================ */
  const COLS = 3;
  const PLACEHOLDERS = ['/assets/hero-couple.webp', '/assets/mehendi.webp', '/assets/engagement.webp',
    '/assets/wedding-watercolor.webp', '/assets/hands-holding.webp', '/assets/arch-bougainvillea.webp']
    .map((src, i) => ({ id: 'ph' + i, src, w: 0, h: 0 }));
  let collageKey = null;

  // Three columns of photos drifting vertically (middle one in the opposite direction), looping forever.
  function renderCollage() {
    const pics = state.items.filter(i => !i.v).slice(0, 45);
    const key = pics.map(p => p.id).join(',') + '|' + innerWidth; // width only: address-bar height changes must not redraw
    const el = $('#collage');
    // Hidden (album page) → nothing to measure; render again when home is shown.
    if (el.clientWidth < 60 || el.clientHeight < 60) { collageKey = null; return; }
    if (key === collageKey) return;
    collageKey = key;

    const list = pics.length ? pics : PLACEHOLDERS;
    const gap = 6;
    const colW = (el.clientWidth - gap * (COLS + 1)) / COLS;
    // Mixed tile shapes so the collage feels organic: real portraits stay portrait,
    // other photos get a varied crop (tall, square, wide) based on their position.
    const SHAPES = [0.75, 1.25, 0.66, 1, 0.8, 1.5, 0.7, 1.1];
    const ar = (it, pos) => {
      const real = it.w && it.h ? it.w / it.h : 0;
      if (real && real < 0.9) return Math.max(0.6, real);
      return SHAPES[pos % SHAPES.length];
    };
    const height = items => items.reduce((sum, it, i) => sum + colW / ar(it, i) + gap, 0);
    el.innerHTML = '';

    for (let c = 0; c < COLS; c++) {
      // spread photos across columns (rotated so columns don't line up), repeat until taller than the box
      let col;
      if (list.length >= COLS * 4) {
        col = list.filter((_, i) => i % COLS === c);
      } else {
        // few photos: every column shows all of them, starting at a different one
        const k = Math.round((c * list.length) / COLS) % list.length;
        col = list.slice(k).concat(list.slice(0, k));
        if (c % 2) col.reverse();
      }
      let filled = col.slice();
      for (let guard = 0; guard < 30 && height(filled) < el.clientHeight * 1.4; guard++) filled = filled.concat(col);

      const colEl = document.createElement('div');
      colEl.className = 'c-col' + (c % 2 ? ' rev' : '');
      const track = document.createElement('div');
      track.className = 'c-track';
      // two identical halves → translateY(-50%) loops seamlessly
      const shift = c * 3; // different shape sequence per column
      const shaped = filled.map((it, i) => ({ it, a: ar(it, i + shift) }));
      const colHeight = shaped.reduce((sum, x) => sum + colW / x.a + gap, 0);
      shaped.concat(shaped).forEach(({ it, a }) => {
        const t = document.createElement('button');
        t.className = 'c-tile';
        t.style.aspectRatio = String(a);
        const img = new Image();
        img.alt = '';
        img.decoding = 'async';
        img.onload = () => img.classList.add('ok');
        img.src = thumbUrl(it, 400);
        t.appendChild(img);
        t.onclick = it.id.startsWith('ph') ? () => pickFiles() : openFromCollage;
        track.appendChild(t);
      });
      const dur = Math.round(colHeight / (16 + c * 3));
      track.style.animationDuration = `${dur}s`;
      track.style.animationDelay = `-${Math.round(dur * (c * 0.37 % 1))}s`; // start columns at different points
      colEl.appendChild(track);
      el.appendChild(colEl);
    }
  }

  function openFromCollage() {
    location.hash = 'album';
  }

  /* ---------------- Home <-> Album page (hash routing) ---------------- */
  let lastRoute = null;
  let backTo = '#'; // where the Updates page's back arrow goes
  function route() {
    const h = location.hash;
    if (h !== '#updates' && h !== '#schedule') backTo = h || '#';
    const album = h === '#album';
    const mine = h === '#mine';
    const missions = h === '#missions';
    const missionId = h.startsWith('#mission/') ? decodeURIComponent(h.slice(9)) : null;
    const updates = h === '#schedule' || h === '#updates';
    const home = h === '#home';
    document.body.classList.toggle('view-updates', updates);
    document.body.classList.toggle('view-home', home);
    document.body.classList.toggle('view-album', album);
    document.body.classList.toggle('view-mine', mine);
    document.body.classList.toggle('view-missions', missions);
    document.body.classList.toggle('view-mission', !!missionId);
    if (h === lastRoute) return;
    lastRoute = h;
    window.scrollTo(0, 0);
    if (!album) setSelecting(false);
    if (album) layout(true);
    else if (mine) loadMine();
    else if (missions) renderMissions();
    else if (missionId) renderMissionDetail(missionId);
    else if (updates) openUpdates();
    else if (home) renderHome();
    else renderCollage();
    renderBanner();
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('resize', debounce(() => renderCollage(), 300));

  /* ================================================================ */
  /* Admin multi-select: Download / Hide / Delete                     */
  /* ================================================================ */
  function setSelecting(on) {
    state.selecting = on;
    if (!on) state.sel.clear();
    document.body.classList.toggle('selecting', on);
    $('#selBar').hidden = !on;
    $('#selToggle').textContent = on ? 'Cancel' : 'Select';
    $$('.tile.sel').forEach(t => { if (!state.sel.has(t.dataset.id)) t.classList.remove('sel'); });
    updateSelUI();
  }

  function toggleSel(id, el) {
    if (state.sel.has(id)) state.sel.delete(id); else state.sel.add(id);
    el.classList.toggle('sel', state.sel.has(id));
    updateSelUI();
  }

  function updateSelUI() {
    const n = state.sel.size;
    $('#albumTitle').textContent = state.selecting ? (n ? `${n} selected` : 'Select photos') : 'Our album';
    ['#selDownload', '#selHide', '#selDelete'].forEach(s => { $(s).disabled = !n; });
    const all = state.view.length && n === state.view.length;
    $('#selAll').textContent = all ? 'Clear' : 'Select all';
  }

  $('#selToggle').onclick = () => setSelecting(!state.selecting);
  $('#selAll').onclick = () => {
    const all = state.view.length && state.sel.size === state.view.length;
    state.sel = new Set(all ? [] : state.view.map(i => i.id));
    $$('.tile').forEach(t => t.classList.toggle('sel', state.sel.has(t.dataset.id)));
    updateSelUI();
  };

  // Run one API call per photo, 3 at a time, with a live count in the title.
  async function bulk(action, verb) {
    const ids = [...state.sel];
    let done = 0, failed = 0;
    const queue = ids.slice();
    const title = $('#albumTitle');
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift();
        try { await api({ action, id }, 2); state.items = state.items.filter(x => x.id !== id); }
        catch (e) { failed++; }
        done++;
        title.textContent = `${verb} ${done}/${ids.length}…`;
      }
    };
    document.body.classList.add('busy');
    await Promise.all([worker(), worker(), worker()]);
    document.body.classList.remove('busy');
    setSelecting(false);
    refresh();
    return { ok: ids.length - failed, failed };
  }

  $('#selDelete').onclick = async () => {
    const n = state.sel.size;
    if (!n || !confirm(`Delete ${n} ${n === 1 ? 'photo' : 'photos'}? They move to your Google Drive trash (recoverable for 30 days).`)) return;
    const r = await bulk('delete', 'Deleting');
    toast(r.failed ? `Deleted ${r.ok}, ${r.failed} failed` : `Deleted ${r.ok} ${r.ok === 1 ? 'photo' : 'photos'}`);
  };

  $('#selHide').onclick = async () => {
    const n = state.sel.size;
    if (!n || !confirm(`Hide ${n} ${n === 1 ? 'photo' : 'photos'} from the album? They stay in your Drive.`)) return;
    const r = await bulk('hide', 'Hiding');
    toast(r.failed ? `Hidden ${r.ok}, ${r.failed} failed` : `Hidden ${r.ok} ${r.ok === 1 ? 'photo' : 'photos'}`);
  };

  $('#selDownload').onclick = async () => {
    const ids = [...state.sel];
    if (!ids.length) return;
    const title = $('#albumTitle');
    title.textContent = `Preparing ${ids.length}…`;
    document.body.classList.add('busy');
    try {
      const r = DEMO ? { url: 'https://drive.google.com/', copied: ids.length, requested: ids.length } : await api({ action: 'collect', ids }, 1);
      setSelecting(false);
      $('#noticeText').textContent = r.copied === r.requested
        ? `${r.copied} ${r.copied === 1 ? 'photo is' : 'photos are'} ready in a new Drive folder. Open it and tap Download to get a zip.`
        : `${r.copied} of ${r.requested} photos are ready (it was a big batch). Open the folder and tap Download, then select the rest again.`;
      $('#noticeLink').href = r.url;
      $('#notice').hidden = false;
    } catch (e) {
      toast('Could not prepare the download: ' + e.message);
      updateSelUI();
    } finally {
      document.body.classList.remove('busy');
    }
  };
  $('#noticeClose').onclick = () => { $('#notice').hidden = true; };
  $('#noticeLink').addEventListener('click', () => setTimeout(() => { $('#notice').hidden = true; }, 300));

  /* ================================================================ */
  /* Wedding Missions                                                 */
  /* ================================================================ */
  const MISSIONS = (C.MISSIONS || []).slice();
  function missionById(id) { return MISSIONS.find(m => m.id === id); }
  function dayLabel(m) {
    const a = m.day && C.ALBUMS.find(x => x.id === m.day);
    return a ? `${a.label} · ${a.when}` : '';
  }

  // Missions this phone has completed (remembered locally + anything the server marks as ours).
  function missionsDone() {
    let local = [];
    try { local = JSON.parse(store.get('wp_ms_done') || '[]'); } catch (e) {}
    const set = new Set(local);
    state.items.forEach(it => { if (it.ms && isMine(it)) set.add(it.ms); });
    return new Set([...set].filter(id => missionById(id)));
  }
  function markMissionDone(id) {
    const s = missionsDone();
    s.add(id);
    store.set('wp_ms_done', JSON.stringify([...s]));
  }

  function celebrateMissions() {
    const n = missionsDone().size;
    const best = Number(store.get('wp_ms_best') || 0);
    if (n <= best) return;
    store.set('wp_ms_best', String(n));
    const total = MISSIONS.length;
    if (n === total) { toast('🏆 All missions complete! You legend.'); burstPetals(); setTimeout(burstPetals, 500); setTimeout(burstPetals, 1000); }
    else if (n === 5 || n === 10) { toast(`🎉 ${n} missions done!`); burstPetals(); setTimeout(burstPetals, 500); }
  }

  // Leaderboard: distinct missions per guest name, from photos shared with everyone.
  function leaderboard() {
    const by = new Map();
    state.items.forEach(it => {
      const name = (it.g || '').trim();
      if (!it.ms || !name || !missionById(it.ms)) return;
      const key = name.toLowerCase();
      if (!by.has(key)) by.set(key, { name, set: new Set() });
      by.get(key).set.add(it.ms);
    });
    return [...by.values()].map(x => ({ name: x.name, n: x.set.size }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  }

  let msTab = 'list';
  $$('.ms-seg button').forEach(b => b.onclick = () => { msTab = b.dataset.mt; renderMissions(); window.scrollTo(0, 0); });

  const AV_COLORS = ['#C9A48A', '#B8A27A', '#9C7F95', '#A4917D', '#8FA18C', '#B49283', '#9A9A86', '#C08497'];
  function avColor(name) {
    let h = 0;
    for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return AV_COLORS[h % AV_COLORS.length];
  }

  // Show the slim strip only while the big progress card is scrolled out of view (Missions tab only).
  let miniObs = null;
  function watchMiniProgress() {
    const mini = $('#msMini');
    const seg = $('.ms-seg');
    const card = $('#msPanelList .ms-card-top');
    const stuckBottom = 52 + seg.offsetHeight;         // header + switch, when stuck
    mini.style.top = `${stuckBottom + 12}px`;
    if (miniObs) miniObs.disconnect();
    miniObs = new IntersectionObserver(([e]) => {
      const show = !e.isIntersecting && msTab === 'list' && document.body.classList.contains('view-missions');
      mini.classList.toggle('show', show);
    }, { rootMargin: `-${stuckBottom}px 0px 0px 0px` });
    miniObs.observe(card);
  }

  function renderMissions() {
    $$('.ms-seg button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.mt === msTab)));
    $('#msPanelList').hidden = msTab !== 'list';
    $('#msPanelBoard').hidden = msTab !== 'board';

    const done = missionsDone();
    const total = MISSIONS.length;
    $('#msDone').textContent = done.size;
    $('#msTotal').textContent = total;
    $('#msBar').style.width = `${total ? Math.round((done.size / total) * 100) : 0}%`;
    $('#msMiniDone').textContent = done.size;
    $('#msMiniTotal').textContent = total;
    $('#msMiniBar').style.width = $('#msBar').style.width;
    watchMiniProgress();
    const allDone = total && done.size >= total;
    $('#msBadge').hidden = !allDone;

    const name = batch.guest || store.get('wp_name');
    const me = (name || '').trim().toLowerCase();
    const board = leaderboard();
    const myRank = me ? board.findIndex(r => r.name.toLowerCase() === me) : -1;

    // "You're #4" chip (or a nudge to join) → opens the Leaderboard tab
    const rank = $('#msRank');
    rank.hidden = !!allDone;
    rank.textContent = myRank >= 0 ? `You're #${myRank + 1}` : 'Join the leaderboard';
    rank.onclick = () => { msTab = 'board'; renderMissions(); window.scrollTo(0, 0); };

    // name card
    $('#msNameShow').hidden = !name;
    $('#msNameForm').hidden = !!name;
    $('#msNameHint').hidden = !!name;
    $('#msNameNow').textContent = name || '';

    // podium (2nd · 1st · 3rd)
    const pod = $('#msPodium');
    pod.innerHTML = '';
    const top = board.slice(0, 3);
    pod.hidden = !top.length;
    [1, 0, 2].forEach(i => {
      const r = top[i];
      if (!r) { pod.insertAdjacentHTML('beforeend', '<div class="pod empty"></div>'); return; }
      const isMe = r.name.toLowerCase() === me;
      pod.insertAdjacentHTML('beforeend', `
        <div class="pod p${i + 1}${isMe ? ' me' : ''}">
          <div class="av" style="background:${avColor(r.name)}">${esc(r.name.charAt(0).toUpperCase())}</div>
          <b>${esc(r.name)}${isMe ? ' <small>(you)</small>' : ''}</b>
          <small>${r.n} ${r.n === 1 ? 'mission' : 'missions'}</small>
          <div class="step"><span>${i + 1}</span></div>
        </div>`);
    });

    // everyone else
    const list = $('#msBoardList');
    list.innerHTML = '';
    board.slice(3).forEach((r, k) => {
      const isMe = r.name.toLowerCase() === me;
      const li = document.createElement('li');
      if (isMe) li.className = 'me';
      li.innerHTML = `<span class="rk">${k + 4}</span><span class="av" style="background:${avColor(r.name)}">${esc(r.name.charAt(0).toUpperCase())}</span><span class="nm">${esc(r.name)}${isMe ? ' <small>(you)</small>' : ''}</span><span class="ct">${r.n}</span>`;
      list.appendChild(li);
    });
    $('#msBoardEmpty').hidden = board.length > 0;

    // mission cards
    const counts = {};
    state.items.forEach(it => { if (it.ms) counts[it.ms] = (counts[it.ms] || 0) + 1; });
    const wrap = $('#msList');
    wrap.innerHTML = '';
    MISSIONS.forEach(m => {
      const isDone = done.has(m.id);
      const card = document.createElement('div');
      card.className = 'ms-item' + (isDone ? ' done' : '');
      const day = dayLabel(m);
      const c = counts[m.id] || 0;
      card.innerHTML = `
        <a class="ms-open" href="#mission/${encodeURIComponent(m.id)}">
          <span class="ms-icon">${isDone ? '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>' : esc(m.icon || '🎯')}</span>
          <span class="ms-text">
            <b>${esc(m.title)}</b>
            <small>${esc(m.hint || '')}</small>
            <span class="ms-meta">${day ? `<span class="ms-day">${esc(day)}</span>` : ''}<span>${c ? `${c} ${c === 1 ? 'photo' : 'photos'}` : 'No photos yet'}</span></span>
          </span>
        </a>
        <button type="button" class="ms-up ${isDone ? 'again' : ''}">${isDone ? 'Add more' : 'Upload'}</button>`;
      card.querySelector('.ms-up').onclick = () => pickFiles(m.id);
      wrap.appendChild(card);
    });
  }
  $('#msNameChange').onclick = () => {
    $('#msNameShow').hidden = true;
    $('#msNameForm').hidden = false;
    const i = $('#msNameInput');
    i.value = batch.guest || store.get('wp_name') || '';
    i.focus();
  };
  $('#msNameForm').onsubmit = e => {
    e.preventDefault();
    const v = $('#msNameInput').value.trim();
    $('#msNameInput').blur();
    setBatch({ guest: v });
    renderMissions();
    if (v) toast(`You're on the board, ${v}!`);
  };

  let detailId = null;
  function renderMissionDetail(id) {
    const m = missionById(id);
    if (!m) { location.hash = 'missions'; return; }
    detailId = id;
    const idx = MISSIONS.indexOf(m);
    $('#mdNum').textContent = `Mission ${idx + 1} of ${MISSIONS.length}`;
    $('#mdIcon').textContent = m.icon || '🎯';
    $('#mdTitle').textContent = m.title;
    $('#mdHint').textContent = m.hint || '';
    const day = dayLabel(m);
    $('#mdDay').hidden = !day;
    $('#mdDay').textContent = day;

    const items = state.items.filter(it => it.ms === id);
    const grid = $('#mdGrid');
    grid.innerHTML = '';
    $('#mdEmpty').hidden = items.length > 0;
    items.forEach((it, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'm-tile';
      const img = new Image();
      img.alt = '';
      img.loading = 'lazy';
      img.src = thumbUrl(it, 400);
      img.onerror = () => img.remove();
      b.appendChild(img);
      if (it.g) b.insertAdjacentHTML('beforeend', `<span class="m-badge pub">${esc(it.g)}</span>`);
      b.onclick = () => { state.view = items; openLightbox(i); };
      grid.appendChild(b);
    });
  }
  // Bottom bar "+ Upload": on a mission page it uploads for that mission
  $('#bnavUpload').onclick = () => pickFiles(document.body.classList.contains('view-mission') && detailId ? detailId : null);

  // keep the mission views fresh when the album list changes
  const _refresh = refresh;
  // "Share your photos with us" banner: only until this phone has uploaded something.
  function updateShareBanner() {
    const uploaded = !!store.get('wp_uploaded') || state.items.some(i => i.m);
    if (uploaded && !store.get('wp_uploaded')) store.set('wp_uploaded', '1');
    const b = $('.album-share');
    if (b) b.hidden = uploaded;
  }

  refresh = function () {
    _refresh();
    updateShareBanner();
    if (document.body.classList.contains('view-missions')) renderMissions();
    if (document.body.classList.contains('view-mission') && detailId) renderMissionDetail(detailId);
    if (document.body.classList.contains('view-home')) renderHome();
  };

  /* ================================================================ */
  /* Updates: schedule, "happening now", announcements, push opt-in   */
  /* ================================================================ */
  let SCHEDULE = [];
  function setSchedule(list) {
    SCHEDULE = (list || []).filter(e => e && e.day && e.start && e.title).map(e => ({
      ...e,
      s: new Date(`${e.day}T${e.start}:00+05:30`).getTime(),
      e2: new Date(`${e.day}T${e.end || e.start}:00+05:30`).getTime() + (e.end ? 0 : 90 * 60000)
    })).sort((a, b) => a.s - b.s);
  }
  const rawSchedule = () => SCHEDULE.map(({ s, e2, ...e }) => e);
  function demoSchedStore(list) {
    if (list) store.set('wp_demo_sched', JSON.stringify(list));
    try { return JSON.parse(store.get('wp_demo_sched') || 'null') || C.SCHEDULE || []; } catch (e) { return C.SCHEDULE || []; }
  }
  setSchedule(DEMO ? demoSchedStore() : (C.SCHEDULE || []));

  // The live schedule comes from the backend (your Google Sheet); config.js is the fallback.
  async function loadSchedule() {
    if (DEMO) return;
    try {
      const r = await api({ action: 'schedule' }, 1);
      if (Array.isArray(r.items) && r.items.length) { setSchedule(r.items); scheduleChanged(); }
    } catch (e) { /* backend not ready → keep config.js schedule */ }
  }
  function scheduleChanged() {
    renderNowCard();
    if (document.body.classList.contains('view-updates')) renderUpdates();
    if (document.body.classList.contains('view-home')) renderHome();
  }
  const fmtTime = t => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }).format(t).replace(' am', ' AM').replace(' pm', ' PM');
  const fmtDay = t => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' }).format(t);
  const dayKey = t => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(t);
  function ago(t) {
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} hr ago`;
    return fmtDay(t);
  }

  function nowNext() {
    const t = Date.now();
    return { now: SCHEDULE.find(e => e.s <= t && t < e.e2), next: SCHEDULE.find(e => e.s > t) };
  }

  function fillNow(prefix, card) {
    const { now, next } = nowNext();
    const e = now || next;
    card.hidden = !e;
    if (!e) return;
    card.classList.toggle('live', !!now);
    $(`#${prefix}Icon`).textContent = e.icon || '📅';
    $(`#${prefix}Label`).textContent = now ? 'Happening now' : 'Up next';
    $(`#${prefix}Title`).textContent = e.title;
    const sameDay = dayKey(e.s) === dayKey(Date.now());
    $(`#${prefix}Meta`).textContent = now
      ? `Until ${fmtTime(e.e2)} · ${e.venue || ''}`
      : `${sameDay ? 'Today' : fmtDay(e.s)}, ${fmtTime(e.s)} · ${e.venue || ''}`;
  }

  function renderHome() {
    // Home = communications only: "Get updates" + announcements (+ send box for admin)
    store.set('wp_upd_open', String(Date.now()));
    state.ann.forEach(a => markSeen(a.id));
    renderBellDots();
    renderBanner();
    renderPushCard();
    renderUpdates();
  }

  function renderNowCard() {
    if (document.body.classList.contains('view-home')) renderHome();
    const { now, next } = nowNext();
    const card = $('#nowCard');
    if (!card) return; // landing page no longer shows "Up next"
    const e = now || next;
    card.hidden = !e;
    if (!e) return;
    card.classList.toggle('live', !!now);
    $('#nowIcon').textContent = e.icon || '📅';
    $('#nowLabel').textContent = now ? 'Happening now' : 'Up next';
    $('#nowTitle').textContent = e.title;
    const sameDay = dayKey(e.s) === dayKey(Date.now());
    $('#nowMeta').textContent = now
      ? `Until ${fmtTime(e.e2)} · ${e.venue || ''}`
      : `${sameDay ? 'Today' : fmtDay(e.s)}, ${fmtTime(e.s)} · ${e.venue || ''}`;
  }

  /* ---------- announcements ---------- */
  state.ann = [];
  const FIRST_SEEN = (() => {
    const v = Number(store.get('wp_first_seen'));
    if (v) return v;
    const now = Date.now();
    store.set('wp_first_seen', String(now));
    return now;
  })();
  const DEMO_ANN = () => {
    const n = Date.now();
    return [
      { id: 'a2', text: 'Lunch is open in the banquet hall 🍽️ Come hungry!', t: new Date(n - 6 * 60000).toISOString() },
      { id: 'a1', text: 'Haldi starts at 10:30 by the pool. Wear yellow 💛 and bring your phones for photos!', t: new Date(n - 3 * 3600000).toISOString() }
    ];
  };
  function demoAnnStore(list) {
    if (list) store.set('wp_demo_ann', JSON.stringify(list));
    try { return JSON.parse(store.get('wp_demo_ann') || 'null') || DEMO_ANN(); } catch (e) { return DEMO_ANN(); }
  }

  // Guests see everything from the start (midnight, India time) of the day they first opened the site.
  function firstDayStart() {
    return new Date(`${dayKey(FIRST_SEEN)}T00:00:00+05:30`).getTime();
  }

  async function loadAnnouncements() {
    try {
      let list;
      if (DEMO) list = demoAnnStore();
      else list = (await api({ action: 'updates' }, 1)).items || [];
      state.ann = list
        .map(a => ({ ...a, ts: new Date(a.at || a.t).getTime() }))
        .filter(a => state.isAdmin || (a.ts <= Date.now() && a.ts >= firstDayStart()))
        .sort((a, b) => b.ts - a.ts);
    } catch (e) {
      state.ann = []; // backend not ready yet → simply no announcements
    }
    state.annLoaded = true;
    renderBanner();
    renderBellDots();
    if (document.body.classList.contains('view-updates')) renderUpdates();
    if (document.body.classList.contains('view-home')) renderHome();
  }

  const seen = () => { try { return new Set(JSON.parse(store.get('wp_ann_seen') || '[]')); } catch (e) { return new Set(); } };
  function markSeen(id) { const s = seen(); s.add(id); store.set('wp_ann_seen', JSON.stringify([...s])); }

  function renderBanner() {
    const b = $('#annBanner');
    const live = state.ann.filter(a => a.ts <= Date.now());
    const latest = live[0];
    const show = latest && !seen().has(latest.id) && !document.body.classList.contains('view-home')
      && $('#sheet').hidden;
    b.hidden = !show;
    if (!show) return;
    const parts = splitIcon(latest.text);
    $('#annBannerText').textContent = parts.body;
    $('#annBanner .ann-ic').textContent = parts.icon;
    $('#annBannerTime').textContent = `From Nupur & Aditya · ${ago(latest.ts)}`;
    b.dataset.id = latest.id;
  }
  $('#annBannerClose').onclick = () => { markSeen($('#annBanner').dataset.id); renderBanner(); };
  $('#annBanner .ann-main').addEventListener('click', () => markSeen($('#annBanner').dataset.id));

  function renderBellDots() {
    const lastOpen = Number(store.get('wp_upd_open') || 0);
    const fresh = state.ann.some(a => a.ts <= Date.now() && a.ts > lastOpen);
    $$('.bell-dot').forEach(d => { d.hidden = !fresh; });
  }


  function openUpdates() {
    $('#schedAdd').hidden = !state.isAdmin;
    renderUpdates();
  }

  function shareText(a) {
    const link = `${location.origin}${location.pathname}?k=${encodeURIComponent(KEY)}`;
    return `📣 ${a.text}\n\n📸 Share your photos: ${link}`;
  }

  function renderUpdates() {
    // announcements
    const list = $('#annList');
    list.innerHTML = '';
    // Until the first load finishes, show placeholder cards instead of the empty state.
    $('#annLoading').hidden = !!state.annLoaded;
    $('#annEmpty').hidden = !state.annLoaded || state.ann.length > 0;
    if (!state.ann.length) {
      // empty state: point to what's coming up next on the schedule
      const { now, next } = nowNext();
      const e = now || next;
      $('#annEmptyNext').hidden = !e;
      if (e) {
        $('#annEmptyIc').textContent = e.icon || '📅';
        $('#annEmptyLabel').textContent = now ? 'Happening now' : 'Up next';
        $('#annEmptyTitle').textContent = e.title;
        const sameDay = dayKey(e.s) === dayKey(Date.now());
        $('#annEmptyMeta').textContent = now
          ? `Until ${fmtTime(e.e2)} · ${e.venue || ''}`
          : `${sameDay ? 'Today' : fmtDay(e.s)}, ${fmtTime(e.s)} · ${e.venue || ''}`;
      }
    }
    state.ann.forEach(a => {
      const scheduled = a.ts > Date.now();
      const el = document.createElement('div');
      el.className = 'ann' + (scheduled ? ' scheduled' : '');
      el.innerHTML = `
        <span class="ann-ic">${esc(splitIcon(a.text).icon)}</span>
        <p>${esc(splitIcon(a.text).body)}</p>
        <small>${scheduled ? `⏰ Scheduled for ${fmtDay(a.ts)}, ${fmtTime(a.ts)}` : ago(a.ts)}</small>
        ${state.isAdmin ? `<button type="button" class="ann-more" aria-label="More options"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button>
        <div class="ann-actions" hidden>
          <button type="button" class="chip-btn" data-act="copy">Copy</button>
          <a class="chip-btn wa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(shareText(a))}">Send on WhatsApp</a>
          <button type="button" class="chip-btn danger" data-act="del">Delete</button>
        </div>` : ''}`;
      if (state.isAdmin) {
        el.querySelector('.ann-more').onclick = () => { const r = el.querySelector('.ann-actions'); r.hidden = !r.hidden; };
        el.querySelector('[data-act="copy"]').onclick = async () => {
          try { await navigator.clipboard.writeText(shareText(a)); toast('Copied. Paste it in WhatsApp'); }
          catch (e) { toast('Could not copy on this browser'); }
        };
        el.querySelector('[data-act="del"]').onclick = async () => {
          if (!confirm('Delete this update?')) return;
          try {
            if (DEMO) demoAnnStore(demoAnnStore().filter(x => x.id !== a.id));
            else await api({ action: 'unannounce', id: a.id }, 2);
            loadAnnouncements();
          } catch (e) { toast('Could not delete: ' + e.message); }
        };
      }
      list.appendChild(el);
    });

    // schedule, grouped by day
    const sched = $('#sched');
    sched.innerHTML = '';
    const t = Date.now();
    let day = '';
    let group;
    let shown = 0;
    SCHEDULE.forEach(e => {
      // guests don't see items that finished before they first opened the site
      if (!state.isAdmin && e.e2 < firstDayStart()) return;
      shown++;
      const k = dayKey(e.s);
      if (k !== day) {
        day = k;
        const fn = C.ALBUMS.find(a => a.date === k);
        group = document.createElement('div');
        group.className = 'sched-day';
        group.innerHTML = `<div class="sched-h"><b>${esc(fmtDay(e.s))}</b>${fn ? `<span class="ms-day">${esc(fn.label)}</span>` : ''}</div>`;
        sched.appendChild(group);
      }
      const state2 = t >= e.e2 ? 'done' : t >= e.s ? 'now' : '';
      const row = document.createElement('div');
      row.className = 'sched-row ' + state2;
      row.innerHTML = `
        <span class="sched-time">${esc(fmtTime(e.s))}</span>
        <span class="sched-ic">${esc(e.icon || '📅')}</span>
        <span class="sched-tx"><b>${esc(e.title)}</b><small>${esc(e.venue || '')}</small></span>
        ${state2 === 'now' ? '<span class="sched-live">Now</span>' : ''}
        ${state.isAdmin ? '<button type="button" class="sched-edit" aria-label="Edit"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M14 6l4 4"/></svg></button>' : ''}`;
      if (state.isAdmin) row.querySelector('.sched-edit').onclick = () => openSchedEditor(e);
      group.appendChild(row);
    });
    $('#schedEmpty').hidden = shown > 0;
  }

  async function postAnnouncement(text, at) {
    const item = { id: 'a' + Date.now(), text, t: new Date().toISOString(), at: at || undefined };
    if (DEMO) demoAnnStore([item].concat(demoAnnStore()));
    else await api({ action: 'announce', text, at: at || '' }, 2);
    loadAnnouncements();
  }

  /* ---------- schedule editor (admin) ---------- */
  let sedItem = null; // the item being edited (null = new)
  const istDateTime = (day, time) => new Date(`${day}T${time}:00+05:30`).getTime();

  function openSchedEditor(e) {
    sedItem = e || null;
    const first = SCHEDULE[0];
    $('#sedTitle').textContent = e ? 'Edit schedule item' : 'Add to schedule';
    $('#sedIcon').value = e ? (e.icon || '') : '';
    $('#sedName').value = e ? e.title : '';
    $('#sedDay').value = e ? e.day : (first ? first.day : (C.ALBUMS[0] && C.ALBUMS[0].date) || '');
    $('#sedStart').value = e ? e.start : '';
    $('#sedEnd').value = e ? (e.end || '') : '';
    $('#sedVenue').value = e ? (e.venue || '') : '';
    $('#sedDelete').hidden = !e;
    $('#sedNotify').checked = false;
    $('#sedNotify').dataset.touched = '';
    updateSedNotify();
    $('#schedEditor').hidden = false;
    document.body.classList.add('no-scroll');
  }
  function closeSchedEditor() {
    $('#schedEditor').hidden = true;
    document.body.classList.remove('no-scroll');
  }
  $$('[data-close-sed]').forEach(b => b.onclick = closeSchedEditor);

  // The announcement guests would get for this change (or '' if nothing worth announcing).
  function sedAnnouncement() {
    const title = $('#sedName').value.trim();
    const day = $('#sedDay').value, start = $('#sedStart').value;
    if (!title || !day || !start) return '';
    const when = istDateTime(day, start);
    const venue = $('#sedVenue').value.trim();
    const whenText = `${dayKey(when) === dayKey(Date.now()) ? 'today' : fmtDay(when)} at ${fmtTime(when)}`;
    if (!sedItem) return `📅 Added to the schedule: ${title}, ${whenText}${venue ? ` · ${venue}` : ''}`;
    const moved = sedItem.day !== day || sedItem.start !== start;
    const placeChanged = (sedItem.venue || '') !== venue;
    if (moved) return `⏰ Change of plan: ${title} is now ${whenText}${venue ? ` · ${venue}` : ''}`;
    if (placeChanged && venue) return `📍 ${title} has moved to ${venue}`;
    return '';
  }
  function updateSedNotify() {
    const msg = sedAnnouncement();
    const box = $('#sedNotify');
    $('.sed-notify').hidden = !msg;
    if (!box.dataset.touched) box.checked = !!msg && !!sedItem; // on by default for real changes
    $('#sedNotifyLabel').textContent = sedItem ? 'Tell guests about this change' : 'Announce this to guests';
    $('#sedPreview').hidden = !msg || !box.checked;
    $('#sedPreview').textContent = msg;
  }
  ['#sedName', '#sedDay', '#sedStart', '#sedVenue'].forEach(sel => $(sel).addEventListener('input', updateSedNotify));
  $('#sedNotify').addEventListener('change', () => { $('#sedNotify').dataset.touched = '1'; updateSedNotify(); });

  async function saveSchedule(list) {
    setSchedule(list);
    if (DEMO) demoSchedStore(rawSchedule());
    else await api({ action: 'saveSchedule', items: rawSchedule() }, 2);
    scheduleChanged();
  }

  $('#sedForm').onsubmit = async ev => {
    ev.preventDefault();
    const item = {
      id: sedItem ? sedItem.id : 'e' + Date.now(),
      icon: $('#sedIcon').value.trim() || '📅',
      title: $('#sedName').value.trim(),
      day: $('#sedDay').value,
      start: $('#sedStart').value,
      end: $('#sedEnd').value || undefined,
      venue: $('#sedVenue').value.trim()
    };
    if (item.end && item.end <= item.start) { toast('End time should be after the start time'); return; }
    const announce = $('#sedNotify').checked ? sedAnnouncement() : '';
    const list = rawSchedule().filter(e => e.id !== item.id).concat(item);
    try {
      await saveSchedule(list);
      if (announce) await postAnnouncement(announce);
      closeSchedEditor();
      toast(announce ? 'Saved and guests notified' : 'Schedule updated');
    } catch (e) { toast('Could not save: ' + e.message); }
  };

  $('#sedDelete').onclick = async () => {
    if (!sedItem) return;
    const tell = confirm(`Remove "${sedItem.title}" from the schedule?\n\nOK = remove and tell guests it's cancelled\nCancel = keep it`);
    if (!tell) return;
    try {
      await saveSchedule(rawSchedule().filter(e => e.id !== sedItem.id));
      await postAnnouncement(`❌ ${sedItem.title} (${fmtDay(sedItem.s)}, ${fmtTime(sedItem.s)}) has been cancelled`);
      closeSchedEditor();
      toast('Removed and guests notified');
    } catch (e) { toast('Could not remove: ' + e.message); }
  };
  $('#schedAdd').onclick = () => openSchedEditor(null);

  /* ---------- compose (admin) ---------- */
  $('#composeLater').onchange = e => { $('#composeAt').hidden = !e.target.checked; };
  const ANN_ICONS = ['📣', '🍽️', '🚌', '💃', '🎉', '⏰', '📸', '❤️'];
  const ICON_RULES = [
    [/lunch|dinner|breakfast|food|buffet|snack|chai|tea|dessert|eat/i, '🍽️'],
    [/bus|cab|car|pickup|pick-up|transport|lobby|leave|leaving|depart/i, '🚌'],
    [/danc|sangeet|dj|music|dhol|baraat/i, '💃'],
    [/photo|picture|pic|upload|camera|selfie/i, '📸'],
    [/delay|late|postpon|moved|resched|time|minutes|min |starts|starting|begins|now/i, '⏰'],
    [/thank|love|bless|grateful|miss/i, '❤️'],
    [/congrat|celebrat|party|cheers|toast|welcome/i, '🎉']
  ];
  const LEADING_EMOJI = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*️?)\s*/u;
  function splitIcon(text) {
    const m = String(text || '').match(LEADING_EMOJI);
    return m ? { icon: m[1], body: text.slice(m[0].length) } : { icon: '📣', body: text };
  }
  function guessIcon(text) {
    for (const [re, icon] of ICON_RULES) if (re.test(text)) return icon;
    return '📣';
  }
  let csIcon = '📣', csIconPicked = false;
  function renderIconPicker() {
    const wrap = $('#csIcons');
    wrap.innerHTML = '';
    ANN_ICONS.forEach(ic => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cs-icon';
      b.textContent = ic;
      b.setAttribute('aria-pressed', String(ic === csIcon));
      b.onclick = () => { csIcon = ic; csIconPicked = true; renderIconPicker(); };
      wrap.appendChild(b);
    });
  }
  $('#composeText').addEventListener('input', e => {
    if (csIconPicked) return;
    const g = guessIcon(e.target.value);
    if (g !== csIcon) { csIcon = g; renderIconPicker(); }
  });

  function openCompose() {
    csIcon = '📣'; csIconPicked = false;
    renderIconPicker();
    $('#composeSheet').hidden = false;
    document.body.classList.add('no-scroll');
    setTimeout(() => $('#composeText').focus(), 250);
  }
  function closeCompose() {
    $('#composeSheet').hidden = true;
    document.body.classList.remove('no-scroll');
  }
  $('#annFab').onclick = openCompose;
  $$('[data-close-cs]').forEach(b => b.onclick = closeCompose);

  $('#composeSend').onclick = async () => {
    const text = $('#composeText').value.trim();
    if (!text) { toast('Write a message first'); return; }
    let at = '';
    if ($('#composeLater').checked) {
      const v = $('#composeAt').value;
      if (!v) { toast('Pick a time'); return; }
      at = new Date(`${v}:00+05:30`).toISOString();
    }
    try {
      await postAnnouncement(LEADING_EMOJI.test(text) ? text : `${csIcon} ${text}`, at);
      $('#composeText').value = '';
      $('#composeLater').checked = false;
      $('#composeAt').hidden = true;
      closeCompose();
      toast(at ? 'Update scheduled' : 'Update sent');
    } catch (e) { toast('Could not send: ' + e.message); }
  };

  /* ---------- push opt-in ---------- */
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  // "On" = permission granted AND this phone is registered with Firebase.
  const pushReady = () => !!(C.FIREBASE && C.FIREBASE.apiKey && C.VAPID_KEY);
  function renderPushCard() {
    const supported = 'Notification' in window && 'serviceWorker' in navigator;
    const on = supported && Notification.permission === 'granted' && store.get('wp_push') === 'on';
    const blocked = supported && Notification.permission === 'denied';
    $('#pushCard').classList.toggle('on', on);
    $('#pushTitle').textContent = on ? 'Updates are on' : 'Get updates on your phone';
    $('#pushSub').textContent = on ? "We'll notify you when things start."
      : blocked ? 'Notifications are blocked. Turn them on in your browser settings.'
      : "Lunch, haldi, pickups. We'll let you know when things start.";
    $('#pushBtn').hidden = on || blocked;
    $('#pushBtn').textContent = isIOS && !isStandalone ? 'How to turn on' : 'Turn on';
  }
  function loadScript(src) {
    return new Promise((res, rej) => {
      if ([...document.scripts].some(s => s.src === src)) return res();
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }
  const FB = 'https://www.gstatic.com/firebasejs/10.12.2/';

  // Register this phone with Firebase and give its token to our backend.
  async function registerPush() {
    await loadScript(FB + 'firebase-app-compat.js');
    await loadScript(FB + 'firebase-messaging-compat.js');
    if (!firebase.apps.length) firebase.initializeApp(C.FIREBASE);
    const reg = await navigator.serviceWorker.register('firebase-messaging-sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
    const messaging = firebase.messaging();
    const token = await messaging.getToken({ vapidKey: C.VAPID_KEY, serviceWorkerRegistration: reg });
    if (!token) throw new Error('No token');
    if (!DEMO) await api({ action: 'subscribe', token }, 3);
    store.set('wp_push', 'on');
    // While the site is open, show new announcements in the page instead of a system notification.
    messaging.onMessage(() => { loadAnnouncements(); });
    return token;
  }

  $('#pushBtn').onclick = async () => {
    if (isIOS && !isStandalone) { $('#iosGuide').hidden = false; return; }
    if (!('Notification' in window) || !('serviceWorker' in navigator)) { toast("This browser can't show notifications"); return; }
    if (!pushReady()) { toast('Phone notifications are being set up. Check back soon!'); return; }
    const btn = $('#pushBtn');
    btn.disabled = true;
    try {
      const res = await Notification.requestPermission();
      if (res !== 'granted') { renderPushCard(); return; }
      await registerPush();
      renderPushCard();
      toast("You're all set. We'll notify you");
    } catch (e) {
      console.error(e);
      toast('Could not turn on notifications. Please try again.');
    } finally {
      btn.disabled = false;
    }
  };

  // Already turned on earlier → quietly refresh the registration (tokens can change).
  if (pushReady() && 'Notification' in window && Notification.permission === 'granted' && store.get('wp_push') === 'on') {
    registerPush().catch(() => {});
  }
  $('#iosGuideClose').onclick = () => { $('#iosGuide').hidden = true; };

  /* ================================================================ */
  /* Lightbox                                                         */
  /* ================================================================ */
  const lb = $('#lightbox');
  function openLightbox(i) {
    state.lbIndex = i;
    lb.hidden = false;
    document.body.classList.add('no-scroll');
    history.pushState({ lb: 1 }, '');
    $('#lbHide').hidden = !state.isAdmin;
    showSlide();
  }
  function closeLightbox(fromPop) {
    if (lb.hidden) return;
    lb.hidden = true;
    $('#lbStage').innerHTML = '';
    document.body.classList.remove('no-scroll');
    if (!fromPop && history.state && history.state.lb) history.back();
  }
  function showSlide() {
    const v = state.view;
    if (!v.length) return closeLightbox();
    state.lbIndex = (state.lbIndex + v.length) % v.length;
    const it = v[state.lbIndex];
    const stage = $('#lbStage');
    stage.innerHTML = '<div class="spinner"></div>';
    if (it.v) {
      if (state.local.has(it.id) || it.src) {
        const vid = document.createElement('video');
        vid.controls = true; vid.playsInline = true; vid.autoplay = true;
        vid.src = state.local.get(it.id) || it.src;
        stage.appendChild(vid);
      } else {
        const f = document.createElement('iframe');
        f.src = `https://drive.google.com/file/d/${it.id}/preview`;
        f.allow = 'autoplay; fullscreen';
        f.allowFullscreen = true;
        f.onload = () => $('.spinner', stage)?.remove();
        stage.appendChild(f);
      }
    } else {
      const img = new Image();
      img.alt = it.g ? `Photo by ${it.g}` : 'Wedding photo';
      img.onload = () => $('.spinner', stage)?.remove();
      img.onerror = () => { $('.spinner', stage)?.remove(); img.src = thumbUrl(it, 800); };
      img.src = fullUrl(it);
      stage.appendChild(img);
      // preload neighbours
      [1, -1].forEach(d => { const n = v[(state.lbIndex + d + v.length) % v.length]; if (n && !n.v) new Image().src = fullUrl(n); });
    }
    const album = C.ALBUMS.find(a => a.id === it.a);
    const lbMs = it.ms && missionById(it.ms);
    $('#lbCaption').innerHTML = (it.g ? `<b>${esc(it.g)}</b>` : '<span>Shared by a guest</span>') +
      (lbMs ? `<br><span class="lb-ms">${esc(lbMs.icon || '🎯')} ${esc(lbMs.title)}</span>` : '');
    $('#lbCount').textContent = `${state.lbIndex + 1} / ${v.length}`;
    $('#lbDownload').href = downloadUrl(it);
    $('#lbDelete').hidden = !(state.isAdmin || isMine(it));
  }

  // Photos this phone uploaded (server marks them m:1; this session's uploads are known locally).
  function isMine(it) { return !!it.m || state.local.has(it.id); }

  async function deletePhoto(id) {
    await api({ action: 'delete', id }, 2);
    state.items = state.items.filter(x => x.id !== id);
    refresh();
  }

  $('#lbDelete').onclick = async () => {
    const it = state.view[state.lbIndex];
    if (!it) return;
    const msg = isMine(it)
      ? 'Delete this photo? It will be removed from the album.'
      : 'Delete this photo? It moves to your Google Drive trash (recoverable for 30 days).';
    if (!confirm(msg)) return;
    try {
      await deletePhoto(it.id);
      const j = jobs.find(x => x.id === it.id);
      if (j) removeJob(j);
      showSlide();
      toast('Photo deleted');
    } catch (e) { toast('Could not delete: ' + e.message); }
  };
  $('#lbPrev').onclick = () => { state.lbIndex--; showSlide(); };
  $('#lbNext').onclick = () => { state.lbIndex++; showSlide(); };
  $$('[data-close-lb]').forEach(b => b.onclick = () => closeLightbox());
  $('#lbHide').onclick = async () => {
    const it = state.view[state.lbIndex];
    if (!it || !confirm('Hide this from the album? It moves to the _Hidden folder in your Drive.')) return;
    try {
      await api({ action: 'hide', id: it.id }, 2);
      state.items = state.items.filter(x => x.id !== it.id);
      refresh();
      showSlide();
      toast('Hidden from the album');
    } catch (e) { toast('Could not hide: ' + e.message); }
  };
  (() => {
    let x0 = null, y0 = 0;
    lb.addEventListener('touchstart', e => { if (e.touches.length === 1) { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; } }, { passive: true });
    lb.addEventListener('touchend', e => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      x0 = null;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) { state.lbIndex += dx < 0 ? 1 : -1; showSlide(); }
      else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) closeLightbox();
    });
  })();
  document.addEventListener('keydown', e => {
    if (!lb.hidden) {
      if (e.key === 'ArrowRight') { state.lbIndex++; showSlide(); }
      if (e.key === 'ArrowLeft') { state.lbIndex--; showSlide(); }
      if (e.key === 'Escape') closeLightbox();
    } else if (!$('#sheet').hidden && e.key === 'Escape' && !state.uploading) closeSheet();
  });
  window.addEventListener('popstate', () => {
    if (!lb.hidden) closeLightbox(true);
    if (!$('#sheet').hidden && !state.uploading) closeSheet(true);
  });

  /* ================================================================ */
  /* Upload flow                                                      */
  /*   tap Upload -> phone gallery opens -> uploads start immediately. */
  /*   Name and function are optional extras shown while uploading;  */
  /*   changing them later re-tags the photos already uploaded.      */
  /* ================================================================ */

  // Which function is happening now (IST). Day flips at 6 AM, so late-night
  // photos still count for that evening's function.
  function autoAlbum() {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() - 6 * 3600 * 1000));
    let pick = C.ALBUMS[0].id;
    for (const a of C.ALBUMS) if (a.date <= day) pick = a.id;
    return pick;
  }

  const batch = { guest: store.get('wp_name'), private: true }; // default: only the couple sees uploads

  // mission: id when uploading for a mission, otherwise a normal upload
  let missionCtx = null;
  function pickFiles(mission) {
    missionCtx = typeof mission === 'string' ? mission : null;
    $('#fileInput').click();
  }

  $('#fileInput').addEventListener('change', e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) startUploads(files);
  });

  function openSheet() {
    const s = $('#sheet');
    if (s.hidden) {
      s.hidden = false;
      document.body.classList.add('no-scroll');
      history.pushState({ sheet: 1 }, '');
    }
    renderExtras();
  }
  function closeSheet(fromPop) {
    if (state.uploading && !confirm('Uploads are still in progress. Close anyway? They will keep going while this page stays open.')) {
      if (fromPop) history.pushState({ sheet: 1 }, '');
      return;
    }
    $('#sheet').hidden = true;
    document.body.classList.remove('no-scroll');
    if (!fromPop && history.state && history.state.sheet) history.back();
  }
  $$('[data-close-sheet]').forEach(b => b.onclick = () => closeSheet());

  /* ---------------- Optional extras: function + name ---------------- */
  function albumLabel(id) {
    const a = C.ALBUMS.find(x => x.id === id);
    return a ? a.label : id;
  }

  function renderExtras() {
    const ms = batch.mission && missionById(batch.mission);
    $('#msRow').hidden = !ms;
    if (ms) $('#msRowTitle').textContent = ms.title;
    $$('#visSeg button').forEach(b => b.setAttribute('aria-pressed', String((b.dataset.vis === 'private') === batch.private)));
    const hasName = !!batch.guest;
    $('#nameShow').hidden = !hasName;
    $('#nameForm').hidden = hasName;
    $('#nameNow').textContent = batch.guest || '';
  }

  $$('#visSeg button').forEach(b => b.onclick = () => setBatch({ private: b.dataset.vis === 'private' }));
  $('#nameChange').onclick = () => {
    $('#nameShow').hidden = true;
    $('#nameForm').hidden = false;
    const i = $('#guestName');
    i.value = batch.guest || '';
    i.focus();
  };
  $('#nameForm').onsubmit = e => {
    e.preventDefault();
    const i = $('#guestName');
    i.blur();
    setBatch({ guest: i.value.trim() });
    if (batch.guest) toast(`Thanks, ${batch.guest}!`);
  };

  function setBatch(changes) {
    Object.assign(batch, changes);
    if ('guest' in changes) store.set('wp_name', batch.guest);
    renderExtras();
    retagDone();
    const done = jobs.filter(j => j.status === 'done').length;
    if (!$('#doneActions').hidden && !jobs.some(j => j.status === 'error')) {
      $('#overallText').textContent = doneText(done);
    }
  }

  function doneText(n) {
    const w = n === 1 ? 'photo' : 'photos';
    const ms = batch.mission && missionById(batch.mission);
    if (ms) return batch.private ? `${n} ${w} sent privately for “${ms.title}”` : `Mission done! ${n} ${w} added to “${ms.title}”`;
    return batch.private ? `${n} ${w} sent privately to Nupur & Aditya` : `${n} ${w} added to the album`;
  }

  // Bring already-uploaded photos of this batch in line with the current name/function.
  function retagDone() {
    const stale = jobs.filter(j => j.status === 'done' && j.id && (j.private !== batch.private || j.guest !== batch.guest));
    if (!stale.length) return;
    const ids = stale.map(j => j.id);
    stale.forEach(j => {
      j.guest = batch.guest;
      j.private = batch.private;
      j.item.g = batch.guest;
    });
    // private photos leave the album; public ones (re)appear
    state.items = state.items.filter(it => !ids.includes(it.id));
    if (!batch.private) stale.slice().reverse().forEach(j => state.items.unshift(j.item));
    refresh();
    if (DEMO) return;
    api({ action: 'retag', ids, guest: batch.guest || '', private: batch.private }, 3)
      .catch(() => toast('Saved for your next uploads'));
  }

  /* ---------------- Queue ---------------- */
  let jobs = [];
  let running = 0;
  let wakeLock = null;
  const isActive = j => j.status === 'queued' || j.status === 'uploading';

  function guessMime(f) {
    if (f.type) return f.type;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    return ({ heic: 'image/heic', heif: 'image/heif', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
      mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v', '3gp': 'video/3gpp' })[ext] || '';
  }

  function startUploads(files) {
    if (!jobs.some(isActive)) {
      jobs = [];
      $('#queue').innerHTML = '';
      batch.private = !missionCtx; // missions are social → Everyone; normal uploads → Private
    }
    batch.mission = missionCtx;
    const max = C.MAX_FILE_MB * 1024 * 1024;
    let added = 0;
    files.forEach(f => {
      const mime = guessMime(f);
      if (!/^(image|video)\//.test(mime) || f.size === 0) return;
      if (f.size > max) { toast(`${f.name} is larger than ${C.MAX_FILE_MB} MB and was skipped`); return; }
      const job = { file: f, mime, mission: missionCtx, album: null, guest: null, private: false, item: null, id: null, loaded: 0, status: 'queued', el: null, url: URL.createObjectURL(f) };
      job.el = queueEl(job);
      jobs.push(job);
      added++;
    });
    if (!added) { toast('Please pick photos or videos.'); return; }

    $('#doneActions').hidden = true;
    $('.keep-open').hidden = false;
    $('#upTitle').textContent = 'Uploading…';
    openSheet();
    updateOverall();
    acquireWakeLock();
    pump();
  }

  function queueEl(job) {
    const li = document.createElement('li');
    li.className = 'q';
    if (job.mime.startsWith('video/')) {
      li.innerHTML = `<video muted playsinline preload="metadata" src="${job.url}#t=0.1"></video><span class="vtag">VIDEO</span>`;
    } else {
      li.innerHTML = `<img src="${job.url}" alt="">`;
      li.querySelector('img').onerror = function () { this.remove(); };
    }
    li.insertAdjacentHTML('beforeend', '<div class="qbar"><i></i></div><div class="qstate"></div>');
    $('#queue').appendChild(li);
    return li;
  }

  function pump() {
    while (running < C.PARALLEL_UPLOADS) {
      const job = jobs.find(j => j.status === 'queued');
      if (!job) break;
      running++;
      state.uploading++;
      job.status = 'uploading';
      uploadOne(job)
        .then(() => {
          job.status = 'done';
          job.el.className = 'q done';
          // small × on each finished thumbnail: "oops, not that one"
          const x = document.createElement('button');
          x.className = 'q-del';
          x.type = 'button';
          x.setAttribute('aria-label', 'Remove this photo');
          x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>';
          x.onclick = async e => {
            e.stopPropagation();
            if (!confirm('Remove this photo? It will be deleted from the album.')) return;
            x.disabled = true;
            try { await deletePhoto(job.id); removeJob(job); }
            catch (err) { x.disabled = false; toast('Could not remove: ' + err.message); }
          };
          job.el.appendChild(x);
          retagDone();
        })
        .catch(err => {
          console.error(err);
          job.status = 'error';
          job.el.className = 'q error';
          $('.qstate', job.el).textContent = 'Tap to retry';
          job.el.onclick = () => {
            job.el.onclick = null; job.status = 'queued'; job.loaded = 0;
            job.el.className = 'q'; $('.qstate', job.el).textContent = '';
            $('#doneActions').hidden = true; $('#upTitle').textContent = 'Uploading…';
            acquireWakeLock(); pump();
          };
          if (/INVALID_KEY/.test(err.message)) toast('This album link has expired. Please scan the QR code again.');
        })
        .finally(() => { running--; state.uploading--; updateOverall(); pump(); });
    }
    if (running === 0) allDone();
  }

  function removeJob(job) {
    jobs = jobs.filter(j => j !== job);
    job.el.remove();
    updateOverall();
    if (!$('#doneActions').hidden) {
      const done = jobs.filter(j => j.status === 'done').length;
      $('#overallText').textContent = done ? doneText(done) : 'No photos uploaded';
    }
  }

  function updateOverall() {
    const total = jobs.reduce((s, j) => s + j.file.size, 0) || 1;
    const loaded = jobs.reduce((s, j) => s + (j.status === 'done' ? j.file.size : j.loaded), 0);
    const done = jobs.filter(j => j.status === 'done').length;
    $('#overallBar').style.width = `${Math.round((loaded / total) * 100)}%`;
    $('#overallText').textContent = `${done} of ${jobs.length} uploaded`;
  }

  function allDone() {
    if (!jobs.length) return;
    releaseWakeLock();
    const done = jobs.filter(j => j.status === 'done').length;
    const failed = jobs.filter(j => j.status === 'error').length;
    $('#upTitle').textContent = failed ? `${done} uploaded, ${failed} failed` : 'Thank you!';
    $('#overallText').textContent = failed
      ? 'Tap the red ones to try again.'
      : doneText(done);
    $('#doneActions').hidden = false;
    $('.keep-open').hidden = true;
    $('#seeAlbum').textContent = 'Go to album';
    if (document.body.classList.contains('view-mine')) loadMine();
    if (document.body.classList.contains('view-missions')) renderMissions();
    celebrateMissions();
    if (!failed) burstPetals();
  }
  $('#addMore').onclick = () => pickFiles(batch.mission || null);
  $('#seeAlbum').onclick = () => {
    const dest = batch.mission ? 'mission/' + batch.mission : (batch.private ? 'mine' : 'album');
    closeSheet();
    state.album = 'all';
    setTimeout(() => {
      if (location.hash !== '#' + dest) location.hash = dest;
      else if (dest === 'album') layout(true); else if (dest === 'mine') loadMine(); else route();
    }, 150);
  };

  /* ================================================================ */
  /* My uploads: see, re-share or delete what this phone uploaded      */
  /* ================================================================ */
  const demoMine = [];
  const mine = { items: [], sel: new Set() };

  async function loadMine() {
    $('#mineLoading').hidden = false;
    $('#mineGrid').innerHTML = '';
    $('#mineEmpty').hidden = true;
    try {
      const r = DEMO ? { items: demoMine.slice() } : await api({ action: 'mine' }, 2);
      mine.items = r.items || [];
      if (mine.items.length) { store.set('wp_uploaded', '1'); updateShareBanner(); }
      mine.sel.clear();
      renderMine();
    } catch (e) {
      toast('Could not load your uploads: ' + e.message);
    } finally {
      $('#mineLoading').hidden = true;
    }
  }

  function renderMine() {
    const grid = $('#mineGrid');
    grid.innerHTML = '';
    $('#mineEmpty').hidden = mine.items.length > 0;
    mine.items.forEach(it => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'm-tile' + (mine.sel.has(it.id) ? ' sel' : '');
      const src = state.local.get(it.id) || it.th || (it.p ? '' : thumbUrl(it, 400));
      if (src && !(it.v && state.local.has(it.id))) {
        const img = new Image();
        img.alt = '';
        img.loading = 'lazy';
        img.src = src;
        img.onerror = () => img.remove();
        b.appendChild(img);
      } else if (it.v && state.local.has(it.id)) {
        b.insertAdjacentHTML('beforeend', `<video muted playsinline preload="metadata" src="${state.local.get(it.id)}#t=0.1"></video>`);
      }
      b.insertAdjacentHTML('beforeend', it.p
        ? '<span class="m-badge priv"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/></svg>Private</span>'
        : '<span class="m-badge pub"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 017.5-2"/></svg>Everyone</span>');
      if (it.v) b.insertAdjacentHTML('beforeend', '<span class="m-vid">VIDEO</span>');
      b.onclick = () => {
        if (mine.sel.has(it.id)) mine.sel.delete(it.id); else mine.sel.add(it.id);
        b.classList.toggle('sel', mine.sel.has(it.id));
        updateMineUI();
      };
      grid.appendChild(b);
    });
    updateMineUI();
  }

  function updateMineUI() {
    const n = mine.sel.size;
    $('#mineTitle').textContent = n ? `${n} selected` : 'Our album';
    ['#minePublic', '#minePrivate', '#mineDelete'].forEach(s => { $(s).disabled = !n; });
    const all = mine.items.length && n === mine.items.length;
    $('#mineAll').textContent = all ? 'Clear' : 'Select all';
    $('#mineAll').hidden = !mine.items.length;
    $('.mine-hint').hidden = !mine.items.length; // nothing to select yet → no hint
    // Nothing selected → the normal "Upload photos" button; something selected → actions.
    $('#mineBar').hidden = !n;
    document.body.classList.toggle('mine-selecting', n > 0);
  }

  $('#mineCancel').onclick = () => { mine.sel.clear(); renderMine(); };
  $('#mineAll').onclick = () => {
    const all = mine.items.length && mine.sel.size === mine.items.length;
    mine.sel = new Set(all ? [] : mine.items.map(i => i.id));
    renderMine();
  };

  async function setMineAccess(makePrivate) {
    const ids = [...mine.sel];
    if (!ids.length) return;
    document.body.classList.add('busy');
    try {
      if (!DEMO) await api({ action: 'retag', ids, private: makePrivate }, 2);
      mine.items.forEach(it => { if (ids.includes(it.id)) it.p = makePrivate ? 1 : 0; });
      demoMine.forEach(it => { if (ids.includes(it.id)) it.p = makePrivate ? 1 : 0; });
      mine.sel.clear();
      renderMine();
      toast(makePrivate ? 'Private: only Nupur & Aditya can see these' : 'Everyone can now see these in the album');
      if (!DEMO) loadItems(true);
    } catch (e) {
      toast('Could not update: ' + e.message);
    } finally {
      document.body.classList.remove('busy');
    }
  }
  $('#minePublic').onclick = () => setMineAccess(false);
  $('#minePrivate').onclick = () => setMineAccess(true);

  $('#mineDelete').onclick = async () => {
    const ids = [...mine.sel];
    if (!ids.length || !confirm(`Delete ${ids.length} ${ids.length === 1 ? 'photo' : 'photos'}? This can't be undone from here.`)) return;
    document.body.classList.add('busy');
    let failed = 0;
    for (const id of ids) {
      try {
        await api({ action: 'delete', id }, 2);
        mine.items = mine.items.filter(i => i.id !== id);
        state.items = state.items.filter(i => i.id !== id);
        const k = demoMine.findIndex(i => i.id === id);
        if (k >= 0) demoMine.splice(k, 1);
      } catch (e) { failed++; }
    }
    document.body.classList.remove('busy');
    mine.sel.clear();
    renderMine();
    refresh();
    toast(failed ? `Deleted ${ids.length - failed}, ${failed} failed` : `Deleted ${ids.length} ${ids.length === 1 ? 'photo' : 'photos'}`);
  };

  async function uploadOne(job) {
    const f = job.file;
    job.album = autoAlbum(); // Drive folder only (sorted by date); guests never pick
    job.guest = batch.guest;
    job.private = batch.private;
    const dims = await getDims(job);
    const progress = n => { job.loaded = n; $('.qbar i', job.el).style.width = `${Math.round((n / f.size) * 100)}%`; updateOverall(); };

    if (DEMO) {
      for (let p = 0; p <= 10; p++) { await sleep(120 + Math.random() * 120); progress((f.size * p) / 10); }
      const id = 'local-' + Math.random().toString(36).slice(2);
      addMine(id, job, dims);
      return;
    }

    const { uploadUrl } = await api({
      action: 'start', album: job.album, mission: job.mission || '', guest: job.guest, name: f.name,
      size: f.size, mimeType: job.mime, origin: location.origin
    });

    let file;
    if (state.uploadMode === 'direct') {
      try {
        file = await uploadDirect(uploadUrl, f, job.mime, progress);
      } catch (e) {
        if (!e.cors) throw e;
        state.uploadMode = 'proxy';
        store.set('wp_mode', 'proxy');
        file = await uploadProxy(uploadUrl, f, progress);
      }
    } else {
      file = await uploadProxy(uploadUrl, f, progress);
    }
    if (!file || !file.id) throw new Error('Upload did not finish');
    await api({ action: 'finalize', id: file.id, guest: job.guest, private: job.private, mission: job.mission || '', name: f.name, width: dims.w, height: dims.h });
    addMine(file.id, job, dims);
  }

  function addMine(id, job, dims) {
    job.id = id;
    store.set('wp_uploaded', '1');
    updateShareBanner();
    if (DEMO) demoMine.unshift({ id, g: job.guest, ms: job.mission || '', v: job.mime.startsWith('video/') ? 1 : 0, w: dims.w, h: dims.h, p: job.private ? 1 : 0 });
    if (job.mission) markMissionDone(job.mission);
    state.local.set(id, job.url);
    job.item = { id, a: job.album, ms: job.mission || '', m: 1, g: job.guest, v: job.mime.startsWith('video/') ? 1 : 0, t: new Date().toISOString(), w: dims.w, h: dims.h };
    if (!job.private) { state.items.unshift(job.item); refresh(); }
  }

  // Straight from the phone to Google Drive, in 8 MB pieces.
  async function uploadDirect(url, f, mime, progress) {
    const CHUNK = 8 * 1024 * 1024;
    let start = 0;
    while (start < f.size) {
      const end = Math.min(start + CHUNK, f.size);
      let res, attempt = 0;
      for (;;) {
        res = await xhrPut(url, f.slice(start, end), `bytes ${start}-${end - 1}/${f.size}`, mime, n => progress(start + n));
        if (res.status === 308 || res.status === 200 || res.status === 201) break;
        if (res.status === 0 && start === 0 && attempt >= 1) { const e = new Error('cors'); e.cors = true; throw e; }
        if (++attempt > 4 || (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429)) {
          throw new Error(`Upload failed (${res.status})`);
        }
        await sleep(1000 * Math.pow(2, attempt));
      }
      start = end;
      progress(start);
      if (res.status === 200 || res.status === 201) return JSON.parse(res.body || '{}');
    }
    throw new Error('Upload ended unexpectedly');
  }

  function xhrPut(url, blob, range, mime, onProgress) {
    return new Promise(resolve => {
      const x = new XMLHttpRequest();
      x.open('PUT', url);
      x.setRequestHeader('Content-Range', range);
      x.setRequestHeader('Content-Type', mime);
      x.upload.onprogress = e => onProgress(e.loaded);
      x.onload = () => resolve({ status: x.status, body: x.responseText });
      x.onerror = () => resolve({ status: 0 });
      x.ontimeout = () => resolve({ status: 0 });
      x.timeout = 5 * 60 * 1000;
      x.send(blob);
    });
  }

  // Fallback: phone -> Apps Script -> Drive, in 4 MB pieces.
  async function uploadProxy(url, f, progress) {
    const CHUNK = 4 * 1024 * 1024;
    let start = 0;
    while (start < f.size) {
      const end = Math.min(start + CHUNK, f.size);
      const data = await toBase64(f.slice(start, end));
      const r = await api({ action: 'chunk', uploadUrl: url, start, total: f.size, data });
      start = end;
      progress(start);
      if (r.done) return r.file;
    }
    throw new Error('Upload ended unexpectedly');
  }

  function toBase64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1] || '');
      r.onerror = () => rej(r.error);
      r.readAsDataURL(blob);
    });
  }

  function getDims(job) {
    return new Promise(resolve => {
      const done = (w, h) => resolve({ w: w || 0, h: h || 0 });
      setTimeout(() => done(0, 0), 4000);
      if (job.mime.startsWith('video/')) {
        const v = document.createElement('video');
        v.preload = 'metadata'; v.muted = true;
        v.onloadedmetadata = () => done(v.videoWidth, v.videoHeight);
        v.onerror = () => done(0, 0);
        v.src = job.url;
      } else {
        const i = new Image();
        i.onload = () => done(i.naturalWidth, i.naturalHeight);
        i.onerror = () => done(0, 0);
        i.src = job.url;
      }
    });
  }

  async function acquireWakeLock() {
    try { if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
  function releaseWakeLock() { try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null; }
  window.addEventListener('beforeunload', e => { if (state.uploading) { e.preventDefault(); e.returnValue = ''; } });

  /* ================================================================ */
  /* Demo data (used when SCRIPT_URL is empty)                         */
  /* ================================================================ */
  const DEMO_ITEMS = [
    ['/assets/hero-couple.webp', 'Wedding', 'Riya', 0, 0],
    ['/assets/mehendi.webp', 'Mehendi', 'Kabir', 0, 0],
    ['/assets/engagement.webp', 'Engagement', 'Aashi', 0, 0],
    ['/assets/og-wedding.jpg', 'Wedding', 'Uma', 1200, 630],
    ['/assets/hands-holding.webp', 'Wedding', '', 0, 0],
    ['/assets/og-mehendi.jpg', 'Mehendi', 'Prem', 1200, 630],
    ['/assets/wedding-watercolor.webp', 'Wedding', 'Sumit', 0, 0],
    ['/assets/swans.webp', 'Engagement', 'Vinita', 0, 0],
    ['/assets/og-engagement.jpg', 'Engagement', 'Kabir', 1200, 630],
    ['/assets/arch-bougainvillea.webp', 'Wedding', 'Riya', 0, 0],
    ['/assets/peony.webp', 'Mehendi', '', 480, 853],
    ['/assets/og-reception.jpg', 'Wedding', 'Aashi', 1200, 630],
    ['/assets/hero-frames-hd.webp', 'Wedding', 'Punam', 0, 0],
    ['/assets/og-lovestory.jpg', 'Engagement', 'Girdhar', 1200, 630]
  ];
  async function demoApi(body) {
    await sleep(250);
    if (body.action === 'check') return { ok: true, admin: qs.has('admin') || !!ADMIN };
    if (body.action === 'list') {
      if (!demoApi.items) {
        demoApi.items = await Promise.all(DEMO_ITEMS.map(async ([src, a, g, w, h], i) => {
          if (!w) { const d = await getDims({ mime: 'image/', url: src }); w = d.w; h = d.h; }
          return { id: 'demo' + i, src, a, g, v: 0, w, h, t: '', ms: i % 3 === 2 ? '' : 'm' + String((i % 9) + 1).padStart(2, '0') };
        }));
      }
      return { ok: true, items: demoApi.items };
    }
    if (body.action === 'hide' || body.action === 'delete') { demoApi.items = demoApi.items.filter(i => i.id !== body.id); return { ok: true }; }
    return { ok: true };
  }

  /* ================================================================ */
  /* Little things                                                    */
  /* ================================================================ */
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.hidden = true; }, 3500);
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  function fmtMB(b) { return b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(b > 100 * 1024 * 1024 ? 0 : 1)} MB`; }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }

  function petal(burst) {
    const p = document.createElement('i');
    p.className = 'petal' + (Math.random() < 0.35 ? ' gold' : '');
    const dur = burst ? 2.5 + Math.random() * 2 : 7 + Math.random() * 6;
    p.style.left = `${Math.random() * 100}%`;
    p.style.animationDuration = `${dur}s`;
    p.style.setProperty('--dx', `${(Math.random() - 0.5) * 200}px`);
    p.style.setProperty('--rot', `${(Math.random() - 0.5) * 900}deg`);
    p.style.transform = `scale(${0.6 + Math.random() * 0.7})`;
    $('.petals').appendChild(p);
    setTimeout(() => p.remove(), dur * 1000 + 100);
  }
  function startPetals() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // Ambient petals removed for a cleaner look; petals only burst after a successful upload.
  }
  function burstPetals() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    for (let i = 0; i < 36; i++) setTimeout(() => petal(true), i * 40);
  }

  /* ================================================================ */
  /* Loading state: buttons that wait on the server show a spinner and  */
  /* ignore extra taps until the work is done (no double sends).        */
  /* ================================================================ */
  function guardButton(sel, label) {
    const el = $(sel);
    if (!el) return;
    const isForm = el.tagName === 'FORM';
    const btn = isForm ? el.querySelector('[type="submit"]') : el;
    const orig = isForm ? el.onsubmit : el.onclick;
    if (!orig || !btn) return;
    const wrapped = async function (e) {
      if (btn.dataset.busy) { if (e) e.preventDefault(); return; }
      btn.dataset.busy = '1';
      const html = btn.innerHTML;
      btn.classList.add('is-loading');
      btn.disabled = true;
      btn.innerHTML = `<span class="btn-spin" aria-hidden="true"></span><span>${esc(label)}</span>`;
      try { return await orig.call(this, e); }
      finally {
        btn.innerHTML = html;
        btn.classList.remove('is-loading');
        btn.disabled = false;
        delete btn.dataset.busy;
        updateSelUI && sel.startsWith('#sel') && updateSelUI();
        sel.startsWith('#mine') && updateMineUI();
      }
    };
    if (isForm) el.onsubmit = wrapped; else el.onclick = wrapped;
  }
  guardButton('#composeSend', 'Sending…');
  guardButton('#pushBtn', 'Turning on…');
  guardButton('#sedForm', 'Saving…');
  guardButton('#sedDelete', 'Removing…');
  guardButton('#minePublic', 'Updating…');
  guardButton('#minePrivate', 'Updating…');
  guardButton('#mineDelete', 'Deleting…');
  guardButton('#selDownload', 'Preparing…');
  guardButton('#selHide', 'Hiding…');
  guardButton('#selDelete', 'Deleting…');

  init();
})();
