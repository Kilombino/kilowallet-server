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
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
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
  if (j.error) throw new Error(j.error);
  return j;
}
function qr(text) {
  const q = qrcode(0, 'L'); q.addData(text); q.make();
  return h('div', { class: 'qr' }, h('img', { src: q.createDataURL(8, 0), alt: 'QR' }));
}
async function copy(t) { try { await navigator.clipboard.writeText(t); toast('Copied.'); } catch { toast('Could not copy: select it by hand.'); } }
function fiat(n) {
  const p = S.w && S.w.price; if (!p) return '≈ –';
  const px = S.fiat === 'EUR' ? p.eur : p.usd; if (!px) return '≈ –';
  return '≈ ' + (S.fiat === 'EUR' ? '€' : '$') + (n * px / 1e8).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// ------------------------------------------------------------------ boot

async function boot() {
  S.me = await api('state');
  if (S.me.unlocked) await loadWallet();
  render();
  setInterval(async () => { if (S.me && S.me.unlocked && !S.sheet && document.visibilityState === 'visible') { await loadWallet().catch(() => {}); render(); } }, 30000);
  // Leaving the page puts street mode back on (as the app does).
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && S.w) { S.street = S.w.settings.streetDefault; render(); } });
}
async function loadWallet() {
  S.w = await api('wallet');
  if (S.street === true && S.w.settings && !S.w.settings.streetDefault && !loadWallet.done) S.street = false;
  loadWallet.done = true;
}

function render() {
  $app.replaceChildren();
  if (!S.me) return;
  if (!S.me.mode) return $app.append(setupView());
  if (!S.me.unlocked) return $app.append(unlockView());
  $app.append(mainView());
}

// ------------------------------------------------------------------ setup / unlock

function setupView() {
  const pw = h('input', { type: 'password', placeholder: 'password (8+ characters)', autocomplete: 'new-password' });
  const words = h('textarea', { placeholder: '12 or 24 recovery words' });
  const pass = h('input', { type: 'text', placeholder: 'BIP-39 passphrase (optional, usually empty)' });
  const key = h('textarea', { placeholder: 'xpub / ypub / zpub' });
  const taproot = h('input', { type: 'checkbox' });
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
      key, h('label', { class: 'check' }, taproot, 'Taproot (bc1p) account'),
      h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: () => run('setup/watch', { password: pw.value, key: key.value, taproot: taproot.checked, since: ts() }) }, 'WATCH IT'))));
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
      h('button', { class: 'link', onclick: () => { S.showSettings = !S.showSettings; render(); } }, S.showSettings ? 'close' : 'settings'),
      h('button', { class: 'link faint', onclick: () => api('lock', {}).then(() => { S.me.unlocked = false; S.w = null; render(); }) }, 'lock')));
  if (S.newWords) return h('div', {}, top, newWordsPanel());
  if (w.error) return h('div', {}, top, h('div', { class: 'panel bad' }, h('div', { class: 'label' }, 'Node'), h('p', {}, w.error)));
  if (w.importing) return h('div', {}, top, h('div', { class: 'panel' }, h('div', { class: 'label' }, 'Reading your history'),
    h('p', { class: 'soft' }, 'The node is looking through the chain for this wallet\'s coins and movements. It can take from a minute to a while; this page updates by itself.')));
  const total = (w.confirmed || 0) + (w.pending || 0);
  const parts = [top,
    h('div', { class: 'panel' },
      h('div', { class: 'between' }, h('div', { class: 'label' }, 'BTC balance'),
        h('button', { class: 'link', onclick: () => { S.street = !S.street; render(); } }, S.street ? '👁 show' : '🙈 hide')),
      h('div', { class: 'big' }, street(sats(total))), h('div', { class: 'faint' }, S.street ? 'STREET MODE' : 'sats'),
      h('div', { class: 'between' }, h('span', { class: 'mid' }, street(fiat(total))),
        h('span', {}, ...['USD', 'EUR'].map(f => h('button', { class: 'link' + (S.fiat === f ? '' : ' faint'), onclick: () => { S.fiat = f; localStorage.setItem('kw.fiat', f); render(); } }, f)))),
      w.pending ? h('div', { class: 'warnc small' }, 'unconfirmed: ' + street(sats(w.pending) + ' sats')) : null,
      h('div', { class: 'faint small' }, `height ${w.height || '–'} · node wallet ${w.node || ''}`)),
    h('div', { class: 'btns' },
      h('button', { class: 'soft', onclick: () => { S.sheet = 'receive'; render(); } }, 'RECEIVE'),
      h('button', { class: 'primary', onclick: () => { S.sheet = 'send'; S.draft = null; S.sent = null; S.psbt = null; render(); } }, 'SEND'))];
  if (S.sheet === 'receive') parts.push(receivePanel());
  if (S.sheet === 'send') parts.push(sendPanel());
  if (S.showSettings) parts.push(settingsPanel());
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
  const r = S.w.receive;
  return h('div', { class: 'panel' },
    h('div', { class: 'between' }, h('div', { class: 'label' }, 'Receive'), h('button', { class: 'link faint', onclick: () => { S.sheet = null; render(); } }, 'close')),
    qr('bitcoin:' + r.address), h('div', { class: 'mono center' }, r.address),
    h('div', { class: 'faint small center' }, `unused · m/…/0/${r.index}`),
    h('div', { class: 'btns' },
      h('button', { class: 'soft', onclick: () => copy(r.address) }, 'COPY'),
      h('button', { class: 'soft', onclick: () => api('receive/next', {}).then(n => { S.w.receive = n; render(); }).catch(e => toast(e.message)) }, 'NEXT ADDRESS')));
}

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
  const coinBox = h('div', {}, (S.w.coins || []).map(c => h('label', { class: 'check small' },
    h('input', { type: 'checkbox', checked: f.coins.has(c.outpoint), onchange: e => { e.target.checked ? f.coins.add(c.outpoint) : f.coins.delete(c.outpoint); } }),
    h('span', { class: 'grow' }, `${street(sats(c.value) + ' sats')} · ${c.confirmations} conf${c.change ? ' · change' : ''}`))));
  const cc = h('details', {}, h('summary', { class: 'soft small' }, 'Coin control'), coinBox);
  return h('div', {},
    h('div', { class: 'row' }, h('div', { class: 'grow' }, to), scan),
    h('div', { class: 'row' },
      h('button', { class: 'link', onclick: async () => { try { f.to = (await navigator.clipboard.readText()).trim().replace(/^bitcoin:/i, '').split('?')[0]; to.value = f.to; } catch { toast('Paste it into the box.'); } } }, 'PASTE'),
      pick),
    h('div', { class: 'row small faint' }, h('div', { class: 'grow' }, 'amount (sats)'), h('div', { class: 'w110' }, 'fee sat/vB')),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, amount), h('div', { class: 'w110' }, rate)),
    h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: f.max, onchange: e => { f.max = e.target.checked; render(); } }), 'MAX: send everything (minus the fee)'),
    cc,
    h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => api('send/prepare', {
      to: f.to, amount: Number(f.amount || 0), max: f.max, rate: Number(f.rate || 2), coins: [...f.coins] })
      .then(d => { S.draft = d; render(); }).catch(e => toast(e.message)) }, 'REVIEW')));
}

function reviewView(d) {
  const hot = S.me.mode === 'hot';
  const feeOk = h('input', { type: 'checkbox' });
  const pw = h('input', { type: 'password', placeholder: 'password, to sign', autocomplete: 'current-password' });
  const rows = [
    d.cpfpParent ? h('p', { class: 'small soft' }, 'Pulls the stuck payment along: a payment to yourself that spends what it brought you, with a fee big enough for both.') : null,
    d.replaces ? h('p', { class: 'small soft' }, 'Replaces the stuck send with the same payment and a higher fee, taken from your change.') : null,
    h('div', { class: 'between' }, h('span', { class: 'soft' }, d.cpfpParent ? 'Back to you' : 'To'), h('span', { class: 'mono' }, short(d.to))),
    h('div', { class: 'between' }, h('span', { class: 'soft' }, 'Amount'), h('span', {}, sats(d.amount) + ' sats')),
    h('div', { class: 'between' }, h('span', { class: 'soft' }, 'Fee'), h('span', {}, (d.replaces ? sats(d.replacedFee) + ' → ' : '') + sats(d.fee) + ' sats · ' +
      (d.cpfpParent ? d.packageRate.toFixed(1) + ' sat/vB both together' : d.rate.toFixed(1) + ' sat/vB'))),
    h('div', { class: 'between' }, h('span', { class: 'soft' }, 'Change'), h('span', {}, d.change && !d.cpfpParent ? sats(d.change) + ' sats' : '—')),
    h('div', { class: 'between' }, h('span', { class: 'soft' }, 'Inputs'), h('span', {}, d.inputs)),
    h('p', { class: 'faint small' }, 'Signed with the unified sighash: valid only on BTC, it can\'t be replayed on the spamchain.'),
    d.concern ? h('div', {}, h('p', { class: 'badc small' }, '⚠ ' + d.concern + ' Check it before signing: a fee can\'t be taken back.'),
      h('label', { class: 'check small' }, feeOk, 'Yes, I want to pay this fee')) : null];
  if (hot) return h('div', {}, rows, pw,
    h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => {
      if (d.concern && !feeOk.checked) return toast('Tick the box to confirm the fee.');
      api('send/confirm', { draft: d.draft, password: pw.value, acceptFee: feeOk.checked }).then(r => { S.sent = r.txid; S.draft = null; S.form = null; loadWallet().then(render); render(); }).catch(e => toast(e.message));
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
        api('psbt/export', { draft: d.draft, origin: origin.value, acceptFee: feeOk.checked }).then(r => { S.psbt = r.psbt; render(); }).catch(e => toast(e.message));
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
  return h('div', { class: 'panel' }, h('div', { class: 'label' }, 'Movements · confirmations'),
    txs.length ? txs.map(t => h('div', { class: 'tx', onclick: () => txDetail(t) },
      h('div', { class: 'between' }, h('span', { class: t.net > 0 ? 'in' : 'out' }, street((t.net > 0 ? '+' : '') + sats(t.net) + ' sats')),
        h('span', { class: t.confirmations ? 'faint small' : 'warnc small' }, t.confirmations ? `${t.confirmations} conf${t.confirmations >= 6 ? '  ✓' : ''}` : 'in mempool · 0 conf')),
      h('div', { class: 'faint small' }, street(`(left: ${sats(t.left)} sats)`)),
      h('div', { class: 'faint small' }, t.txid.slice(0, 8) + '…' + t.txid.slice(-6)))) : h('p', { class: 'faint small' }, 'Nothing yet.'));
}

function coinsPanel() {
  const cs = (S.w && S.w.coins) || [];
  if (!cs.length) return null;
  return h('details', { class: 'panel' }, h('summary', { class: 'label' }, `Coins (${cs.length})`),
    cs.map(c => h('div', { class: 'tx' }, h('div', { class: 'between' }, h('span', {}, street(sats(c.value) + ' sats')), h('span', { class: 'faint small' }, `${c.confirmations} conf`)),
      h('div', { class: 'faint small mono' }, c.address + (c.change ? ' · change' : '')))));
}

function modal(...kids) {
  const bg = h('div', { class: 'modal-bg', onclick: e => { if (e.target === bg) bg.remove(); } }, h('div', { class: 'modal' }, ...kids));
  document.body.append(bg); return bg;
}

function txDetail(t) {
  const hot = S.me.mode === 'hot';
  const rate = h('input', { placeholder: 'sat/vB', inputmode: 'decimal', value: '3' });
  let m;
  const speed = cpfp => api(cpfp ? 'cpfp' : 'bump', { txid: t.txid, rate: Number(rate.value.replace(',', '.')) })
    .then(d => { m.remove(); S.sheet = 'send'; S.sent = null; S.psbt = null; S.draft = d; render(); window.scrollTo(0, 0); }).catch(e => toast(e.message));
  m = modal(h('div', { class: 'label' }, 'Transaction'),
    h('p', { class: t.confirmations ? 'soft' : 'warnc' }, t.confirmations ? `${t.confirmations} confirmation${t.confirmations === 1 ? '' : 's'}` : 'in mempool · 0 confirmations'),
    h('p', { class: 'mono small' }, t.txid),
    h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: () => copy(t.txid) }, '📋 COPY TXID'),
      h('button', { class: 'soft', onclick: () => window.open(S.w.settings.explorer + '/tx/' + t.txid, '_blank', 'noopener') }, '🔎 EXPLORER')),
    !t.confirmations ? h('div', {}, h('p', { class: 'small soft' }, t.net > 0
      ? 'Stuck? Pull it along (CPFP): choose the fee rate for it and the speed-up together.'
      : 'Stuck? Replace it (RBF) with the same payment at a higher fee rate.'), rate,
      h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => speed(t.net > 0) }, t.net > 0 ? '⚡ SPEED UP (CPFP)' : '⚡ SPEED UP (RBF)'))) : null,
    h('div', { class: 'btns' }, h('button', { class: 'link faint', onclick: () => m.remove() }, 'close')));
}

// ------------------------------------------------------------------ settings

function settingsPanel() {
  const st = S.w.settings || {};
  const set = (k, v) => api('settings', { [k]: v }).then(s => { S.w.settings = s; render(); }).catch(e => toast(e.message));
  const explorer = h('input', { value: st.explorer || '' });
  const pwBox = () => h('input', { type: 'password', placeholder: 'password' });
  const pw1 = pwBox(), pwNew = h('input', { type: 'password', placeholder: 'new password (8+)' }), pw2 = pwBox(), pw3 = pwBox();
  const hot = S.me.mode === 'hot';
  return h('div', { class: 'panel' }, h('div', { class: 'label' }, 'Settings'),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.streetDefault !== false, onchange: e => set('streetDefault', e.target.checked) }),
      h('span', {}, 'Street mode', h('br'), h('span', { class: 'faint small' }, 'On: amounts hidden every time the page opens, until you tap the eye.'))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: st.prices !== false, onchange: e => set('prices', e.target.checked) }),
      h('span', {}, 'USD/EUR prices', h('br'), h('span', { class: 'faint small' }, 'From mempool.kilombino.com (it sees this server asking, nothing about your wallet).'))),
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

boot().catch(e => { $app.replaceChildren(h('div', { class: 'panel bad' }, e.message)); });
