// The ARK tab, as the app's ArkScreen: Ark through the Paperclip Ark server, with this wallet's own
// words, its engine running on this server. What the app asks the fingerprint for, this page asks
// the wallet's password for. No inline handlers: the page's CSP forbids them.
'use strict';

const K = { st: null, sheet: null, shown: null, lnState: null, send: null, board: null, msg: null, accept: false, chain: null };

async function loadArk() { K.st = await api('ark'); }

/** "≈ €1.23" for [sats], a third decimal below one unit (Ark amounts are often cents). */
function arkFiat(n) {
  const px = perCoin(S.fiat); if (px == null) return null;
  const v = n * px / 1e8, f = fiatInfo(S.fiat);
  return '≈ ' + fmtFiat(v, S.fiat, Math.abs(v) < 1 && f.dec > 0 ? 3 : f.dec);
}
const arkDays = blocks => (blocks * 10 / 1440).toFixed(1);

async function arkDo(label_, fn) {
  K.msg = { text: label_, busy: true }; render();
  try { const r = await fn(); K.msg = r ? { text: r } : null; } catch (e) { if (e.message !== 'locked' && e.message !== 'cancelled') K.msg = { text: 'Error: ' + e.message, bad: true }; else K.msg = null; }
  await loadArk().catch(() => {});
  render();
}

setInterval(async () => {
  if (!S.me || !S.me.unlocked || S.tab !== 'ark' || document.visibilityState !== 'visible' || busy()) return;
  try { await loadArk(); if (!busy()) render(); } catch {}
}, 15000);
// A Lightning invoice on screen: followed until it is paid, so nobody pays it twice.
setInterval(async () => {
  if (S.tab !== 'ark' || !K.shown || !K.shown.invoice || K.lnState === 'settled' || document.visibilityState !== 'visible') return;
  try {
    const r = await api('ark/invoice/state', { invoice: K.shown.text });
    if (r.state && r.state !== K.lnState) { K.lnState = r.state; render(); }
  } catch {}
}, 4000);

function arkView(accent) {
  const st = K.st;
  const foot = [K.msg ? t(K.msg.text, 'bs', { style: { color: K.msg.busy ? COLORS.warn : K.msg.bad ? COLORS.bad : COLORS.good } }) : null];
  if (!st) return panel(accent, label('Ark', accent), spacer(8), t('Starting the Ark engine…', 'bm c-soft'));
  if (st.blocker) return [panel(accent, label('Ark', accent), spacer(8), explain(st.blocker)), arkWarnings()];
  if (st.activating) return panel(accent, label('Ark', accent), spacer(8), workingLine(accent, 'Creating your Ark wallet…', null,
    "The engine is asking the Ark server for any coins these words already had. It can take a few minutes; this page updates by itself."));
  if (!st.enabled) return [arkWarnings(), arkActivate(st, accent), foot];
  if (!st.running) return [arkDown(st, accent), arkWarnings(), foot];
  const parts = [arkBalance(st, accent)];
  if (st.tipMismatch) parts.push(t('⚠ ' + st.tipMismatch, 'bs c-warn'));
  const sheetBtn = (k, text) => arkButton(text, K.sheet === k, accent, () => { K.sheet = K.sheet === k ? null : k; K.shown = null; K.send = null; K.board = null; render(); });
  parts.push(row('gap8', sheetBtn('receive', 'RECEIVE'), sheetBtn('send', 'SEND')),
    row('gap8', sheetBtn('board', 'MOVE INTO ARK'), arkButton('RENEW', false, accent, () => arkRenewDialog(accent))));
  if (K.sheet === 'receive') parts.push(arkReceive(st, accent));
  if (K.sheet === 'send') parts.push(arkSend(st, accent));
  if (K.sheet === 'board') parts.push(arkBoard(st, accent));
  if ((st.activity || []).length) parts.push(arkHistory(st, accent));
  parts.push(arkBackupPanel(accent), arkEmergency(st, accent), arkLog(accent), arkWarnings(), foot);
  return parts;
}

function arkButton(text, selected, accent, onclick) {
  return btn(text, { kind: selected ? 'fill' : 'soft', grow: true, cls: 'ts', color: accent, onclick, style: { minHeight: '52px' } });
}

// ------------------------------------------------------------------ before activation

function arkWarnings() {
  const l = (K.st && K.st.limits) || { lifetime: 4320, minBoard: 20000, maxVtxo: 1000000, maxLightning: 250000, boardConfs: 3 };
  return panel(COLORS.warn, label('Before you use Ark', COLORS.warn), spacer(8),
    [`Ark funds expire after ${l.lifetime} blocks (about 30 days). The wallet must go online before then to renew them, or they have to be withdrawn on-chain with fees and waiting times.`,
      `Minimum to move funds into Ark: ${groupSats(l.minBoard)} sats.`,
      `Maximum per Ark coin: ${groupSats(l.maxVtxo)} sats.`,
      `Lightning: up to ${groupSats(l.maxLightning)} sats per payment, no channels needed.`,
      'Every Ark payment pre-pays recovery reserves for each coin it uses: about 1 056 sats for a coin spent whole and 1 584 for one with change (4 000 and 6 000 where the server has not enabled its smaller anchors); change must be at least 1 330 sats. Small balances can only leave Ark on-chain. The wallet shows the exact cost before you confirm.',
      `Rounds every 60 seconds; moving funds in needs ${l.boardConfs} confirmations.`,
      "Back up Ark twice: your words (the same as this wallet's) let the Ark server hand your coins back; a StartOS backup of Kilowallet holds the Ark folder, which is what lets you leave Ark on your own if the server ever disappears. Make one after each movement.",
      'Ark is beta software, through the Paperclip Ark server (ark.paperclippool.xyz).'].map(x => [t('•  ' + x, 'bs c-soft'), spacer(6)]));
}

function arkActivate(st, accent) {
  const nodeOk = !st.nodeProblem;
  if (K.chain == null) K.chain = nodeOk ? 'node' : 'esplora';
  const go = btn('ACTIVATE ARK', { full: true, cls: 'tm', color: accent, disabled: !K.accept, onclick: async () => {
    let pw; try { pw = await askPassword('Unlock your wallet', "Make Ark's words from your wallet's"); } catch { return; }
    api('ark/activate', { password: pw, accept: true, chain: K.chain }).then(async () => { await loadArk(); render(); }).catch(e => toast(e.message));
  } });
  return panel(accent,
    checkLine(K.accept, 'I have read the warnings above. Ark is beta software and I will start with a small amount.', accent, () => { K.accept = !K.accept; render(); }),
    spacer(8),
    explain('Ark uses the same words as this wallet, so one set of words backs up both. If these words already had Ark coins (in the Kilowallet app, say), the Ark server hands them back; their history does not come back.'),
    spacer(8), t('Where the Ark engine reads the chain', 'bm c-main'),
    radioLine(K.chain === 'node', 'Your node (recommended)', accent, () => { K.chain = 'node'; render(); }, !nodeOk),
    explain(nodeOk ? 'Over RPC, as Paperclip requires on BTC. Nothing about your wallet leaves your server, except to the Ark server.' : st.nodeProblem),
    radioLine(K.chain === 'esplora', R('mempool.kilombino.com'), accent, () => { K.chain = 'esplora'; render(); }),
    explain('Its Esplora API, as the phone app does. It sees which addresses the Ark engine looks up.'),
    spacer(10), go);
}

function arkDown(st, accent) {
  const why = !st.hasWords ? 'The Ark engine is starting with your words…'
    : st.error ? 'The Ark engine could not start: ' + st.error + ' It tries again by itself.' : 'Starting the Ark engine…';
  return panel(st.error ? COLORS.bad : accent, label(st.error ? 'Ark could not start' : 'Ark', st.error ? COLORS.bad : accent), spacer(8),
    t(why, 'bm', { style: { color: st.error ? COLORS.bad : COLORS.soft } }),
    st.expiry != null ? t(`Last seen: your next Ark coin expires in about ${st.expiry} blocks (≈ ${arkDays(st.expiry)} days). It is only renewed while the engine runs.`, 'bs', { style: { color: st.expiry < st.limits.warnBlocks ? COLORS.bad : COLORS.faint } }) : null,
    tbtn('refresh', accent, () => loadArk().then(render).catch(e => toast(e.message)), 'bs', { style: { alignSelf: 'flex-start' } }));
}

// ------------------------------------------------------------------ balance (ArkBalancePanel)

function pocketRow(lab, n, note, color) {
  return row('', t(lab, 'bs c-soft', { style: { width: '130px', flex: 'none' } }), t(R(street(groupSats(n) + ' sats')), 'bm nowrap', { style: { color } }), hspace(8),
    t(note, 'bs c-faint grow end'));
}

function arkBalance(st, accent) {
  const b = st.balance || {};
  const deposit = (b.onchainConfirmed || 0) + (b.onchainPending || 0);
  const total = (b.spendable || 0) + (b.pendingBoard || 0) + (b.pendingRound || 0) + deposit + (b.lightningPending || 0);
  const boardM = (st.activity || []).find(a => a.kind === 'move into Ark' && a.confirmations != null);
  return panel(accent,
    row('', label('Your Ark wallet', accent), h('div', { class: 'grow' }), streetEye()),
    S.street ? t('STREET MODE', 'hm', { style: { color: accent } })
      : row('bottom wrap', t(R(groupSats(total)), 'dl', { style: { color: accent } }), hspace(8), t('sats', 'tl', { style: { color: accent, opacity: .7, paddingBottom: '6px' } })),
    row('', t(R(street(arkFiat(total) || '≈ –')), 'hs c-main grow'), fiatPicker(accent)),
    b.pendingBoard ? t(R(tr('entering Ark: ') + street(groupSats(b.pendingBoard) + ' sats') + ' · ' + tr(boardM ? `${boardM.confirmations} of ${st.limits.boardConfs} confirmations` : `needs ${st.limits.boardConfs} confirmations`)), 'bs c-warn') : null,
    b.pendingRound ? t(R(tr('in the next round: ') + street(groupSats(b.pendingRound) + ' sats')), 'bs c-warn') : null,
    spacer(6),
    pocketRow('In Ark', b.spendable || 0, 'spendable', COLORS.good),
    b.refused ? t(R(tr('Not counted: ') + street(groupSats(b.refused) + ' sats') + tr(' in coins the server says were already spent earlier (left over from an older wallet state, such as an old backup).')), 'bs c-warn') : null,
    pocketRow('On-chain deposit', deposit, b.onchainPending ? R(street(groupSats(b.onchainPending)) + tr(' unconfirmed · not in Ark yet')) : 'not in Ark yet', COLORS.soft),
    b.lightningPending ? pocketRow('Lightning', b.lightningPending, 'settling', COLORS.warn) : null,
    b.pendingExit ? t(R(tr('leaving Ark (emergency exit): ') + street(groupSats(b.pendingExit) + ' sats')), 'bs c-bad') : null,
    st.expiry != null ? [spacer(6), t(`Next coin expires in ${st.expiry} blocks (≈ ${arkDays(st.expiry)} days). The wallet renews it while it is open; tap RENEW to do it now.`, 'bs', { style: { color: st.expiry < 1008 ? COLORS.bad : COLORS.faint } })] : null);
}

// ------------------------------------------------------------------ receive (ArkReceiveSheet)

function lnStateLine() {
  const s = K.lnState;
  const [x, c] = s === 'settled' ? ["✅ Paid: this invoice is done, it can't be paid again. Create a new one for another payment.", COLORS.good]
    : ['htlcs-ready', 'preimage-revealed', 'delivering'].includes(s) ? ['⏳ Payment arriving…', COLORS.warn] : ['Waiting for payment. Valid for one payment only.', COLORS.faint];
  return t(x, 'bs', { style: { color: c } });
}

function arkReceive(st, accent) {
  const amount = field({ label: 'sats for Lightning', mode: 'numeric', value: K.lnAmount || '', style: { flex: '1 1 0' } });
  const est = h('div', { class: 'col' });
  let tm;
  const quote = () => {
    clearTimeout(tm); const n = Number(amount.input.value.replace(/\D/g, '')); K.lnAmount = amount.input.value;
    if (!n) { est.replaceChildren(); return; }
    tm = setTimeout(() => api('ark/estimate', { kind: 'lnreceive', amount: n }).then(e => {
      est.replaceChildren(spacer(6), costBox(e, 'You receive', 'Invoice amount', accent),
        e.amount < st.limits.minOutput ? t(`Too small: after the receive cost you would get ${groupSats(e.amount)} sats, below the ${groupSats(st.limits.minOutput)}-sat minimum, so the payer's payment would fail.`, 'bs c-bad') : '');
    }).catch(() => est.replaceChildren()), 500);
  };
  amount.input.addEventListener('input', () => { amount.input.value = amount.input.value.replace(/\D/g, ''); quote(); });
  if (K.lnAmount) quote();
  const show = (lab, text, extra) => { K.shown = Object.assign({ label: lab, text }, extra || {}); K.lnState = null; K.msg = null; render(); };
  const get = (msg, path, body, done) => { K.msg = { text: msg, busy: true }; render(); api(path, body).then(done).catch(e => { K.msg = { text: 'Error: ' + e.message, bad: true }; render(); }); };
  const sh = K.shown;
  const paid = sh && sh.invoice && K.lnState === 'settled';
  return panel(accent, label('Receive', accent), spacer(8),
    row('gap6', arkButton('ARK', false, accent, () => get('Getting an Ark address…', 'ark/address', { kind: 'ark' }, r => show('Ark address', r.address))),
      arkButton('DEPOSIT', false, accent, () => get('Getting a deposit address…', 'ark/address', { kind: 'deposit' }, r => show('On-chain deposit address', r.address))),
      arkButton('⚡ OFFER', false, accent, () => { const n = Number(amount.input.value || 0);
        get('Getting your reusable offer…', 'ark/offer', n ? { amount: n } : {}, r => show('Reusable Lightning offer (BOLT12)' + (n ? ` for ${n} sats` : ', any amount'), r.offer, { offer: true })); })),
    spacer(8),
    row('gap6', amount, btn('⚡ INVOICE', { kind: 'soft', cls: 'ts', color: accent, style: { width: '130px', minHeight: '52px', marginTop: '8px' }, onclick: () => {
      const n = Number(amount.input.value || 0);
      if (!n) return toast('Type the amount in sats first.');
      K.shown = null;
      get('Creating a new Lightning invoice… It can take a minute while the wallet finishes other work, such as claiming an earlier payment.', 'ark/invoice', { amount: n }, r => show(`Lightning invoice (${n} sats)`, r.invoice, { invoice: true }));
    } })),
    fiatField(amount, () => quote()),
    t(`Lightning: up to ${groupSats(st.limits.maxLightning)} sats per payment. Deposits become Ark funds with MOVE INTO ARK (minimum ${groupSats(st.limits.minBoard)} sats).`, 'bs c-faint'),
    est,
    sh ? [spacer(10), t(sh.label, 'bs', { style: { color: accent } }), sh.invoice ? lnStateLine() : null, spacer(6),
      paid ? null : h('div', { class: 'row' }, h('div', { class: 'qr', onclick: () => copyText(sh.text) }, qrImg(sh.label.includes('Lightning') ? sh.text.toUpperCase() : sh.text, 230))),
      spacer(6), t(R(sh.text), 'bs c-main brk tap', { onclick: () => copyText(sh.text) }),
      row('', copyButton('COPY', () => sh.text, accent),
        sh.offer ? tbtn('DISABLE', COLORS.soft, () => get('Disabling the offer…', 'ark/offer/disable', {}, () => { K.shown = null; K.msg = null; render(); })) : null),
      sh.offer ? t('One code you can share and be paid on many times; each payment lands in Ark. It only works while Kilowallet is running. Each payment pays the Lightning receive cost (about 4 100 sats: recovery reserve plus the server\'s fee); payments under about 5 500 sats fail. A StartOS backup brings this same offer back; the words alone give you a new one. Type an amount first to fix it, or leave it empty so payers choose.', 'bs c-faint') : null] : null);
}

// ------------------------------------------------------------------ cost (CostBreakdown)

function costBox(e, amountLabel, totalLabel, accent) {
  const share = e.total > 0 ? Math.floor(e.fee * 100 / e.total) : 0;
  return h('div', { class: 'box col' },
    row('', t(amountLabel, 'bs c-soft grow'), t(R(groupSats(e.amount) + ' sats'), 'bs c-main')),
    row('', t(e.exact ? 'Cost' : 'Cost (approx.)', 'bs c-soft grow'), t(R(groupSats(e.fee) + ' sats' + (share > 0 ? tr(`  (${share}% of the total)`) : '')), 'bs', { style: { color: share >= 15 ? COLORS.warn : COLORS.main } })),
    row('', t(totalLabel, 'bs c-soft grow'), t(R(groupSats(e.total) + ' sats'), 'ts', { style: { color: accent } })),
    arkFiat(e.total) ? row('', h('div', { class: 'grow' }), t(R(`${arkFiat(e.total)}  (${tr('cost')} ${arkFiat(e.fee) || ''})`), 'bs c-faint')) : null,
    e.note ? t(e.note, 'bs c-faint') : null);
}

// ------------------------------------------------------------------ send (ArkSendSheet)

function arkCoinPicker(coins, picked, accent, onChange) {
  if (!coins) return t('Loading…', 'bs c-faint');
  if (!coins.length) return t('No coins here.', 'bs c-faint');
  const sum = t('', 'bs c-soft');
  const upd = () => { sum.textContent = tr(`Chosen: ${groupSats(coins.filter(c => picked.has(c.id)).reduce((a, c) => a + c.amount, 0))} sats in ${picked.size} coin${picked.size === 1 ? '' : 's'}`); };
  upd();
  return h('div', { class: 'box col' }, coins.map(c => {
    const mark = t(R(picked.has(c.id) ? '☑' : '☐'), 'tm', { style: { color: accent } });
    return row('rowtap gap8', mark, weight(t(R(street(groupSats(c.amount) + ' sats')), 'bm c-main'),
      t(R(c.id.slice(0, 10) + '…' + c.id.slice(-6) + '  ' + c.note + (c.refused ? tr(' · ALREADY SPENT (says the server)') : '')), 'bs c-faint')))
      .also(() => { picked.has(c.id) ? picked.delete(c.id) : picked.add(c.id); mark.textContent = picked.has(c.id) ? '☑' : '☐'; onChange(); upd(); });
  }), sum);
}

function arkSend(st, accent) {
  const f = K.send || (K.send = { to: '', amount: '', fromDeposit: false, choose: false, coins: null, picked: new Set(), review: null, rate: '' });
  const b = st.balance || {};
  const reset = () => { if (f.review) { f.review = null; render(); } };
  const to = field({ label: 'Ark address, Lightning invoice or BTC address', value: f.to, oninput: v => { f.to = v.trim(); reset(); } });
  const amount = field({ label: "sats (empty: the invoice's amount, or everything to a BTC address)", mode: 'numeric', value: f.amount,
    oninput: (v, el) => { el.value = v.replace(/\D/g, ''); f.amount = el.value; reset(); } });
  const loadCoins = () => api('ark/coins', { deposit: f.fromDeposit }).then(c => { f.coins = c; render(); }).catch(e => toast(e.message));
  const pocket = (dep, text) => chip(text, f.fromDeposit === dep, () => { f.fromDeposit = dep; f.choose = false; f.picked = new Set(); f.coins = null; f.review = null; render(); }, true);
  const isAddr = /^(bc1|bcrt1|tb1|1|3)/i.test(f.to);
  const parts = [label(f.fromDeposit ? 'Send from the on-chain deposit' : 'Send from Ark', accent), spacer(8),
    row('', t('From', 'bs c-soft grow'), pocket(false, tr('ARK')), hspace(6), pocket(true, tr('DEPOSIT') + ' · ' + street(groupSats(b.onchainConfirmed || 0)))),
    checkLine(f.choose, 'Choose coins' + (f.fromDeposit ? '' : ' (Ark payments and withdrawals to a BTC address)'), accent, () => {
      f.choose = !f.choose; f.picked = new Set(); f.review = null; if (f.choose) loadCoins(); else render();
    }, 'bs'),
    f.choose ? arkCoinPicker(f.coins, f.picked, accent, () => { f.review = null; }) : null,
    f.fromDeposit ? t('Plain on-chain BTC to a BTC address. Only the network fee; no Ark reserves.', 'bs c-faint') : null];
  if (!f.fromDeposit && isAddr) parts.push(t("A withdrawal from Ark leaves in the server's next round: its network fee is the round's, shown in the cost.", 'bs c-faint'));
  parts.push(spacer(6), to, contactName(f.to, accent),
    row('', tbtn('PASTE', accent, async () => { try { f.to = scannedDestination(await navigator.clipboard.readText()); to.input.value = f.to; reset(); } catch { toast('Paste it into the box.'); } }),
      hasCamera() ? tbtn(R('📷'), accent, () => scanQr(v => { f.to = scannedDestination(v); to.input.value = f.to; reset(); }), 'tm') : null,
      contactsButton(accent, v => { f.to = v; to.input.value = v; reset(); })),
    amount, fiatField(amount, v => { f.amount = v; reset(); }), spacer(8));
  const r = f.review;
  if (!r) parts.push(btn('REVIEW COST', { full: true, cls: 'tm', color: accent, disabled: !f.to, onclick: () => {
    if (f.choose && !f.picked.size) { f.review = { problem: 'Tick the coins to spend.' }; return render(); }
    K.msg = { text: 'CALCULATING…', busy: true }; render();
    api('ark/estimate', { kind: 'send', to: f.to, amount: Number(f.amount || 0), fromDeposit: f.fromDeposit, choose: f.choose, coins: [...f.picked] })
      .then(e => { f.review = e; K.msg = null; render(); }).catch(e => { K.msg = { text: 'Could not estimate the cost. Check the destination and the amount.', bad: true }; render(); });
  } }));
  else {
    if (!r.problem) parts.push(costBox(r, 'They receive', 'You pay in total', accent));
    parts.push(spacer(8));
    if (r.problem) parts.push(t(r.problem, 'bs c-warn'));
    const fee = Math.max(0, (r.total || 0) - (r.amount || 0));
    const concern = !r.problem && (fee > 100000 || (r.amount > 0 && fee * 100 > r.amount * 5)) ? `This fee is high: ${groupSats(fee)} sats.` : null;
    const gate = { ok: false };
    const send = btn('CONFIRM AND SEND', { full: true, cls: 'tm', color: accent, disabled: !!concern, onclick: async () => {
      let pw; try { pw = await askPassword('Send from Ark', 'Confirm it is you'); } catch { return; }
      const body = { to: f.to, amount: Number(f.amount || 0), approved: r.total, fromDeposit: f.fromDeposit, coins: f.choose ? [...f.picked] : [], password: pw };
      K.sheet = null; K.send = null;
      arkDo('Sending…', () => api('ark/send', body).then(x => x.message));
    } });
    if (concern) parts.push(feeGate(concern, gate, () => { send.disabled = !gate.ok; }));
    if (!r.problem) parts.push(send);
    parts.push(tbtn('change', COLORS.soft, () => { f.review = null; render(); }, null, { style: { alignSelf: 'flex-start' } }));
  }
  return panel(accent, parts);
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

// ------------------------------------------------------------------ move into Ark (ArkBoardSheet)

function arkBoard(st, accent) {
  const f = K.board || (K.board = { amount: '', rate: '', rates: null, review: null });
  const b = st.balance || {};
  const avail = b.onchainConfirmed || 0;
  if (!f.rates) { f.rates = {}; api('ark/fees').then(r => { f.rates = r; if (!f.rate && r.regular) f.rate = String(Math.max(1, r.regular)); render(); }).catch(() => {}); }
  const amount = field({ label: 'sats (empty = everything)', mode: 'numeric', value: f.amount, oninput: (v, el) => { el.value = v.replace(/\D/g, ''); f.amount = el.value; f.review = null; } });
  const rate = field({ label: 'sat/vB (decimals allowed, at least 0.1)', mode: 'decimal', value: f.rate, oninput: v => { f.rate = v.replace(',', '.'); f.review = null; } });
  const r = Number(f.rate);
  const parts = [label('Move into Ark', accent), spacer(6),
    explain(`Moves confirmed BTC from this wallet's deposit address into Ark. Minimum ${groupSats(st.limits.minBoard)} sats; spendable after ${st.limits.boardConfs} confirmations. Available: ${groupSats(avail)} sats.`),
    amount, spacer(6),
    row('', t('Network fee', 'bs c-soft grow'), ...['slow', 'normal', 'fast'].map(n => {
      const v = f.rates[n === 'normal' ? 'regular' : n]; if (!v) return null;
      const val = String(Math.max(1, v)); return [chip(n, f.rate === val, () => { f.rate = val; f.review = null; render(); }), hspace(4)];
    })),
    rate,
    r && r < 1 ? t(`Below 1 sat/vB most BTC pools do not mine it yet, so it can take a long time to confirm. The move only counts from its ${st.limits.boardConfs}rd confirmation, and the new coin's 30 days start when you send it: a long wait shortens them.`, 'bs c-warn') : null,
    spacer(8)];
  const ok = avail >= st.limits.minBoard && (!f.amount || Number(f.amount) >= st.limits.minBoard) && r >= 0.1 && r <= 10000;
  if (f.review && !f.review.problem) parts.push(costBox(f.review, 'Added to Ark', 'From your deposit', accent),
    t(`Your Ark balance after: ${groupSats((b.spendable || 0) + f.review.amount)} sats (now ${groupSats(b.spendable || 0)} + ${groupSats(f.review.amount)}).`, 'bs c-soft'), spacer(8));
  if (f.review && f.review.problem) parts.push(t(f.review.problem, 'bs c-warn'));
  if (!f.review) parts.push(btn('REVIEW COST', { full: true, cls: 'tm', color: accent, disabled: !ok, onclick: () => {
    api('ark/estimate', { kind: 'board', amount: Number(f.amount || 0), rate: r }).then(e => { f.review = e; render(); }).catch(e => toast(e.message));
  } }));
  else if (!f.review.problem) {
    const high = r > 100, gate = { ok: false };
    const go = btn('MOVE INTO ARK', { full: true, cls: 'tm', color: accent, disabled: high, onclick: async () => {
      let pw; try { pw = await askPassword('Move into Ark', 'Confirm it is you'); } catch { return; }
      const body = { amount: Number(f.amount || 0), rate: r, password: pw };
      K.sheet = null; K.board = null;
      arkDo('Moving funds into Ark…', () => api('ark/board', body).then(x => x.message));
    } });
    if (high) parts.push(feeGate(`This fee is high: ${f.rate} sat/vB.`, gate, () => { go.disabled = !gate.ok; }));
    parts.push(go);
  }
  if (f.review) parts.push(tbtn('change', COLORS.soft, () => { f.review = null; render(); }, null, { style: { alignSelf: 'flex-start' } }));
  return panel(accent, parts);
}

// ------------------------------------------------------------------ renew (ArkRenewDialog)

async function arkRenewDialog(accent) {
  K.msg = { text: 'Calculating the renewal cost…', busy: true }; render();
  let quote;
  try { quote = await api('ark/estimate', { kind: 'renew' }); } catch (e) { quote = { problem: 'Could not calculate the cost. Try again in a moment.' }; }
  K.msg = null; render();
  const coins = await api('ark/coins', { deposit: false }).catch(() => []);
  const picked = new Set(coins.filter(c => !c.refused).map(c => c.id));
  const box = h('div', { class: 'col' });
  const show = q => box.replaceChildren(q.problem ? t(q.problem, 'bs c-warn') : costBox(Object.assign({}, q, { exact: true }), 'Your coins after', 'Renewed now', accent));
  show(quote);
  const requote = () => {
    if (picked.size === coins.length) return show(quote);
    if (!picked.size) return show({ problem: 'Tick at least one coin.' });
    api('ark/estimate', { kind: 'renew', coins: [...picked] }).then(show).catch(() => show({ problem: 'Could not calculate the cost.' }));
  };
  const d = dialog({ title: 'Renew your Ark coins?', body: [
    t('Renewing takes your coins into the next round: they get a new expiry, about 30 days from now, and are joined into one coin, which makes later payments cheaper. The wallet also renews by itself before coins expire, so you only need this to join coins or to renew early.', 'bs'),
    coins.length > 1 ? arkCoinPicker(coins, picked, accent, requote) : null, box],
  buttons: [tbtn('CANCEL', COLORS.soft, () => d.close()), quote.problem ? null : tbtn('RENEW', accent, async () => {
    if (!picked.size) return;
    d.close();
    let pw; try { pw = await askPassword('Renew Ark coins', 'Confirm it is you'); } catch { return; }
    arkDo('Renewing coins…', () => api('ark/renew', { password: pw, coins: picked.size === coins.length ? [] : [...picked] }).then(x => x.message));
  })] });
}

// ------------------------------------------------------------------ history (ArkHistory)

function arkStatus(m, st) {
  if (m.confirmations == null) return m.status;
  return m.kind === 'move into Ark' ? `${m.status} · ${m.confirmations}/${st.limits.boardConfs} conf`
    : m.kind === 'withdrawal' ? (m.confirmations === 0 ? 'sent, in the mempool' : 'sent') + ` · ${m.confirmations}/1 conf` : `${m.status} · ${m.confirmations} conf`;
}

function arkHistory(st, accent) {
  const items = st.activity.slice(0, 20);
  let run = (st.balance || {}).spendable || 0;
  const after = {};
  for (const m of items) {
    if (m.kind === 'deposit received' || m.kind === 'sent from deposit') continue;
    after[m.id] = run;
    const s = (m.status || '').toLowerCase();
    run -= ['failed', 'canceled', 'cancelled'].includes(s) || (s === 'pending' && m.amount > 0) ? 0 : m.amount;
  }
  return panel(accent, label('Ark activity', accent), spacer(4), t('tap a movement for its details', 'bs c-faint'), spacer(6),
    items.map(m => col('rowtap', row('', t(R(street((m.amount >= 0 ? '+' : '') + groupSats(m.amount) + ' sats')), 'bs grow', { style: { color: m.amount >= 0 ? COLORS.good : COLORS.main } }),
      t(R(tr(m.kind) + ' · ' + tr(arkStatus(m, st))), 'bs c-faint')),
    after[m.id] != null ? t(street(['failed', 'canceled', 'cancelled'].includes((m.status || '').toLowerCase()) ? `(nothing changed: ${groupSats(after[m.id])} sats left)` : `(left: ${groupSats(after[m.id])} sats)`), 'bs c-soft') : null,
    spacer(4)).also(() => arkMovement(m, st, accent))));
}

function arkMovement(m, st, accent) {
  const site = explorer().replace(/^https?:\/\//, '');
  const line = (k, v) => t(R(tr(k) + ': ' + v), 'bs');
  const d = dialog({ title: R(tr(m.kind.charAt(0).toUpperCase() + m.kind.slice(1))), body: [
    line('Amount', street((m.amount >= 0 ? '+' : '') + groupSats(m.amount) + ' sats') + (arkFiat(m.amount) ? '  ' + arkFiat(m.amount) : '')),
    m.fee > 0 ? line('Cost', groupSats(m.fee) + ' sats' + (arkFiat(m.fee) ? '  ' + arkFiat(m.fee) : '')) : null,
    line('Status', tr(arkStatus(m, st))),
    m.time ? line('Date', m.time.split('.')[0].replace('T', ' ') + ' UTC') : null,
    (m.to || []).map(x => line('To', x.slice(0, 24) + '…' + x.slice(-8))),
    m.txid ? [t(R(tr('On the blockchain: ') + m.txid.slice(0, 12) + '…' + m.txid.slice(-8)), 'bs'), t(`Opening it shows ${site} which transaction you look up.`, 'bs c-faint')]
      : t('This movement is off-chain: an Ark coin signed with the server, with no blockchain transaction until the coin is renewed or withdrawn.', 'bs c-faint'),
    (m.vtxos || []).slice(0, 3).map(v => t(R(tr('Ark coin: ') + v.slice(0, 12) + '…' + v.slice(-10)), 'bs c-soft tap', { onclick: () => copyText(v) })),
    m.paymentHash ? t(R(tr('Payment hash: ') + m.paymentHash.slice(0, 16) + '…'), 'bs c-soft tap', { onclick: () => copyText(m.paymentHash) }) : null,
    m.preimage ? t(R(tr('Preimage (proof of payment): ') + m.preimage.slice(0, 16) + '…'), 'bs c-soft tap', { onclick: () => copyText(m.preimage) }) : null,
    (m.vtxos || []).length || m.paymentHash ? t('Tap an identifier to copy it.', 'bs c-faint') : null],
  buttons: m.txid ? [tbtn('CLOSE', COLORS.soft, () => d.close()), tbtn(R(tr('OPEN ON ') + site.toUpperCase()), accent, () => { d.close(); window.open(explorer() + '/tx/' + m.txid, '_blank', 'noopener'); })]
    : [tbtn('CLOSE', accent, () => d.close())] });
}

// ------------------------------------------------------------------ backup, exit, log

function arkBackupPanel(accent) {
  return panel(accent, label('Backup', accent),
    t("Your words: Ark uses this wallet's own words (settings → RECOVERY WORDS). With them the Ark server hands your coins back on a new install; history does not come back.", 'bs c-soft'),
    spacer(4),
    explain("A StartOS backup of Kilowallet includes the Ark folder, this server's backup file. It is STILL needed: if the Ark server ever disappears, only that folder lets you take your coins on-chain alone (the emergency exit). Make a backup after each movement or renewal."),
    spacer(4),
    explain('Never run the same Ark wallet in two places at once (this server and the app with the same words, or two restored copies): the two would spend the same coins and the server refuses one of them.'));
}

function arkEmergency(st, accent) {
  const exits = st.exits || [];
  K.exitOpen = K.exitOpen || exits.length > 0;
  const head = tbtn(R((K.exitOpen ? '▾ ' : '▸ ') + tr('EMERGENCY EXIT (without the Ark server)')), COLORS.ark, () => { K.exitOpen = !K.exitOpen; render(); }, null, { full: true, style: { justifyContent: 'center' } });
  if (!K.exitOpen) return panel(accent, head);
  const startExit = async () => {
    let q; try { q = await api('ark/estimate', { kind: 'exit' }); } catch (e) { return toast(e.message); }
    const typed = field({ label: R('EXIT'), cls: 'ondlg', oninput: (v, el) => { el.value = v.toUpperCase(); go.disabled = el.value !== 'EXIT'; go.style.color = el.value === 'EXIT' ? COLORS.bad : COLORS.faint; } });
    const go = tbtn('START EXIT', COLORS.faint, async () => {
      d.close();
      let pw; try { pw = await askPassword('Emergency exit', 'Confirm it is you'); } catch { return; }
      arkDo('Starting the emergency exit…', () => api('ark/exit/start', { confirm: 'EXIT', password: pw }).then(x => x.message));
    });
    go.disabled = true;
    const d = dialog({ title: 'Start the emergency exit?', body: [
      t('This takes ALL your Ark coins on-chain without the Ark server, using the recovery transactions each coin carries. Only do it if the server has disappeared or will not let you renew. While the server works, a normal withdrawal (SEND to a BTC address) is far cheaper and faster.', 'bs'),
      t('It cannot be undone once the last transaction is broadcast. It takes about 144 blocks (~1 day) plus confirmations, and the wallet must stay running to push it forward. Then you claim the BTC to an address of yours.', 'bs c-warn'),
      q.problem ? t(q.problem, 'bs c-bad') : t(`Estimated cost: ${groupSats(q.fee)} sats (${q.note}). You get about ${groupSats(q.amount)} of ${groupSats(q.total)} sats.`, 'bs'),
      t('Type EXIT to confirm.', 'bs'), typed],
    buttons: [tbtn('CANCEL', COLORS.soft, () => d.close()), go] });
  };
  const state = e => e.lost ? 'lost: the coin expired and the server swept it' : ({
    claimable: 'ready to claim', 'awaiting-delta': 'waiting the safety delay' + (e.claimableHeight && e.tip ? ` · claimable in ${e.claimableHeight - e.tip} blocks (~${Math.floor((e.claimableHeight - e.tip) * 10 / 60)} h)` : ''),
    processing: 'broadcasting its transactions', claimed: 'claimed', 'claim-in-progress': 'claimed' }[e.type] || e.type);
  const dest = field({ label: 'your BTC address to receive it' });
  return panel(accent, head,
    explain('Last resort, if ark.paperclippool.xyz disappears or stops renewing your coins: your coins carry signed transactions that let you take them on-chain alone. It is slow (~1 day) and costs on-chain fees. While the server works, withdraw normally instead.'),
    spacer(6), btn('START EMERGENCY EXIT…', { kind: 'soft', full: true, color: COLORS.bad, onclick: startExit }),
    exits.map(e => t(R(shortAddress(e.vtxo) + ' · ' + tr(state(e))), 'bs c-main')),
    exits.some(e => e.type === 'claimable') ? [dest, btn('CLAIM TO THIS ADDRESS', { full: true, color: accent, onclick: async () => {
      let pw; try { pw = await askPassword('Emergency exit', 'Confirm it is you'); } catch { return; }
      arkDo('Claiming…', () => api('ark/exit/claim', { to: dest.input.value.trim(), password: pw }).then(x => x.message));
    } })] : null);
}

function arkLog(accent) {
  return panel(accent, label('Engine log', accent), spacer(4),
    t('If a renewal or payment fails, share this with whoever helps you: it says why. It shows coin ids and amounts, never your words.', 'bs c-faint'),
    tbtn('SHOW ENGINE LOG', accent, () => api('ark/log').then(r => {
      if (!r.log) return toast('The Ark engine has not written a log yet.');
      const d = dialog({ title: 'Engine log', body: [h('pre', { class: 'log' }, R(r.log.split('\n').slice(-200).join('\n')))],
        buttons: [copyButton('COPY', () => r.log, accent), tbtn('CLOSE', COLORS.soft, () => d.close())] });
    }).catch(e => toast(e.message)), null, { style: { alignSelf: 'flex-start' } }));
}
