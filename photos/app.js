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
    uploadMode: store.get('wp_mode') || 'direct'
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
          body: JSON.stringify(Object.assign({}, body, { k: KEY, admin: ADMIN }))
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

    // Floating "Add photos" button appears once the hero buttons scroll away
    const fab = $('.fab');
    new IntersectionObserver(([e]) => fab.classList.toggle('show', !e.isIntersecting)).observe($('.cta'));

    $$('[data-open-upload]').forEach(b => b.addEventListener('click', openSheet));
    window.addEventListener('resize', debounce(() => layout(true), 200));
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

      if (silent && fresh.length && state.items.length && window.scrollY > $('#gallery').offsetTop + 200) {
        const pill = $('#newPill');
        pill.textContent = `↑ ${fresh.length} new ${fresh.length === 1 ? 'memory' : 'memories'}`;
        pill.hidden = false;
        pill.onclick = () => { pill.hidden = true; state.items = next; refresh(); $('#gallery').scrollIntoView({ behavior: 'smooth' }); };
        return;
      }
      if (!silent || fresh.length || next.length !== state.items.length) {
        state.items = next;
        refresh();
      }
    } catch (e) {
      if (!silent) toast('Could not load the album. Pull to refresh in a moment.');
    } finally {
      $('#loading').hidden = true;
    }
  }

  function refresh() {
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
        const g = $('#gallery');
        if (window.scrollY > g.offsetTop) g.scrollIntoView();
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
    b.onclick = () => openLightbox(idx);
    return b;
  }

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
    $('#lbCaption').innerHTML = (it.g ? `<b>${esc(it.g)}</b><br>` : '<span>Shared by a guest</span><br>') +
      `<span>${esc(album ? album.label : it.a || '')}</span>`;
    $('#lbCount').textContent = `${state.lbIndex + 1} / ${v.length}`;
    $('#lbDownload').href = downloadUrl(it);
  }
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
  /* Upload sheet                                                     */
  /* ================================================================ */
  let selectedAlbum = sessionStorageGet('wp_album') || defaultAlbum();

  function defaultAlbum() {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    let pick = C.ALBUMS[C.ALBUMS.length - 1].id;
    for (const a of C.ALBUMS) if (a.date === today) pick = a.id;
    if (today < C.ALBUMS[0].date) pick = C.ALBUMS[0].id;
    for (let i = 0; i < C.ALBUMS.length - 1; i++) {
      if (today > C.ALBUMS[i].date && today < C.ALBUMS[i + 1].date) pick = C.ALBUMS[i].id;
    }
    return pick;
  }

  function openSheet() {
    const s = $('#sheet');
    s.hidden = false;
    document.body.classList.add('no-scroll');
    history.pushState({ sheet: 1 }, '');
    if (!state.uploading) showPickStep();
  }
  function closeSheet(fromPop) {
    if (state.uploading && !confirm('Uploads are still in progress. Close anyway? They will keep going in the background while this page stays open.')) {
      if (fromPop) history.pushState({ sheet: 1 }, '');
      return;
    }
    $('#sheet').hidden = true;
    document.body.classList.remove('no-scroll');
    if (!fromPop && history.state && history.state.sheet) history.back();
  }
  $$('[data-close-sheet]').forEach(b => b.onclick = () => closeSheet());

  function showPickStep() {
    $('#stepPick').hidden = false;
    $('#stepUpload').hidden = true;
    const chips = $('#albumChips');
    chips.innerHTML = '';
    C.ALBUMS.forEach(a => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.type = 'button';
      b.setAttribute('aria-pressed', String(a.id === selectedAlbum));
      b.innerHTML = `<b>${esc(a.label)}</b><small>${esc(a.when)}</small>`;
      b.onclick = () => { selectedAlbum = a.id; sessionStorageSet('wp_album', a.id); showPickStep(); };
      chips.appendChild(b);
    });
    const name = $('#guestName');
    if (!name.value) name.value = store.get('wp_name');
  }
  $('#guestName').addEventListener('change', e => store.set('wp_name', e.target.value.trim()));

  $('#fileInput').addEventListener('change', e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) startUploads(files);
  });

  /* ---------------- Queue ---------------- */
  let jobs = [];
  let running = 0;
  let wakeLock = null;

  function guessMime(f) {
    if (f.type) return f.type;
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    return ({ heic: 'image/heic', heif: 'image/heif', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
      mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v', '3gp': 'video/3gpp' })[ext] || '';
  }

  function startUploads(files) {
    store.set('wp_name', $('#guestName').value.trim());
    $('#stepPick').hidden = true;
    $('#stepUpload').hidden = false;
    $('#doneActions').hidden = true;
    $('.keep-open').hidden = false;
    $('#upTitle').textContent = 'Uploading…';
    if (!jobs.some(j => j.status === 'queued' || j.status === 'uploading')) { jobs = []; $('#queue').innerHTML = ''; }

    const guest = $('#guestName').value.trim();
    const max = C.MAX_FILE_MB * 1024 * 1024;
    let skipped = 0;
    files.forEach(f => {
      const mime = guessMime(f);
      if (!/^(image|video)\//.test(mime) || f.size === 0) { skipped++; return; }
      if (f.size > max) { skipped++; toast(`${f.name} is larger than ${C.MAX_FILE_MB} MB and was skipped`); return; }
      const job = { file: f, mime, album: selectedAlbum, guest, loaded: 0, status: 'queued', el: null, url: URL.createObjectURL(f) };
      job.el = queueEl(job);
      jobs.push(job);
    });
    if (skipped && skipped === files.length) {
      toast('Those files could not be uploaded. Please pick photos or videos.');
      showPickStep();
      return;
    }
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
        .then(() => { job.status = 'done'; job.el.className = 'q done'; })
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

  function updateOverall() {
    const total = jobs.reduce((s, j) => s + j.file.size, 0) || 1;
    const loaded = jobs.reduce((s, j) => s + (j.status === 'done' ? j.file.size : j.loaded), 0);
    const done = jobs.filter(j => j.status === 'done').length;
    $('#overallBar').style.width = `${Math.round((loaded / total) * 100)}%`;
    $('#overallText').textContent = `${done} of ${jobs.length} uploaded · ${fmtMB(loaded)} of ${fmtMB(total)}`;
  }

  function allDone() {
    if (!jobs.length) return;
    releaseWakeLock();
    const done = jobs.filter(j => j.status === 'done').length;
    const failed = jobs.filter(j => j.status === 'error').length;
    const album = C.ALBUMS.find(a => a.id === jobs[0].album);
    $('#upTitle').textContent = failed ? `${done} uploaded, ${failed} failed` : 'Thank you!';
    $('#overallText').textContent = failed
      ? 'Tap the red ones to try again.'
      : `${done} ${done === 1 ? 'photo' : 'photos'} added to ${album ? album.label : 'the album'}`;
    $('#doneActions').hidden = false;
    $('.keep-open').hidden = true;
    if (!failed) burstPetals();
  }
  $('#addMore').onclick = () => { jobs = []; $('#queue').innerHTML = ''; showPickStep(); $('#fileInput').click(); };
  $('#seeAlbum').onclick = () => {
    const a = jobs[0] && jobs[0].album;
    jobs = []; $('#queue').innerHTML = '';
    closeSheet();
    if (a) { state.album = a; renderTabs(); layout(true); }
    setTimeout(() => $('#gallery').scrollIntoView({ behavior: 'smooth' }), 50);
  };

  async function uploadOne(job) {
    const f = job.file;
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
    await api({ action: 'finalize', id: file.id, guest: job.guest, name: f.name, width: dims.w, height: dims.h });
    addMine(file.id, job, dims);
  }

  function addMine(id, job, dims) {
    state.local.set(id, job.url);
    state.items.unshift({ id, a: job.album, g: job.guest, v: job.mime.startsWith('video/') ? 1 : 0, t: new Date().toISOString(), w: dims.w, h: dims.h });
    refresh();
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
    if (body.action === 'hide') { demoApi.items = demoApi.items.filter(i => i.id !== body.id); return { ok: true }; }
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
