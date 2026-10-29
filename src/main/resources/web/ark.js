// The app's ARK tab: Ark through the Paperclip Ark server, with this wallet's own words.
// Loaded before app.js, whose helpers (h, api, sats, street, qr, copy, modal, toast, render, S, C)
// these functions use when they run. No inline handlers: the page's CSP forbids them.
'use strict';

const K = { st: null, sheet: null, shown: null, lnState: null, send: null, board: null, msg: null, loading: false };

async function loadArk() { K.st = await api('ark'); }

function arkFiat(n) { const f = fiat(n); return f === '≈ –' ? '' : f; }
const arkDays = blocks => (blocks * 10 / 1440).toFixed(1);
const arkPw = ph => h('input', { type: 'password', placeholder: ph || 'password, to confirm', autocomplete: 'current-password' });
const arkOk = m => { K.msg = { text: m, bad: false }; };
const arkErr = e => { K.msg = { text: 'Error: ' + (e.message || e), bad: true }; };

async function arkDo(label, fn) {
  K.msg = { text: label, bad: false, busy: true }; render();
  try { const r = await fn(); if (r) arkOk(r); else K.msg = null; } catch (e) { if (e.message !== 'locked') arkErr(e); }
  await loadArk().catch(() => {});
  render();
}

function arkTimers() {
  // The figures stay live while the tab is open; boards and rounds settle on their own.
  setInterval(async () => {
    if (!S.me || !S.me.unlocked || S.tab !== 'ark' || document.visibilityState !== 'visible') return;
    const st = K.st;
    if (st && st.enabled && st.running && busy()) return;
    try { await loadArk(); if (!busy()) render(); } catch {}
  }, 15000);
  // A Lightning invoice on screen: follow it until it is paid, so nobody pays it twice.
  setInterval(async () => {
    if (S.tab !== 'ark' || !K.shown || !K.shown.invoice || K.lnState === 'settled' || document.visibilityState !== 'visible') return;
    try {
      const r = await api('ark/invoice/state', { invoice: K.shown.text });
      if (r.state && r.state !== K.lnState) { K.lnState = r.state; const el = document.getElementById('lnstate'); if (el) el.replaceWith(lnStateLine()); }
    } catch {}
  }, 4000);
}
arkTimers();

function arkView() {
  const st = K.st;
  if (!st) return h('div', { class: 'panel' }, h('p', { class: 'faint small' }, 'Loading…'));
  if (st.blocker) return h('div', {}, h('div', { class: 'panel warn' }, h('div', { class: 'label' }, 'Ark'), h('p', { class: 'small' }, st.blocker)), arkWarnings());
  if (st.activating) return h('div', { class: 'panel' }, h('div', { class: 'label' }, 'Activating Ark…'),
    h('p', { class: 'small soft' }, 'The engine is creating your Ark wallet with this wallet\'s words, and asking the Ark server for any coins those words already had. It can take a few minutes (longer with the node as chain source, while it looks through recent blocks for your deposit). This page updates by itself.'));
  if (!st.enabled) return h('div', {}, arkWarnings(), arkActivate(st));
  if (!st.running) return h('div', {}, arkDown(st), arkWarnings());
  const parts = [arkBalance(st)];
  if (st.tipMismatch) parts.push(h('p', { class: 'warnc small' }, '⚠ ' + st.tipMismatch));
  const sheetBtn = (k, label) => h('button', { class: K.sheet === k ? 'primary' : 'soft', onclick: () => { K.sheet = K.sheet === k ? null : k; K.shown = null; K.send = null; K.board = null; render(); } }, label);
  parts.push(h('div', { class: 'btns' }, sheetBtn('receive', 'RECEIVE'), sheetBtn('send', 'SEND')),
    h('div', { class: 'btns' }, sheetBtn('board', 'MOVE INTO ARK'), h('button', { class: 'soft', onclick: arkRenewDialog }, 'RENEW')));
  if (K.msg) parts.push(h('p', { class: 'small ' + (K.msg.bad ? 'badc' : K.msg.busy ? 'warnc' : 'good') }, K.msg.text,
    K.msg.busy ? null : h('button', { class: 'link faint', onclick: () => { K.msg = null; render(); } }, 'ok')));
  if (K.sheet === 'receive') parts.push(arkReceive(st));
  if (K.sheet === 'send') parts.push(arkSend(st));
  if (K.sheet === 'board') parts.push(arkBoard(st));
  if ((st.activity || []).length) parts.push(arkHistory(st));
  parts.push(arkBackupPanel(), arkEmergency(st), arkNotify(), arkLog(), arkWarnings());
  return h('div', {}, parts);
}

// ------------------------------------------------------------------ before activation

function arkWarnings() {
  const l = (K.st && K.st.limits) || { lifetime: 4320, minBoard: 20000, maxVtxo: 1000000, maxLightning: 250000, boardConfs: 3 };
  return h('div', { class: 'panel warn' }, h('div', { class: 'label warnc' }, 'Before you use Ark'),
    [`Ark funds expire after ${l.lifetime} blocks (about 30 days). The Ark engine must run before then to renew them, or they have to be withdrawn on-chain with fees and waiting times. On this server it runs while Kilowallet runs, once you have unlocked it after a restart.`,
      `Minimum to move funds into Ark: ${sats(l.minBoard)} sats.`,
      `Maximum per Ark coin: ${sats(l.maxVtxo)} sats.`,
      `Lightning: up to ${sats(l.maxLightning)} sats per payment, no channels needed.`,
      'Every Ark payment pre-pays recovery reserves for each coin it uses: about 1 056 sats for a coin spent whole and 1 584 for one with change (4 000 and 6 000 where the server has not enabled its smaller anchors); change must be at least 1 330 sats. Small balances can only leave Ark on-chain. The wallet shows the exact cost before you confirm.',
      `Rounds every 60 seconds; moving funds in needs ${l.boardConfs} confirmations.`,
      'Back up Ark twice: your words (the same as this wallet\'s) let the Ark server hand your coins back; a StartOS backup of Kilowallet holds the Ark folder, which is what lets you leave Ark on your own if the server ever disappears. Make one after each movement.',
      'Ark is beta software, through the Paperclip Ark server (ark.paperclippool.xyz).'].map(t => h('p', { class: 'small soft' }, '•  ' + t)));
}

function arkActivate(st) {
  const accept = h('input', { type: 'checkbox' });
  const pw = arkPw('wallet password');
  const nodeOk = !st.nodeProblem;
  let chain = nodeOk ? 'node' : 'esplora';
  const radio = (v, label, note, disabled) => h('label', { class: 'check small' + (disabled ? ' faint' : '') },
    h('input', { type: 'radio', name: 'arkchain', value: v, checked: chain === v, disabled, onchange: () => { chain = v; } }),
    h('span', {}, label, h('br'), h('span', { class: 'faint small' }, note)));
  return h('div', { class: 'panel' }, h('div', { class: 'label' }, 'Activate Ark'),
    h('p', { class: 'small soft' }, 'Ark uses the same words as this wallet, so one set of words backs up both. If these words already had Ark coins (in the Kilowallet app, say), the Ark server hands them back; their history does not come back.'),
    h('div', { class: 'soft small mt' }, 'Where the Ark engine reads the chain'),
    radio('node', 'Your node (recommended)', nodeOk ? 'Over RPC, as Paperclip requires on XBT. Nothing about your wallet leaves your server, except to the Ark server.' : st.nodeProblem, !nodeOk),
    radio('esplora', 'mempool.kilombino.com', 'Its Esplora API, as the phone app does. It sees which addresses the Ark engine looks up.', false),
    h('label', { class: 'check small mt' }, accept, h('span', {}, 'I have read the warnings above. Ark is beta software and I will start with a small amount.')),
    pw,
    h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => {
      if (!accept.checked) return toast('Tick the box first.');
      api('ark/activate', { password: pw.value, accept: true, chain }).then(async () => { await loadArk(); render(); }).catch(e => toast(e.message));
    } }, 'ACTIVATE ARK')),
    h('p', { class: 'faint small' }, 'Asks for the password: the words are what Ark runs with. They go to the Ark engine in memory only, never to disk.'));
}

function arkDown(st) {
  const why = !st.hasWords ? 'The Ark engine is starting with your words…'
    : st.error ? 'The Ark engine could not start: ' + st.error + ' It tries again by itself.'
      : 'Starting the Ark engine…';
  return h('div', { class: 'panel' + (st.error ? ' bad' : '') }, h('div', { class: 'label' }, 'Ark'),
    h('p', { class: 'small ' + (st.error ? 'badc' : 'soft') }, why),
    st.expiry != null ? h('p', { class: 'small ' + (st.expiry < st.limits.warnBlocks ? 'badc' : 'faint') },
      `Last seen: your next Ark coin expires in about ${st.expiry} blocks (≈ ${arkDays(st.expiry)} days). It is only renewed while the engine runs.`) : null,
    h('button', { class: 'link', onclick: () => loadArk().then(render).catch(e => toast(e.message)) }, 'refresh'));
}

// ------------------------------------------------------------------ balance

function arkBalance(st) {
  const b = st.balance || {};
  const deposit = (b.onchainConfirmed || 0) + (b.onchainPending || 0);
  const total = (b.spendable || 0) + (b.pendingBoard || 0) + (b.pendingRound || 0) + deposit + (b.lightningPending || 0);
  const row = (label, n, note, cls) => h('div', { class: 'row small' }, h('span', { class: 'soft w110' }, label),
    h('span', { class: 'grow ' + (cls || '') }, street(sats(n) + ' sats')), h('span', { class: 'faint' }, note));
  const l = st.limits;
  return h('div', { class: 'panel' },
    h('div', { class: 'between' }, h('div', { class: 'label' }, 'Your Ark wallet'),
      h('button', { class: 'link', onclick: () => { S.street = !S.street; render(); } }, S.street ? '👁 show' : '🙈 hide')),
    h('div', { class: 'big' }, street(sats(total))), h('div', { class: 'faint' }, S.street ? 'STREET MODE' : 'sats'),
    h('div', { class: 'between' }, h('span', { class: 'mid' }, street(fiat(total))),
      fiatPicker()),
    b.pendingBoard ? h('div', { class: 'warnc small' }, 'entering Ark: ' + street(sats(b.pendingBoard) + ' sats') + ' · ' + boardConfText(st)) : null,
    b.pendingRound ? h('div', { class: 'warnc small' }, 'in the next round: ' + street(sats(b.pendingRound) + ' sats')) : null,
    h('div', { class: 'mt' }),
    row('In Ark', b.spendable || 0, 'spendable', 'good'),
    b.refused ? h('p', { class: 'warnc small' }, 'Not counted: ' + street(sats(b.refused) + ' sats') + ' in coins the server says were already spent earlier (left over from an older wallet state, such as an old backup).') : null,
    row('On-chain deposit', deposit, b.onchainPending ? street(sats(b.onchainPending)) + ' unconfirmed · not in Ark yet' : 'not in Ark yet'),
    b.lightningPending ? row('Lightning', b.lightningPending, 'settling', 'warnc') : null,
    b.pendingExit ? h('div', { class: 'badc small' }, 'leaving Ark (emergency exit): ' + street(sats(b.pendingExit) + ' sats')) : null,
    st.expiry != null ? h('p', { class: 'small ' + (st.expiry < l.warnBlocks ? 'badc' : 'faint') },
      `Next coin expires in ${st.expiry} blocks (≈ ${arkDays(st.expiry)} days). The engine renews it by itself while Kilowallet runs; tap RENEW to do it now.`) : null,
    h('div', { class: 'faint small' }, `chain: ${st.chain === 'node' ? 'your node' : 'mempool.kilombino.com'} · block ${st.tip || '–'} · ${st.server.replace('https://', '')}`));
}

function boardConfText(st) {
  const m = (st.activity || []).find(a => a.kind === 'move into Ark' && a.confirmations != null);
  return m ? `${m.confirmations} of ${st.limits.boardConfs} confirmations` : `needs ${st.limits.boardConfs} confirmations`;
}

// ------------------------------------------------------------------ receive

function lnStateLine() {
  const s = K.lnState;
  const [t, c] = s === 'settled' ? ['✅ Paid: this invoice is done, it can\'t be paid again. Create a new one for another payment.', 'good']
    : ['htlcs-ready', 'preimage-revealed', 'delivering'].includes(s) ? ['⏳ Payment arriving…', 'warnc'] : ['Waiting for payment. Valid for one payment only.', 'faint'];
  return h('p', { id: 'lnstate', class: 'small ' + c }, t);
}

function arkReceive(st) {
  const amount = h('input', { placeholder: 'sats for Lightning', inputmode: 'numeric', value: K.lnAmount || '' });
  const est = h('div', {});
  let t;
  const quote = () => {
    clearTimeout(t); const n = Number(amount.value.replace(/\D/g, '')); K.lnAmount = amount.value;
    if (!n) { est.replaceChildren(); return; }
    t = setTimeout(() => api('ark/estimate', { kind: 'lnreceive', amount: n }).then(e => {
      est.replaceChildren(h('div', {}, costBox(e, 'You receive', 'Invoice amount'),
        e.amount < st.limits.minOutput ? h('p', { class: 'badc small' }, `Too small: after the receive cost you would get ${sats(e.amount)} sats, below the ${sats(st.limits.minOutput)}-sat minimum, so the payer's payment would fail.`) : null));
    }).catch(() => est.replaceChildren()), 500);
  };
  amount.addEventListener('input', quote);
  if (K.lnAmount) quote();
  const show = (label, text, extra) => { K.shown = Object.assign({ label, text }, extra || {}); K.lnState = null; render(); };
  const get = (label, path, body, done) => arkDoInline(label, () => api(path, body).then(done));
  const sh = K.shown;
  return h('div', { class: 'panel' }, h('div', { class: 'between' }, h('div', { class: 'label' }, 'Receive'), h('button', { class: 'link faint', onclick: () => { K.sheet = null; K.shown = null; render(); } }, 'close')),
    h('div', { class: 'btns' },
      h('button', { class: 'soft', onclick: () => get('Getting an Ark address…', 'ark/address', { kind: 'ark' }, r => show('Ark address', r.address)) }, 'ARK'),
      h('button', { class: 'soft', onclick: () => get('Getting a deposit address…', 'ark/address', { kind: 'deposit' }, r => show('On-chain deposit address', r.address)) }, 'DEPOSIT'),
      h('button', { class: 'soft', onclick: () => { const n = Number(amount.value.replace(/\D/g, '')) || 0;
        get('Getting your reusable offer…', 'ark/offer', n ? { amount: n } : {}, r => show('Reusable Lightning offer (BOLT12)' + (n ? ` for ${n} sats` : ', any amount'), r.offer, { offer: true })); } }, '⚡ OFFER')),
    h('div', { class: 'row mt' }, h('div', { class: 'grow' }, amount),
      h('button', { class: 'primary', onclick: () => {
        const n = Number(amount.value.replace(/\D/g, ''));
        if (!n) return toast('Type the amount in sats first.');
        K.shown = null; render();
        get('Creating a new Lightning invoice… It can take a minute while the wallet finishes other work.', 'ark/invoice', { amount: n }, r => show(`Lightning invoice (${n} sats)`, r.invoice, { invoice: true }));
      } }, '⚡ INVOICE')),
    fiatBox(amount, () => quote()),
    est,
    h('p', { class: 'faint small' }, `Lightning: up to ${sats(st.limits.maxLightning)} sats per payment. Deposits become Ark funds with MOVE INTO ARK (minimum ${sats(st.limits.minBoard)} sats).`),
    sh ? h('div', { class: 'mt' }, h('div', { class: 'label' }, sh.label),
      sh.invoice ? lnStateLine() : null,
      sh.invoice && K.lnState === 'settled' ? null : qr(sh.label.includes('Lightning') ? sh.text.toUpperCase() : sh.text),
      h('div', { class: 'mono small' }, sh.text),
      h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: () => copy(sh.text) }, 'COPY'),
        sh.offer ? h('button', { class: 'soft', onclick: () => arkDoInline('Disabling the offer…', () => api('ark/offer/disable', {}).then(() => { K.shown = null; render(); })) }, 'DISABLE') : null),
      sh.offer ? h('p', { class: 'faint small' }, 'One code you can share and be paid on many times; each payment lands in Ark. It only works while Kilowallet is running. Each payment pays the Lightning receive cost (about 4 100 sats: recovery reserve plus the server\'s fee); payments under about 5 500 sats fail. A StartOS backup brings this same offer back; the words alone give you a new one. Type an amount first to fix it, or leave it empty so payers choose.') : null,
      sh.label === 'On-chain deposit address' ? h('p', { class: 'faint small' }, 'Plain XBT to this address lands in your Ark deposit (on-chain, not in Ark yet). Then MOVE INTO ARK.') : null) : null);
}

/** Like arkDo, but the progress line stays in the sheet and nothing reloads on success. */
async function arkDoInline(label, fn) {
  K.msg = { text: label, bad: false, busy: true }; render();
  try { await fn(); K.msg = null; } catch (e) { if (e.message !== 'locked') arkErr(e); }
  render();
}

// ------------------------------------------------------------------ cost

function costBox(e, amountLabel, totalLabel) {
  const share = e.total > 0 ? Math.floor(e.fee * 100 / e.total) : 0;
  return h('div', { class: 'panel', style: null },
    h('div', { class: 'between small' }, h('span', { class: 'soft' }, amountLabel), h('span', {}, sats(e.amount) + ' sats')),
    h('div', { class: 'between small' }, h('span', { class: 'soft' }, e.exact ? 'Cost' : 'Cost (approx.)'),
      h('span', { class: share >= 15 ? 'warnc' : '' }, sats(e.fee) + ' sats' + (share > 0 ? `  (${share}% of the total)` : ''))),
    h('div', { class: 'between' }, h('span', { class: 'soft small' }, totalLabel), h('span', { class: 'mid' }, sats(e.total) + ' sats')),
    arkFiat(e.total) ? h('div', { class: 'faint small', style: null }, `${arkFiat(e.total)}  (cost ${arkFiat(e.fee)})`) : null,
    e.note ? h('p', { class: 'faint small' }, e.note) : null);
}

// ------------------------------------------------------------------ send

function arkSend(st) {
  const f = K.send || (K.send = { to: '', amount: '', fromDeposit: false, choose: false, coins: null, picked: new Set(), review: null });
  const b = st.balance || {};
  const reset = () => { f.review = null; };
  const to = h('input', { placeholder: 'Ark address, Lightning invoice or XBT address', value: f.to, oninput: e => { f.to = e.target.value.trim(); reset(); } });
  const amount = h('input', { placeholder: 'sats (empty: the invoice\'s amount, or everything to an XBT address)', inputmode: 'numeric', value: f.amount, oninput: e => { f.amount = e.target.value.replace(/\D/g, ''); reset(); } });
  const pocket = (dep, label) => h('button', { class: 'link' + (f.fromDeposit === dep ? '' : ' faint'), onclick: () => { f.fromDeposit = dep; f.choose = false; f.picked = new Set(); f.coins = null; reset(); render(); } }, label);
  const loadCoins = () => api('ark/coins', { deposit: f.fromDeposit }).then(c => { f.coins = c; render(); }).catch(e => toast(e.message));
  const scan = ('BarcodeDetector' in window) ? h('button', { class: 'link', onclick: () => scanQr(v => { f.to = scannedDestination(v); to.value = f.to; reset(); }) }, '📷 SCAN') : null;
  const contacts = (S.w && S.w.contacts) || [];
  const pick = contacts.length ? h('select', { onchange: e => { if (e.target.value) { f.to = e.target.value; to.value = f.to; reset(); } } },
    h('option', { value: '' }, 'CONTACTS…'), contacts.map(c => h('option', { value: c.address }, `${c.name} · ${short(c.address)}`))) : null;
  const parts = [
    h('div', { class: 'between' }, h('div', { class: 'label' }, f.fromDeposit ? 'Send from the on-chain deposit' : 'Send from Ark'), h('button', { class: 'link faint', onclick: () => { K.sheet = null; K.send = null; render(); } }, 'close')),
    h('div', { class: 'row small' }, h('span', { class: 'soft grow' }, 'From'), pocket(false, 'ARK'), pocket(true, 'DEPOSIT · ' + street(sats((b.onchainConfirmed || 0))))),
    h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: f.choose, onchange: e => { f.choose = e.target.checked; f.picked = new Set(); reset(); if (f.choose) loadCoins(); else render(); } }),
      'Choose coins' + (f.fromDeposit ? '' : ' (Ark payments and withdrawals to an XBT address)')),
    f.choose ? arkCoinPicker(f.coins, f.picked, reset) : null,
    f.fromDeposit ? h('p', { class: 'faint small' }, 'Plain on-chain XBT to an XBT address. Only the network fee; no Ark reserves.') : null,
    h('div', { class: 'row' }, h('div', { class: 'grow' }, to), scan),
    h('div', { class: 'row' }, h('button', { class: 'link', onclick: async () => { try { f.to = scannedDestination(await navigator.clipboard.readText()); to.value = f.to; reset(); } catch { toast('Paste it into the box.'); } } }, 'PASTE'), pick),
    amount, fiatBox(amount, v => { f.amount = v; reset(); })];
  const r = f.review;
  if (!r) parts.push(h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => {
    if (!f.to) return toast('Type where to send.');
    arkDoInline('Calculating the cost…', () => api('ark/estimate', { kind: 'send', to: f.to, amount: Number(f.amount || 0), fromDeposit: f.fromDeposit, choose: f.choose, coins: [...f.picked] })
      .then(e => { f.review = e; }));
  } }, 'REVIEW COST')));
  else {
    if (!r.problem) parts.push(costBox(r, 'They receive', 'You pay in total'));
    if (r.problem) parts.push(h('p', { class: 'warnc small' }, r.problem));
    const pw = arkPw();
    if (!r.problem) parts.push(pw, h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => {
      const body = { to: f.to, amount: Number(f.amount || 0), approved: r.total, fromDeposit: f.fromDeposit, coins: f.choose ? [...f.picked] : [], password: pw.value };
      K.sheet = null; K.send = null;
      arkDo('Sending…', () => api('ark/send', body).then(x => x.message));
    } }, 'CONFIRM AND SEND')));
    parts.push(h('button', { class: 'link faint', onclick: () => { f.review = null; render(); } }, 'change'));
  }
  return h('div', { class: 'panel' }, parts);
}

function arkCoinPicker(coins, picked, onChange) {
  if (!coins) return h('p', { class: 'faint small' }, 'Loading coins…');
  if (!coins.length) return h('p', { class: 'faint small' }, 'No coins here.');
  const sum = h('p', { class: 'soft small' });
  const upd = () => { sum.textContent = `Chosen: ${sats(coins.filter(c => picked.has(c.id)).reduce((a, c) => a + c.amount, 0))} sats in ${picked.size} coin${picked.size === 1 ? '' : 's'}`; };
  upd();
  return h('div', {}, coins.map(c => h('label', { class: 'check small' },
    h('input', { type: 'checkbox', checked: picked.has(c.id), onchange: e => { e.target.checked ? picked.add(c.id) : picked.delete(c.id); onChange(); upd(); } }),
    h('span', { class: 'grow' }, street(sats(c.amount) + ' sats'), h('br'), h('span', { class: 'faint' }, short(c.id) + '  ' + c.note + (c.refused ? ' · ALREADY SPENT (says the server)' : ''))))), sum);
}

/** What to pay from a scanned or pasted code (also inside a lightning:/bitcoin: link; BIP-21 prefers its Ark or Lightning part). */
function scannedDestination(raw) {
  let v = (raw || '').trim();
  const scheme = v.includes(':') ? v.slice(0, v.indexOf(':')).toLowerCase() : '';
  if (scheme === 'lightning') return v.slice(v.indexOf(':') + 1).trim();
  if (scheme === 'bitcoin') {
    const q = v.includes('?') ? v.slice(v.indexOf('?') + 1) : '';
    const p = {}; q.split('&').forEach(kv => { const i = kv.indexOf('='); if (i > 0) p[kv.slice(0, i).toLowerCase()] = decodeURIComponent(kv.slice(i + 1)); });
    if (p.ark) return p.ark; if (p.lno) return p.lno; if (p.lightning) return p.lightning;
    v = v.slice(v.indexOf(':') + 1).split('?')[0];
  }
  return v.trim();
}

// ------------------------------------------------------------------ move into Ark

function arkBoard(st) {
  const f = K.board || (K.board = { amount: '', rate: '', rates: null, review: null });
  const b = st.balance || {};
  const avail = b.onchainConfirmed || 0;
  if (!f.rates) { f.rates = {}; api('ark/fees').then(r => { f.rates = r; if (!f.rate && r.regular) f.rate = String(Math.max(1, r.regular)); render(); }).catch(() => {}); }
  const amount = h('input', { placeholder: 'sats (empty = everything)', inputmode: 'numeric', value: f.amount, oninput: e => { f.amount = e.target.value.replace(/\D/g, ''); f.review = null; } });
  const rate = h('input', { placeholder: 'sat/vB (decimals allowed, at least 0.1)', inputmode: 'decimal', value: f.rate, oninput: e => { f.rate = e.target.value.replace(',', '.'); f.review = null; } });
  const chip = (name, v) => v ? h('button', { class: 'link' + (f.rate === String(Math.max(1, v)) ? '' : ' faint'), onclick: () => { f.rate = String(Math.max(1, v)); f.review = null; render(); } }, name) : null;
  const r = Number(f.rate);
  const parts = [h('div', { class: 'between' }, h('div', { class: 'label' }, 'Move into Ark'), h('button', { class: 'link faint', onclick: () => { K.sheet = null; K.board = null; render(); } }, 'close')),
    h('p', { class: 'small soft' }, `Moves confirmed XBT from your Ark deposit address into Ark. Minimum ${sats(st.limits.minBoard)} sats; spendable after ${st.limits.boardConfs} confirmations. Available: ${street(sats(avail))} sats.`),
    amount,
    h('div', { class: 'row small' }, h('span', { class: 'soft grow' }, 'Network fee'), chip('slow', f.rates.slow), chip('normal', f.rates.regular), chip('fast', f.rates.fast)),
    rate,
    r && r < 1 ? h('p', { class: 'warnc small' }, `Below 1 sat/vB most XBT pools do not mine it yet, so it can take a long time to confirm. The move only counts from its ${st.limits.boardConfs}rd confirmation, and the new coin's 30 days start when you send it: a long wait shortens them.`) : null];
  const ok = avail >= st.limits.minBoard && (!f.amount || Number(f.amount) >= st.limits.minBoard) && r >= 0.1 && r <= 10000;
  if (!f.review) parts.push(h('div', { class: 'btns' }, h('button', { class: 'primary', disabled: !ok, onclick: () =>
    arkDoInline('Calculating the cost…', () => api('ark/estimate', { kind: 'board', amount: Number(f.amount || 0), rate: r }).then(e => { f.review = e; })) }, 'REVIEW COST')));
  else {
    const e = f.review;
    if (e.problem) parts.push(h('p', { class: 'warnc small' }, e.problem));
    else {
      const pw = arkPw();
      parts.push(costBox(e, 'Added to Ark', 'From your deposit'),
        h('p', { class: 'soft small' }, `Your Ark balance after: ${street(sats((b.spendable || 0) + e.amount))} sats (now ${street(sats(b.spendable || 0))} + ${street(sats(e.amount))}).`),
        pw, h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => {
          const body = { amount: Number(f.amount || 0), rate: r, password: pw.value };
          K.sheet = null; K.board = null;
          arkDo('Moving funds into Ark…', () => api('ark/board', body).then(x => x.message));
        } }, 'MOVE INTO ARK')));
    }
    parts.push(h('button', { class: 'link faint', onclick: () => { f.review = null; render(); } }, 'change'));
  }
  if (avail < st.limits.minBoard) parts.push(h('p', { class: 'faint small' }, 'Send XBT to your DEPOSIT address first (RECEIVE → DEPOSIT).'));
  return h('div', { class: 'panel' }, parts);
}

// ------------------------------------------------------------------ renew

async function arkRenewDialog() {
  let quote;
  try { quote = await api('ark/estimate', { kind: 'renew' }); } catch (e) { return toast(e.message); }
  const coins = await api('ark/coins', { deposit: false }).catch(() => []);
  const picked = new Set(coins.filter(c => !c.refused).map(c => c.id));
  const box = h('div', {});
  const show = q => box.replaceChildren(q.problem ? h('p', { class: 'warnc small' }, q.problem) : costBox(q, 'Your coins after', 'Renewed now'));
  show(quote);
  const requote = () => {
    if (picked.size === coins.length) return show(quote);
    if (!picked.size) return show({ problem: 'Tick at least one coin.' });
    api('ark/estimate', { kind: 'renew', coins: [...picked] }).then(show).catch(e => show({ problem: e.message }));
  };
  const pw = arkPw();
  let m;
  m = modal(h('div', { class: 'label' }, 'Renew your Ark coins?'),
    h('p', { class: 'small soft' }, 'Renewing takes your coins into the next round: they get a new expiry, about 30 days from now, and are joined into one coin, which makes later payments cheaper. The engine also renews by itself before coins expire, so you only need this to join coins or to renew early.'),
    coins.length > 1 ? arkCoinPicker(coins, picked, requote) : null,
    box, pw,
    h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: () => m.remove() }, 'CANCEL'),
      h('button', { class: 'primary', onclick: () => {
        if (!picked.size) return toast('Tick at least one coin.');
        const body = { password: pw.value, coins: picked.size === coins.length ? [] : [...picked] };
        m.remove();
        arkDo('Renewing coins… (it waits for the round, up to a few minutes)', () => api('ark/renew', body).then(x => x.message));
      } }, 'RENEW')));
}

// ------------------------------------------------------------------ history

function arkStatus(m, st) {
  if (m.confirmations == null) return m.status;
  return m.kind === 'move into Ark' ? `${m.status} · ${m.confirmations}/${st.limits.boardConfs} conf` : `${m.status} · ${m.confirmations} conf`;
}

function arkHistory(st) {
  const items = st.activity.slice(0, 20);
  // What was left in Ark after each movement, walking back from today's spendable balance.
  let run = (st.balance || {}).spendable || 0;
  const after = {};
  for (const m of items) {
    after[m.id] = run;
    const s = (m.status || '').toLowerCase();
    const eff = ['failed', 'canceled', 'cancelled'].includes(s) || (s === 'pending' && m.amount > 0) || m.id.startsWith('tx:') ? 0 : m.amount;
    run -= eff;
  }
  return h('div', { class: 'panel' }, h('div', { class: 'label' }, 'Ark activity'), h('p', { class: 'faint small' }, 'tap a movement for its details'),
    items.map(m => h('div', { class: 'tx', onclick: () => arkMovement(m, st) },
      h('div', { class: 'between' }, h('span', { class: m.amount >= 0 ? 'in' : 'out' }, street((m.amount >= 0 ? '+' : '') + sats(m.amount) + ' sats')),
        h('span', { class: 'faint small' }, `${m.kind} · ${arkStatus(m, st)}`)),
      m.id.startsWith('tx:') ? null : h('div', { class: 'faint small' }, street(['failed', 'canceled', 'cancelled'].includes((m.status || '').toLowerCase()) ? `(nothing changed: ${sats(after[m.id])} sats left)` : `(left: ${sats(after[m.id])} sats)`)))));
}

function arkMovement(m, st) {
  let md;
  const ex = (S.w && S.w.settings && S.w.settings.explorer) || 'https://mempool.kilombino.com';
  const line = (k, v) => h('p', { class: 'small' }, h('span', { class: 'soft' }, k + ': '), v);
  md = modal(h('div', { class: 'label' }, m.kind.charAt(0).toUpperCase() + m.kind.slice(1)),
    line('Amount', street((m.amount >= 0 ? '+' : '') + sats(m.amount) + ' sats') + (arkFiat(m.amount) ? '  ' + arkFiat(m.amount) : '')),
    m.fee > 0 ? line('Cost', sats(m.fee) + ' sats') : null,
    line('Status', arkStatus(m, st)),
    m.time ? line('Date', m.time.split('.')[0].replace('T', ' ') + ' UTC') : null,
    (m.to || []).map(d => line('To', short(d))),
    m.txid ? h('div', {}, line('On the blockchain', short(m.txid)),
      h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: () => copy(m.txid) }, 'COPY TXID'), h('button', { class: 'soft', onclick: () => window.open(ex + '/tx/' + m.txid, '_blank', 'noopener') }, '🔎 EXPLORER')))
      : h('p', { class: 'faint small' }, 'This movement is off-chain: an Ark coin signed with the server, with no blockchain transaction until the coin is renewed or withdrawn.'),
    (m.vtxos || []).slice(0, 3).map(v => h('p', { class: 'small soft mono', onclick: () => copy(v) }, 'Ark coin: ' + short(v))),
    m.paymentHash ? h('p', { class: 'small soft mono', onclick: () => copy(m.paymentHash) }, 'Payment hash: ' + m.paymentHash.slice(0, 16) + '…') : null,
    m.preimage ? h('p', { class: 'small soft mono', onclick: () => copy(m.preimage) }, 'Preimage (proof of payment): ' + m.preimage.slice(0, 16) + '…') : null,
    (m.vtxos || []).length || m.paymentHash ? h('p', { class: 'faint small' }, 'Tap an identifier to copy it.') : null,
    h('div', { class: 'btns' }, h('button', { class: 'link faint', onclick: () => md.remove() }, 'close')));
}

// ------------------------------------------------------------------ backup, exit, log, notifications

function arkBackupPanel() {
  return h('div', { class: 'panel' }, h('div', { class: 'label' }, 'Backup'),
    h('p', { class: 'small soft' }, 'Words: Ark uses this wallet\'s own words (Settings → Recovery words). With them the Ark server hands your coins back on a new install; history does not come back.'),
    h('p', { class: 'small soft' }, 'StartOS backup: it includes the Ark folder, the server\'s version of the app\'s backup file. It is STILL needed: if the Ark server ever disappears, only that folder lets you take your coins on-chain alone (the emergency exit). Make a backup after each movement or renewal.'),
    h('p', { class: 'small faint' }, 'Never run the same Ark wallet in two places at once (this server and the app with the same words, or two restored copies): the two would spend the same coins and the server refuses one of them. Restoring an old backup brings back coins already spent; the wallet then leaves them out of your balance.'));
}

function arkEmergency(st) {
  const exits = st.exits || [];
  const open = exits.length > 0;
  const startExit = async () => {
    let q; try { q = await api('ark/estimate', { kind: 'exit' }); } catch (e) { return toast(e.message); }
    const typed = h('input', { placeholder: 'type EXIT' }); const pw = arkPw();
    let m;
    m = modal(h('div', { class: 'label badc' }, 'Start the emergency exit?'),
      h('p', { class: 'small soft' }, 'This takes ALL your Ark coins on-chain without the Ark server, using the recovery transactions each coin carries. Only do it if the server has disappeared or will not let you renew. While the server works, a normal withdrawal (SEND to an XBT address) is far cheaper and faster.'),
      h('p', { class: 'small soft' }, 'It cannot be undone once the last transaction is broadcast. It takes about 144 blocks (~1 day) plus confirmations, and Kilowallet must keep running to push it forward. Then you claim the XBT to an address of yours.'),
      q.problem ? h('p', { class: 'badc small' }, q.problem) : h('p', { class: 'small' }, `Estimated cost: ${sats(q.fee)} sats (${q.note}). You get about ${sats(q.amount)} of ${sats(q.total)} sats.`),
      typed, pw,
      h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: () => m.remove() }, 'CANCEL'),
        h('button', { class: 'primary', onclick: () => {
          if (typed.value !== 'EXIT') return toast('Type EXIT to confirm.');
          const body = { confirm: 'EXIT', password: pw.value }; m.remove();
          arkDo('Starting the emergency exit…', () => api('ark/exit/start', body).then(x => x.message));
        } }, 'START EXIT')));
  };
  const dest = h('input', { placeholder: 'your XBT address to receive it' });
  const pw = arkPw();
  const state = e => e.lost ? 'lost: the coin expired and the server swept it' : ({
    claimable: 'ready to claim', 'awaiting-delta': 'waiting the safety delay' + (e.claimableHeight && e.tip ? ` · claimable in ${e.claimableHeight - e.tip} blocks (~${Math.floor((e.claimableHeight - e.tip) * 10 / 60)} h)` : ''),
    processing: 'broadcasting its transactions', claimed: 'claimed', 'claim-in-progress': 'claimed' }[e.type] || e.type);
  return h('details', { class: 'panel', open: open || null }, h('summary', { class: 'label badc' }, 'EMERGENCY EXIT (without the Ark server)'),
    h('p', { class: 'small soft' }, 'Last resort, if ark.paperclippool.xyz disappears or stops renewing your coins: your coins carry signed transactions that let you take them on-chain alone. It is slow (~1 day) and costs on-chain fees. While the server works, withdraw normally instead.'),
    h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: startExit }, 'START EMERGENCY EXIT…')),
    exits.map(e => h('p', { class: 'small' }, short(e.vtxo) + ' · ' + state(e))),
    exits.some(e => e.type === 'claimable') ? h('div', {}, dest, pw, h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: () => {
      const body = { to: dest.value.trim(), password: pw.value };
      arkDo('Claiming…', () => api('ark/exit/claim', body).then(x => x.message));
    } }, 'CLAIM TO THIS ADDRESS'))) : null);
}

function arkLog() {
  return h('details', { class: 'panel' }, h('summary', { class: 'label' }, 'Engine log'),
    h('p', { class: 'faint small' }, 'If a renewal or payment fails, share this with whoever helps you: it says why. It shows coin ids and amounts, never your words.'),
    h('button', { class: 'link', onclick: () => api('ark/log').then(r => {
      if (!r.log) return toast('The Ark engine has not written a log yet.');
      let m; const pre = h('pre', { class: 'small mono log' }, r.log.split('\n').slice(-200).join('\n'));
      m = modal(h('div', { class: 'label' }, 'Ark engine log (end)'), pre,
        h('div', { class: 'btns' }, h('button', { class: 'soft', onclick: () => copy(r.log) }, 'COPY'), h('button', { class: 'link faint', onclick: () => m.remove() }, 'close')));
    }).catch(e => toast(e.message)) }, 'SHOW ENGINE LOG'));
}

function arkNotify() {
  const st = (C.st && C.st.settings) || {};
  const token = h('input', { placeholder: st.telegram_set ? 'bot token (saved; type to replace)' : 'bot token', autocomplete: 'off' });
  const chat = h('input', { placeholder: 'your chat id', value: st.telegram_chat || '', autocomplete: 'off' });
  const out = h('span', { class: 'small soft' });
  return h('details', { class: 'panel' }, h('summary', { class: 'label' }, '🔔 Notifications'),
    h('p', { class: 'small soft' }, 'Ark events (payments in and out, moves into Ark, renewals, withdrawals, deposits, coins close to expiry, and the engine not running) arrive as StartOS notifications, and through your own Telegram bot if you set one: make one with @BotFather, send it any message, and put its token and your chat id here (@userinfobot tells you your id). The same bot gets the coinjoin events.'),
    token, chat,
    h('div', { class: 'row' },
      h('button', { class: 'link', onclick: () => {
        const body = { telegram_chat: chat.value }; if (token.value) body.telegram_token = token.value;
        api('coinjoin/settings', body).then(s => { if (C.st) C.st.settings = s; token.value = ''; out.textContent = 'saved'; }).catch(e => { out.textContent = e.message; });
      } }, 'SAVE'),
      h('button', { class: 'link', onclick: () => { out.textContent = 'sending…'; api('coinjoin/telegram/test', {}).then(() => { out.textContent = 'sent ✓'; }).catch(e => { out.textContent = e.message; }); } }, 'SEND A TEST'),
      out));
}
