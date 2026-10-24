// Kilowallet on a home node: the app's screens, as a web page for the phone.
// No inline scripts (the page's CSP forbids them): every handler is attached here.
'use strict';

const $app = document.getElementById('app');
const S = { // app state
  me: null, w: null, tab: 'btc', sheet: null, draft: null, sent: null, psbt: null,
  street: true, fiat: localStorage.getItem('kw.fiat') || 'USD', showSettings: false, error: null,
};

// ------------------------------------------------------------------ helpers

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'class') e.className = v;
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}
const sats = n => (n < 0 ? '-' : '') + Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const street = s => (S.street ? 'STREET MODE' : s);
const short = a => a.length > 22 ? a.slice(0, 10) + '…' + a.slice(-8) : a;
function toast(m) { const t = document.getElementById('toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), 4000); }

async function api(path, body) {
  const r = await fetch('/api/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: 'bad answer from the server' }));
  if (r.status === 401) { S.me.unlocked = false; render(); throw new Error('locked'); }
  if (r.status === 503 && j.chain) { S.me.chain = j.chain; render(); throw new Error(j.chain.title); }
  if (j.error) throw new Error(j.error);
  return j;
}
function qr(text) {
  const q = qrcode(0, 'L'); q.addData(text); q.make();
  return h('div', { class: 'qr' }, h('img', { src: q.createDataURL(8, 0), alt: 'QR' }));
}
async function copy(t) { try { await navigator.clipboard.writeText(t); toast('Copied.'); } catch { toast('Could not copy: select it by hand.'); } }
// The currencies the app offers: code, symbol before the number (or the code after it), decimals.
const FIATS = [['USD', '$', 2], ['EUR', '€', 2], ['GBP', '£', 2], ['JPY', '¥', 0], ['CHF', null, 2], ['CNY', 'CN¥', 2], ['RON', null, 2],
  ['PLN', null, 2], ['CZK', null, 2], ['HUF', null, 0], ['SEK', null, 2], ['NOK', null, 2], ['DKK', null, 2], ['ISK', null, 0], ['TRY', '₺', 2],
  ['CAD', 'CA$', 2], ['AUD', 'A$', 2], ['NZD', 'NZ$', 2], ['BRL', 'R$', 2], ['MXN', 'MX$', 2], ['ARS', null, 2], ['CLP', null, 0], ['COP', null, 0],
  ['PEN', null, 2], ['UYU', null, 2], ['VES', null, 2], ['INR', '₹', 2], ['KRW', '₩', 0], ['HKD', 'HK$', 2], ['SGD', 'S$', 2], ['ZAR', null, 2],
  ['ILS', '₪', 2], ['THB', null, 2], ['IDR', null, 0], ['PHP', '₱', 2], ['MYR', null, 2]];
function fiatInfo(code) { const f = FIATS.find(x => x[0] === code) || [code, null, 2]; return { code: f[0], sym: f[1], dec: f[2] }; }
/** One XBT in [code] (rates from mempool.kilombino.com), or null without a price. */
function perCoin(code) {
  const p = S.w && S.w.price; if (!p || !p.usd) return null;
  if (code === 'USD') return p.usd;
  if (code === 'EUR' && p.eur) return p.eur;
  const r = p.perUsd && p.perUsd[code]; return r ? p.usd * r : null;
}
function fmtFiat(v, code) {
  const f = fiatInfo(code);
  const n = v.toLocaleString('en-US', { minimumFractionDigits: f.dec, maximumFractionDigits: f.dec });
  return f.sym ? f.sym + n : n + ' ' + f.code;
}
function fiat(n) { const px = perCoin(S.fiat); return px == null ? '≈ –' : '≈ ' + fmtFiat(n * px / 1e8, S.fiat); }
function setFiat(f) { S.fiat = f; localStorage.setItem('kw.fiat', f); render(); }
/** USD and EUR at hand, every other currency with a rate behind ▾: one choice for the whole page. */
function fiatPicker() {
  const p = S.w && S.w.price;
  const avail = FIATS.filter(f => f[0] === 'USD' || f[0] === 'EUR' || (p && p.perUsd && p.perUsd[f[0]]));
  const other = S.fiat !== 'USD' && S.fiat !== 'EUR';
  return h('span', {}, ['USD', 'EUR'].map(f => h('button', { class: 'link' + (S.fiat === f ? '' : ' faint'), onclick: () => setFiat(f) }, f)),
    h('select', { class: 'fiatsel' + (other ? ' on' : ''), onchange: e => { if (e.target.value) setFiat(e.target.value); } },
      h('option', { value: '' }, other ? S.fiat + ' ▾' : '▾'), avail.map(f => h('option', { value: f[0] }, f[0] + (f[1] ? '  ' + f[1] : '')))));
}
/** A typed amount: "12.5", "12,5", "1,234.56" or "1.234,56". Null if it is not a number. */
function parseFiat(text) {
  const t = String(text).trim().replace(/\s/g, ''); if (!t) return null;
  const dot = t.lastIndexOf('.'), comma = t.lastIndexOf(',');
  let n = t;
  if (dot >= 0 && comma >= 0) n = dot > comma ? t.replace(/,/g, '') : t.replace(/\./g, '').replace(',', '.');
  else if (comma >= 0) n = (t.split(',').length === 2) ? t.replace(',', '.') : t.replace(/,/g, '');
  else if (t.split('.').length > 2) n = t.replace(/\./g, '');
  const v = Number(n); return isFinite(v) && v >= 0 ? v : null;
}
/**
 * A box in the chosen currency bound to a sats box: typing in either fills the other.
 * [onSats] gets the sats worked out from the currency.
 */
function fiatBox(satsInput, onSats) {
  const px = perCoin(S.fiat), dec = fiatInfo(S.fiat).dec;
  const box = h('input', { placeholder: '≈ ' + S.fiat + (px == null ? ' (no price yet)' : ''), inputmode: 'decimal', disabled: px == null });
  const fromSats = () => { const v = Number(satsInput.value || 0); box.value = v > 0 && px ? (v * px / 1e8).toFixed(dec) : ''; };
  satsInput.addEventListener('input', fromSats); fromSats();
  box.addEventListener('input', () => {
    const v = parseFiat(box.value); const s = v == null || !px ? '' : String(Math.round(v / px * 1e8));
    satsInput.value = s; onSats(s);
  });
  return box;
}

/** A pasted extended public key's prefix and depth (no checksum check: only to know what to ask). */
function xpubInfo(text) {
  const t = String(text || '').replace(/\s/g, '');
  if (!/^[xyzt]pub[1-9A-HJ-NP-Za-km-z]{100,}$/.test(t)) return null;
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n; for (const c of t) n = n * 58n + BigInt(A.indexOf(c));
  const hex = n.toString(16).padStart(164, '0'); // 78 bytes + 4 of checksum
  return { prefix: t.slice(0, 4), depth: parseInt(hex.slice(8, 10), 16) };
}
/**
 * Under a pasted key (as the app since 1.2.4): a plain xpub doesn't say which addresses it makes,
 * so its type is asked; a key that is not an account key (depth 3) is pointed out.
 * [types]: the choices offered; [state.type] holds the pick.
 */
function xpubTypeChoice(state, types) {
  const box = h('div', {});
  const draw = () => {
    const k = xpubInfo(state.text);
    const kids = [];
    if (k && k.depth !== 3) kids.push(h('p', { class: 'badc small' }, `This key is at depth ${k.depth}, not an account key (m/84'/0'/0', m/86'/0'/0'…): its addresses won't match your wallet's. Export the account xpub instead.`));
    if (k && (k.prefix === 'xpub' || k.prefix === 'tpub')) {
      kids.push(h('p', { class: 'soft small' }, "A plain xpub doesn't say which addresses it makes: pick the type your wallet uses."));
      types.forEach(([v, name]) => kids.push(h('label', { class: 'check small' },
        h('input', { type: 'radio', name: 'xpubtype' + (state.id || ''), checked: state.type === v, onchange: () => { state.type = v; } }), h('span', {}, name))));
    } else state.type = '';
    box.replaceChildren(...kids);
  };
  draw();
  box.redraw = draw;
  return box;
}
const XPUB_TYPES = [['p2wpkh', 'Native SegWit · bc1q… (BIP84)'], ['p2tr', 'Taproot · bc1p… (BIP86)'], ['p2sh-p2wpkh', 'Nested SegWit · 3… (BIP49)'], ['p2pkh', 'Legacy · 1… (BIP44)']];

// ------------------------------------------------------------------ boot

async function boot() {
  S.me = await api('state');
  if (S.me.unlocked) await loadWallet();
  render();
  // While the node is not known to be on the BLAKE2b chain, keep asking: the page opens by itself once it is.
  setInterval(async () => {
    if (!S.me || !S.me.chain || S.me.chain.ok) return;
    const me = await api('state').catch(() => null); if (!me) return;
    S.me = me; if (me.chain.ok && me.unlocked) await loadWallet().catch(() => {});
    render();
  }, 20000);
  setInterval(async () => { if (S.me && S.me.unlocked && !busy() && document.visibilityState === 'visible') { await loadWallet().catch(() => {}); if (!busy()) render(); } }, 30000);
  startCoinjoinTimers();
  // Leaving the page puts street mode back on (as the app does).
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && S.w) { S.street = S.w.settings.streetDefault; render(); } });
}
async function loadWallet() {
  S.w = await api('wallet');
  if (!C.st) loadCoinjoin().catch(() => {});
  if (S.street === true && S.w.settings && !S.w.settings.streetDefault && !loadWallet.done) S.street = false;
  loadWallet.done = true;
}

function render() {
  $app.replaceChildren();
  if (!S.me) return;
  if (S.me.chain && !S.me.chain.ok) return $app.append(chainView());
  if (!S.me.mode) return $app.append(setupView());
  if (!S.me.unlocked) return $app.append(unlockView());
  $app.append(mainView());
}

// ------------------------------------------------------------------ the node's chain

// The node follows another chain (or is not past the BLAKE2b fork yet): nothing else opens.
function chainView() {
  const c = S.me.chain;
  const wait = c.state === 'syncing' || c.state === 'unreachable';
  const again = () => api('state').then(async me => { S.me = me; if (me.chain.ok && me.unlocked) await loadWallet().catch(() => {}); render(); }).catch(e => toast(e.message));
  return h('div', {},
    h('div', { class: 'center' }, h('img', { src: 'icon-192.png', width: 96, height: 96, alt: '' })),
    h('h1', { class: 'center' }, 'Kilowallet'),
    h('p', { class: 'center soft small' }, 'BITCOIN BLAKE2b (XBT) WALLET · ON YOUR OWN NODE'),
    h('div', { class: 'panel ' + (wait ? 'warn' : 'bad') },
      h('div', { class: 'label' }, 'Node'),
      h('p', { class: wait ? 'warnc' : 'badc' }, c.title),
      h('p', { class: 'small soft' }, c.message),
      h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: again }, 'CHECK AGAIN'))));
}

// ------------------------------------------------------------------ setup / unlock

function setupView() {
  const pw = h('input', { type: 'password', placeholder: 'password (8+ characters)', autocomplete: 'new-password' });
  const words = h('textarea', { placeholder: '12 or 24 recovery words' });
  const pass = h('input', { type: 'text', placeholder: 'BIP-39 passphrase (optional, usually empty)' });
  const ks = { text: '', type: '', id: 'setup' };
  const kType = xpubTypeChoice(ks, XPUB_TYPES);
  const key = h('textarea', { placeholder: 'xpub / ypub / zpub', oninput: e => { ks.text = e.target.value; kType.redraw(); } });
  const since = h('input', { type: 'date' });
  const run = (path, body) => api(path, body).then(async r => {
    S.me = await api('state'); await loadWallet().catch(() => {});
    if (r.words) S.newWords = r.words;
    render();
  }).catch(e => toast(e.message));
  const ts = () => since.value ? Math.floor(new Date(since.value).getTime() / 1000) : 0;
  return h('div', {},
    h('div', { class: 'center' }, h('img', { src: 'icon-192.png', width: 96, height: 96, alt: '' })),
    h('h1', { class: 'center' }, 'Kilowallet'),
    h('p', { class: 'center soft small' }, 'BITCOIN BLAKE2b (XBT) WALLET · ON YOUR OWN NODE'),
    h('div', { class: 'panel' },
      h('div', { class: 'label' }, 'Password for this wallet'),
      h('p', { class: 'small soft' }, 'It encrypts the words on this server and is asked again before every send. There is no way to recover it: keep it with your backup.'),
      pw),
    h('div', { class: 'panel' },
      h('div', { class: 'label' }, 'Hot wallet'),
      h('p', { class: 'small soft' }, 'A wallet you can send from. The words are made on this server and kept encrypted; the node only ever sees the public key.'),
      h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => run('setup/new', { password: pw.value }) }, 'NEW WALLET')),
      h('p', { class: 'small faint' }, 'Or restore one:'), words, pass,
      h('p', { class: 'small faint' }, 'Created on (optional). Without it the node looks back from the oldest coin the wallet still holds. A pruned node can only look back as far as it keeps:'), since,
      h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: () => run('setup/restore', { password: pw.value, words: words.value, passphrase: pass.value, since: ts() }) }, 'RESTORE'))),
    h('div', { class: 'panel' },
      h('div', { class: 'label' }, 'Watch-only wallet'),
      h('p', { class: 'small soft' }, 'An extended PUBLIC key: balance, fresh addresses, movements. It holds no keys: to send, it hands a PSBT to a separate signer.'),
      key, kType,
      h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: () => {
        const k = xpubInfo(key.value);
        if (k && (k.prefix === 'xpub' || k.prefix === 'tpub') && !ks.type) return toast("Pick the address type of this xpub first.");
        run('setup/watch', { password: pw.value, key: key.value, type: ks.type, since: ts() });
      } }, 'WATCH IT'))));
}

function unlockView() {
  const pw = h('input', { type: 'password', placeholder: 'password', autocomplete: 'current-password' });
  const go = () => api('unlock', { password: pw.value }).then(async () => { S.me = await api('state'); await loadWallet().catch(e => toast(e.message)); render(); }).catch(e => toast(e.message));
  pw.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  setTimeout(() => pw.focus(), 0);
  return h('div', {},
    h('div', { class: 'center' }, h('img', { src: 'icon-192.png', width: 96, height: 96, alt: '' })),
    h('h1', { class: 'center' }, 'Kilowallet'),
    h('div', { class: 'panel' }, h('div', { class: 'label' }, 'Unlock'), pw, h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: go }, 'UNLOCK'))));
}

// ------------------------------------------------------------------ main

function mainView() {
  const w = S.w || {};
  const hot = S.me.mode === 'hot';
  const top = h('div', { class: 'between' },
    h('span', { class: 'pill' }, hot ? 'HOT WALLET' : 'WATCH-ONLY'),
    h('div', {},
      h('button', { class: 'link', onclick: () => toggleSettings() }, S.showSettings ? '✕ close' : '⚙ settings'),
      h('button', { class: 'link faint', onclick: () => api('lock', {}).then(() => { S.me.unlocked = false; S.w = null; render(); }) }, 'lock')));
  if (S.newWords) return h('div', {}, top, newWordsPanel());
  // Settings open in place of the screen, from the top (as the app since 1.2.5): ✕ or back closes them.
  if (S.showSettings && S.w && !S.w.error) return h('div', {}, top, settingsPanel());
  const tabs = h('div', { class: 'tabs mt' }, [['btc', 'BTC'], ['ark', 'ARK'], ['coinjoin', 'COINJOIN']].map(([k, label]) =>
    h('button', { class: S.tab === k ? 'on' : '', onclick: () => openTab(k) }, label)));
  if (S.tab === 'coinjoin' && !w.error && !w.importing) return h('div', {}, top, tabs, coinjoinView());
  if (S.tab === 'ark') return h('div', {}, top, tabs, arkView());
  if (w.error) return h('div', {}, top, h('div', { class: 'panel bad' }, h('div', { class: 'label' }, 'Node'), h('p', {}, w.error)));
  if (w.importing) return h('div', {}, top, h('div', { class: 'panel' }, h('div', { class: 'label' }, 'Reading your history'),
    h('p', { class: 'soft' }, 'The node is looking through the chain for this wallet\'s coins and movements. It can take from a minute to a while; this page updates by itself.')));
  const total = (w.confirmed || 0) + (w.pending || 0);
  const parts = [top, tabs,
    h('div', { class: 'panel' },
      h('div', { class: 'between' }, h('div', { class: 'label' }, 'BTC balance'),
        h('button', { class: 'link', onclick: () => { S.street = !S.street; render(); } }, S.street ? '👁 show' : '🙈 hide')),
      h('div', { class: 'big' }, street(sats(total))), h('div', { class: 'faint' }, S.street ? 'STREET MODE' : 'sats'),
      h('div', { class: 'between' }, h('span', { class: 'mid' }, street(fiat(total))),
        fiatPicker()),
      w.pending ? h('div', { class: 'warnc small' }, 'unconfirmed: ' + street(sats(w.pending) + ' sats')) : null,
      h('div', { class: 'faint small' }, `height ${w.height || '–'} · node wallet ${w.node || ''}`)),
    h('div', { class: 'btns' },
      h('button', { class: 'soft', onclick: () => { S.sheet = 'receive'; render(); } }, 'RECEIVE'),
      h('button', { class: 'primary', onclick: () => { S.sheet = 'send'; S.draft = null; S.sent = null; S.psbt = null; render(); } }, 'SEND'))];
  if (S.sheet === 'receive') parts.push(receivePanel());
  if (S.sheet === 'send') parts.push(sendPanel());
  parts.push(movementsPanel(), coinsPanel());
  return h('div', {}, parts);
}

function newWordsPanel() {
  const ws = S.newWords.split(' ');
  return h('div', { class: 'panel bad' },
    h('div', { class: 'label' }, `Write these ${ws.length} words down`),
    h('p', { class: 'small soft' }, 'This is the ONLY backup of your money. Anyone who sees them can take your coins; if you lose them, no one can recover them. On paper, never a photo or the cloud.'),
    h('div', { class: 'words' }, ws.map((x, i) => h('div', {}, `${i + 1}. ${x}`))),
    h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => { S.newWords = null; render(); } }, "I'VE WRITTEN THEM DOWN")));
}

function receivePanel() {
  // A hot wallet has a Taproot account too: receive on either.
  const tr = S.recvTr && S.w.receiveTr;
  const r = tr ? S.w.receiveTr : S.w.receive;
  const pickType = S.w.taproot ? h('div', { class: 'tabs' },
    h('button', { class: tr ? 'soft' : 'primary', onclick: () => { S.recvTr = false; render(); } }, 'bc1q · SegWit'),
    h('button', { class: tr ? 'primary' : 'soft', onclick: () => { S.recvTr = true; render(); } }, 'bc1p · Taproot')) : null;
  // An optional amount to ask for: the QR and COPY then carry a BIP-21 request.
  const request = () => { const a = Number(S.recvAmt || 0); return a > 0 ? 'bitcoin:' + r.address + '?amount=' + (a / 1e8).toFixed(8).replace(/\.?0+$/, '') : r.address; };
  const qrBox = h('div', {}, qr(request().startsWith('bitcoin:') ? request() : 'bitcoin:' + r.address));
  const redraw = () => { const q = request(); qrBox.replaceChildren(qr(q.startsWith('bitcoin:') ? q : 'bitcoin:' + q)); };
  const ask = h('input', { placeholder: 'amount to ask (sats, optional)', inputmode: 'numeric', value: S.recvAmt || '',
    oninput: e => { e.target.value = e.target.value.replace(/\D/g, ''); S.recvAmt = e.target.value; redraw(); } });
  return h('div', { class: 'panel' },
    h('div', { class: 'between' }, h('div', { class: 'label' }, 'Receive'), h('button', { class: 'link faint', onclick: () => { S.sheet = null; render(); } }, 'close')),
    pickType,
    qrBox, h('div', { class: 'mono center' }, r.address),
    h('div', { class: 'faint small center' }, `unused · m/${tr ? 86 : 84}'/…/0/${r.index}`),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, ask), h('div', { class: 'grow' }, fiatBox(ask, v => { S.recvAmt = v; redraw(); }))),
    h('div', { class: 'btns' },
      h('button', { class: 'soft', onclick: () => copy(request()) }, 'COPY'),
      h('button', { class: 'soft', onclick: () => api('receive/next', { type: tr ? 'p2tr' : 'p2wpkh' }).then(n => { if (tr) S.w.receiveTr = n; else S.w.receive = n; render(); }).catch(e => toast(e.message)) }, 'NEXT ADDRESS')));
}
const typeTag = c => (S.w && S.w.taproot) ? (c.type === 'p2tr' ? ' · bc1p' : ' · bc1q') : '';

// ------------------------------------------------------------------ send

function sendPanel() {
  const close = h('button', { class: 'link faint', onclick: () => { S.sheet = null; S.draft = null; S.psbt = null; S.sent = null; render(); } }, 'close');
  const head = h('div', { class: 'between' }, h('div', { class: 'label' }, 'Send'), close);
  if (S.sent) return h('div', { class: 'panel' }, head, sentView());
  if (S.draft) return h('div', { class: 'panel' }, head, reviewView(S.draft));
  return h('div', { class: 'panel' }, head, sendForm());
}

function sendForm() {
  const f = S.form || (S.form = { to: '', amount: '', rate: '', max: false, coins: new Set() });
  const to = h('input', { placeholder: 'recipient address', value: f.to, oninput: e => f.to = e.target.value.trim() });
  const amount = h('input', { placeholder: 'amount (sats)', inputmode: 'numeric', value: f.max ? '' : f.amount, disabled: f.max, oninput: e => f.amount = e.target.value.replace(/\D/g, '') });
  const rate = h('input', { placeholder: 'sat/vB', inputmode: 'decimal', value: f.rate, oninput: e => f.rate = e.target.value.replace(',', '.') });
  if (!f.rate) api('fee').then(r => { if (!f.rate) { f.rate = String(Math.max(1, Math.round((r.suggested || 2) * 10) / 10)); rate.value = f.rate; } }).catch(() => {});
  const contacts = (S.w.contacts || []);
  const pick = contacts.length ? h('select', { onchange: e => { if (e.target.value) { f.to = e.target.value; to.value = f.to; } } },
    h('option', { value: '' }, 'CONTACTS…'), contacts.map(c => h('option', { value: c.address }, `${c.name} · ${short(c.address)}`))) : null;
  const scan = ('BarcodeDetector' in window) ? h('button', { class: 'link', onclick: () => scanQr(v => { f.to = v.replace(/^bitcoin:/i, '').split('?')[0]; to.value = f.to; }) }, '📷 SCAN') : null;
  const coinBox = h('div', {}, (S.w.coins || []).map(c => h('label', { class: 'check small' + (c.inRound ? ' faint' : '') },
    h('input', { type: 'checkbox', disabled: c.inRound, checked: f.coins.has(c.outpoint) && !c.inRound, onchange: e => { e.target.checked ? f.coins.add(c.outpoint) : f.coins.delete(c.outpoint); } }),
    h('span', { class: 'grow' }, `${street(sats(c.value) + ' sats')}${typeTag(c)} · ${c.confirmations} conf${c.change ? ' · change' : ''} · ${short(c.address)}`,
      c.mixed ? h('span', { class: 'good' }, ' · mixed') : null, c.inRound ? h('span', { class: 'warnc' }, ' · in a coinjoin round') : null))));
  const coinNote = (S.w.coins || []).some(c => c.mixed) ? h('p', { class: 'faint small' }, 'Never spend a mixed coin together with other coins: that links them again.') : null;
  const cc = h('details', { open: f.coins.size > 0 }, h('summary', { class: 'soft small' }, 'Coin control'), coinNote, coinBox);
  return h('div', {},
    h('div', { class: 'row' }, h('div', { class: 'grow' }, to), scan),
    h('div', { class: 'row' },
      h('button', { class: 'link', onclick: async () => { try { f.to = (await navigator.clipboard.readText()).trim().replace(/^bitcoin:/i, '').split('?')[0]; to.value = f.to; } catch { toast('Paste it into the box.'); } } }, 'PASTE'),
      pick),
    h('div', { class: 'row small faint' }, h('div', { class: 'grow' }, 'amount (sats)'), h('div', { class: 'w110' }, 'fee sat/vB')),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, amount), h('div', { class: 'w110' }, rate)),
    f.max ? null : h('div', { class: 'row' }, h('div', { class: 'grow' }, fiatBox(amount, v => f.amount = v)), h('div', { class: 'w110' })),
    h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: f.max, onchange: e => { f.max = e.target.checked; render(); } }), 'MAX: send everything (minus the fee)'),
    cc,
    h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => api('send/prepare', {
      to: f.to, amount: Number(f.amount || 0), max: f.max, rate: Number(f.rate || 2), coins: [...f.coins] })
      .then(d => { S.draft = d; render(); }).catch(e => toast(e.message)) }, 'REVIEW')));
}

function reviewView(d) {
  const hot = S.me.mode === 'hot';
  const feeOk = h('input', { type: 'checkbox' });
  const mixOk = h('input', { type: 'checkbox' });
  feeOk.mixOk = mixOk;
  const pw = h('input', { type: 'password', placeholder: 'password, to sign', autocomplete: 'current-password' });
  const rows = [
    d.cpfpParent ? h('p', { class: 'small soft' }, 'Pulls the stuck payment along: a payment to yourself that spends what it brought you, with a fee big enough for both.') : null,
    d.cancels ? h('p', { class: 'small warnc' }, 'Cancels the payment: the same coins go back to a fresh address of this wallet, paying a little more fee, so the recipients get nothing. If the payment confirms first, the cancellation is refused: the earlier, the better.')
      : d.replaces ? h('p', { class: 'small soft' }, 'Replaces the stuck send with the same payment and a higher fee, taken from your change.') : null,
    h('div', { class: 'between' }, h('span', { class: 'soft' }, d.cpfpParent || d.cancels ? 'Back to you' : 'To'), h('span', { class: 'mono' }, short(d.to))),
    h('div', { class: 'between' }, h('span', { class: 'soft' }, 'Amount'), h('span', {}, sats(d.amount) + ' sats')),
    h('div', { class: 'between' }, h('span', { class: 'soft' }, 'Fee'), h('span', {}, (d.replaces ? sats(d.replacedFee) + ' → ' : '') + sats(d.fee) + ' sats · ' +
      (d.cpfpParent ? d.packageRate.toFixed(1) + ' sat/vB both together' : d.rate.toFixed(1) + ' sat/vB'))),
    h('div', { class: 'between' }, h('span', { class: 'soft' }, 'Change'), h('span', {}, d.change && !d.cpfpParent ? sats(d.change) + ' sats' : '—')),
    d.changeAddress && d.change && !d.cpfpParent ? h('div', { class: 'faint small right' }, 'back to your address ' + short(d.changeAddress)) : null,
    h('div', { class: 'between' }, h('span', { class: 'soft' }, 'Inputs'), h('span', {}, d.inputs)),
    h('p', { class: 'faint small' }, 'Signed with the unified sighash: valid only on BTC, it can\'t be replayed on the spamchain.'),
    d.concern ? h('div', {}, h('p', { class: 'badc small' }, '⚠ ' + d.concern + ' Check it before signing: a fee can\'t be taken back.'),
      h('label', { class: 'check small' }, feeOk, 'Yes, I want to pay this fee')) : null,
    d.mixWarning ? h('div', {}, h('p', { class: 'warnc small' }, '⚠ ' + d.mixWarning),
      h('label', { class: 'check small' }, mixOk, 'I understand, send it anyway')) : null];
  if (hot) return h('div', {}, rows, pw,
    h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => {
      if (d.concern && !feeOk.checked) return toast('Tick the box to confirm the fee.');
      if (d.mixWarning && !mixOk.checked) return toast('Tick the box under the coinjoin warning.');
      api('send/confirm', { draft: d.draft, password: pw.value, acceptFee: feeOk.checked, acceptMix: mixOk.checked }).then(r => { S.sent = r.txid; S.draft = null; S.form = null; loadWallet().then(render); render(); }).catch(e => toast(e.message));
    } }, 'CONFIRM & SIGN')),
    h('button', { class: 'link faint', onclick: () => { S.draft = null; render(); } }, 'edit'));
  return h('div', {}, rows, psbtView(d, feeOk));
}

function psbtView(d, feeOk) {
  if (!S.psbt) {
    const origin = h('input', { placeholder: "key origin (optional), e.g. [d34db33f/84'/0'/0']", value: (S.w.settings || {}).keyOrigin || '' });
    return h('div', {}, origin, h('p', { class: 'faint small' }, 'Some signers need it to find their key; Bitcoin Knots does not.'),
      h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => {
        if (d.concern && !feeOk.checked) return toast('Tick the box to confirm the fee.');
        if (d.mixWarning && !feeOk.mixOk.checked) return toast('Tick the box under the coinjoin warning.');
        api('psbt/export', { draft: d.draft, origin: origin.value, acceptFee: feeOk.checked, acceptMix: feeOk.mixOk.checked }).then(r => { S.psbt = r.psbt; render(); }).catch(e => toast(e.message));
      } }, 'EXPORT PSBT')));
  }
  const back = h('textarea', { placeholder: 'paste the signed PSBT (base64 or hex)' });
  const file = h('input', { type: 'file', onchange: async e => {
    const b = new Uint8Array(await e.target.files[0].arrayBuffer());
    const isBin = b[0] === 0x70 && b[1] === 0x73 && b[2] === 0x62 && b[3] === 0x74 && b[4] === 0xff;
    back.value = isBin ? btoa(String.fromCharCode(...b)) : new TextDecoder().decode(b).trim();
  } });
  const dl = () => { const a = h('a', { href: 'data:application/octet-stream;base64,' + S.psbt, download: `kilowallet-${d.amount}.psbt` }); document.body.append(a); a.click(); a.remove(); };
  return h('div', {},
    h('div', { class: 'label' }, '1. Sign it elsewhere'),
    h('p', { class: 'small soft' }, 'Take this PSBT to your signer, for example Bitcoin Knots (walletprocesspsbt). It must sign with the BLAKE2b unified sighash (0x21): an old-style signature would also be valid on the spamchain, so it is refused.'),
    S.psbt.length <= 2500 ? qr(S.psbt) : h('p', { class: 'faint small' }, 'Too big for one QR: copy it or save it as a file.'),
    h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: () => copy(S.psbt) }, 'COPY'), h('button', { class: 'soft', onclick: dl }, 'SAVE FILE')),
    h('div', { class: 'label mt' }, '2. Bring the signed PSBT back'),
    h('p', { class: 'small soft' }, 'Only this same transaction is accepted, and every signature is checked here before anything is sent.'),
    back, file,
    h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => api('psbt/import', { draft: d.draft, psbt: back.value })
      .then(r => { S.sent = r.txid; S.draft = null; S.psbt = null; S.form = null; loadWallet().then(render); render(); }).catch(e => toast(e.message)) }, 'SEND')));
}

function sentView() {
  const name = h('input', { placeholder: 'name, to save the recipient as a contact' });
  const f = S.lastTo;
  return h('div', {},
    h('div', { class: 'good mid' }, 'Broadcast ✓'), h('p', { class: 'mono soft small' }, S.sent),
    h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: () => copy(S.sent) }, 'COPY TXID'),
      h('button', { class: 'soft', onclick: () => window.open(S.w.settings.explorer + '/tx/' + S.sent, '_blank', 'noopener') }, 'EXPLORER')),
    h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => { S.sheet = null; S.sent = null; render(); } }, 'DONE')));
}

// ------------------------------------------------------------------ lists

function movementsPanel() {
  const txs = (S.w && S.w.transactions) || [];
  // Folded by default (the list only grows, and Coins sits under it); open or closed as left last time.
  let open = false; try { open = localStorage.getItem('kw.movOpen') === '1'; } catch {}
  const pending = txs.filter(t => !t.confirmations).length;
  const d = h('details', { class: 'panel', open },
    h('summary', { class: 'label' }, `Movements · confirmations (${txs.length})`, pending ? h('span', { class: 'warnc' }, ` · ${pending} in mempool`) : null),
    txs.length ? txs.map(t => h('div', { class: 'tx', onclick: () => txDetail(t) },
      h('div', { class: 'between' }, h('span', { class: t.net > 0 ? 'in' : 'out' }, street((t.net > 0 ? '+' : '') + sats(t.net) + ' sats')),
        h('span', { class: t.confirmations ? 'faint small' : 'warnc small' }, t.confirmations ? `${t.confirmations} conf${t.confirmations >= 6 ? '  ✓' : ''}` : 'in mempool · 0 conf')),
      h('div', { class: 'faint small' }, street(`(left: ${sats(t.left)} sats)`)),
      h('div', { class: 'faint small' }, t.txid.slice(0, 8) + '…' + t.txid.slice(-6)))) : h('p', { class: 'faint small' }, 'Nothing yet.'));
  d.addEventListener('toggle', () => { try { localStorage.setItem('kw.movOpen', d.open ? '1' : '0'); } catch {} });
  return d;
}

function coinsPanel() {
  const cs = (S.w && S.w.coins) || [];
  if (!cs.length) return null;
  return h('details', { class: 'panel' }, h('summary', { class: 'label' }, `Coins (${cs.length})`),
    cs.map(c => h('div', { class: 'tx' }, h('div', { class: 'between' }, h('span', {}, street(sats(c.value) + ' sats') + typeTag(c)), h('span', { class: 'faint small' }, `${c.confirmations} conf`)),
      h('div', { class: 'faint small mono' }, c.address + (c.change ? ' · change' : ''),
        c.mixed ? h('span', { class: 'good' }, ' · mixed') : null, c.inRound ? h('span', { class: 'warnc' }, ' · in a coinjoin round') : null))));
}

function modal(...kids) {
  const bg = h('div', { class: 'modal-bg', onclick: e => { if (e.target === bg) bg.remove(); } }, h('div', { class: 'modal' }, ...kids));
  document.body.append(bg); return bg;
}

function txDetail(t) {
  const hot = S.me.mode === 'hot';
  const rate = h('input', { placeholder: 'sat/vB', inputmode: 'decimal', value: '3' });
  let m;
  const speed = (cpfp, cancel) => (toast('Preparing…'), api)(cancel ? 'cancel' : cpfp ? 'cpfp' : 'bump', { txid: t.txid, rate: Number(rate.value.replace(',', '.')) })
    .then(d => { m.remove(); S.sheet = 'send'; S.sent = null; S.psbt = null; S.draft = d; render(); window.scrollTo(0, 0); }).catch(e => toast(e.message));
  m = modal(h('div', { class: 'label' }, 'Transaction'),
    h('p', { class: t.confirmations ? 'soft' : 'warnc' }, t.confirmations ? `${t.confirmations} confirmation${t.confirmations === 1 ? '' : 's'}` : 'in mempool · 0 confirmations'),
    h('p', { class: 'mono small' }, t.txid),
    h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: () => copy(t.txid) }, '📋 COPY TXID'),
      h('button', { class: 'soft', onclick: () => window.open(S.w.settings.explorer + '/tx/' + t.txid, '_blank', 'noopener') }, '🔎 EXPLORER')),
    !t.confirmations ? h('div', {}, h('p', { class: 'small soft' }, t.net > 0
      ? 'Stuck? Pull it along (CPFP): choose the fee rate for it and the speed-up together.'
      : 'Stuck? Replace it (RBF) with the same payment at a higher fee rate.'), rate,
      h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => speed(t.net > 0) }, t.net > 0 ? '⚡ SPEED UP (CPFP)' : '⚡ SPEED UP (RBF)'),
        t.net < 0 ? h('button', { class: 'soft', onclick: () => speed(false, true) }, '✕ CANCEL') : null),
      t.net < 0 ? h('p', { class: 'faint small' }, 'Sent by mistake? ✕ CANCEL sends the same coins back to a fresh address of this wallet, at least 1 sat/vB more than it paid, so the recipients get nothing.') : null) : null,
    h('div', { class: 'btns' }, h('button', { class: 'link faint', onclick: () => m.remove() }, 'close')));
}

// ------------------------------------------------------------------ settings

/** Opening the settings is a step back can undo: the browser's back closes them. */
function toggleSettings(open = !S.showSettings) {
  if (open === S.showSettings) return;
  S.showSettings = open;
  if (open) { try { history.pushState({ kwSettings: true }, ''); } catch {} window.scrollTo(0, 0); }
  else if (history.state && history.state.kwSettings) { try { history.back(); } catch {} }
  render();
}
window.addEventListener('popstate', () => { if (S.showSettings) { S.showSettings = false; render(); } });

function settingsPanel() {
  const st = S.w.settings || {};
  const set = (k, v) => api('settings', { [k]: v }).then(s => { S.w.settings = s; render(); }).catch(e => toast(e.message));
  const explorer = h('input', { value: st.explorer || '' });
  const pwBox = () => h('input', { type: 'password', placeholder: 'password' });
  const pw1 = pwBox(), pwNew = h('input', { type: 'password', placeholder: 'new password (8+)' }), pw2 = pwBox(), pw3 = pwBox();
  const hot = S.me.mode === 'hot';
  return h('div', { class: 'panel' }, h('div', { class: 'between' }, h('div', { class: 'label' }, 'Settings'),
      h('button', { class: 'link faint', onclick: () => toggleSettings(false) }, '✕')),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.streetDefault !== false, onchange: e => set('streetDefault', e.target.checked) }),
      h('span', {}, 'Street mode', h('br'), h('span', { class: 'faint small' }, 'On: amounts hidden every time the page opens, until you tap the eye.'))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.prices !== false, onchange: e => set('prices', e.target.checked) }),
      h('span', {}, 'Prices in your currency', h('br'), h('span', { class: 'faint small' }, 'From mempool.kilombino.com (it sees this server asking, nothing about your wallet).'))),
    h('div', { class: 'soft small' }, 'Block explorer (where a movement opens)'), explorer,
    h('button', { class: 'link', onclick: () => set('explorer', explorer.value) }, 'SAVE EXPLORER'),
    h('details', {}, h('summary', { class: 'soft small' }, 'Account key (xpub/zpub)'),
      h('p', { class: 'faint small' }, 'Anyone with it sees every address and payment of this wallet, but cannot spend.'),
      h('p', { class: 'mono small' }, S.w.accountKey), qr(S.w.accountKey)),
    h('details', {}, h('summary', { class: 'soft small' }, 'Change password'), pw1, pwNew,
      h('button', { class: 'link', onclick: () => api('password', { password: pw1.value, newPassword: pwNew.value }).then(() => toast('Password changed.')).catch(e => toast(e.message)) }, 'CHANGE')),
    h('details', {}, h('summary', { class: 'soft small' }, 'Look for older history (rescan)'),
      h('p', { class: 'faint small' }, 'Makes the node read the chain again from a block height for this wallet. Slow (hours from far back); a pruned node can only go back as far as it keeps.'),
      (() => { const hgt = h('input', { inputmode: 'numeric', placeholder: 'from block height, e.g. 961640' });
        return h('div', {}, hgt, h('button', { class: 'link', onclick: () => api('rescan', { from: Number(hgt.value || 0) }).then(() => toast('Rescan started on the node.')).catch(e => toast(e.message)) }, 'RESCAN')); })()),
    hot ? h('details', {}, h('summary', { class: 'badc small' }, 'Recovery words'), pw2,
      h('button', { class: 'link', onclick: () => api('secret/words', { password: pw2.value }).then(r => { S.newWords = r.words; render(); }).catch(e => toast(e.message)) }, 'SHOW')) : null,
    h('details', {}, h('summary', { class: 'faint small' }, 'Forget this wallet'),
      h('p', { class: 'faint small' }, 'Removes it from this server. The coins stay on-chain: make sure you have the words (or the key) first.'), pw3,
      h('button', { class: 'link', onclick: () => api('forget', { password: pw3.value }).then(async () => { S.me = await api('state'); S.w = null; render(); }).catch(e => toast(e.message)) }, 'FORGET')),
    h('p', { class: 'faint small' }, `Kilowallet server ${S.me.version} · updates come from the StartOS store`));
}

// ------------------------------------------------------------------ camera

async function scanQr(done) {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); } catch { return toast('No camera (it needs https).'); }
  const v = h('video', { autoplay: true, playsinline: true, class: 'cam' }); v.srcObject = stream;
  const det = new BarcodeDetector({ formats: ['qr_code'] });
  const stop = () => { stream.getTracks().forEach(t => t.stop()); m.remove(); };
  const m = modal(v, h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: stop }, 'CANCEL')));
  const tick = async () => { if (!m.isConnected) return; try { const r = await det.detect(v); if (r.length) { stop(); return done(r[0].rawValue); } } catch {} requestAnimationFrame(tick); };
  tick();
}

// ------------------------------------------------------------------ coinjoin
// The app's COINJOIN tab: your pools and what they need from you, the open pools on the relay,
// and a form to open one. Joining and signing ask for the password (the app's fingerprint).

const C = { st: null, pools: null, loading: false, msg: null, create: null, join: null, pick: null, chosen: [] };
// The pool's address type is this wallet's (C.st.script): P2WPKH input 68 vB / output 31; Taproot 57.75 / 43.
const inVb = t => (t === 'p2tr' ? 57.75 : 68), outVb = t => (t === 'p2tr' ? 43 : 31);
// The pool being opened or joined decides the type (a hot wallet has bc1q and bc1p accounts).
const cjType = () => (C.pick && C.pick.script) || (C.create && C.create.script) || (C.st && C.st.script) || 'p2wpkh';
const kindName = t => (t === 'p2tr' ? 'Taproot (bc1p)' : 'native SegWit (bc1q)');
// o: mixed outputs each person gets (Kilojoin v4: 2 to 5; 1 before).
const feeShare = (rate, withChange, n = 1, t = cjType(), o = 1) => Math.ceil(rate * (inVb(t) * n + outVb(t) * o + (withChange ? outVb(t) : 0) + 10.5 / 2));
const minCoin = (amount, rate, o = 1) => amount * o + feeShare(rate, false, 1, cjType(), o);
function cjChange(v, amount, rate, n = 1, o = 1) {
  const w = v - amount * o - feeShare(rate, true, n, cjType(), o);
  if (w > ((C.st && C.st.limits.dust) || 294)) return w;
  return v - amount * o - feeShare(rate, false, n, cjType(), o) >= 0 ? 0 : null;
}
// "4 × 100 000" for a pool of several outputs each (v4), the plain amount otherwise.
const amountOf = (amount, o) => (o > 1 ? o + ' × ' : '') + sats(amount);
function left(at) {
  const s = Math.floor(at - Date.now() / 1000);
  if (s <= 0) return 'now';
  return s < 3600 ? Math.floor(s / 60) + ' min' : Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min';
}
const hhmm = at => new Date(at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtRate = r => r >= 10 ? r.toFixed(0) : (Math.round(r * 10) / 10).toString();
const cjOpen = () => C.st && C.st.enabled && !C.st.blocker;

/** Something is being typed or chosen: a refresh would wipe it, so it waits. */
function busy() {
  const a = document.activeElement;
  if (a && a !== document.body && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName)) return true;
  return !!(S.sheet || C.create || C.join || K.sheet || document.querySelector('.modal-bg'));
}

async function loadCoinjoin() { C.st = await api('coinjoin'); }

async function reloadPools() {
  if (C.loading || !cjOpen()) return;
  C.loading = true; if (!busy()) render();
  try { C.pools = await api('coinjoin/pools'); }
  // A failed look keeps the list it had: an empty screen would read as "no pools".
  catch (e) { if (e.message !== 'locked') C.msg = e.message; }
  C.loading = false;
  if (!busy()) render();
}

async function openTab(k) {
  S.tab = k; render();
  if (k === 'ark') { await loadArk().catch(e => toast(e.message)); render(); }
  if (k === 'coinjoin') {
    await loadCoinjoin().catch(e => toast(e.message));
    render();
    reloadPools();
  }
}

function startCoinjoinTimers() {
  // Rounds move on their own: the tab follows them every few seconds, the open pools every minute.
  setInterval(async () => {
    if (!S.me || !S.me.unlocked || S.tab !== 'coinjoin' || document.visibilityState !== 'visible') return;
    try { await loadCoinjoin(); if (!busy()) render(); } catch {}
  }, 5000);
  setInterval(() => { if (S.me && S.me.unlocked && S.tab === 'coinjoin' && document.visibilityState === 'visible') reloadPools(); }, 60000);
  setInterval(pollEvents, 5000);
}

function coinjoinView() {
  const st = C.st;
  if (!st) return h('div', { class: 'panel' }, h('p', { class: 'faint small' }, 'Loading…'));
  if (!st.enabled) return coinjoinIntro();
  const intro = h('div', { class: 'panel' }, h('div', { class: 'label' }, 'Coinjoin'),
    h('p', { class: 'small soft' }, 'Mix your coins with other people\'s: everyone puts one or more coins in and gets back an output of exactly the pool\'s amount, all identical, so nobody watching the chain can tell whose is whose. Each person pays their own share of the fee from their change. No server ever holds your coins: the relay only passes encrypted messages, and you sign only after checking your output.'));
  const parts = [];
  if (st.blocker) { parts.push(intro, h('div', { class: 'panel warn' }, h('p', { class: 'small' }, st.blocker))); return h('div', {}, parts); }
  if (C.msg) parts.push(h('div', { class: 'panel warn' }, h('p', { class: 'warnc small' }, C.msg),
    h('button', { class: 'link faint', onclick: () => { C.msg = null; render(); } }, 'ok')));
  const mine = st.mine || [];
  if (C.pick) { parts.push(coinPicker()); return h('div', {}, parts); }
  if (C.create) { parts.push(createForm()); return h('div', {}, parts); }
  // JOIN · IN PROGRESS · HISTORY, as in the app: rounds going are shown first when there are any.
  const over = p => ['CONFIRMED', 'ABORTED', 'REJECTED'].includes(p.phase);
  const active = mine.filter(p => !over(p)), finished = mine.filter(over);
  const waiting = st.waitingExact || [];
  if (C.cjTab == null) C.cjTab = active.length || waiting.length ? 1 : 0;
  parts.push(h('div', { class: 'tabs cjtabs mt' }, ['JOIN', 'IN PROGRESS', 'HISTORY'].map((l, i) =>
    h('button', { class: C.cjTab === i ? 'on' : '', onclick: () => { C.cjTab = i; render(); } }, l,
      i === 1 && active.length ? h('span', { class: 'count' }, String(active.length)) : null))));
  if (C.cjTab === 1) {
    if (!active.length && !waiting.length) parts.push(h('p', { class: 'faint small mt' }, 'No rounds going. Join a pool, or open your own, in JOIN.'));
    parts.push(active.map(roundCard));
    waiting.forEach(x => parts.push(h('div', { class: 'panel' }, h('div', { class: 'label' }, 'Waiting for the perfect coin'),
      h('p', { class: 'small soft' }, `${sats(x.value)} sats to yourself: at its first confirmation it ${x.create ? 'opens your pool' : 'joins the pool'} by itself.`))));
    return h('div', {}, parts);
  }
  if (C.cjTab === 2) {
    if (!finished.length) parts.push(h('p', { class: 'faint small mt' }, 'Confirmed and cancelled rounds show here, for a week.'));
    else parts.push(finished.map(roundCard), h('button', { class: 'link faint', onclick: async () => { for (const p of finished) await api('coinjoin/remove', { pool: p.id }).catch(() => {}); await loadCoinjoin(); render(); } }, 'remove all'));
    return h('div', {}, parts);
  }
  parts.push(h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => {
    C.create = { amount: '100000', rate: '1', min: '2', max: '5', hours: '6', inputs: '5', outputs: '1', password: '', script: C.st.segwit === false ? 'p2tr' : 'p2wpkh' }; render();
  } }, '＋  OPEN A POOL')));
  parts.push(openPools(mine), intro, autoSignPanel(), destinationsPanel(), notificationsPanel(), howPanel());
  return h('div', {}, parts);
}

function coinjoinIntro() {
  const min = sats(((C.st && C.st.limits) || {}).minAmount || 10000);
  return h('div', { class: 'panel' }, h('div', { class: 'label' }, 'Coinjoin · mix your coins'),
    h('div', { class: 'mid' }, 'Are you interested in coinjoins?'),
    h('p', { class: 'small soft' }, 'A coinjoin puts your coin in one transaction with other people\'s. Everyone gets back an output of exactly the same amount, so nobody watching the chain can tell whose is whose.'),
    h('p', { class: 'small soft' }, `• Someone opens a pool (from ${min} sats to 1 BTC) and others join with one coin.`, h('br'),
      '• With enough people in, anyone asks to close and the rest accept.', h('br'),
      '• This server checks the transaction and you sign with your password. Nobody holds your coins: the relay only passes encrypted messages.', h('br'),
      '• Each person pays their own share of the fee.', h('br'),
      '• Signed so it is valid only on BTC, never on the spamchain.'),
    h('p', { class: 'small faint' }, 'If you turn it on, this tab opens up and this server starts talking to the relay (relay.kilombino.com) to list the pools. You can turn it off again here.'),
    h('p', { class: 'small faint' }, 'With notifications, new public pools are told about (StartOS notifications, and Telegram or this browser if you set them up); your own rounds always are. Without, the tab opens all the same and you can turn them on later in 🔔 Notifications.'),
    h('div', { class: 'btns' },
      h('button', { class: 'soft', onclick: () => { S.tab = 'btc'; render(); } }, 'NOT NOW'),
      h('button', { class: 'primary', onclick: () => api('coinjoin/enable', { on: true, notify: true }).then(r => { C.st = r; render(); reloadPools(); }).catch(e => toast(e.message)) }, 'YES, NOTIFY ME')),
    h('div', { class: 'btns' },
      h('button', { class: 'soft', onclick: () => api('coinjoin/enable', { on: true, notify: false }).then(r => { C.st = r; render(); reloadPools(); }).catch(e => toast(e.message)) }, 'OPEN WITHOUT NOTIFICATIONS')));
}

function phaseText(p) {
  switch (p.phase) {
    case 'JOINING': return 'Asking to join…';
    case 'OPEN': return `Waiting for people · ${p.people}/${p.maxPeers} · closes in ${left(p.expiresAt)}`;
    case 'VOTING': return `Close now with ${p.people} people?`;
    case 'CLOSING': return `Closing with ${p.people} people · collecting outputs`;
    case 'SIGNING': return `Ready: sign within ${left(p.phaseDeadline)}`;
    case 'BROADCAST': return 'Sent · waiting for the first confirmation';
    case 'CONFIRMED': return 'Confirmed ✅';
    case 'ABORTED': return 'Cancelled: ' + p.reason + '. Your coin did not move.';
    case 'REJECTED': return 'Refused: ' + p.reason;
  }
  return p.phase;
}

async function cjAct(path, body) {
  try { await api(path, body); await loadCoinjoin(); } catch (e) { if (e.message !== 'locked') C.msg = e.message; }
  render();
}

function confirmLeave(p) {
  let m;
  m = modal(h('div', { class: 'label' }, p.creator ? 'End this pool?' : 'Leave this pool?'),
    h('p', { class: 'small soft' }, p.creator
      ? 'The round is cancelled for everyone in it, and they are told so. Nobody loses anything: no transaction exists until all have signed, so every coin stays where it is.'
      : 'Your seat is freed and your coin is yours to spend again. Nothing was signed, so nothing moves.'),
    h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: () => m.remove() }, 'STAY'),
      h('button', { class: 'primary', onclick: () => { m.remove(); cjAct('coinjoin/leave', { pool: p.id }); } }, p.creator ? 'END POOL' : 'LEAVE')));
}

function myPool(p, embedded) {
  const cls = p.phase === 'CONFIRMED' ? 'good' : ['ABORTED', 'REJECTED'].includes(p.phase) ? 'badc' : ['VOTING', 'SIGNING'].includes(p.phase) ? 'warnc' : 'soft';
  const leaveBtn = h('button', { class: 'soft', onclick: () => confirmLeave(p) }, p.creator ? 'END POOL' : 'LEAVE');
  const acts = [];
  if (p.phase === 'JOINING') acts.push(h('p', { class: 'faint small' }, `Waiting for the pool's creator to let you in. If nobody answers in ${C.st.limits.joinMinutes} minutes the request is dropped.`),
    h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: () => cjAct('coinjoin/leave', { pool: p.id }) }, 'CANCEL')));
  if (p.phase === 'OPEN') {
    acts.push(h('div', { class: 'btns' }, p.people >= p.minPeers ? h('button', { class: 'primary', onclick: () => cjAct('coinjoin/close', { pool: p.id }) }, 'ASK TO CLOSE NOW') : null, leaveBtn));
    if (p.people < p.minPeers) acts.push(h('p', { class: 'faint small' }, `Closes once ${p.minPeers} people are in.`));
  }
  if (p.phase === 'VOTING') {
    if (p.iAsked || p.voted) acts.push(h('p', { class: 'soft small' }, `Waiting for the others to answer, until ${hhmm(p.voteDeadline)}. Whoever has not answered by then is left out; if too few are left, the pool reopens without them.`),
      h('div', { class: 'btns' }, leaveBtn));
    else acts.push(h('p', { class: 'soft small' }, `Answer before ${hhmm(p.voteDeadline)}.`),
      h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => cjAct('coinjoin/vote', { pool: p.id, accept: true }) }, 'ACCEPT'),
        h('button', { class: 'soft', onclick: () => cjAct('coinjoin/vote', { pool: p.id, accept: false }) }, 'NOT YET')));
  }
  if (p.phase === 'SIGNING') {
    if (p.signed) acts.push(h('p', { class: 'soft small' }, `Signed. Waiting for the others (${p.sigs}/${p.planCoins || '?'} coins)…`));
    else {
      const pw = h('input', { type: 'password', placeholder: 'password, to sign', autocomplete: 'current-password' });
      if (p.planPeople) acts.push(h('p', { class: 'small soft' }, `Checked: ${p.planPeople} people (${p.planCoins} coins), ${p.planIdentical} identical outputs of ${sats(p.amount)} sats, ${p.outputs > 1 ? p.outputs + ' of them' : 'one of them'} yours; ` +
        (p.change > 0 ? 'your change is right' : 'no change (an exact coin)') + `; total fee ${sats(p.planFee)} sats.`));
      acts.push(pw, h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => cjAct('coinjoin/sign', { pool: p.id, password: pw.value }) }, 'SIGN')));
    }
  }
  if (p.txid) acts.push(h('p', { class: 'mono soft small' }, p.txid),
    h('div', { class: 'row' }, h('button', { class: 'link', onclick: () => window.open(S.w.settings.explorer + '/tx/' + p.txid, '_blank', 'noopener') }, 'open in explorer'),
      p.phase === 'CONFIRMED' ? h('button', { class: 'link faint', onclick: () => cjAct('coinjoin/remove', { pool: p.id }) }, 'remove') : null));
  if (['ABORTED', 'REJECTED'].includes(p.phase)) acts.push(h('button', { class: 'link faint', onclick: () => cjAct('coinjoin/remove', { pool: p.id }) }, 'remove'));
  const coinLine = h('p', { class: 'faint small' }, `${p.coins > 1 ? 'your ' + p.coins + ' coins' : 'your coin'} ${sats(p.coinValue)} → ${amountOf(p.amount, p.outputs)} mixed${p.change > 0 ? ' + ' + sats(p.change) + ' change' : ''} · fee ${sats(p.coinValue - p.amount * (p.outputs || 1) - p.change)}`);
  // Only on this server: where the mixed outputs go when it is not this wallet.
  const destLine = p.dest ? h('div', {}, h('p', { class: 'small accent' }, 'mixed outputs go to: ' + p.dest),
    ['JOINING', 'ABORTED', 'REJECTED'].includes(p.phase) ? null : h('button', { class: 'link', onclick: () => showAddresses('This round\'s addresses',
      api('coinjoin/round/addresses', { pool: p.id }), 'The addresses of that wallet this round\'s mixed outputs go to, with their paths.') }, 'show the addresses')) : null;
  if (embedded) return h('div', { class: 'mt' }, coinLine, destLine, acts);
  return h('div', { class: 'panel' + (['VOTING', 'SIGNING'].includes(p.phase) ? ' warn' : ['ABORTED', 'REJECTED'].includes(p.phase) ? ' bad' : '') },
    h('div', { class: 'between' }, h('span', { class: 'mid' }, amountOf(p.amount, p.outputs) + ' sats' + (p.script === 'p2tr' ? ' · Taproot' : '')), h('span', { class: 'faint small' }, (p.private ? '🔒 ' : '') + (p.creator ? 'your pool' : 'joined'))),
    h('p', { class: cls + ' small' }, phaseText(p)),
    h('p', { class: 'faint small' }, `${p.coins > 1 ? 'your ' + p.coins + ' coins' : 'your coin'} ${sats(p.coinValue)} → ${amountOf(p.amount, p.outputs)} mixed${p.change > 0 ? ' + ' + sats(p.change) + ' change' : ''} · fee ${sats(p.coinValue - p.amount * (p.outputs || 1) - p.change)}`),
    destLine, acts);
}

function openPools(mine) {
  // Only rounds still running hide their pool: one that ended or was left shows again to rejoin.
  const ours = new Set(mine.filter(m => !['ABORTED', 'REJECTED', 'CONFIRMED', 'BROADCAST'].includes(m.phase)).map(m => m.id));
  const shown = (C.pools || []).filter(t => !ours.has(t.id));
  return h('div', {},
    h('div', { class: 'between mt' }, h('div', { class: 'label' }, 'Open pools'),
      h('button', { class: 'link faint', onclick: () => reloadPools() }, C.loading ? 'looking…' : 'refresh')),
    C.pools === null ? h('p', { class: 'faint small' }, C.loading ? 'Asking the relay…' : 'Not looked up yet.') :
      shown.length ? shown.map(t => h('div', { class: 'panel' }, h('div', { class: 'row' },
        h('div', { class: 'grow' },
          h('div', { class: 'mid' }, (t.private ? '🔒 ' : '') + amountOf(t.amount, t.outputs) + ' sats'),
          h('div', { class: t.script === 'p2tr' ? 'good small' : 'soft small' }, `${kindName(t.script)} coins only · ${t.maxInputs > 1 ? 'up to ' + t.maxInputs + ' coins each' : 'one coin each'}${t.outputs > 1 ? ' · ' + t.outputs + ' outputs each (v4)' : t.version >= 3 ? ' · blind outputs (v3)' : ''}`),
          h('div', { class: 'soft small' }, `${t.peers}/${t.maxPeers} people (min ${t.minPeers}) · ${t.feeRate} sat/vB · closes in ${left(t.expiresAt)}`),
          h('div', { class: 'faint small' }, `joining costs you ${sats(t.feeWithChange)} sats in fees with one coin (${sats(t.feeNoChange)} with a coin of exactly ${sats(t.amount * (t.outputs || 1) + t.feeNoChange)})`),
          t.joinable ? null : h('div', { class: 'warnc small' }, `This wallet's coins are ${kindName(cjType())}: it can't join this pool.`)),
        h('button', { class: 'soft', disabled: !t.joinable, onclick: () => { C.join = { pool: t, password: '' }; C.pick = { title: 'Join · ' + amountOf(t.amount, t.outputs) + ' sats', amount: t.amount, rate: t.feeRate, maxInputs: t.maxInputs, script: t.script, outputs: t.outputs || 1 }; C.chosen = []; render(); } }, 'JOIN'))))
        : h('p', { class: 'faint small' }, 'No open pools right now. Open one and others will be notified.'));
}

function createError(f) {
  const L = C.st.limits;
  const amount = Number(f.amount.replace(/\D/g, '')), rate = Number(f.rate.replace(',', '.')), max = Number(f.max), min = Number(f.min), hours = Number(f.hours);
  if (!f.amount || !Number.isInteger(amount) || amount < L.minAmount || amount > L.maxAmount) return `Amount: ${sats(L.minAmount)} to ${sats(L.maxAmount)} sats (1 BTC).`;
  if (!f.rate || !isFinite(rate) || rate < 1 || rate > 500) return 'Fee: 1 to 500 sat/vB.';
  if (!Number.isInteger(max) || max < L.minPeers || max > L.maxPeers) return `Most people: ${L.minPeers} to ${L.maxPeers}.`;
  if (!Number.isInteger(min) || min < L.minPeers || min > max) return `Fewest people: ${L.minPeers} to ${max} (the most).`;
  if (!Number.isInteger(hours) || hours < 1 || hours > 72) return 'Open for 1 to 72 hours.';
  const ins = Number(f.inputs);
  if (!Number.isInteger(ins) || ins < 1 || ins > 10) return 'Coins per person: 1 to 10.';
  const outs = Number(f.outputs);
  if (!Number.isInteger(outs) || outs < 1 || outs > 5) return 'Mixed outputs per person: 1 to 5.';
  return null;
}

function createForm() {
  const f = C.create, L = C.st.limits;
  const errBox = h('p', { class: 'warnc small' });
  const btc = h('div', { class: 'faint small' });
  const costs = h('p', { class: 'faint small' });
  const pwNote = h('p', { class: 'faint small' });
  const next = h('button', { class: 'primary' }, 'CHOOSE COINS');
  const amountLabel = h('div', { class: 'soft small mt' }), outNote = h('p', { class: 'faint small' });
  const update = () => {
    const e = createError(f);
    errBox.textContent = e || ''; next.disabled = !!e;
    const amount = Number(f.amount.replace(/\D/g, '')), rate = Number(f.rate.replace(',', '.'));
    const o = Math.min(5, Math.max(1, Number(f.outputs) || 1));
    amountLabel.textContent = o > 1 ? 'amount of each output (sats)' : 'amount per person (sats)';
    outNote.textContent = o > 1 ? `Each person gets ${o} mixed outputs of the amount below, each to an unused address of their own. Only Kilowallet 1.2.0 or newer (Kilojoin v4) sees this pool.`
      : 'One mixed output each: every Kilojoin v3 wallet can join it.';
    btc.textContent = amount ? '= ' + (amount / 1e8).toFixed(8) + ' BTC' + (o > 1 ? ` · ${sats(amount * o)} sats per person in all` : '') : '';
    costs.textContent = amount && rate >= 1 && rate <= 500 ? `A ${kindName(cjType())} pool (this wallet's type): only such coins can join, and every output is of that type. ` +
      'Blind outputs (Kilojoin v3): when the round closes, nobody, not even you as its creator, can tell whose mixed output is whose. ' +
      `Each person pays their own fee, the same however many join: with one coin ${feeShare(rate, true, 1, cjType(), o)} sats with change, ${feeShare(rate, false, 1, cjType(), o)} without; each extra coin adds ${Math.ceil(rate * inVb(cjType()))}. ` +
      `A coin of exactly ${sats(amount * o + feeShare(rate, false, 1, cjType(), o))} sats leaves no change (the best for privacy); a bit more than that, up to ${sats(amount * o + feeShare(rate, true, 1, cjType(), o) + L.dust)}, also goes in without change and the rest goes to the miners.` : '';
    pwNote.textContent = f.password ? 'Only people you give this password to can join. It is not announced anywhere.' : '';
  };
  const field = (label, k, mode) => [h('div', { class: 'soft small mt' }, label),
    h('input', { value: f[k], inputmode: mode, oninput: e => { f[k] = e.target.value; update(); } })];
  next.addEventListener('click', () => {
    if (createError(f)) return;
    C.pick = { title: 'Your coins for the pool', amount: Number(f.amount.replace(/\D/g, '')), rate: Number(f.rate.replace(',', '.')), maxInputs: Number(f.inputs), script: f.script,
      outputs: Number(f.outputs) || 1 }; C.chosen = []; render();
  });
  update();
  return h('div', { class: 'panel' }, h('div', { class: 'label' }, 'Open a pool'),
    (C.st.taproot && C.st.segwit) ? h('div', {}, h('div', { class: 'soft small mt' }, "address type: every coin, mixed output and change of the pool is of it"),
      h('select', { onchange: e => { f.script = e.target.value; update(); } },
        h('option', { value: 'p2wpkh', selected: f.script !== 'p2tr' }, 'Native SegWit (bc1q)'),
        h('option', { value: 'p2tr', selected: f.script === 'p2tr' }, 'Taproot (bc1p)'))) : null,
    field('mixed outputs per person (1–5)', 'outputs', 'numeric'), outNote,
    amountLabel, h('input', { value: f.amount, inputmode: 'numeric', oninput: e => { f.amount = e.target.value; update(); } }), btc,
    field('fee rate (sat/vB)', 'rate', 'decimal'),
    field(`fewest people to close (${L.minPeers}–${L.maxPeers - 1})`, 'min', 'numeric'),
    field(`most people (${L.minPeers}–${L.maxPeers})`, 'max', 'numeric'),
    field('open for (hours)', 'hours', 'numeric'),
    field('most coins per person (1–10)', 'inputs', 'numeric'),
    h('div', { class: 'soft small mt' }, 'password (optional: makes it private 🔒)'),
    h('input', { value: f.password, autocomplete: 'off', oninput: e => { f.password = e.target.value; update(); } }), pwNote,
    costs, errBox,
    h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: () => { C.create = null; render(); } }, 'CANCEL'), next));
}

function cancelPick() {
  if (C.create) C.pick = null; else { C.pick = null; C.join = null; }
  C.chosen = []; render();
}

function coinPicker() {
  const k = C.pick, maxIn = k.maxInputs || 1, o = k.outputs || 1, exact = minCoin(k.amount, k.rate, o);
  const coins = (C.st.coins || []).filter(c => !c.inRound && c.confirmations > 0 && (c.type || 'p2wpkh') === cjType());
  const ok = coins.filter(c => maxIn > 1 || c.value >= exact).sort((a, b) => (a.value === exact ? 0 : 1) - (b.value === exact ? 0 : 1) || b.value - a.value);
  const short = maxIn > 1 ? [] : coins.filter(c => c.value >= k.amount * o && c.value < exact).sort((a, b) => b.value - a.value);
  const pw = h('input', { type: 'password', placeholder: 'password, to put your coins in', autocomplete: 'current-password' });
  const poolPw = C.join && C.join.pool.private ? h('input', { placeholder: 'pool password', autocomplete: 'off', value: C.join.password, oninput: e => { C.join.password = e.target.value; } }) : null;
  const total = coins.filter(c => C.chosen.includes(c.outpoint)).reduce((a, c) => a + c.value, 0);
  const ch = C.chosen.length ? cjChange(total, k.amount, k.rate, C.chosen.length, o) : null;
  const use = h('button', { class: 'primary', disabled: ch === null }, C.create ? 'OPEN POOL' : 'JOIN');
  // Where the mixed outputs go: this wallet by default; another one only when set up and of the pool's type.
  const dests = (C.st.destinations || []).filter(d => d.type === cjType() && !d.scanning);
  if (!dests.some(d => d.id === C.dest)) C.dest = '';
  const destPick = dests.length ? h('div', {}, h('div', { class: 'soft small mt' }, 'Mixed outputs go to'),
    [{ id: '', label: 'This wallet (default)' }].concat(dests).map(d => h('label', { class: 'check small' },
      h('input', { type: 'radio', name: 'cjdest', checked: C.dest === d.id, onchange: () => { C.dest = d.id; render(); } }), h('span', {}, d.which || d.label))),
    C.dest ? h('p', { class: 'faint small' }, "Unused receive addresses of that wallet; the change, if any, comes back here. Nobody in the round can tell: an output is just an address of the pool's type.") : null,
    C.dest ? h('button', { class: 'link', onclick: () => showAddresses('Where the mixed outputs go', api('coinjoin/dest/preview', { dest: C.dest, script: cjType(), outputs: o }),
      'The unused receive addresses of that wallet the mixed outputs would go to now, one per output. Compare them with that wallet (Sparrow, Shrike: Addresses › Receive) before joining.') }, 'SHOW THE ADDRESSES') : null) : null;
  const submit = async () => {
    use.disabled = true;
    try {
      if (C.create) {
        const f = C.create;
        await api('coinjoin/create', { coins: C.chosen, script: cjType(), maxInputs: maxIn, outputs: o, amount: k.amount, feeRate: k.rate, minPeers: Number(f.min), maxPeers: Number(f.max),
          hours: Number(f.hours), poolPassword: f.password, password: pw.value, dest: C.dest || '' });
        C.create = null; toast('Pool opened: others are told about it.');
      } else {
        if (C.join.pool.private && !C.join.password) { use.disabled = false; return toast('Type the pool\'s password first.'); }
        await api('coinjoin/join', { pool: C.join.pool.id, coins: C.chosen, poolPassword: C.join.password, password: pw.value, dest: C.dest || '' });
        C.join = null; toast('Asked to join: the creator\'s wallet lets you in.');
      }
      C.pick = null; C.chosen = [];
      await loadCoinjoin(); render(); reloadPools();
    } catch (e) { use.disabled = false; toast(e.message); }
  };
  use.addEventListener('click', () => {
    // With change, offer the perfect coin first: a coin of exactly the amount plus the fee joins with none.
    if (ch > 0) {
      let m;
      m = modal(h('div', { class: 'label' }, 'Make the perfect coin?'),
        h('p', { class: 'small soft' }, `With ${C.chosen.length > 1 ? 'these ' + C.chosen.length + ' coins' : 'this coin'} you get ${sats(ch)} sats of change back, and that change shows on the chain next to your coins. A single coin of exactly ${sats(exact)} sats goes in with no change at all, so nothing ties your mixed output to anything. You can make it now: a payment to yourself, paid with the coins you tick, which needs one confirmation before it can join.`),
        h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: () => { m.remove(); submit(); } }, 'NOT NEEDED, CONTINUE'),
          h('button', { class: 'primary', onclick: () => { m.remove(); prepareExact(exact, cjType()); } }, 'MAKE THE PERFECT COIN')));
    } else submit();
  });
  const toggle = op => {
    if (C.chosen.includes(op)) C.chosen = C.chosen.filter(x => x !== op);
    else if (maxIn > 1) { if (C.chosen.length < maxIn) C.chosen = C.chosen.concat(op); }
    else C.chosen = [op];
    render();
  };
  const rows = ok.map(c => h('div', { class: 'pick' + (C.chosen.includes(c.outpoint) ? ' sel' : ''), onclick: () => toggle(c.outpoint) },
    h('div', { class: 'between' }, h('span', {}, sats(c.value) + ' sats' + (c.value === exact ? '  ★ EXACT' : '') + (c.mixed ? ' · mixed' : '')), C.chosen.includes(c.outpoint) ? h('span', { class: 'good' }, '✓') : null),
    h('div', { class: 'faint small' }, c.address ? c.address.slice(0, 10) + '…' + c.address.slice(-8) : c.outpoint.slice(0, 10) + '…:' + c.outpoint.split(':')[1])));
  const shortRows = short.map(c => h('div', { class: 'pick' },
    h('div', { class: 'faint' }, sats(c.value) + ' sats'),
    h('div', { class: 'warnc small' }, `${sats(exact - c.value)} sats short of this pool's fee (${fmtRate(k.rate)} sat/vB): it fits a pool at a lower rate`)));
  const summary = C.chosen.length ? h('p', { class: (ch === null ? 'warnc' : 'good') + ' small' }, ch === null
    ? `${C.chosen.length} coin(s), ${sats(total)} sats: ${sats(k.amount * o + feeShare(k.rate, false, C.chosen.length, cjType(), o) - total)} sats short`
    : ch === 0 ? (total === exact ? '★ exact: no change' : `no change, ${sats(total - k.amount * o - feeShare(k.rate, false, C.chosen.length, cjType(), o))} extra to the miners`)
      : `${C.chosen.length} coin(s) · ${sats(total)} sats → ${amountOf(k.amount, o)} mixed + ${sats(ch)} change · fee ${sats(total - k.amount * o - ch)}`) : null;
  const hasExact = coins.some(c => c.value === exact);
  return h('div', { class: 'panel' }, h('div', { class: 'label' }, k.title),
    poolPw ? h('div', {}, h('p', { class: 'small soft' }, '🔒 Private pool: its creator shares the password with the people invited. Without it the pool refuses you.'), poolPw) : null,
    h('p', { class: 'small soft' }, `Only ${kindName(cjType())} coins can join this pool. Your other coins can still pay for an exact coin of this type.`),
    destPick,
    C.dest ? h('p', { class: 'small soft' }, (maxIn > 1
      ? `Tick up to ${maxIn} confirmed coins that together make at least ${sats(k.amount * o)} sats plus your fee. The leftover comes back to a fresh change address. `
      : `Pick ONE confirmed coin of at least ${sats(exact)} sats. Its leftover comes back to a fresh change address. `) +
      (o > 1 ? `Each of your ${o} mixed outputs of ${sats(k.amount)} sats goes to its own unused address of the wallet chosen above.` : 'The mixed output goes to an unused address of the wallet chosen above.'))
    : h('p', { class: 'small soft' }, maxIn > 1
      ? `Tick up to ${maxIn} confirmed coins that together make at least ${sats(k.amount * o)} sats plus your fee. The leftover comes back to a fresh change address; ` +
        (o > 1 ? `each of your ${o} mixed outputs of ${sats(k.amount)} sats goes to its own fresh address of this wallet.` : 'the mixed output goes to another fresh address of this wallet.')
      : `Pick ONE confirmed coin of at least ${sats(exact)} sats. Its leftover comes back to a fresh change address; ` +
        (o > 1 ? `each of your ${o} mixed outputs of ${sats(k.amount)} sats goes to its own fresh address of this wallet.` : 'the mixed output goes to another fresh address of this wallet.')),
    ok.length ? rows : h('p', { class: 'warnc small' }, 'No confirmed coin is big enough.'),
    shortRows, summary,
    hasExact ? null : h('button', { class: 'link', onclick: () => prepareExact(exact, cjType()) }, `＋ PREPARE AN EXACT COIN OF ${sats(exact)} SATS`),
    pw,
    h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: cancelPick }, 'CANCEL'), use));
}

/** A list of addresses with their paths (another wallet's, for a coinjoin), full and copyable. */
async function showAddresses(title, req, note) {
  let list;
  try { list = await req; } catch (e) { return toast(e.message); }
  let m;
  m = modal(h('div', { class: 'label' }, title), h('p', { class: 'small soft' }, note),
    list.map((a, i) => h('div', { class: 'tx', onclick: () => copy(a.address) },
      h('div', { class: 'between' }, h('span', { class: 'soft small' }, list.length > 1 ? `output ${i + 1}` : 'output'), h('span', { class: 'faint small' }, a.path)),
      h('div', { class: 'mono small' }, a.address))),
    h('p', { class: 'faint small' }, 'Tap one to copy it.'),
    h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: () => m.remove() }, 'CLOSE')));
}

/**
 * The perfect coin for a pool: a payment to a fresh address of this wallet of exactly the
 * amount plus the no-change fee, through the normal send review. Paid with unmixed coins only.
 */
async function prepareExact(exact, script) {
  try {
    // To a fresh address of the pool's type; paid with any of your coins (bc1q and bc1p alike).
    // Once it confirms, the server joins this pool (or opens the one being set up) by itself.
    const after = C.create && C.pick ? { create: { amount: C.pick.amount, feeRate: C.pick.rate, minPeers: Number(C.create.min), maxPeers: Number(C.create.max),
        hours: Number(C.create.hours), poolPassword: C.create.password || '', maxInputs: C.pick.maxInputs || 1, outputs: C.pick.outputs || 1 } }
      : C.join ? { pool: C.join.pool.id, poolPassword: C.join.password || '' } : null;
    const r = await api('coinjoin/exact', { script: script || 'p2wpkh', exact, after, dest: C.dest || '' });
    const pool = (C.st.coins || []).filter(c => !c.inRound && !c.mixed && c.confirmations > 0).sort((a, b) => b.value - a.value);
    const pick = new Set(); let sum = 0;
    for (const c of pool) { if (sum >= exact + 500) break; pick.add(c.outpoint); sum += c.value; }
    S.form = { to: r.address, amount: String(exact), rate: '', max: false, coins: pick };
    C.pick = null; C.join = null; C.create = null; C.chosen = [];
    S.tab = 'btc'; S.sheet = 'send'; S.draft = null; S.sent = null; S.psbt = null;
    render(); window.scrollTo(0, 0);
    toast(`A payment to yourself of exactly ${sats(exact)} sats: tick the coins to pay it with (coin control), review it. ` +
      (after ? 'Once it has one confirmation it ' + (after.create ? 'opens the pool' : 'joins the pool') + ' by itself.' : 'It can join once it has one confirmation.'));
  } catch (e) { toast(e.message); }
}

// ------------------------------------------------------------------ coinjoin: alerts

function soundOn() { try { return localStorage.getItem('kw.cjSound') === '1'; } catch { return false; } }

/** Other wallets a coinjoin's mixed outputs can go to: a watch-only wallet's key or Jam's export. */
function destinationsPanel() {
  const ds = C.st.destinations || [];
  const ks = { text: '', type: '', id: 'dest' };
  const kType = xpubTypeChoice(ks, [['p2wpkh', 'Native SegWit · bc1q… (BIP84)'], ['p2tr', 'Taproot · bc1p… (BIP86)']]);
  const text = h('textarea', { placeholder: 'zpub / xpub of a watch-only wallet, or Jam\'s export line (kilowallet-jm:v1:…)', rows: 2,
    oninput: e => { ks.text = e.target.value; kType.redraw(); } });
  const label = h('input', { placeholder: 'name (optional)', autocomplete: 'off' });
  const since = h('input', { type: 'date' });
  const pw = h('input', { type: 'password', placeholder: 'password, to confirm', autocomplete: 'current-password' });
  const add = () => {
    const k = xpubInfo(text.value);
    if (k && (k.prefix === 'xpub' || k.prefix === 'tpub') && !ks.type) return toast('Pick the address type of this xpub first.');
    return api('destinations/add', { text: text.value.trim(), label: label.value, type: ks.type,
      since: since.value ? Math.floor(new Date(since.value + 'T00:00:00Z').getTime() / 1000) : null, password: pw.value })
    .then(r => { C.st.destinations = r; toast('Added. The node is looking through the chain for it: it can take a while.'); render(); }).catch(e => toast(e.message));
  };
  return h('details', { class: 'panel' }, h('summary', { class: 'label' }, '📤 Other wallets for mixed outputs'),
    h('p', { class: 'small soft' }, 'A round\'s mixed outputs can go straight to another wallet of yours instead of this one: a watch-only wallet (its zpub, or a Taproot xpub) or your Jam wallet\'s first jar, Apricot (its "View in Kilowallet" line). The node keeps a watch-only copy of it, so only addresses that never received anything are used. Only output addresses ever leave this server.'),
    ds.length ? ds.map(d => h('div', { class: 'between small' }, h('span', {}, (d.which || d.label) + ' · ' + (d.type === 'p2tr' ? 'bc1p' : 'bc1q') + (d.scanning ? ' · looking through the chain…' : '')),
      h('button', { class: 'link faint', onclick: () => api('destinations/remove', { id: d.id }).then(r => { C.st.destinations = r; render(); }).catch(e => toast(e.message)) }, 'remove'))) : null,
    text, kType, label,
    h('div', { class: 'soft small mt' }, 'made around (the node looks back from that day, so every address it ever used is known)'), since,
    pw, h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: add }, 'ADD')));
}

function notificationsPanel() {
  const st = C.st.settings || {};
  const token = h('input', { placeholder: st.telegram_set ? 'bot token (saved; type to replace)' : 'bot token', autocomplete: 'off' });
  const chat = h('input', { placeholder: 'your chat id', value: st.telegram_chat || '', autocomplete: 'off' });
  const out = h('span', { class: 'small soft' });
  const set = (k, v) => api('coinjoin/settings', { [k]: v }).then(s => { C.st.settings = s; }).catch(e => toast(e.message));
  return h('div', { class: 'panel' }, h('div', { class: 'label' }, '🔔 Notifications'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.notify_new_pools !== false, onchange: e => set('notify_new_pools', e.target.checked) }),
      h('span', {}, 'New public pools', h('br'), h('span', { class: 'faint small' }, 'Looked up every 5 minutes. Your own pools are always followed.'))),
    h('p', { class: 'small soft' }, 'Telegram, with sound, through your own bot: make one with @BotFather, send it any message, and put its token and your chat id here (@userinfobot tells you your id). Every pool event arrives there.'),
    token, chat,
    h('div', { class: 'row' },
      h('button', { class: 'link', onclick: () => {
        const body = { telegram_chat: chat.value }; if (token.value) body.telegram_token = token.value;
        api('coinjoin/settings', body).then(s => { C.st.settings = s; token.value = ''; out.textContent = 'saved'; }).catch(e => { out.textContent = e.message; });
      } }, 'SAVE'),
      h('button', { class: 'link', onclick: () => { out.textContent = 'sending…'; api('coinjoin/telegram/test', {}).then(() => { out.textContent = 'sent ✓'; }).catch(e => { out.textContent = e.message; }); } }, 'SEND A TEST'),
      out),
    h('label', { class: 'check mt' }, h('input', { type: 'checkbox', checked: soundOn(), onchange: e => {
      try { localStorage.setItem('kw.cjSound', e.target.checked ? '1' : '0'); } catch {}
      if (e.target.checked) { chime(); if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); }
    } }), h('span', {}, 'Sound and a notification in this browser', h('br'), h('span', { class: 'faint small' }, 'On every pool event, while this page is open.'))));
}

function autoSignPanel() {
  const st = C.st.settings || {};
  return h('div', { class: 'panel' }, h('div', { class: 'label' }, 'Sign on its own'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!st.auto_sign, onchange: e => api('coinjoin/settings', { auto_sign: e.target.checked }).then(s => { C.st.settings = s; }).catch(er => toast(er.message)) }),
      h('span', {}, 'Accept close requests and sign by itself')),
    h('p', { class: 'small faint' }, 'The password you give when opening or joining a pool is the only one: the round goes on with this page closed, and signs only when the final transaction checks out (your mixed output, your change and your share of the fee). The keys of that round\'s coins stay in the server\'s memory until it ends; if the service restarts, unlock Kilowallet once to let it sign.'),
    h('button', { class: 'link faint', onclick: () => api('coinjoin/enable', { on: false }).then(r => { C.st = r; C.pools = null; S.tab = 'btc'; render(); }).catch(e => toast(e.message)) }, 'turn coinjoin off'));
}

function howPanel() {
  return h('div', { class: 'panel' }, h('div', { class: 'label' }, 'How a round goes'),
    h('p', { class: 'small soft' }, `1. Someone opens a pool with an amount. 2. People join, each proving they own a real coin (one seat per coin, which stops one person from filling the pool alone). 3. With two or more in, anyone can ask to close: the others accept or refuse; whoever does not answer in ${C.st.limits.voteMinutes} minutes is left out. 4. Each wallet posts its mixed output with no name on it, after a random wait. 5. Every wallet builds the same transaction, checks its own output and change, and you sign with your password. 6. Once all have signed it goes out — signed so it is valid only on this chain, never on the spamchain. This server keeps the round going while the page is closed.`),
    h('p', { class: 'faint small' }, 'Relay: ' + C.st.relay));
}

function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + i * 0.18;
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.start(t); o.stop(t + 0.32);
    });
  } catch {}
}

let lastEventAt = null;
async function pollEvents() {
  if (!S.me || !S.me.unlocked || !C.st || !C.st.enabled) return;
  try {
    const evs = await api('coinjoin/events');
    const newest = evs.length ? evs[0].at : 0;
    if (lastEventAt === null) { lastEventAt = newest; return; } // what was there before this page opened
    const fresh = evs.filter(e => e.at > lastEventAt);
    lastEventAt = Math.max(lastEventAt, newest);
    if (!fresh.length) return;
    if (S.tab === 'coinjoin') { await loadCoinjoin().catch(() => {}); if (!busy()) render(); }
    if (!soundOn()) return;
    chime();
    if (window.Notification && Notification.permission === 'granted')
      fresh.slice(0, 3).forEach(e => new Notification(e.title, { body: e.text, tag: e.at + e.title }));
  } catch {}
}

boot().catch(e => { $app.replaceChildren(h('div', { class: 'panel bad' }, e.message)); });

// ------------------------------------------------------------------ coinjoin: round cards

/** Where a round is, 1..5: people, closing vote, outputs and signatures, sent, confirmed (0: ended without). */
function roundStep(p) {
  return { JOINING: 1, OPEN: 1, VOTING: 2, CLOSING: 3, SIGNING: 3, BROADCAST: 4, CONFIRMED: 5 }[p.phase] || 0;
}

/** True while the round waits on you: an answer, or a signature by hand. */
function roundNeedsMe(p) {
  if ((C.st.settings || {}).auto_sign) return false;
  return (p.phase === 'VOTING' && !p.iAsked && !p.voted) || (p.phase === 'SIGNING' && !p.signed);
}

/** One round at a glance: amount, the bar of its five steps, what is happening and where your coin is. */
function roundCard(p) {
  const step = roundStep(p), ended = step === 0;
  C.open = C.open || {};
  const open = p.id in C.open ? C.open[p.id] : roundNeedsMe(p);
  const status = {
    JOINING: 'Asking to join',
    OPEN: `Waiting for people · ${p.people}/${p.maxPeers} people · closes at ${hhmm(p.expiresAt)}`,
    VOTING: roundNeedsMe(p) ? `Closing vote · your answer, by ${hhmm(p.voteDeadline)}` : `Closing vote · ${p.people} people`,
    CLOSING: `Closing · ${p.people} people · collecting outputs`,
    SIGNING: p.signed ? 'Signed · waiting for the others' : roundNeedsMe(p) ? 'Ready to sign' : 'Signing',
    BROADCAST: 'Sent · waiting for a block', CONFIRMED: 'Confirmed', ABORTED: 'Cancelled', REJECTED: 'Refused',
  }[p.phase] || p.phase;
  const where = p.phase === 'BROADCAST' ? 'Your coin left in the group transaction. Waiting for a block.'
    : p.phase === 'CONFIRMED' ? (p.outputs > 1 ? `Done: your ${p.outputs} mixed coins of ${sats(p.amount)} sats are in your wallet.` : `Done: your mixed coin of ${sats(p.amount)} sats is in your wallet.`)
    : ended ? `${(p.reason || 'ended').replace(/^./, c => c.toUpperCase())}. Your coin did not move.`
    : 'Your coin is still in your wallet — it hasn\'t left.';
  const cls = ended ? 'badc' : step === 5 ? 'good' : 'accent';
  const dots = [];
  for (let i = 1; i <= 5; i++) {
    dots.push(h('span', { class: 'dot' + (i < step || step === 5 ? ' done' : i === step ? ' now' : '') }));
    if (i < 5) dots.push(h('span', { class: 'bar' + (i < step ? ' done' : '') }));
  }
  return h('div', { class: 'panel round' + (ended ? ' bad' : '') },
    h('div', { class: 'tap', onclick: () => { C.open[p.id] = !open; render(); } },
      h('div', { class: 'between' }, h('span', { class: 'mid' }, (p.private ? '🔒 ' : '') + amountOf(p.amount, p.outputs) + ' sats each' + (p.script === 'p2tr' ? ' · Taproot' : '')),
        h('span', { class: cls + ' mid' }, (ended ? '' : step + '/5 ') + (open ? '⌄' : '›'))),
      ended ? null : h('div', { class: 'steps' }, dots),
      h('p', { class: cls }, status),
      h('p', { class: 'soft small' }, where)),
    open ? myPool(p, true) : null);
}
