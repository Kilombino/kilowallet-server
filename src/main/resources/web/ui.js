// The app's building blocks (Components.kt and Material 3), as DOM helpers. Every text goes through
// tr() as the app's Text does; R(x) keeps a value as it is (addresses, txids, seed words).
// No inline handlers anywhere: the page's CSP forbids them.
'use strict';

const COLORS = { btc: '#F7931A', cj: '#278BF5', ark: '#E5484D', good: '#34D399', warn: '#FFC53D', bad: '#FF5D5D',
  main: '#D0DCEC', soft: '#9CB0C8', faint: '#5C7090', ink: '#000000' };

class Raw { constructor(s) { this.s = String(s); } }
/** A value shown as it is, never translated. */
const R = s => new Raw(s);

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k === 'value') e.value = v;
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sv == null) continue; if (sk.startsWith('--')) e.style.setProperty(sk, sv); else e.style[sk] = sv; } }
    else if (k === 'checked' || k === 'disabled') e[k] = !!v;
    else if (k === 'placeholder' || k === 'title' || k === 'aria-label') e.setAttribute(k, v instanceof Raw ? v.s : tr(v));
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    if (c instanceof Node) e.append(c);
    else if (c instanceof Raw) e.append(document.createTextNode(c.s));
    else e.append(document.createTextNode(tr(String(c))));
  }
  return e;
}

/** Text in one of the app's styles: t('…', 'bs c-faint'). */
const t = (text, cls, attrs) => h('div', Object.assign({ class: cls || '' }, attrs || {}), text);
const spacer = n => h('div', { class: 'sp', style: { height: n + 'px' } });
const hspace = n => h('div', { class: 'sp', style: { width: n + 'px' } });
const row = (cls, ...kids) => h('div', { class: 'row ' + (cls || '') }, kids);
const col = (cls, ...kids) => h('div', { class: 'col ' + (cls || '') }, kids);
const weight = (...kids) => h('div', { class: 'grow col' }, kids);

/** A bordered panel, the app's one container shape, in [accent]'s colour. */
function panel(accent, ...kids) { return h('div', { class: 'panel', style: { '--a': accent } }, kids); }
function label(text, color) { return h('div', { class: 'label', style: color ? { color } : null }, text); }
/** An explanatory aside: small and faint. */
const explain = (text, cls) => t(text, 'bs c-faint pre ' + (cls || ''));

function dot(color, pulse, size) {
  return h('div', { class: 'dot' + (pulse ? ' pulse' : ''), style: { background: color, width: (size || 8) + 'px', height: (size || 8) + 'px' } });
}
/** Something being prepared: the breathing dot, what is being done and what it waits for now. */
function workingLine(accent, title, step, detail) {
  return row('gap10', dot(accent, true), col('', t(title, 'bm', { style: { color: accent } }), detail ? t(detail, 'bs c-soft') : null, step ? t(step, 'bs c-faint') : null));
}

/**
 * A Material 3 button. kind: 'fill' (accent, ink text), 'soft' (PanelSoft, accent text), 'text'.
 * cls: its text style ('tm' for titleMedium, as most of the app's buttons; Roboto by default).
 */
function btn(text, o) {
  o = o || {};
  const kind = o.kind || 'fill';
  const b = h('button', { class: (kind === 'text' ? 'tbtn' : 'btn' + (kind === 'soft' ? ' soft' : '')) + (o.full ? ' fill' : '') + (o.grow ? ' grow' : '') + (o.cls ? ' ' + o.cls : ''),
    disabled: !!o.disabled, onclick: o.onclick, style: Object.assign({}, o.color ? { '--a': o.color } : {}, o.style || {}) }, text);
  return b;
}
const tbtn = (text, color, onclick, cls, o) => btn(text, Object.assign({ kind: 'text', color, onclick, cls }, o || {}));

/**
 * An outlined text field with its label in the border. o: { label, value, oninput(v, el), type, mode, area,
 * error, size: 'bs'|'bm'|'bl', disabled, raw (no translation of the label), cls, attrs }
 */
function field(o) {
  const tag = o.area ? 'textarea' : 'input';
  const el = h(tag, Object.assign({ placeholder: R(' '), value: o.value == null ? '' : o.value, type: o.area ? null : (o.type || 'text'),
    inputmode: o.mode || null, disabled: !!o.disabled, autocomplete: o.autocomplete || 'off', spellcheck: 'false', autocapitalize: 'off',
    rows: o.area ? (o.rows || 2) : null }, o.attrs || {}));
  if (o.oninput) el.addEventListener('input', () => o.oninput(el.value, el));
  if (o.onenter) el.addEventListener('keydown', e => { if (e.key === 'Enter') o.onenter(el.value, el); });
  const lab = h('label', {}, o.raw ? R(o.label || '') : (o.label || ''));
  const w = h('div', { class: 'field ' + (o.size || 'bs') + (o.big ? ' lbig' : '') + (o.error ? ' err' : '') + (o.cls ? ' ' + o.cls : ''), style: o.style || null }, el, lab);
  w.input = el;
  return w;
}

function sw(on, onchange, disabled) {
  const b = h('button', { class: 'switch' + (on ? ' on' : ''), disabled: !!disabled, role: 'switch', 'aria-checked': on ? 'true' : 'false' });
  b.addEventListener('click', () => { const v = !b.classList.contains('on'); b.classList.toggle('on', v); onchange(v); });
  return b;
}

function chip(text, on, onclick, raw) { return h('span', { class: 'chip' + (on ? ' on' : ''), onclick }, raw ? R(text) : text); }

/** A setting: its name and what it does on the left, its control on the right. */
function settingRow(title, sub, control) {
  return row('', weight(t(title, 'bm c-main'), sub ? explain(sub) : null), control);
}

/** "● Native SegWit…" / "○ …" radio lines (TextButton rows, as the app's selectors). */
function radioLine(on, text, accent, onclick, disabled) {
  const c = on ? accent : disabled ? COLORS.faint : COLORS.main;
  return h('button', { class: 'tbtn fill', disabled: !!disabled, onclick, style: { color: c, justifyContent: 'flex-start' } },
    h('span', { class: 'bs', style: { fontSize: '9px', width: '10px', textAlign: 'center' } }, R(on ? '●' : '○')), hspace(6), h('span', { class: 'bs grow', style: { textAlign: 'start' } }, text));
}
function checkLine(on, text, color, onclick, cls) {
  return row('tap ' + (cls || ''), h('span', { class: 'tm', style: { color: color || COLORS.bad, width: '26px', flex: 'none' } }, R(on ? '☑' : '☐')),
    h('span', { class: 'bs c-main grow' }, text)).also(onclick);
}
HTMLElement.prototype.also = function (onclick) { if (onclick) this.addEventListener('click', onclick); return this; };

// ------------------------------------------------------------------ dialogs

let dialogsOpen = 0;
/**
 * An AlertDialog: title, body (nodes), and buttons at the end. Returns the scrim; .close() removes it.
 * o: { title, body: [...], buttons: [nodes], dismiss: true (tap outside closes), cls }
 */
function dialog(o) {
  const close = () => { if (bg.isConnected) { bg.remove(); dialogsOpen--; if (o.onclose) o.onclose(); } };
  const bg = h('div', { class: 'scrim' },
    h('div', { class: 'dialog ' + (o.cls || '') },
      o.title ? h('div', { class: 'dtitle' }, o.title) : null,
      o.sub ? h('div', { class: 'dsub' }, o.sub) : null,
      h('div', { class: 'dbody' }, o.body || []),
      (o.buttons || []).length ? h('div', { class: 'dbtns' }, o.buttons) : null));
  if (o.dismiss !== false) bg.addEventListener('click', e => { if (e.target === bg) close(); });
  bg.close = close;
  document.body.append(bg); dialogsOpen++;
  return bg;
}

/**
 * The app's unlock prompt (fingerprint or screen lock), here the wallet's password: [title] and
 * [subtitle] as the app's Biometric prompt says them. Resolves with the password; rejects on cancel.
 */
function askPassword(title, subtitle, o) {
  o = o || {};
  return new Promise((resolve, reject) => {
    const err = t('', 'bs c-bad hidden');
    const f = field({ label: o.label || 'password', type: 'password', size: 'bl', autocomplete: o.autocomplete || 'current-password', cls: 'ondlg', style: { '--a': '#D0BCFF' } });
    const f2 = o.repeat ? field({ label: 'repeat password', type: 'password', size: 'bl', autocomplete: 'new-password', cls: 'ondlg', style: { '--a': '#D0BCFF' } }) : null;
    let done = false;
    const ok = () => {
      const v = f.input.value;
      if (o.repeat && v.length < 8) { err.textContent = tr('At least 8 characters.'); err.classList.remove('hidden'); return; }
      if (o.repeat && v !== f2.input.value) { err.textContent = tr('The two passwords do not match.'); err.classList.remove('hidden'); return; }
      if (!v) return;
      done = true; d.close(); resolve(v);
    };
    f.input.addEventListener('keydown', e => { if (e.key === 'Enter') (f2 ? f2.input.focus() : ok()); });
    if (f2) f2.input.addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
    const d = dialog({ cls: 'prompt', title, sub: subtitle, body: [o.note ? t(o.note, 'bs pre', { style: { color: '#CAC4D0' } }) : null, f, f2, err],
      buttons: [tbtn('Cancel', '#D0BCFF', () => d.close()), tbtn('OK', '#D0BCFF', ok)],
      onclose: () => { if (!done) reject(new Error('cancelled')); } });
    setTimeout(() => f.input.focus(), 30);
  });
}

function toast(m) {
  const el = document.getElementById('toast');
  el.textContent = tr(m); el.classList.remove('hidden');
  clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), 3500);
}

// ------------------------------------------------------------------ numbers

/** 12 345 678, with narrow no-break spaces (groupSats). */
const groupSats = n => (n < 0 ? '-' : '') + Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const shortAddress = a => (!a ? '' : a.length <= 20 ? a : a.slice(0, 10) + '…' + a.slice(-8));
/** "%.8f ₿" in the page's language. */
function btcAmount(sats) { const s = (sats / 1e8).toFixed(8); return (decimalComma() ? s.replace('.', ',') : s) + ' ₿'; }
const fmtRate = r => r >= 10 ? r.toFixed(0) : r.toFixed(1);

function qrImg(text, size) {
  const q = qrcode(0, 'L'); q.addData(text); q.make();
  return h('img', { src: q.createDataURL(8, 32), alt: 'QR', width: size, height: size });
}

async function copyText(s) {
  try { await navigator.clipboard.writeText(s); return true; }
  catch {
    // Without https (a LAN address) the clipboard API is missing: the old way.
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }); ta.value = s; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch {} ta.remove();
    if (!ok) toast('Could not copy: select it by hand.');
    return ok;
  }
}
/** A button that says COPIED ✓ for two seconds after copying. */
function copyButton(text, getValue, accent, o) {
  const b = tbtn(text, accent, async () => {
    if (await copyText(getValue())) { b.textContent = tr('COPIED ✓'); b.style.color = COLORS.good; setTimeout(() => { b.textContent = tr(text); b.style.color = accent; }, 2000); }
  }, (o && o.cls) || null);
  return b;
}
