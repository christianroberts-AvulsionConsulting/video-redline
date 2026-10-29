/* =====================================================================
   06 - Make a visual with an AI (the "Make with AI" button of the Visuals and Styles tabs)
   Builds a prompt that you paste into any AI assistant. The prompt holds the library file format, the kinds, options and styles of THIS
   build (read from VIS and the style list, so it cannot go out of date) and two worked examples. The assistant answers with a library
   file, and the Load button of the Visuals tab (importLibraryFile in 06-library.js) adds it. This page sends nothing anywhere.
   ===================================================================== */
const AI_REQUEST_PLACEHOLDER = '(Describe the visual or visuals you want here, then send this message.)';

// Two real entries built by the same code that reads the file, so an example can never be one the tool would not accept
function aiPromptExamples() {
  const ids = ['shortcut', 'steps'].filter(id => kindById(id));
  VIS.KINDS.forEach(k => { if (ids.length < 2 && ids.indexOf(k.id) < 0) ids.push(k.id); });
  return ids.map(id => {
    const k = kindById(id), nv = normVisual({ kind: id, content: k.sample });
    nv.style = 'default'; nv.textBy = 'me';
    return { name: k.sample.title, visual: nv };
  }).concat(kindById('big-number') ? [aiPromptNoteExample()] : []);
}
// The third example shows a "note", built by the same code, so the AI sees the exact key and how a motion request is written
function aiPromptNoteExample() {
  const nv = normVisual({ kind: 'big-number', content: { title: '10x', body: 'faster reports' }, opts: { scale: 1.3 },
    note: 'Turn the number slowly around its vertical axis in 3D, like a rotating sign, for as long as it is on screen.' });
  nv.style = 'default'; nv.textBy = 'me';
  return { name: 'Rotating 10x', visual: nv };
}

function buildMakeAiPrompt(request) {
  const O = VIS.OPTIONS, fieldLabel = (k, key) => { const f = k.fields.find(x => x.key === key); return f ? f.label : key; };
  const kinds = VIS.KINDS.map(k => '- "' + k.id + '" (' + k.label + '): ' + k.blurb + ' title = ' + fieldLabel(k, 'title') + '; body = ' + fieldLabel(k, 'body') + '.');
  const pointerKinds = VIS.KINDS.filter(k => (VIS.OPTION_USE[k.id] || []).indexOf('pointer') >= 0).map(k => '"' + k.id + '"');
  const q = list => list.map(x => '"' + x + '"').join(', ');
  const example = JSON.stringify({ tool: 'video-review-library', version: 1, visuals: aiPromptExamples() }, null, 2);
  const want = (request || '').trim() || AI_REQUEST_PLACEHOLDER;
  return [
    'I use a video-editing helper called Video Redline. It keeps a library of "visuals": small styled overlays (a list, a flow diagram, a big number and so on) that I place on top of my videos. Please design visuals for my library.',
    '',
    'WHAT TO REPLY WITH',
    'Reply with one library file: a single JSON code block and nothing else, except at most two plain sentences before it (for example, to say that a request did not fit any kind exactly). I will save the block as my-visuals.json and load it with the Load button of the Visuals tab, so it must be valid JSON: double quotes, no comments, no trailing commas. If my request is unclear, ask one short question first instead.',
    '',
    'THE FILE',
    'Top level: { "tool": "video-review-library", "version": 1, "visuals": [ one object per visual ] }',
    'Each visual object has a "name" (a short name for my library list) and a "visual" with the keys "kind", "content", "opts", "style" and "textBy", and optionally "note", described below.',
    '',
    '"kind": use exactly one of these ids. No other kind exists, and an id that is not on this list is shown as a title card.',
    kinds.join('\n'),
    'If my idea does not fit any kind, use the closest one and tell me in a sentence what is different. Never invent a kind.',
    '',
    '"content": { "title": "...", "body": "..." }. Plain text only (no markdown or HTML); write \\n for a new line inside a string. Keep the words short, because people read them on a video in a few seconds. Nothing except "title" and "body" is kept.',
    '',
    '"opts": all optional; leave a key out to get its default.',
    '- "align": ' + q(O.align),
    '- "scale": a number from ' + O.scaleRange.min + ' to ' + O.scaleRange.max + ' (text size; 1 is normal)',
    '- "bg": ' + q(O.bg) + ' (the panel behind the words)',
    '- "accent": a colour such as "#2f6feb", or "" to keep the style\'s own accent',
    '- "pointer": ' + q(O.pointer) + '. Only these kinds use it: ' + (pointerKinds.join(', ') || 'none') + '.',
    '',
    '"style": the id of a design look, or "default". Use "default" unless I ask for a look. Valid ids: ' + allStyles().map(s => s.id).join(', ') + '.',
    '',
    '"textBy": "me" when the words are written in "content" (do this unless I ask you to leave the words open). "ai" means the words are left empty to be written later.',
    '',
    '"note": optional. Plain text, up to ' + NOTE_MAX + ' characters: an instruction for the AI video editor that is added to the marker Comment every time I use this visual, so I do not have to write it again. Use it for anything the picture itself cannot show, such as movement, a 3D look, an animation or timing. Write it as a direct instruction, for example "Turn the number slowly around its vertical axis in 3D, like a rotating sign, for as long as it is on screen." Nothing moves inside the tool itself; the note is what makes the editor do it. If I ask for 3D, a spin, a fade or any other motion, choose the closest kind and put the motion in "note". Leave "note" out when I ask for nothing special.',
    '',
    'Leave out "id" and any dates; the tool adds them.',
    '',
    'EXAMPLE OF A VALID FILE',
    example,
    '',
    'MY REQUEST',
    want
  ].join('\n');
}

function copyPlainText(text, okMsg, failMsg) {
  const fallback = () => {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text;
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove(); toast(ok ? okMsg : failMsg, ok ? undefined : 6000);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast(okMsg), fallback);
  else fallback();
}

// The AI's answer as pasted: a ```json fence around it, or a sentence before and after it, is fine; a bare list of visuals is accepted too
function parsePastedLibrary(text) {
  let s = String(text || '').trim();
  const fence = /```[a-z]*\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const attempt = t => { try { return JSON.parse(t); } catch (e) { return null; } };
  let d = attempt(s);
  if (!d) { const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a >= 0 && b > a) d = attempt(s.slice(a, b + 1)); }
  return Array.isArray(d) ? { visuals: d } : d;
}

function openMakeWithAi() {
  if (!HAS_VIS) { toast('The visuals module is missing from this page.'); return; }
  const ask = h('textarea', { rows: 3, 'aria-label': 'What visual do you want', placeholder: 'For example: three short tips for working with tables, in a warm style' });
  const out = h('textarea', { rows: 9, readonly: true, 'aria-label': 'The prompt to copy', style: 'font:11.5px/1.45 ui-monospace,Consolas,monospace' });
  const redraw = () => { out.value = buildMakeAiPrompt(ask.value); };
  ask.addEventListener('input', redraw); redraw();
  const kindNames = VIS.KINDS.map(k => k.label.toLowerCase()).join(', ');
  const paste = h('textarea', { rows: 4, 'aria-label': 'The AI answer', placeholder: 'Paste the AI’s whole answer here' });
  const note = h('div', { class: 'hint', style: 'min-height:18px' });
  const say = (msg, bad) => { note.textContent = msg; note.style.color = bad ? 'var(--danger)' : ''; };
  const addPasted = () => {
    if (!paste.value.trim()) { say('Paste the AI’s answer into the box first.', true); return; }
    const d = parsePastedLibrary(paste.value);
    if (!d || !Array.isArray(d.visuals)) { say('That is not a library file. Paste the whole answer, from the first { to the last }. It needs a "visuals" list.', true); return; }
    const unknown = d.visuals.filter(it => it && it.visual && typeof it.visual === 'object' && !kindById(it.visual.kind) && VIS.normalize(it.visual).kind === VIS.defaultKind('visual')).length;   // a kind this tool lacks becomes a title card
    const n = addLibraryData(d);
    if (n < 1) { say('Nothing was added: none of the entries had a "visual" in it.', true); return; }
    closeModal();
    if (ui.tab !== 'visuals') showTab('visuals');       // opened from the Styles tab: show where the new visuals went
    const list = $('paneVisuals').querySelector('.pane-body'); if (list) list.scrollTop = list.scrollHeight;
    toast('Added ' + n + ' visual' + (n === 1 ? '' : 's') + ' at the bottom of your library.' + (unknown ? ' ' + unknown + ' used a kind this tool does not have, so check ' + (unknown === 1 ? 'it' : 'them') + '.' : ''), unknown ? 7000 : undefined);
  };
  const pasteBox = h('div', { style: 'margin-top:16px;padding-top:14px;border-top:1px solid var(--line)' },
    h('label', { class: 'field' }, 'Got the AI’s answer? Paste it here', paste),
    h('div', { style: 'display:flex;align-items:center;gap:10px;margin-top:8px' }, h('button', { class: 'btn sm', onclick: addPasted }, icon('plus'), 'Add to my library'), note));
  const modal = openModal({
    title: 'Make visuals with an AI',
    narrow: true,
    body: h('div', {},
      h('p', { class: 'hint', style: 'margin:0 0 12px', text: 'Let an AI assistant (Claude, ChatGPT, Gemini or any other) design visuals for your library. It does not connect to this page, and this page sends nothing anywhere.' }),
      h('ol', { style: 'margin:0 0 16px 18px;padding:0;display:grid;gap:8px;list-style:decimal;font-size:13px;line-height:1.5;color:var(--text-2)' },
        h('li', {}, 'Say what you want below (optional: you can also tell your AI after you paste).'),
        h('li', {}, 'Press ', h('b', { text: 'Copy prompt' }), ' and paste it into your AI assistant.'),
        h('li', {}, 'It answers with a block of text. Copy all of it.'),
        h('li', {}, 'Paste it into the box at the bottom of this window and press ', h('b', { text: 'Add to my library' }), '. (Or save it as a file that ends in .json, for example my-visuals.json, and use the upload icon at the top of the Visuals tab.)')),
      h('label', { class: 'field' }, 'What visual do you want?', ask),
      h('div', { class: 'hint', style: 'margin:12px 0 8px', text: 'The AI can combine the ' + VIS.KINDS.length + ' kinds this tool has (' + kindNames + ') with any of its ' + allStyles().length + ' styles. It cannot add a brand-new kind; the prompt tells it so.' }),
      h('details', {}, h('summary', { style: 'cursor:pointer;color:var(--text-2);font-size:12px;margin-bottom:8px', text: 'Show the prompt' }), out),
      pasteBox),
    footer: [h('button', { class: 'btn', onclick: closeModal }, 'Close'),
      h('button', { class: 'btn primary', onclick: () => copyPlainText(out.value, 'Prompt copied. Paste it into your AI assistant.', 'Could not copy. Open "Show the prompt", select all of it and copy.') }, icon('copy'), 'Copy prompt')]
  });
  mountIcons(modal.box);
  ask.focus();
}
