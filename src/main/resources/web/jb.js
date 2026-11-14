// PAY THROUGH JOINBLAKET, as the app since 1.6.0: on SEND, the JoinBlaket market (makers with a
// fidelity bond, the smallest and largest amount they take, what a CoinJoin of the typed amount
// would cost) and the button; then the round's sheet (JoinBlaketSheet): where it is, the plan to
// confirm, and how it ended. The round runs on the server: closing the page doesn't stop it.
'use strict';

const J = { m: null, key: '', at: 0, round: null, known: false, dlg: null, body: null, error: null, copied: false };
const JB_EXPLORER = 'https://mempool.kilombino.com/tx/';

/** A plain bc1q address (the CoinJoin's equal outputs are all native SegWit); bcrt1q in a regtest test. */
const jbBc1q = a => /^(bc1q|bcrt1q)[02-9ac-hj-np-z]{38}$/.test((a || '').trim().toLowerCase()) && (a.trim() === a.trim().toLowerCase() || a.trim() === a.trim().toUpperCase());

/** SEND's JoinBlaket block, in [box]: the market for what is typed now, read again every 30 s. */
function jbCheck(f, box, accent) {
  if (!isHot()) { box.replaceChildren(); return; }
  box.jb = { f, accent };
  const amount = Number(f.amount || 0), rate = Number(String(f.rate || '1').replace(',', '.')) || 1;
  const key = amount + '|' + rate;
  jbDraw(box);
  clearTimeout(jbCheck.t);
  if (key === J.key && Date.now() - J.at < 30000) return;
  jbCheck.t = setTimeout(async () => {
    try { J.m = await api('joinblaket', { amount, rate }); J.key = key; J.at = Date.now(); if (J.m.round) J.round = J.m.round; }
    catch { if (!J.m) J.m = { failed: true }; }
    if (box.isConnected) jbDraw(box);
  }, 300);
}
// Makers come and go: the open SEND reads the market again every 30 s (the app's send screen does).
setInterval(() => { const box = document.getElementById('jbbox'); if (box && box.jb && document.visibilityState === 'visible') { J.at = 0; jbCheck(box.jb.f, box, box.jb.accent); } }, 30000);

function jbDraw(box) {
  const { f, accent } = box.jb;
  const m = J.m;
  const small = 'bs c-faint';
  const amt = Number(f.amount || 0);
  const extra = (f.extra || []).length > 0;
  const kids = [spacer(8), t(R('🔀 JoinBlaket'), 'bm', { style: { color: accent } })];
  const read = m && m.read;
  if (!m) kids.push(t('Reading the JoinBlaket market…', small));
  else if (!read && m.failed) kids.push(t("The JoinBlaket market can't be read right now.", small));
  else if (!read) kids.push(t('Reading the JoinBlaket market…', small));
  else if (!m.makers || m.min == null || m.max == null) kids.push(t('No makers with a fidelity bond right now.', small));
  else {
    kids.push(t(`${m.makers === 1 ? `${m.makers} maker with a fidelity bond` : `${m.makers} makers with a fidelity bond`} · minimum ${groupSats(m.min)} sats · maximum ${groupSats(m.max)} sats`, small));
    // The estimate is for the amount the market was last read with (it follows the box within a moment).
    if (amt > 0 && !extra && J.key.startsWith(amt + '|')) {
      const e = m.estimate;
      if (!e) kids.push(t(`No maker takes ${groupSats(amt)} sats: it has to be between the minimum and the maximum.`, 'bs c-warn'));
      else kids.push(t(`For ${groupSats(amt)} sats with ${e.makers} maker${e.makers === 1 ? '' : 's'}: ${groupSats(e.makerFees)} to the makers + about ${groupSats(e.miningFee)} mining fee = about ${groupSats(e.total)} sats`, small));
    }
    if (m.makers === 1) kids.push(t('With a single maker, that maker can link your coin to your payment.', 'bs c-warn'));
  }
  const takes = !!(read && m.takes && J.key.startsWith(amt + '|'));
  const recipientOk = jbBc1q(f.to);
  const running = !!(J.round && !J.round.finished);
  const tor = !!(m && m.tor), torUp = !!(m && m.torUp);
  const ready = read && takes && !extra && amt > 0 && recipientOk && !(m && m.blocker) && !running && tor && torUp && (!f.coinControl || f.coins.size > 0);
  const b = h('button', { class: 'obtn bm', disabled: !ready, style: { color: ready ? accent : COLORS.faint, width: '100%' }, onclick: () => jbPay(f, box) }, '🔀 PAY THROUGH JOINBLAKET');
  kids.push(spacer(4), b);
  let why = null;
  if (m && !tor) why = ['Tor is not available on this server, and the JoinBlaket directory is reached only through Tor.', 'On Umbrel, Tor comes with the system. On StartOS, install the Tor service.'];
  else if (m && !torUp) why = ['Tor does not answer on this server right now, and the JoinBlaket directory is reached only through Tor.'];
  else if (!read || !takes || amt <= 0) why = null;
  else if (extra) why = ['One recipient only: JoinBlaket pays one address per CoinJoin.'];
  else if (!recipientOk) why = ['Only plain bc1q addresses can be paid through JoinBlaket.'];
  else if (m.blocker) why = [m.blocker];
  else if (running) why = ['Another JoinBlaket payment is going: wait for it to end.'];
  else why = ["You confirm the makers' fees and the mining fee before anything is signed. It takes a few minutes, over Tor."];
  if (why) why.forEach(w => kids.push(t(w, small)));
  if (J.error) kids.push(t(J.error, 'bs c-bad'));
  box.replaceChildren(...kids);
}

/** The button: the coins checked first (5 confirmations, 20 % of the amount), then the password, then the round. */
async function jbPay(f, box) {
  J.error = null;
  const req = { to: cleanDest(f.to), amount: Number(f.amount || 0), rate: Number(String(f.rate || '1').replace(',', '.')) || 1,
    coins: f.coinControl ? [...f.coins] : [] };
  try { await api('joinblaket/precheck', req); }
  catch (e) { J.error = e.message; return jbDraw(box); }
  let pw; try { pw = await askPassword('Pay through JoinBlaket', 'Unlock to let the CoinJoin use your coins'); } catch { return; }
  try {
    const r = await api('joinblaket/start', Object.assign({ password: pw }, req));
    J.round = r.round; J.copied = false;
    S.sheet = null; S.form = null; render();
    jbOpen();
  } catch (e) { J.error = e.message; if (box.isConnected) jbDraw(box); }
}

// ------------------------------------------------------------------ the round's sheet

/** The BTC tab's line while a round goes (or just ended) and its sheet is hidden: tap to show it. */
function jbLine(accent) {
  const v = J.round;
  if (!v || J.dlg) return null;
  const c = v.result ? (v.result.kind === 'sent' ? COLORS.good : v.result.kind === 'failed' ? COLORS.bad : COLORS.warn) : accent;
  return panel(accent, row('gap10 tap', v.finished ? null : dot(accent, true),
    weight(t('🔀 Pay through JoinBlaket', 'bm', { style: { color: accent } }), t(v.line, 'bs', { style: { color: c } })),
    tbtn('SHOW', accent, () => jbOpen(), 'bs')).also(() => jbOpen()));
}

function jbOpen() {
  if (J.dlg) return;
  J.body = h('div', { class: 'col gap8' });
  J.dlg = dialog({ title: '🔀 Pay through JoinBlaket', body: [J.body], dismiss: false, onclose: () => { J.dlg = null; J.body = null; if (!busy()) render(); } });
  jbSheet();
}

function jbSheet() {
  const v = J.round, box = J.body;
  if (!box) return;
  if (!v) { J.dlg && J.dlg.close(); return; }
  const accent = COLORS.btc, small = 'bs c-faint', soft = 'bs c-soft';
  const kids = [t(`Paying ${groupSats(v.amount)} sats to ${shortAddress(v.recipient)}`, 'bm c-main')];
  const p = v.plan, r = v.result;
  if (p) {
    kids.push(t('Confirm the CoinJoin', 'bm c-main'),
      t(p.makers.length === 1 ? '1 maker with a fidelity bond' : `${p.makers.length} makers with a fidelity bond`, soft),
      p.makers.map((mk, i) => t(`maker ${i + 1}: fee ${groupSats(mk.fee)} sats`, small)),
      t(`Makers' fees: ${groupSats(p.makerFees)} sats`, soft),
      t(`Mining fee: about ${groupSats(p.miningFeeEstimate)} sats, at most ${groupSats(p.miningFeeMax)} sats (${p.feeRate.toFixed(2)} sat/vB)`, soft),
      t(`Total cost: about ${groupSats(p.totalEstimate)} sats, at most ${groupSats(p.totalMax)} sats`, 'bm', { style: { color: accent } }),
      t(`From ${p.inputs} coin(s) of yours (${groupSats(p.inputTotal)} sats); the change comes back to this wallet.`, small),
      p.makers.length === 1 ? t('With a single maker, that maker can link your coin to your payment.', 'bs c-warn') : null,
      t('Nothing about your coins has left this server yet. If a maker drops out, another may take its place within these fees.', small),
      spacer(4),
      btn('CONFIRM & SIGN', { full: true, cls: 'tm', onclick: e => { e.target.disabled = true; api('joinblaket/answer', { yes: true }).then(jbPoll).catch(er => toast(er.message)); } }),
      tbtn('CANCEL', COLORS.faint, () => api('joinblaket/cancel', {}).then(jbPoll).catch(er => toast(er.message)), 'bs', { full: true }));
  } else if (r) {
    if (r.kind === 'sent') {
      kids.push(t(r.seen ? 'Done: the CoinJoin was broadcast.' : "Sent to the makers; your server doesn't show it yet.", 'bm c-good'),
        t(`${r.makers} maker(s) · makers' fees ${groupSats(r.makerFees)} sats · mining fee ${groupSats(r.txFee)} sats`, soft),
        t(`Total cost: ${groupSats(r.makerFees + r.txFee)} sats`, soft),
        r.change > 0 ? t(`Change back to you: ${groupSats(r.change)} sats`, soft) : null,
        r.vbytes ? t(`Transaction: ${r.vbytes} vB · whole mining fee ${groupSats(r.minerFee)} sats (${(r.minerFee / r.vbytes).toFixed(2)} sat/vB)`, small) : null,
        t(r.viaMaker ? 'Broadcast by a maker.' : 'Broadcast by your server.', small),
        t(R(r.txid), 'bs c-faint brk mono'),
        row('gap8', copyButton('📋 COPY TXID', () => r.txid, accent),
          h('a', { class: 'tbtn', href: JB_EXPLORER + r.txid, target: '_blank', rel: 'noopener noreferrer', style: { '--a': accent, color: accent, textDecoration: 'none' } }, '🔎 EXPLORER')));
    } else if (r.kind === 'failed') {
      kids.push(t(r.reason, 'bm c-bad'), r.detail ? t(R(r.detail), small) : null);
    } else kids.push(t(r.reason, 'bm c-warn'));
    kids.push(spacer(4), btn('CLOSE', { full: true, cls: 'tm', onclick: () => {
      api('joinblaket/dismiss', {}).catch(() => {}); J.round = null; J.dlg && J.dlg.close(); loadWallet().then(() => { if (!busy()) render(); }).catch(() => {});
    } }));
  } else {
    kids.push(row('gap10', dot(accent, true), t(v.line, soft)),
      t('It goes on on this server if you close this page.', small),
      spacer(4),
      row('', v.pastReturn ? h('div', { class: 'grow' }) : tbtn('CANCEL', COLORS.bad, () => api('joinblaket/cancel', {}).then(jbPoll).catch(er => toast(er.message)), 'bs'),
        h('div', { class: 'grow' }), tbtn('HIDE', COLORS.faint, () => J.dlg && J.dlg.close(), 'bs')));
  }
  box.replaceChildren(...kids.flat());
}

/** The round as the server has it now. */
async function jbPoll() {
  if (!S.me || !S.me.unlocked || !isHot()) return;
  let r; try { r = await api('joinblaket/round'); } catch { return; }
  const before = J.round ? J.round.line + '|' + !!J.round.plan + '|' + J.round.finished : '';
  J.round = r.round; J.known = true;
  const now = J.round ? J.round.line + '|' + !!J.round.plan + '|' + J.round.finished : '';
  if (J.dlg) { if (before !== now) jbSheet(); }
  // The plan to confirm, and the outcome, bring the sheet back (as the app's).
  else if (before && before !== now && J.round && (J.round.plan || J.round.finished)) jbOpen();
  else if (before !== now && S.tab === 'btc' && !busy()) render();
}
// A round moves every few seconds; with none going, a look now and then finds one started elsewhere (another tab).
setInterval(() => {
  if (!S.me || !S.me.unlocked || document.visibilityState !== 'visible') return;
  const going = J.round && !J.round.finished;
  if (going || J.dlg || !J.known || Date.now() % 30000 < 2000) jbPoll();
}, 2000);
