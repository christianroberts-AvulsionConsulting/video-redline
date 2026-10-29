/* =====================================================================
   07 - Saved sessions: the "sessions" folder, and the list in the File menu
   The page cannot read a folder by itself, so the person picks the "sessions" folder that came with Video Redline ONCE (the browser's own
   folder picker, File System Access API: Chrome, Edge and other Chromium browsers). The browser keeps that choice (IndexedDB) and asks
   for a click of permission again after a restart. Nothing goes through the helper and nothing leaves the computer.
   The File menu then lists the sessions in that folder; each row opens, renames, duplicates or deletes one. A session is the same JSON
   file that "Download session file" makes, so the two are interchangeable. Browsers without the folder picker keep the download / load buttons.
   ===================================================================== */
const SESS = {
  dir: null,                 // FileSystemDirectoryHandle of the sessions folder once it is known
  state: 'none',             // unsupported | none (no folder chosen yet) | ask (chosen, the browser needs a click to allow it) | gone (the folder is missing) | ready
  current: null,             // name (no .json) of the saved session these markers came from or were last saved to ...
  curVideo: '',              // ... and the video that was open then: Save session never writes a session of one video over another's
  cache: new Map()           // 'file|modified|size' -> { video, count } so a long list is read from disk only once
};
const sessSupported = () => typeof window.showDirectoryPicker === 'function';
const SESS_MAX_BYTES = 20 * 1024 * 1024;          // a real session is a few hundred KB; anything bigger is not read

/* ---------- remembering the folder (a handle can only be kept in IndexedDB) ---------- */
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('vrt-sessions', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) {
  let db = null;
  try { db = await idbOpen(); return await new Promise((res, rej) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); }); }
  catch (e) { return null; }
  finally { if (db) db.close(); }
}
async function idbSet(k, v) {
  let db = null;
  try { db = await idbOpen(); await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error); }); return true; }
  catch (e) { return false; }                // the folder then works until the page is closed
  finally { if (db) db.close(); }
}

/* ---------- names ---------- */
// A file name that is safe on Windows, Mac and Linux: no slashes or other forbidden characters, no ".json" typed by the person, no dots or spaces at the ends.
function sessCleanName(raw) {
  let n = String(raw == null ? '' : raw).replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\.json$/i, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (n.length > 100) n = n.slice(0, 100).trim();
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(n)) n += ' session';
  return n;
}
// `taken` holds lower-case names: Windows and Mac treat "A" and "a" as the same file
function sessUnique(want, taken) {
  if (!taken.has(want.toLowerCase())) return want;
  for (let i = 2; ; i++) { const n = want + ' ' + i; if (!taken.has(n.toLowerCase())) return n; }
}
async function sessNames(dir) {
  const names = new Set();
  for await (const [fname, handle] of dir.entries()) if (handle.kind === 'file' && /\.json$/i.test(fname)) names.add(fname.replace(/\.json$/i, '').toLowerCase());
  return names;
}
async function sessPut(dir, name, text) {
  const fh = await dir.getFileHandle(name + '.json', { create: true });
  const w = await fh.createWritable();       // written to a side file and swapped in on close, so a failed save never leaves half a session
  await w.write(text); await w.close();
}
function sessForget() { SESS.current = null; SESS.curVideo = ''; }

/* ---------- remembering the videos (a session only holds the video's name, so the page keeps a handle to each video it opened) ---------- */
const VID_TYPES = [{ description: 'Video files', accept: { 'video/*': ['.mp4', '.mov', '.m4v', '.webm'] } }];
const vidKey = name => 'video:' + name;
function vidRemember(name, handle) { if (handle && handle.kind === 'file') idbSet(vidKey(name), handle); }
// The File the page was allowed to keep for this video name, or null: never opened with the picker, moved or deleted, or the browser's OK was refused.
async function vidRecall(name) {
  const handle = await idbGet(vidKey(name));
  if (!handle || typeof handle.queryPermission !== 'function') return null;
  try {
    let p = await handle.queryPermission({ mode: 'read' });
    if (p !== 'granted') p = await handle.requestPermission({ mode: 'read' });          // (needs the click that opened the session: it is still fresh)
    return p === 'granted' ? { file: await handle.getFile(), handle } : null;
  } catch (e) { return null; }
}
// The browser's own file picker; unlike the hidden file input it hands back a handle the page can keep. Throws AbortError when cancelled.
async function vidPick() {
  const [handle] = await window.showOpenFilePicker({ id: 'vrt-video', startIn: 'videos', types: VID_TYPES });
  return { file: await handle.getFile(), handle };
}
// Open video…: the picker above where the browser has it, otherwise the plain file input.
async function openVideoPicker() {
  if (typeof window.showOpenFilePicker !== 'function') { $('fileVideo').click(); return; }
  try { const p = await vidPick(); loadVideo(p.file, p.handle); }
  catch (e) { if (!e || e.name !== 'AbortError') toast('The browser would not open its file picker. Drop the video onto the page instead.', 6000); }
}
// Resolves true when the video just given to loadVideo is ready (false when the browser could not play it)
function videoReady() {
  return new Promise(res => {
    const done = ok => { video.removeEventListener('loadedmetadata', yes); video.removeEventListener('error', no); res(ok && !!meta); };
    const yes = () => done(true), no = () => done(false);
    video.addEventListener('loadedmetadata', yes); video.addEventListener('error', no);       // (added after the page's own listeners, so `meta` is set by then)
  });
}
const sessFail = e => e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
  ? 'The browser no longer allows this folder. Open File and allow it again.'
  : e && e.name === 'NotFoundError' ? 'That session or folder cannot be found any more.' : 'That did not work (' + ((e && e.message) || 'unknown problem') + ').';

/* ---------- the folder: is it known, and may the page use it ---------- */
async function sessRefresh() {
  if (!sessSupported()) return SESS.state = 'unsupported';
  if (!SESS.dir) SESS.dir = await idbGet('dir');
  if (!SESS.dir) return SESS.state = 'none';
  let p; try { p = await SESS.dir.queryPermission({ mode: 'readwrite' }); } catch (e) { p = 'prompt'; }
  return SESS.state = (p === 'granted' ? 'ready' : 'ask');
}
async function sessAllow() {                   // must run from a click
  try { return (await SESS.dir.requestPermission({ mode: 'readwrite' })) === 'granted'; } catch (e) { return false; }
}
async function sessPick() {                    // must run from a click
  try {
    const dir = await window.showDirectoryPicker({ id: 'vrt-sessions', mode: 'readwrite', startIn: 'documents' });
    SESS.dir = dir; SESS.state = 'ready'; SESS.cache.clear();
    await idbSet('dir', dir);
    toast('Sessions will be kept in the folder “' + dir.name + '”.');
    return true;
  } catch (e) {
    if (!e || e.name !== 'AbortError') toast('The browser would not use that folder. Pick the sessions folder that came with Video Redline (a system folder such as Documents itself is not allowed).', 7000);
    return false;
  }
}
// Where the page was opened from, so the explanation can say where the sessions folder should be (only for a page opened from a file on this computer)
function sessExpectedPath() {
  if (location.protocol !== 'file:' || location.host) return '';
  try {
    const dir = decodeURIComponent(location.pathname).replace(/\/[^/]*$/, '');
    return /^\/[A-Za-z]:/.test(dir) ? dir.slice(1).replace(/\//g, '\\') + '\\sessions' : dir + '/sessions';
  } catch (e) { return ''; }
}
// The first-time explanation, then the browser's folder picker. Resolves true when a folder was chosen.
function sessSetup() {
  return new Promise(resolve => {
    let settled = false;
    const done = v => { if (!settled) { settled = true; resolve(v); } };
    const path = sessExpectedPath();
    openModal({
      title: 'Choose your sessions folder', narrow: true, onClose: () => done(false),
      body: h('div', { class: 'sess-setup' },
        h('p', {}, 'Video Redline keeps your saved sessions in the ', h('b', { text: 'sessions' }), ' folder that came with it, next to the page. Pick that folder once. This browser remembers it, so every session you save appears in File.'),
        path ? h('p', {}, 'It should be here: ', h('code', { text: path })) : null,
        h('p', { class: 'dim', text: 'No sessions folder? Make a new folder with that name, or pick any folder you like.' })),
      footer: [h('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => { if (await sessPick()) { done(true); closeModal(); } } }, 'Choose folder…')]
    });
  });
}

/* ---------- the saved sessions ---------- */
// Every session in the folder, newest first. Files that are not sessions (other .json files) are left out.
async function sessList() {
  const files = [];
  for await (const [fname, handle] of SESS.dir.entries()) if (handle.kind === 'file' && /\.json$/i.test(fname)) files.push(handle);
  const rows = await Promise.all(files.map(async fh => {
    try {
      const file = await fh.getFile();
      if (file.size > SESS_MAX_BYTES) return null;
      const key = fh.name + '|' + file.lastModified + '|' + file.size;
      let info = SESS.cache.get(key);
      if (!info) {
        let data = null; try { data = JSON.parse(await file.text()); } catch (e) { /* not JSON */ }
        info = (data && Array.isArray(data.markers)) ? { video: String((data.video && data.video.name) || ''), count: data.markers.length } : { video: null, count: 0 };
        SESS.cache.set(key, info);
      }
      return info.video === null ? null : { fname: fh.name, name: fh.name.replace(/\.json$/i, ''), modified: file.lastModified, video: info.video, count: info.count };
    } catch (e) { return null; }
  }));
  return rows.filter(Boolean).sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
}
function sessWhen(ms) {
  const d = new Date(ms), now = new Date(), sameDay = d.toDateString() === now.toDateString();
  const time = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  return sameDay ? 'today ' + time : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' }) + ' ' + time;
}

// Clicking a session opens the video it was made for as well, so the person does not have to find it first: the page's remembered copy of it,
// otherwise the file picker (asked for in the toast). Returns false when there is still no video to put the markers on.
async function sessOpenVideo(s) {
  if (!s.video || (meta && meta.name === s.video)) return true;               // the right video is open already (or the session names none)
  let got = await vidRecall(s.video);
  if (!got) {
    if (typeof window.showOpenFilePicker !== 'function') return true;         // this browser has no picker like that: the old way ("Open a video first", or “Load it anyway?” for another video)
    toast('Pick the video “' + s.video + '” to open this session.', 6000);
    try { got = await vidPick(); }
    catch (e) {
      if (e && e.name !== 'AbortError') toast('The browser would not open its file picker. Open the video with Open video…, then pick the session again.', 6000);
      else if (!meta) toast('Not opened: this session needs its video “' + s.video + '”.', 5000);
      return !!meta;                                                          // (cancelled with another video open: the question “Load it anyway?” follows)
    }
  }
  const ready = videoReady();
  loadVideo(got.file, got.handle);
  return await ready;
}
async function sessOpen(s) {
  if (!(await sessOpenVideo(s))) return;
  if (needVideo()) return;
  let text;
  try { text = await (await (await SESS.dir.getFileHandle(s.fname)).getFile()).text(); } catch (e) { toast('Could not read “' + s.name + '”. ' + sessFail(e), 5000); return; }
  if (await loadSessionText(text, s.fname)) { SESS.current = s.name; SESS.curVideo = meta.name; }
}
async function sessRename(s, raw) {            // -> 'ok' | 'same' | 'empty' | 'exists'
  const nn = sessCleanName(raw);
  if (!nn) return 'empty';
  if (nn.toLowerCase() === s.name.toLowerCase()) return 'same';
  if ((await sessNames(SESS.dir)).has(nn.toLowerCase())) return 'exists';
  const fh = await SESS.dir.getFileHandle(s.fname);
  let moved = false;
  if (typeof fh.move === 'function') { try { await fh.move(nn + '.json'); moved = true; } catch (e) { /* this browser cannot rename here: copy instead */ } }
  if (!moved) {
    await sessPut(SESS.dir, nn, await (await fh.getFile()).text());
    await SESS.dir.removeEntry(s.fname);
  }
  if (SESS.current === s.name) SESS.current = nn;
  return 'ok';
}
async function sessDuplicate(s) {
  const names = await sessNames(SESS.dir);
  const nn = sessUnique(sessCleanName(s.name + ' copy') || 'copy', names);
  await sessPut(SESS.dir, nn, await (await (await SESS.dir.getFileHandle(s.fname)).getFile()).text());
  toast('Made a copy: “' + nn + '”.');
}
async function sessDelete(s) {
  if (!confirm('Delete the saved session “' + s.name + '”? It is removed from the folder and cannot be brought back.')) return false;
  await SESS.dir.removeEntry(s.fname);
  if (SESS.current === s.name) sessForget();
  toast('Deleted “' + s.name + '”.');
  return true;
}

// Save session: into the sessions folder when there is one (asking for it the first time), otherwise a download like before.
async function saveSession() {
  if (needVideo()) return;
  let st = await sessRefresh();
  if (st === 'unsupported') { saveSessionFile(); return; }
  if (st === 'none' || st === 'gone') { if (!(await sessSetup())) return; }
  else if (st === 'ask' && !(await sessAllow())) { toast('Not saved: the browser needs your OK to use the sessions folder. Open File and try again, or use Download session file.', 6000); return; }
  try {
    const names = await sessNames(SESS.dir);
    const reuse = SESS.current && SESS.curVideo === meta.name && names.has(SESS.current.toLowerCase());     // saving again updates the session this work came from
    const name = reuse ? SESS.current : sessUnique(sessCleanName(baseName()) || 'session', names);
    await sessPut(SESS.dir, name, JSON.stringify(buildJson({ keepHidden: true }), null, 2));
    SESS.current = name; SESS.curVideo = meta.name;
    toast((reuse ? 'Saved' : 'Saved a new session,') + ' “' + name + '” in the folder “' + SESS.dir.name + '”.');
  } catch (e) { toast('Could not save the session. ' + sessFail(e), 6000); }
}

/* ---------- the File menu ---------- */
async function sessRender(box) {               // fills the "Saved sessions" part of the menu; called again after every change
  const st = await sessRefresh();
  const head = (extra) => h('div', { class: 'sess-head' }, h('span', { text: 'Saved sessions' }), h('span', { class: 'grow' }), extra);
  const note = text => h('div', { class: 'sess-note', text });
  const choose = (label, fn) => h('button', { role: 'menuitem', onclick: fn }, icon('folder-open'), label);
  const redraw = () => sessRender(box);
  const kids = [];
  if (st === 'unsupported') {
    kids.push(head(), note('Saving into a folder needs Chrome, Edge or another Chromium browser. Here, use Download session file and Load session from file below.'));
  } else if (st === 'none') {
    kids.push(head(), note('Pick your sessions folder once and every session you save is listed here, ready to open, rename, copy or delete.'),
      choose('Choose sessions folder…', async () => { closePopover(); if (await sessSetup()) openFileMenu(); }));        // (the explanation window would close the menu anyway)
  } else if (st === 'ask') {
    kids.push(head(), note('The browser needs your OK before Video Redline can use the folder “' + SESS.dir.name + '” again.'),
      choose('Allow the folder “' + SESS.dir.name + '”', async () => { if (await sessAllow()) redraw(); else toast('The folder was not allowed.'); }),
      choose('Choose a different folder…', async () => { if (await sessPick()) redraw(); }));
  } else {
    let rows = null;
    try { rows = await sessList(); } catch (e) { SESS.state = 'gone'; }
    if (!rows) {
      kids.push(head(), note('The sessions folder “' + SESS.dir.name + '” cannot be found. It may have been moved or renamed.'),
        choose('Choose the sessions folder…', async () => { if (await sessPick()) redraw(); }));
    } else {
      kids.push(head(h('button', { class: 'sess-folder', title: 'Keeping sessions in the folder “' + SESS.dir.name + '”. Click to use another folder.', onclick: async () => { if (await sessPick()) redraw(); } },
        icon('folder-open'), SESS.dir.name || 'folder')));
      if (!rows.length) kids.push(note('No saved sessions yet. Use Save session below and it shows up here.'));
      else {
        kids.push(h('div', { class: 'sess-list' }, rows.map(s => sessRow(s, box))));
      }
    }
  }
  box.replaceChildren(...kids);
}
function sessRow(s, box) {
  const redraw = () => sessRender(box);
  const guard = fn => async e => { e.stopPropagation(); try { await fn(); } catch (err) { toast(sessFail(err), 6000); } redraw(); };
  const mine = !!(meta && s.video && s.video === meta.name);
  const cur = SESS.current === s.name && SESS.curVideo === (meta && meta.name);
  const main = h('button', { class: 'sess-main', role: 'menuitem', title: 'Open this session' + (s.video ? ' (made for ' + s.video + ')' : ''), onclick: () => { closePopover(); sessOpen(s); } },
    h('span', { class: 'sess-nm', text: s.name }),
    h('span', { class: 'sess-sub' }, (s.video || 'no video name') + ' · ' + s.count + ' marker' + (s.count === 1 ? '' : 's') + ' · ' + sessWhen(s.modified),
      mine ? h('span', { class: 'sess-tag', text: ' · this video' }) : null));
  const row = h('div', { class: 'sess-row' + (cur ? ' cur' : '') }, main,
    h('span', { class: 'sess-acts' },
      h('button', { title: 'Rename', 'aria-label': 'Rename ' + s.name, onclick: e => { e.stopPropagation(); sessStartRename(row, main, s, box); } }, icon('pencil')),
      h('button', { title: 'Make a copy', 'aria-label': 'Duplicate ' + s.name, onclick: guard(() => sessDuplicate(s)) }, icon('duplicate')),
      h('button', { class: 'danger', title: 'Delete', 'aria-label': 'Delete ' + s.name, onclick: guard(async () => { await sessDelete(s); }) }, icon('trash'))));
  return row;
}
// Rename in place: the name turns into a text box. Enter keeps the new name, Escape or clicking away puts the old one back.
function sessStartRename(row, main, s, box) {
  const input = h('input', { type: 'text', class: 'sess-rename', value: s.name, maxlength: 100, 'aria-label': 'New name for ' + s.name, spellcheck: 'false' });
  let busy = false;
  const cancel = () => { if (!busy && input.isConnected) input.replaceWith(main); };
  const commit = async () => {
    if (busy) return;
    busy = true;
    let r;
    try { r = await sessRename(s, input.value); } catch (e) { toast(sessFail(e), 6000); r = 'error'; }
    busy = false;
    if (r === 'exists') { toast('There is already a session called “' + sessCleanName(input.value) + '”. Pick another name.', 4500); input.focus(); input.select(); return; }
    if (r === 'empty') { toast('Type a name for the session.'); input.focus(); return; }
    if (r === 'ok') toast('Renamed to “' + sessCleanName(input.value) + '”.');
    sessRender(box);
  };
  input.addEventListener('keydown', e => {
    e.stopPropagation();                         // Escape must not close the whole menu, and letters must not trigger the editor's shortcuts
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });
  input.addEventListener('blur', () => setTimeout(cancel, 120));          // (a short wait, so a click on another button in the row still lands before the box goes away)
  main.replaceWith(input); input.focus(); input.select();
}

async function openFileMenu() {
  const token = openFileMenu.n = (openFileMenu.n || 0) + 1;
  const item = (ic, label, fn) => h('button', { role: 'menuitem', onclick: () => { closePopover(); fn(); } }, icon(ic), label);
  const box = h('div', { class: 'sess-box' });
  const menu = h('div', { class: 'menu sess-menu', role: 'menu' },
    item('folder-open', 'Open video…', openVideoPicker), h('hr'),
    box, h('hr'),
    item('save', 'Save session', saveSession), h('hr'),
    item('download', 'Download session file (JSON)', saveSessionFile), item('upload', 'Load session from file…', () => $('fileSession').click()));
  await sessRender(box);
  if (token === openFileMenu.n) openPopover($('btnFile'), menu);          // (a later click on File wins)
}
