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

    renderCollage();
    route();
    $('#selToggle').hidden = !state.isAdmin;

    $$('[data-open-upload]').forEach(b => b.addEventListener('click', pickFiles));
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

  function refresh() {
    renderCollage();
    renderTabs();
    updateStats();
    layout(true);
  }

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
        t.onclick = it.id.startsWith('ph') ? pickFiles : openFromCollage;
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
  function route() {
    const album = location.hash === '#album';
    const was = document.body.classList.contains('view-album');
    document.body.classList.toggle('view-album', album);
    if (album !== was) {
      window.scrollTo(0, 0);
      if (album) layout(true); else { setSelecting(false); renderCollage(); }
    }
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
    $('#lbCaption').innerHTML = it.g ? `<b>${esc(it.g)}</b>` : '<span>Shared by a guest</span>';
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

  const batch = { guest: store.get('wp_name'), private: false };

  function pickFiles() { $('#fileInput').click(); }

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
      batch.private = false;
    }
    const max = C.MAX_FILE_MB * 1024 * 1024;
    let added = 0;
    files.forEach(f => {
      const mime = guessMime(f);
      if (!/^(image|video)\//.test(mime) || f.size === 0) return;
      if (f.size > max) { toast(`${f.name} is larger than ${C.MAX_FILE_MB} MB and was skipped`); return; }
      const job = { file: f, mime, album: null, guest: null, private: false, item: null, id: null, loaded: 0, status: 'queued', el: null, url: URL.createObjectURL(f) };
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
    if (!failed) burstPetals();
  }
  $('#addMore').onclick = pickFiles;
  $('#seeAlbum').onclick = () => {
    closeSheet();
    state.album = 'all'; layout(true);
    setTimeout(() => { if (location.hash !== '#album') location.hash = 'album'; else layout(true); }, 150);
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
      action: 'start', album: job.album, guest: job.guest, name: f.name,
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
    await api({ action: 'finalize', id: file.id, guest: job.guest, private: job.private, name: f.name, width: dims.w, height: dims.h });
    addMine(file.id, job, dims);
  }

  function addMine(id, job, dims) {
    job.id = id;
    state.local.set(id, job.url);
    job.item = { id, a: job.album, g: job.guest, v: job.mime.startsWith('video/') ? 1 : 0, t: new Date().toISOString(), w: dims.w, h: dims.h };
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
          return { id: 'demo' + i, src, a, g, v: 0, w, h, t: '' };
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

  init();
})();
