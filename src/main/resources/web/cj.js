// The COINJOIN tab, as the app's CoinjoinScreen: POOLS · IN PROGRESS · HISTORY, the round cards with
// their five steps, opening and joining pools, the perfect coin. The rounds run on this server;
// what the app asks the fingerprint for, this page asks the wallet's password for.
'use strict';

const C = { st: null, pools: null, loading: false, msg: null, create: null, join: null, pick: null, chosen: [], exact: null, open: {} };
const inVb = t => (t === 'p2tr' ? 57.75 : 68), outVb = t => (t === 'p2tr' ? 43 : 31);
const cjType = () => (C.pick && C.pick.script) || (C.create && C.create.script) || (C.st && C.st.script) || 'p2wpkh';
const kindName = t => (t === 'p2tr' ? 'Taproot (bc1p)' : 'native SegWit (bc1q)');
const feeShare = (rate, withChange, n = 1, t = cjType(), o = 1) => Math.ceil(rate * (inVb(t) * n + outVb(t) * o + (withChange ? outVb(t) : 0) + 10.5 / 2));
const poolAmount = (amount, o) => (o > 1 ? o + ' × ' : '') + groupSats(amount);
const poolKind = t => (t === 'p2tr' ? ' · Taproot' : '');
function remaining(at) {
  const s = Math.floor(at - Date.now() / 1000);
  if (s <= 0) return 'now';
  return s < 3600 ? Math.floor(s / 60) + ' min' : Math.floor(s / 3600) + ' h ' + Math.floor((s % 3600) / 60) + ' min';
}
const hhmm = at => new Date(at * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const cjOpen = () => C.st && C.st.enabled && !C.st.blocker;

async function loadCoinjoin() { C.st = await api('coinjoin'); }

async function reloadPools() {
  if (C.loading || !cjOpen()) return;
  C.loading = true; if (!busy()) render();
  try { C.pools = await api('coinjoin/pools'); }
  // A failed look keeps the list it had: an empty screen would read as "no pools".
  catch (e) { if (e.message !== 'locked') C.msg = 'Could not reach the relay: ' + e.message; }
  C.loading = false;
  if (!busy()) render();
}

function startCoinjoinTimers() {
  // Rounds move on their own: the tab follows them every few seconds, the open pools every minute.
  setInterval(async () => {
    if (!S.me || !S.me.unlocked || S.tab !== 'coinjoin' || document.visibilityState !== 'visible') return;
    try { await loadCoinjoin(); if (!busy()) render(); } catch {}
  }, 5000);
  setInterval(() => { if (S.me && S.me.unlocked && S.tab === 'coinjoin' && document.visibilityState === 'visible') reloadPools(); }, 60000);
  setInterval(pollEvents, 5000);
  // The cards' countdowns.
  setInterval(() => document.querySelectorAll('[data-deadline]').forEach(el => {
    const left = Number(el.dataset.deadline) - Math.floor(Date.now() / 1000);
    el.textContent = (left > 0 ? `${Math.floor(left / 3600)}:${String(Math.floor(left % 3600 / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')} ` : '') + el.dataset.arrow;
  }), 1000);
}

/**
 * What coinjoin is, before using it (CoinjoinIntro): in the tab until accepted, and once to a new
 * spending wallet. [after] runs once answered.
 */
function coinjoinIntro(accent, after, declineLabel, onDecline) {
  const min = groupSats(((C.st && C.st.limits) || {}).minAmount || 10000);
  const answer = (on, notify) => api('coinjoin/enable', { on, notify }).then(r => { C.st = r; after && after(); render(); if (on) reloadPools(); }).catch(e => toast(e.message));
  return panel(accent, label('Coinjoin · mix your coins', accent), spacer(8),
    t('Are you interested in coinjoins?', 'tm c-main'), spacer(8),
    explain("A coinjoin puts your coin in one transaction with other people's. Everyone gets back an output of exactly the same amount, so nobody watching the chain can tell whose is whose."),
    spacer(6),
    explain(R([`• Someone opens a pool (from ${min} sats each to 1 BTC per output) and others join with one coin.\n`,
      '• With enough people in, anyone asks to close and the rest accept.\n',
      '• This server checks the transaction and you sign with your password. Nobody holds your ',
      'coins: the relay only passes encrypted messages.\n',
      '• Each person pays their own share of the fee.\n',
      '• Signed so it is valid only on BTC, never on the spamchain.'].map(tr).join(''))),
    spacer(6),
    explain('If you accept, the COINJOIN tab opens up and you will be notified of open pools — and nothing else. You can turn the notifications off any time in settings.'),
    spacer(12),
    row('gap8', btn(declineLabel || 'NOT NOW', { kind: 'soft', grow: true, color: COLORS.soft, onclick: () => { if (onDecline) onDecline(); else { S.tab = 'btc'; render(); } } }),
      btn('YES, NOTIFY ME', { grow: true, color: accent, onclick: () => answer(true, true) })),
    tbtn('OPEN WITHOUT NOTIFICATIONS', accent, () => answer(true, false), null, { full: true }));
}

function coinjoinScreen(accent) {
  const st = C.st;
  if (!st) return panel(accent, t('reading your coins…', 'bs c-soft'));
  if (!st.enabled) return coinjoinIntro(accent);
  if (st.blocker) return panel(accent, label('Coinjoin', accent), spacer(8), explain(st.blocker));
  const parts = [];
  if (C.msg) parts.push(panel(COLORS.warn, t(C.msg, 'bs c-warn'), tbtn('ok', COLORS.soft, () => { C.msg = null; render(); }, null, { style: { alignSelf: 'flex-start' } })));
  if (C.exact) { parts.push(exactCoinPanel(accent)); return parts; }
  if (C.pick) { if (C.join && C.join.pool.private) parts.push(privatePoolPanel(accent)); parts.push(coinPicker(accent)); return parts; }
  if (C.create) { parts.push(C.create.confirm ? createConfirm(accent) : createForm(accent)); return parts; }
  const mine = st.mine || [];
  const over = p => ['CONFIRMED', 'ABORTED', 'REJECTED'].includes(p.phase);
  const active = mine.filter(p => !over(p)), finished = mine.filter(over);
  const waiting = st.waitingExact || [];
  if (C.cjTab == null) C.cjTab = active.length || waiting.length ? 1 : 0;
  parts.push(h('div', { class: 'subtabs', style: { '--a': accent } }, ['POOLS', 'IN PROGRESS', 'HISTORY'].map((l, i) =>
    h('div', { class: (C.cjTab === i ? 'on ' : '') + 'lM', onclick: () => { C.cjTab = i; render(); } }, l,
      i === 1 && active.length + waiting.length ? h('span', { class: 'count' }, R(String(active.length + waiting.length))) : null))));
  if (C.cjTab === 1) {
    if (!active.length && !waiting.length) parts.push(explain('No rounds going. Join a pool, or open your own, in JOIN.'));
    waiting.forEach(x => parts.push(perfectCoinCard(x, accent)));
    active.forEach(p => parts.push(roundCard(p, accent)));
    return parts;
  }
  if (C.cjTab === 2) {
    if (!finished.length) parts.push(explain('Confirmed and cancelled rounds show here, for a week.'));
    else parts.push(finished.map(p => roundCard(p, accent)),
      tbtn('remove all', COLORS.faint, async () => { for (const p of finished) await api('coinjoin/remove', { pool: p.id }).catch(() => {}); await loadCoinjoin(); render(); }, 'bs', { style: { alignSelf: 'flex-start' } }));
    return parts;
  }
  parts.push(btn('＋  OPEN A POOL', { full: true, cls: 'tm', color: accent, onclick: () => {
    // From your coins (the default): whole coins ticked, the amount worked out so there is no change.
    C.create = { fromCoins: true, picked: [], amount: '100000', rate: '1', min: '2', max: '5', hours: '6', inputs: '5', outputs: '1', password: '', script: C.st.segwit === false ? 'p2tr' : 'p2wpkh' };
    render(); window.scrollTo(0, 0);
  } }));
  parts.push(openPools(mine, accent));
  parts.push(panel(accent, label('Coinjoin', accent), spacer(8),
    explain("Mix your coins with other people's: everyone puts one or more coins in and gets back an output of exactly the pool's amount, all identical, so nobody watching the chain can tell whose is whose. A pool is either native SegWit (bc1q) or Taproot (bc1p), never both, so no coin stands out. Each person pays their own share of the fee from their change. No server ever holds your coins: the relay only passes encrypted messages, and you sign only after checking your output." +
      "\n\nPools marked \"blind outputs\" (Kilojoin v3, every pool this version opens): each output is signed blindly by the pool's creator and handed in from a fresh key over a connection of its own, so neither the relay, nor the other members, nor the creator can tell whose output is whose, and only the creator's own key runs the pool. In older pools the relay's operator together with one member could tell. Either way the relay sees which connection sends what (over Tor only when Tor is already on).")));
  parts.push(panel(accent, autoSetting(accent)), telegramPanel(accent), destinationsPanel(accent),
    panel(accent, label('How a round goes', accent), spacer(8),
      explain(`1. Someone opens a pool with an amount and an address type. 2. People join, each proving they own real coins of that type (one seat per coin: a coin can't sit twice, but one person with several coins can take several seats, so the others in a pool are not proven to be other people). 3. With two or more in, anyone can ask to close: the others accept or refuse; whoever does not answer in ${st.limits.voteMinutes} minutes is left out. 4. Each wallet posts its mixed output with no name on it, after a random wait. 5. Every wallet builds the same transaction, checks its own output and change, and signs: on its own if you chose so above (one password when joining), otherwise with your password. 6. Once all have signed it goes out — signed so it is valid only on this chain, never on the spamchain. This server keeps the round going while the page is closed.`),
      spacer(6), t(R('Relay: ' + st.relay), 'bs c-faint')));
  return parts;
}

/** What kind of pool it is, in one line (poolTypeLine). */
function poolTypeLine(t_) {
  return (t_.script === 'p2tr' ? 'Taproot (bc1p) coins only' : 'Native SegWit (bc1q) coins only') +
    (t_.maxInputs > 1 ? ` · up to ${t_.maxInputs} coins each` : ' · one coin each') +
    (t_.v5 ? ' · ' + (t_.outputs > 1 ? `a payment pool (v5): the creator pays ${(t_.payments || []).length} recipient(s); you get ${groupSats(t_.mixTotal)} in ${t_.outputs} equal outputs`
      : `a payment pool (v5): the creator pays ${(t_.payments || []).length} recipient(s); you get ${groupSats(t_.mixTotal)} in one output`)
      : t_.outputs > 1 ? ` · ${t_.outputs} outputs each (v4)` : t_.version >= 3 ? ' · blind outputs (v3)' : '');
}

function openPools(mine, accent) {
  // Only rounds still running hide their pool: one that ended or was left shows again to rejoin.
  const ours = new Set(mine.filter(m => !['ABORTED', 'REJECTED', 'CONFIRMED', 'BROADCAST'].includes(m.phase)).map(m => m.id));
  const shown = (C.pools || []).filter(p => !ours.has(p.id) && !p.test);
  return [row('', label('Open pools', accent), h('div', { class: 'grow' }), tbtn(C.loading ? 'looking…' : 'refresh', COLORS.soft, () => reloadPools(), 'bs')),
    C.pools !== null && !shown.length ? explain('No open pools right now. Open one and others will be notified.') : null,
    shown.map(p => panel(accent, row('', weight(
      t(R((p.private ? '🔒 ' : '') + `${poolAmount(p.amount, p.outputs)} sats`), 'tm c-main'),
      t(poolTypeLine(p), 'bs', { style: { color: accent } }),
      t(`${p.peers}/${p.maxPeers} people (min ${p.minPeers}) · ${p.feeRate.toFixed(1)} sat/vB · closes in ${remaining(p.expiresAt)}`, 'bs c-soft'),
      t(`joining costs you ${p.feeWithChange} sats in fees with one coin (${p.feeNoChange} with a coin of exactly ${groupSats(p.mixTotal + p.feeNoChange)})`, 'bs c-faint'),
      p.joinable ? null : t('Taproot pool: turn on Taproot addresses in settings to join it.', 'bs c-warn')),
    btn('JOIN', { kind: 'soft', disabled: !p.joinable, color: accent, onclick: () => {
      C.join = { pool: p, password: '' };
      C.pick = { title: `Join · ${poolAmount(p.amount, p.outputs)} sats${poolKind(p.script)}`, amount: p.amount, rate: p.feeRate, maxInputs: p.maxInputs, script: p.script, outputs: p.outputs || 1 };
      C.chosen = []; render(); window.scrollTo(0, 0);
    } }))))];
}

function privatePoolPanel(accent) {
  return panel(accent, label('🔒 Private pool', accent), spacer(6),
    explain('Its creator shares the password with the people invited. Without it the pool refuses you.'),
    field({ label: 'pool password', size: 'bm', value: C.join.password, oninput: v => { C.join.password = v; } }));
}

// ---- round cards

function roundStep(p) { return { JOINING: 1, OPEN: 1, VOTING: 2, CLOSING: 3, SIGNING: 3, BROADCAST: 4, CONFIRMED: 5 }[p.phase] || 0; }
/** True while the round waits on you: an answer, or a signature by hand. */
function needsMe(p) {
  if ((C.st.settings || {}).auto_sign) return false;
  return (p.phase === 'VOTING' && !p.iAsked && !p.voted) || (p.phase === 'SIGNING' && !p.signed);
}
function roundSteps(step, accent) {
  const kids = [];
  for (let i = 1; i <= 5; i++) {
    kids.push(h('span', { class: 's' + (i < step || step === 5 ? ' done' : i === step ? ' now' : ''), style: i === step && step < 5 ? { background: accent, borderColor: accent } : null }));
    if (i < 5) kids.push(h('span', { class: 'bar' + (i < step ? ' done' : '') }));
  }
  return h('div', { class: 'steps' }, kids);
}
/** "📅 Sent 28 Oct 2026, 10:42 · confirmed 10:51", as HISTORY shows it. */
function timesOf(p) {
  const loc = I18N.lang === 'zh' ? 'zh-CN' : I18N.lang;
  const day = at => new Date(at * 1000).toLocaleString(loc, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const same = (a, b) => new Date(a * 1000).toDateString() === new Date(b * 1000).toDateString();
  const s = p.sentAt, e = p.endedAt;
  switch (p.phase) {
    case 'BROADCAST': return s ? `📅 Sent ${day(s)}` : null;
    case 'CONFIRMED': return s && e ? `📅 Sent ${day(s)} · confirmed ${same(s, e) ? hhmm(e) : day(e)}` : s ? `📅 Sent ${day(s)}` : e ? `📅 Confirmed ${day(e)}` : null;
    case 'ABORTED': return e ? `📅 Cancelled ${day(e)}` : null;
    case 'REJECTED': return e ? `📅 Refused ${day(e)}` : null;
  }
  return null;
}

/** One round at a glance: amount, the bar of its five steps, what is happening and where your coin is (RoundCard). */
function roundCard(p, accent) {
  const step = roundStep(p), ended = step === 0;
  const color = ended ? COLORS.bad : step === 5 ? COLORS.good : accent;
  const open = p.id in C.open ? C.open[p.id] : needsMe(p);
  const status = {
    JOINING: 'Asking to join',
    OPEN: `Waiting for people · ${p.people}/${p.maxPeers} people · closes at ${hhmm(p.expiresAt)}`,
    VOTING: needsMe(p) ? `Closing vote · your answer, by ${hhmm(p.voteDeadline)}` : `Closing vote · ${p.people} people`,
    CLOSING: `Closing · ${p.people} people · collecting outputs`,
    SIGNING: p.signed ? 'Signed · waiting for the others' : needsMe(p) ? 'Ready to sign' : 'Signing',
    BROADCAST: 'Sent · waiting for a block', CONFIRMED: 'Confirmed', ABORTED: 'Cancelled', REJECTED: 'Refused',
  }[p.phase] || p.phase;
  const pay = p.pay;
  const where = p.phase === 'BROADCAST' ? (pay ? 'The payment left in the group transaction. Waiting for a block.' : 'Your coin left in the group transaction. Waiting for a block.')
    : p.phase === 'CONFIRMED' ? (pay ? `Done: paid ${groupSats(p.mixTotal)} sats to the recipients.`
      : p.outputs > 1 ? `Done: your ${p.outputs} mixed coins of ${groupSats(p.amount)} sats are in your wallet.` : `Done: your mixed coin of ${groupSats(p.amount)} sats is in your wallet.`)
      : ended ? (p.reason || 'ended').replace(/^./, c => c.toUpperCase()) + '. ' + (pay ? 'Nothing was paid: send it normally if you like.' : 'Your coin did not move.')
        : pay ? 'Not paid yet: the payment goes out when the pool closes.' : 'Your coin is still in your wallet — it hasn\'t left.';
  const deadline = { JOINING: p.expiresAt, OPEN: p.expiresAt, VOTING: p.voteDeadline, CLOSING: p.phaseDeadline, SIGNING: p.phaseDeadline }[p.phase] || 0;
  const leftS = deadline - Math.floor(Date.now() / 1000);
  const arrow = open ? '⌄' : '›';
  const title = (p.private ? '🔒 ' : '') + (pay ? '💸 ' : '') + (p.v5 && p.creator ? tr(`${groupSats(p.mixTotal)} sats to ${(p.payments || []).length} recipient(s)`) : tr(`${poolAmount(p.amount, p.outputs)} sats each`)) + (p.script === 'p2tr' ? ' · Taproot' : '');
  const goes = p.phase !== 'ABORTED' && p.phase !== 'REJECTED' ? t(R('→ ' + (pay ? tr('Payment recipients') : p.dest ? p.dest : tr('Hot wallet'))), 'bs', { style: { color: accent } }) : null;
  const head = col('tap',
    row('', t(R(title), 'tm c-main grow'), h('div', { class: 'tm', style: { color }, 'data-deadline': deadline || null, 'data-arrow': arrow },
      R((deadline > 0 && leftS > 0 ? `${Math.floor(leftS / 3600)}:${String(Math.floor(leftS % 3600 / 60)).padStart(2, '0')}:${String(leftS % 60).padStart(2, '0')} ` : '') + arrow))),
    ended ? null : roundSteps(step, accent),
    t(status, 'bm', { style: { color } }), spacer(2),
    t(where, 'bs c-soft'),
    timesOf(p) ? t(timesOf(p), 'bs c-faint') : null,
    goes).also(() => { C.open[p.id] = !open; render(); });
  return panel(color, head, open ? [spacer(8), myPool(p, accent, color)] : null);
}

async function cjAct(path, body) {
  try { await api(path, body); await loadCoinjoin(); } catch (e) { if (e.message !== 'locked') C.msg = e.message; }
  render();
}

/** The whole card of a round of yours (MyPoolCard), inside its RoundCard. */
function myPool(p, accent, color) {
  const coins = p.coins > 1 ? `your ${p.coins} coins` : 'your coin';
  const mixTotal = p.mixTotal || p.amount * (p.outputs || 1);
  const out = p.v5 && p.creator ? `${groupSats(mixTotal)} paid to ${(p.payments || []).length} recipient(s)` : `${poolAmount(p.amount, p.outputs)} mixed`;
  const fee = groupSats(p.coinValue - mixTotal - p.change);
  const kids = [t(`${coins} ${groupSats(p.coinValue)} → ${out}` + (p.change > 0 ? ` + ${groupSats(p.change)} change · fee ${fee}` : ` · fee ${fee}`), 'bs c-faint')];
  if (p.pay || p.dest) kids.push(t((p.pay ? 'the payments go to: ' : 'mixed outputs go to: ') + (p.pay ? 'Payment recipients' : p.dest), 'bs', { style: { color: accent } }));
  if (p.pay && ['JOINING', 'OPEN', 'VOTING'].includes(p.phase)) kids.push(t("A payment: it goes out only when the pool closes. If the pool doesn't fill, nothing is paid; cancel it and send normally.", 'bs c-faint'));
  if (p.pay && p.recipients && p.recipients.length) kids.push(p.recipients.map(r => [t(R(r.address), 'bs c-main brk'), t(R(groupSats(r.amount) + ' sats'), 'ls c-faint')]));
  else if (p.dest && !['JOINING', 'ABORTED', 'REJECTED'].includes(p.phase)) {
    const box = h('div', { class: 'col' });
    kids.push(tbtn('show the addresses', accent, async () => {
      if (box.childNodes.length) return box.replaceChildren();
      try { const l = await api('coinjoin/round/addresses', { pool: p.id }); box.replaceChildren(...l.map(a => [t(R(a.address), 'bs c-main brk'), t(R(a.path), 'ls c-faint'), spacer(4)])); } catch (e) { toast(e.message); }
    }, 'ls', { style: { padding: '0', alignSelf: 'flex-start' } }), box);
  }
  const auto = (C.st.settings || {}).auto_sign;
  if (auto && ['OPEN', 'VOTING', 'CLOSING', 'SIGNING'].includes(p.phase)) kids.push(t('on its own ✓', 'ls c-good'));
  kids.push(spacer(8));
  const b = (text, primary, onclick, grow) => btn(text, { kind: primary ? 'fill' : 'soft', grow, full: !grow, color, onclick });
  const leave = () => {
    const d = dialog({ title: p.creator ? 'Cancel this pool?' : 'Leave this pool?', body: [t(p.creator
      ? 'The round is cancelled for everyone in it, and they are told so. Nobody loses anything: no transaction exists until all have signed, so every coin stays where it is.'
      : 'Your seat is freed and your coin is yours to spend again. Nothing was signed, so nothing moves.', 'bs')],
    buttons: [tbtn('STAY', COLORS.soft, () => d.close()), tbtn(p.creator ? 'CANCEL POOL' : 'LEAVE', COLORS.bad, () => { d.close(); cjAct('coinjoin/leave', { pool: p.id }); })] });
  };
  switch (p.phase) {
    case 'JOINING':
      kids.push(t(`Waiting for the pool's creator to let you in. If nobody answers in ${C.st.limits.joinMinutes} minutes the request is dropped.`, 'bs c-faint'), spacer(6),
        b('CANCEL', false, () => cjAct('coinjoin/leave', { pool: p.id })));
      break;
    case 'OPEN': {
      const close = () => {
        const d = dialog({ title: `Close the pool now with ${p.people} people?`, body: [t(`Everyone in the pool is asked to accept within ${C.st.limits.voteMinutes} minutes; whoever does not answer is left out of this round. If enough say yes, the round starts: each wallet posts its mixed output and then you sign. Nobody else can join once it closes.`, 'bs')],
          buttons: [tbtn('NOT NOW', COLORS.soft, () => d.close()), tbtn('ASK TO CLOSE', accent, () => { d.close(); cjAct('coinjoin/close', { pool: p.id }); })] });
      };
      kids.push(row('gap8', p.people >= p.minPeers ? b('ASK TO CLOSE NOW', true, close, true) : null, b(p.creator ? 'CANCEL POOL' : 'LEAVE', false, leave, true)));
      if (p.people < p.minPeers) kids.push(t(`Closes once ${p.minPeers} people are in.`, 'bs c-faint'));
      break;
    }
    case 'VOTING':
      if (p.iAsked || p.voted) kids.push(t(`Waiting for the others to answer, until ${hhmm(p.voteDeadline)}. Whoever has not answered by then is left out; if too few are left, the pool reopens without them.`, 'bs c-soft'), spacer(6),
        b(p.creator ? 'CANCEL POOL' : 'LEAVE', false, leave));
      else kids.push(t(`Answer before ${hhmm(p.voteDeadline)}.`, 'bs c-soft'),
        row('gap8', b('ACCEPT', true, () => cjAct('coinjoin/vote', { pool: p.id, accept: true }), true), b('NOT YET', false, () => cjAct('coinjoin/vote', { pool: p.id, accept: false }), true)));
      break;
    case 'SIGNING':
      if (p.signed) kids.push(t(`Signed. Waiting for the others (${p.sigs}/${p.planCoins || '?'} coins)…`, 'bs c-soft'));
      else {
        if (p.planPeople) {
          const ppl = p.planPeople, n = p.planCoins, same = p.planIdentical, each = groupSats(p.amount), total = groupSats(p.planFee), mine = p.outputs;
          kids.push(explain(mine > 1 && p.change > 0 ? `Checked: ${ppl} people (${n} coins), ${same} identical outputs of ${each} sats, ${mine} of them yours; your change is right; total fee ${total} sats.`
            : mine > 1 ? `Checked: ${ppl} people (${n} coins), ${same} identical outputs of ${each} sats, ${mine} of them yours; no change (an exact coin); total fee ${total} sats.`
              : p.change > 0 ? `Checked: ${ppl} people (${n} coins), ${same} identical outputs of ${each} sats, one of which is yours; your change is right; total fee ${total} sats.`
                : `Checked: ${ppl} people (${n} coins), ${same} identical outputs of ${each} sats, one of which is yours; no change (an exact coin); total fee ${total} sats.`), spacer(6));
        }
        kids.push(b('SIGN', true, async () => {
          let pw; try { pw = await askPassword('Sign the coinjoin', "Unlock to sign your coins' inputs"); } catch { return; }
          cjAct('coinjoin/sign', { pool: p.id, password: pw });
        }));
      }
      break;
    case 'BROADCAST': case 'CONFIRMED':
      if (p.txid) kids.push(t(R(p.txid), 'bs c-soft brk'), row('gap8', tbtn('open in explorer', accent, () => window.open(explorer() + '/tx/' + p.txid, '_blank', 'noopener'), 'bs'),
        p.phase === 'CONFIRMED' ? tbtn('remove', COLORS.faint, () => cjAct('coinjoin/remove', { pool: p.id })) : null));
      break;
    case 'ABORTED': case 'REJECTED':
      kids.push(tbtn('remove', COLORS.faint, () => cjAct('coinjoin/remove', { pool: p.id }), null, { style: { alignSelf: 'flex-start' } }));
  }
  return col('', kids);
}

/** A perfect coin sent and waiting for its first confirmation; then its pool goes on by itself (PerfectCoinCard). */
function perfectCoinCard(x, accent) {
  return panel(accent, row('', t(`${groupSats(x.value)} sats · perfect coin`, 'tm c-main grow'), dot(accent, false)),
    roundSteps(0, accent), t('Waiting for its first confirmation', 'bm', { style: { color: accent } }),
    t(x.create ? 'Then your pool opens by itself and runs on its own.' : 'Then it joins the pool by itself and the round runs on its own.', 'bs c-soft'));
}

// ---- open a pool (CreatePool)

function v5Split(total, wanted) {
  const minOut = (C.st && C.st.limits.testMinAmount) || 1000;
  return wanted >= 2 && wanted <= 5 && total % wanted === 0 && total / wanted >= minOut ? [total / wanted, wanted] : [total, 1];
}
function noChangeAmount(total, n, rate, t_, o) {
  const left = total - feeShare(rate, false, n, t_, o);
  return left <= 0 || o < 1 ? null : Math.floor(left / o);
}
const poolCoins = t_ => (C.st.coins || []).filter(c => !c.inRound && c.confirmations > 0 && (c.type || 'p2wpkh') === t_);

/** What the create form works out: the amount per output, the outputs each, and why it can't open yet. */
function createPlan(f) {
  const L = C.st.limits, t_ = f.script || 'p2wpkh';
  const rate = Number(String(f.rate).replace(',', '.')), max = Number(f.max), min = Number(f.min), hours = Number(f.hours), ins = Number(f.inputs);
  const rateOk = f.rate !== '' && isFinite(rate) && rate >= 1 && rate <= 500;
  const pay = f.pay, v5 = pay && pay.v5;
  const split = v5 ? v5Split(pay.total, Number(f.outputs) || 1) : null;
  const o = split ? split[1] : Number(f.outputs);
  const outsOk = Number.isInteger(o) && o >= 1 && o <= L.maxOutputs;
  const picked = poolCoins(t_).filter(c => (f.picked || []).includes(c.outpoint));
  const total = picked.reduce((a, c) => a + c.value, 0);
  const amount = split ? split[0] : pay ? pay.amount : !f.fromCoins ? Number(String(f.amount).replace(/\D/g, '')) || null
    : !picked.length || !rateOk || !outsOk ? null : noChangeAmount(total, picked.length, rate, t_, o);
  const err = (() => {
    if (f.fromCoins && !rateOk) return 'Fee: 1 to 500 sat/vB.';
    if (f.fromCoins && !outsOk) return `Mixed outputs per person: 1 to ${L.maxOutputs}.`;
    if (f.fromCoins && !picked.length) return 'Tick the coins to put in.';
    if (f.fromCoins && (!Number.isInteger(ins) || ins < 1 || ins > L.maxInputs)) return `Coins per person: 1 to ${L.maxInputs}.`;
    if (f.fromCoins && picked.length > ins) return `You ticked ${picked.length} coins: set the most coins per person to at least ${picked.length}.`;
    if (f.fromCoins && (amount == null || amount < L.testMinAmount || amount * o < L.minAmount))
      return `These coins make ${groupSats(Math.max(0, amount || 0) * o)} sats in all: a pool takes at least ${groupSats(L.minAmount)} each, and ${groupSats(L.testMinAmount)} per output.`;
    if (f.fromCoins && amount > L.maxAmount) return `These coins make ${groupSats(amount)} sats per output: a pool takes at most ${groupSats(L.maxAmount)} (1 BTC). Tick fewer coins or give more outputs.`;
    if (!amount || !Number.isInteger(amount) || amount < L.testMinAmount || amount > L.maxAmount) return `Amount per output: ${groupSats(L.testMinAmount)} to ${groupSats(L.maxAmount)} sats (1 BTC).`;
    if (outsOk && amount * o < L.minAmount) return `${groupSats(amount)} × ${o} = ${groupSats(amount * o)} sats each: a pool takes at least ${groupSats(L.minAmount)} each in all.`;
    if (!rateOk) return 'Fee: 1 to 500 sat/vB.';
    if (!Number.isInteger(max) || max < L.minPeers || max > L.maxPeers) return `Most people: ${L.minPeers} to ${L.maxPeers}.`;
    if (!Number.isInteger(min) || min < L.minPeers || min > max) return `Fewest people: ${L.minPeers} to ${max} (the most).`;
    if (!Number.isInteger(hours) || hours < 1 || hours > 72) return 'Open for 1 to 72 hours.';
    if (!Number.isInteger(ins) || ins < 1 || ins > L.maxInputs) return `Coins per person: 1 to ${L.maxInputs}.`;
    if (!outsOk) return `Mixed outputs per person: 1 to ${L.maxOutputs}.`;
    return null;
  })();
  return { t: t_, rate, rateOk, o, outsOk, split, amount, picked, total, err };
}

function coinLine(c, sel, accent, onclick) {
  return h('div', { class: 'pick' + (sel ? ' sel' : ''), style: { '--a': accent }, onclick },
    row('', weight(row('', t(R(`${groupSats(c.value)} sats`), 'bm c-main'), c.mixed ? t(' · mixed', 'bm c-warn') : null),
      t(R(c.address ? shortAddress(c.address) : c.outpoint.slice(0, 10) + '…'), 'bs c-faint')), sel ? t(R('✓'), '', { style: { color: accent } }) : null));
}

function createForm(accent) {
  const f = C.create, L = C.st.limits;
  const pay = f.pay, v5 = pay && pay.v5;
  const errBox = t('', 'bs c-warn');
  const btcLine = t('', 'bs c-faint');
  const costs = t('', 'bs c-faint');
  const pwNote = t('', 'bs c-faint');
  const splitNote = h('div', { class: 'col' });
  const coinsSum = h('div', { class: 'col' });
  const outNote = t('', 'bs c-faint');
  const amountField = !pay && !f.fromCoins ? field({ label: Number(f.outputs) > 1 ? 'amount of each output (sats)' : 'amount per person (sats)', mode: 'numeric', size: 'bm', value: f.amount, oninput: v => { f.amount = v; update(); } }) : null;
  const next = btn(f.fromCoins ? 'OPEN THE POOL' : pay && pay.coins.length ? 'CONTINUE WITH YOUR COINS' : 'CHOOSE COINS', { grow: true, color: accent });
  const update = () => {
    const P = createPlan(f);
    errBox.textContent = P.err ? tr(P.err) : ''; next.disabled = !!P.err;
    const amount = P.amount, rate = P.rate, o = Math.min(5, Math.max(1, P.o || 1)), t_ = P.t;
    outNote.textContent = tr(o > 1 ? (f.fromCoins ? `Each person gets ${o} mixed outputs of the pool's amount, each to an unused address of their own. ` : `Each person gets ${o} mixed outputs of the amount below, each to an unused address of their own. `) +
      'Only Kilowallet 1.2.0 or newer (Kilojoin v4) sees this pool.' : 'One mixed output each: every Kilojoin v3 wallet can join it.');
    btcLine.textContent = amount && !f.fromCoins && !pay ? tr(`= ${(amount / 1e8).toFixed(8)} BTC` + (o > 1 ? ` · ${groupSats(amount * o)} sats per person in all` : '')) : '';
    if (v5) {
      const wanted = Number(f.outputs) || 1;
      splitNote.replaceChildren(t(P.split[1] > 1 ? `The others get ${groupSats(pay.total)} sats back as ${P.split[1]} × ${groupSats(P.split[0])}.` : `The others get ${groupSats(pay.total)} sats back as one output.`, 'bs c-faint'),
        wanted > 1 && P.split[1] === 1 ? t(`It doesn't split evenly into ${wanted} outputs of at least ${groupSats(L.testMinAmount)} sats: one output each.`, 'bs c-warn') : '');
    }
    if (f.fromCoins) {
      const fee = P.picked.length && P.rateOk && P.outsOk ? feeShare(rate, false, P.picked.length, t_, P.o) : null;
      const rounding = P.total - (fee || 0) - (amount || 0) * P.o;
      coinsSum.replaceChildren(
        P.picked.filter(c => c.mixed).length && P.picked.length > 1 ? t("A mixed coin in one seat with other coins ties them together: the round shows they are one person's. Remix mixed coins one at a time.", 'bs c-warn') : '',
        P.picked.length && amount > 0 && fee != null ? col('', spacer(4), t(P.o > 1 ? `Pool of ${P.o} × ${groupSats(amount)} sats · change 0` : `Pool of ${groupSats(amount)} sats per output · change 0`, 'bm', { style: { color: P.err ? COLORS.warn : COLORS.good } }),
          t(`${P.picked.length} coin(s), ${groupSats(P.total)} sats · fee ${groupSats(fee)} sats` + (rounding > 0 ? ` · ${rounding} sats of rounding to the miners` : ''), 'bs c-faint')) : '');
    }
    costs.textContent = !f.fromCoins && !v5 && amount && rate >= 1 && rate <= 500 && P.outsOk ? tr(`Each person pays their own fee, the same however many join: with one coin ${feeShare(rate, true, 1, t_, o)} sats with change, ${feeShare(rate, false, 1, t_, o)} without (each extra coin adds ${Math.ceil(rate * inVb(t_))}). ` +
      `A coin of exactly ${groupSats(amount * o + feeShare(rate, false, 1, t_, o))} sats leaves no change (the best for privacy); a bit more than that, up to ${groupSats(amount * o + feeShare(rate, true, 1, t_, o) + L.dust)}, also goes in without change and the rest goes to the miners.`) : '';
    pwNote.textContent = f.password ? tr('Only people you give this password to can join. It is not announced anywhere.') : '';
  };
  const fld = (lab, k, mode) => field({ label: lab, mode, size: 'bm', value: f[k], oninput: v => { f[k] = v; if (k === 'outputs' && amountField) amountField.querySelector('label').textContent = tr(Number(v) > 1 ? 'amount of each output (sats)' : 'amount per person (sats)'); update(); } });
  next.addEventListener('click', () => {
    const P = createPlan(f);
    if (P.err) return;
    if (f.fromCoins) {
      // Where the outputs go, when there is more than this wallet; then the password.
      const dests = (C.st.destinations || []).filter(d => d.type === P.t && !d.scanning);
      if (dests.length) { f.confirm = true; render(); return; }
      return openFromCoins(P, '');
    }
    C.pick = { title: pay ? 'Your coins for the payment' : 'Your coins for the pool', amount: P.amount, rate: P.rate, maxInputs: Number(f.inputs), script: P.t,
      outputs: P.o, pay, feeOutputs: v5 ? pay.amounts.length : P.o };
    C.chosen = pay ? poolCoins(P.t).filter(c => pay.coins.includes(c.outpoint)).slice(0, Number(f.inputs)).map(c => c.outpoint) : [];
    C.pick.leftOut = pay ? pay.coins.length - C.chosen.length : 0;
    render(); window.scrollTo(0, 0);
  });
  const back = btn(pay ? 'BACK' : 'CANCEL', { kind: 'soft', grow: true, color: COLORS.soft, onclick: () => { if (pay) backToSend(pay); else { C.create = null; render(); } } });
  const payHead = !pay ? null : v5 ? [
    t(`${groupSats(pay.total)} sats to ${pay.amounts.length} recipient(s)`, 'tm c-main'),
    pay.recipients.map(r => t(R(shortAddress(r.to) + ' · ' + groupSats(r.amount) + ' sats'), 'bs', { style: { color: accent } })),
    t((pay.script === 'p2tr' ? 'Taproot (bc1p)' : 'Native SegWit (bc1q)') + ' pool · a payment pool (v5)', 'bs c-faint'), spacer(6),
    explain(`A new payment pool opens: each of the others puts in ${groupSats(pay.total)} sats too and gets it back in equal outputs, while your outputs are the payments. On the chain the payments show as odd amounts, and as one person's; which coins paid them stays hidden among the members, best when everyone uses perfect coins. The payment only goes out when the pool closes, which can take hours. If it doesn't fill, nothing is paid and your coins stay here: you can cancel it and send normally.`),
    fld(`outputs for each of the others (1–${L.maxOutputs})`, 'outputs', 'numeric'), splitNote, spacer(6)]
    : [t(pay.recipients.length > 1 ? `${pay.recipients.length} recipients × ${groupSats(pay.amount)} sats` : `${groupSats(pay.amount)} sats to 1 recipient`, 'tm c-main'),
      pay.recipients.map(r => t(R(shortAddress(r.to)), 'bs', { style: { color: accent } })),
      t((pay.script === 'p2tr' ? 'Taproot (bc1p)' : 'Native SegWit (bc1q)') + ' pool · one output per recipient', 'bs c-faint'), spacer(6),
      explain("A new pool of exactly this amount opens, and its outputs for you go straight to the recipients: on the chain the payment looks like any other output of the round. The payment only goes out when the pool closes, which can take hours. If it doesn't fill, nothing is paid and your coins stay here: you can cancel it and send normally."), spacer(6)];
  const coinList = () => {
    const list = poolCoins(f.script || 'p2wpkh');
    if (!list.length) return t(`No confirmed ${kindName(f.script || 'p2wpkh')} coin.`, 'bs c-warn');
    return list.map(c => {
      const sel = (f.picked || []).includes(c.outpoint);
      return coinLine(c, sel, accent, () => { f.picked = sel ? f.picked.filter(x => x !== c.outpoint) : (f.picked.length < L.maxInputs ? f.picked.concat(c.outpoint) : f.picked); render(); });
    });
  };
  const body = [label(pay ? 'Pay through a coinjoin' : 'Open a pool', accent), spacer(8)];
  if (pay) body.push(payHead);
  else {
    body.push(t('Pool amount', 'bm c-main'),
      [[true, 'From your coins: tick them, no change (the best for privacy)'], [false, 'Type the amount']].map(([v, l]) => radioLine(!!f.fromCoins === v, l, accent, () => { f.fromCoins = v; render(); })),
      t('Address type', 'bm c-main'),
      [[false, 'Native SegWit (bc1q)'], [true, 'Taproot (bc1p)']].map(([v, l]) => {
        const can = !v || C.st.taproot;
        return radioLine((f.script === 'p2tr') === v, l + (can ? '' : ' — turn on Taproot in settings'), accent, () => { if (can) { f.script = v ? 'p2tr' : 'p2wpkh'; f.picked = []; render(); } }, !can);
      }),
      t(f.script === 'p2tr' ? 'Only Taproot coins can join, and everyone gets Taproot outputs back.' : 'Only native SegWit coins can join, and everyone gets native SegWit outputs back.', 'bs c-faint'),
      fld(`mixed outputs per person (1–${L.maxOutputs})`, 'outputs', 'numeric'), outNote,
      amountField, amountField ? btcLine : null);
  }
  body.push(fld('fee rate (sat/vB)', 'rate', 'decimal'));
  if (f.fromCoins) body.push(spacer(8), label('Your coins', accent),
    explain("Tick whole coins: the pool's amount is worked out from them so they go in with no change at all. The others join with coins of their own."),
    coinList(), coinsSum, spacer(8));
  body.push(fld(`fewest people to close (${L.minPeers}–${L.maxPeers - 1})`, 'min', 'numeric'),
    fld(`most people (${L.minPeers}–${L.maxPeers})`, 'max', 'numeric'),
    fld('open for (hours)', 'hours', 'numeric'),
    fld(`most coins per person (1–${L.maxInputs})`, 'inputs', 'numeric'),
    v5 ? t('Only Kilowallet 1.2.7 or newer (Kilojoin v5) sees this pool.', 'bs c-faint')
      : Number(f.outputs || 1) === 1 ? t(f.script !== 'p2tr' && Number(f.inputs) === 1 ? 'One coin each: Kilowallet versions before 0.27 can join it too.' : 'Only Kilowallet 0.27 or newer sees this pool.', 'bs c-faint') : null,
    field({ label: 'password (optional: makes it private 🔒)', size: 'bm', value: f.password, oninput: v => { f.password = v; update(); } }), pwNote,
    costs, errBox, spacer(10), row('gap8', back, next));
  update();
  return panel(accent, body);
}

async function openFromCoins(P, dest) {
  const f = C.create;
  let pw; try { pw = await askPassword('Open a coinjoin pool', 'Unlock to put your coins in'); } catch { return; }
  try {
    const r = await api('coinjoin/create', { coins: P.picked.map(c => c.outpoint), script: P.t, maxInputs: Number(f.inputs), outputs: P.o, fromCoins: true, amount: P.amount,
      feeRate: P.rate, minPeers: Number(f.min), maxPeers: Number(f.max), hours: Number(f.hours), poolPassword: f.password, password: pw, dest: dest || '' });
    C.create = null; C.cjTab = 1; toast(`Pool opened (${poolAmount(r.amount, r.outputs)} sats, no change): others are told about it.`);
    await loadCoinjoin(); render(); reloadPools(); window.scrollTo(0, 0);
  } catch (e) { toast(e.message); }
}

/** From your coins, then where the outputs go (when there is more than this wallet). */
function createConfirm(accent) {
  const f = C.create, P = createPlan(f);
  const dests = (C.st.destinations || []).filter(d => d.type === P.t && !d.scanning);
  if (!dests.some(d => d.id === C.dest)) C.dest = '';
  return panel(accent, label('Open a pool from your coins', accent), spacer(8),
    t(P.o > 1 ? `Pool of ${P.o} × ${groupSats(P.amount)} sats · change 0` : `Pool of ${groupSats(P.amount)} sats per output · change 0`, 'bm c-good'),
    spacer(8), destChooser(dests, P.t, P.o, accent),
    row('gap8', btn('BACK', { kind: 'soft', grow: true, color: COLORS.soft, onclick: () => { f.confirm = false; render(); } }),
      btn('OPEN THE POOL', { grow: true, color: accent, disabled: !!P.err, onclick: () => openFromCoins(P, C.dest) })));
}

/** Where the mixed outputs go, when there is more than this wallet to choose from (DestinationChooser). */
function destChooser(dests, t_, o, accent) {
  if (!dests.length) return null;
  const box = h('div', { class: 'col' });
  return col('', t('Mixed outputs go to', 'bm c-main'),
    [{ id: '', which: tr('Hot wallet') + ' ' + tr('(default)') }].concat(dests).map(d => radioLine(C.dest === d.id, R(d.which || d.label), accent, () => { C.dest = d.id; render(); })),
    C.dest ? t("Unused receive addresses of that wallet; the change, if any, comes back here. Nobody in the round can tell: an output is just an address of the pool's type.", 'bs c-faint') : null,
    C.dest ? tbtn('SHOW THE ADDRESSES', accent, async () => {
      try {
        const l = await api('coinjoin/dest/preview', { dest: C.dest, script: t_, outputs: o });
        box.replaceChildren(t(l.length > 1 ? 'The next unused receive addresses of that wallet, as of now. Compare them with the wallet itself (in Sparrow or Shrike: Addresses › Receive).'
          : 'The next unused receive address of that wallet, as of now. Compare it with the wallet itself (in Sparrow or Shrike: Addresses › Receive).', 'bs c-faint'),
        ...l.map(a => [t(R(a.address), 'bs c-main brk'), t(R(a.path), 'ls c-faint'), spacer(4)]));
      } catch (e) { toast(e.message); }
    }, 'ls', { style: { alignSelf: 'flex-start' } }) : null, box, spacer(8));
}

// ---- the coins for a pool (CoinPicker)

function coinPicker(accent) {
  const k = C.pick, maxIn = k.maxInputs || 1, o = k.outputs || 1, t_ = cjType();
  const pay = k.pay, v5 = pay && pay.v5, fo = k.feeOutputs || o;
  const mixTotal = k.amount * o, exact = mixTotal + feeShare(k.rate, false, 1, t_, fo);
  const changeOf = (v, n) => {
    const w = v - mixTotal - feeShare(k.rate, true, n, t_, fo);
    if (w > ((C.st && C.st.limits.dust) || 294)) return w;
    return v - mixTotal - feeShare(k.rate, false, n, t_, fo) >= 0 ? 0 : null;
  };
  const coins = poolCoins(t_);
  const ok = coins.filter(c => maxIn > 1 || c.value >= exact).sort((a, b) => (a.value === exact ? 0 : 1) - (b.value === exact ? 0 : 1) || b.value - a.value);
  const short = maxIn > 1 ? [] : coins.filter(c => c.value >= mixTotal && c.value < exact).sort((a, b) => b.value - a.value);
  const total = coins.filter(c => C.chosen.includes(c.outpoint)).reduce((a, c) => a + c.value, 0);
  const ch = C.chosen.length ? changeOf(total, C.chosen.length) : null;
  const fee = ch == null ? 0 : total - mixTotal - ch;
  const dests = pay ? [] : (C.st.destinations || []).filter(d => d.type === t_ && !d.scanning);
  if (!dests.some(d => d.id === C.dest)) C.dest = '';
  const kind = kindName(t_);
  const pickLine = maxIn > 1 ? `Pick up to ${maxIn} confirmed ${kind} coins that together make at least ${groupSats(mixTotal)} sats plus your fee. The leftover comes back to a fresh change address`
    : `Pick ONE confirmed ${kind} coin of at least ${groupSats(exact)} sats. Its leftover comes back to a fresh change address`;
  const explainText = v5 ? (pickLine + '.') + '\n\n' + 'Your outputs are the payments, one to each recipient.'
    : pay ? (pickLine + '.') + '\n\n' + "The pool's outputs go to the payment's recipients, one each."
      : C.dest ? (pickLine + '.') + '\n\n' + (o > 1 ? `Each of your ${o} mixed outputs of ${groupSats(k.amount)} sats goes to its own unused address of the wallet chosen above.` : 'The mixed output goes to an unused address of the wallet chosen above.')
        : pickLine + '; ' + (o > 1 ? `each of your ${o} mixed outputs of ${groupSats(k.amount)} sats goes to its own fresh address of this wallet.` : 'the mixed output goes to another fresh address of this wallet.');
  const submit = async () => {
    let pw;
    try { pw = await askPassword(C.create ? 'Open a coinjoin pool' : 'Join coinjoin', C.create ? 'Unlock to put your coins in' : 'Unlock to prove you own the coins'); } catch { return; }
    try {
      if (C.create) {
        const f = C.create;
        await api('coinjoin/create', { coins: C.chosen, script: t_, maxInputs: maxIn, outputs: pay ? Number(f.outputs) || 1 : o, amount: k.amount, feeRate: k.rate, minPeers: Number(f.min), maxPeers: Number(f.max),
          hours: Number(f.hours), poolPassword: f.password, password: pw, dest: C.dest || '', pay: pay ? pay.recipients : undefined, paymentPool: !!v5 });
        C.create = null; toast(pay ? 'Pool opened: the payment goes out when it closes.' : 'Pool opened: others are told about it.');
      } else {
        if (C.join.pool.private && !C.join.password) return toast("Type the pool's password first.");
        await api('coinjoin/join', { pool: C.join.pool.id, coins: C.chosen, poolPassword: C.join.password, password: pw, dest: C.dest || '' });
        C.join = null;
      }
      C.pick = null; C.chosen = []; C.cjTab = 1;
      await loadCoinjoin(); render(); reloadPools(); window.scrollTo(0, 0);
    } catch (e) { toast(e.message); }
  };
  const use = btn(C.chosen.length > 1 ? `USE THESE ${C.chosen.length} COINS` : 'USE THIS COIN', { grow: true, color: accent, disabled: ch === null, onclick: () => {
    // With change, offer the perfect coin first: a coin of exactly the amount plus the fee joins with none (not for a payment).
    if (ch > 0 && !pay) {
      const d = dialog({ title: 'Make the perfect coin?', body: [t(`With ${C.chosen.length === 1 ? 'this coin' : `these ${C.chosen.length} coins`} you get ${groupSats(ch)} sats of change back, and that change shows on the chain next to your coins. A single coin of exactly ${groupSats(exact)} sats goes in with no change at all, so nothing ties your mixed output to anything. You can make it now: a payment to yourself (from any of your coins, bc1q and bc1p together), which needs one confirmation before it can join.`, 'bs')],
        buttons: [tbtn('NOT NEEDED, CONTINUE', COLORS.soft, () => { d.close(); submit(); }), tbtn('MAKE THE PERFECT COIN', accent, () => { d.close(); startExact(exact, t_); })] });
    } else submit();
  } });
  const toggle = op => {
    if (C.chosen.includes(op)) C.chosen = C.chosen.filter(x => x !== op);
    else if (maxIn > 1) { if (C.chosen.length < maxIn) C.chosen = C.chosen.concat(op); }
    else C.chosen = [op];
    render();
  };
  const rows = ok.map(c => {
    const sel = C.chosen.includes(c.outpoint);
    return h('div', { class: 'pick' + (sel ? ' sel' : ''), style: { '--a': accent }, onclick: () => toggle(c.outpoint) },
      row('', weight(row('', t(R(`${groupSats(c.value)} sats` + (c.value === exact && !pay ? tr('  ★ EXACT') : '')), 'bm', { style: { color: c.value === exact ? COLORS.good : COLORS.main } }),
        c.mixed ? t(' · mixed', 'bm c-warn') : null), t(R(shortAddress(c.address)), 'bs c-faint')), sel ? t(R('✓'), '', { style: { color: accent } }) : null));
  });
  const shortRows = short.map(c => col('', t(R(`${groupSats(c.value)} sats`), 'bm c-faint'),
    t(`${groupSats(exact - c.value)} sats short of this pool's fee (${fmtRate(k.rate)} sat/vB): it fits a pool at a lower rate`, 'bs c-warn')).also(null));
  shortRows.forEach(x => { x.style.padding = '10px'; });
  const mixedChosen = coins.filter(c => C.chosen.includes(c.outpoint) && c.mixed).length;
  const summary = C.chosen.length ? t(ch === null ? `${C.chosen.length} coin(s), ${groupSats(total)} sats: ${groupSats(mixTotal + feeShare(k.rate, false, C.chosen.length, t_, fo) - total)} sats short`
    : ch === 0 && total === exact ? `★ exact: no change · fee ${groupSats(fee)} sats`
      : ch === 0 ? `${C.chosen.length} coin(s) · no change, ${groupSats(fee)} sats to the miners`
        : v5 ? `${C.chosen.length} coin(s) · ${groupSats(total)} sats → ${groupSats(mixTotal)} paid + ${groupSats(ch)} change · fee ${groupSats(fee)}`
          : `${C.chosen.length} coin(s) · ${groupSats(total)} sats → ${poolAmount(k.amount, o)} mixed + ${groupSats(ch)} change · fee ${groupSats(fee)}`, 'bs', { style: { color: ch === null ? COLORS.warn : accent } }) : null;
  return panel(accent, label(k.title, accent), spacer(8),
    dests.length ? destChooser(dests, t_, o, accent) : null,
    explain(explainText),
    k.leftOut > 0 ? t(`${k.leftOut} of the coins ticked in SEND can't go in (unconfirmed, of another address type, or already in a pool): tick others here.`, 'bs c-warn') : null,
    spacer(8),
    !coins.length ? t(`No confirmed ${kind} coin.`, 'bs c-warn') : ok.length ? rows : t('No confirmed coin is big enough.', 'bs c-warn'),
    shortRows,
    mixedChosen > 0 && C.chosen.length > 1 ? t("A mixed coin in one seat with other coins ties them together: the round shows they are one person's. Remix mixed coins one at a time.", 'bs c-warn') : null,
    summary ? [spacer(4), summary] : null,
    !pay ? t(t_ === 'p2tr' ? 'Only Taproot (bc1p) coins can join this pool. Your native SegWit coins can still pay for a Taproot exact coin below.'
      : 'Only native SegWit (bc1q) coins can join this pool. Your Taproot coins can still pay for a native SegWit exact coin below.', 'bs c-faint') : null,
    !pay && !coins.some(c => c.value === exact) ? tbtn(`＋ PREPARE AN EXACT COIN OF ${groupSats(exact)} SATS`, accent, () => startExact(exact, t_), 'bs', { style: { alignSelf: 'flex-start' } }) : null,
    spacer(10),
    row('gap8', btn(pay ? 'BACK' : 'CANCEL', { kind: 'soft', grow: true, color: COLORS.soft, onclick: () => {
      if (C.create) C.pick = null; else { C.pick = null; C.join = null; }
      C.chosen = []; render();
    } }), use));
}

// ---- the perfect coin (ExactCoinPanel)

function startExact(exact, script) {
  const after = C.create && C.pick ? { create: { amount: C.pick.amount, feeRate: C.pick.rate, minPeers: Number(C.create.min), maxPeers: Number(C.create.max),
    hours: Number(C.create.hours), poolPassword: C.create.password || '', maxInputs: C.pick.maxInputs || 1, outputs: C.pick.outputs || 1 } }
    : C.join ? { pool: C.join.pool.id, poolPassword: C.join.password || '' } : null;
  C.exact = { exact, script, after, dest: C.dest || '', picked: [], rate: '', suggested: undefined, phase: 'edit' };
  api('fee').then(r => { C.exact.suggested = r.suggested; if (!C.exact.rate) C.exact.rate = fmtRate(Math.max(1, r.suggested || 1)); if (!busy() || C.exact) render(); }).catch(() => { C.exact.suggested = null; C.exact.rate = '1'; render(); });
  render(); window.scrollTo(0, 0);
}

function exactCoinPanel(accent) {
  const x = C.exact;
  const kindT = x.script === 'p2tr' ? 'Taproot (bc1p)' : 'native SegWit (bc1q)';
  const head = [label(`Exact coin · ${groupSats(x.exact)} sats`, accent), spacer(6)];
  const cancel = () => { C.exact = null; render(); };
  if (x.phase === 'sent') {
    setTimeout(() => {
      if (!C.exact || C.exact.shownDone) return; C.exact.shownDone = true;
      const d = dialog({ dismiss: false, title: 'Perfect coin sent', body: [t(`${groupSats(x.exact)} sats to a fresh address of yours.`, 'bm c-main'), spacer(8),
        t(R(x.txid), 'bs c-soft brk'), spacer(8),
        t((x.after && x.after.create ? 'At its first confirmation (about 10 minutes) your pool opens by itself' : 'At its first confirmation (about 10 minutes) it joins the pool by itself') +
          ' and the round runs on its own: you can close the app. Follow it in COINJOIN → IN PROGRESS.', 'bs c-soft'),
        row('', copyButton('COPY TXID', () => x.txid, accent), tbtn('EXPLORER', accent, () => window.open(explorer() + '/tx/' + x.txid, '_blank', 'noopener')))],
      buttons: [tbtn('CLOSE', accent, () => { d.close(); C.exact = null; C.pick = null; C.join = null; C.create = null; C.cjTab = 1; loadCoinjoin().then(render).catch(() => render()); })] });
    }, 0);
    return panel(accent, head, t('Sent ✓', 'bs c-good'));
  }
  if (x.phase === 'working') return panel(accent, head, workingLine(accent, 'Preparing the payment to yourself…', x.step || null, `${groupSats(x.exact)} sats to a fresh address of yours.`));
  if (x.phase === 'review') {
    const d = x.draft;
    const fee = { ok: false };
    const sign = btn('CONFIRM & SIGN', { full: true, color: accent, disabled: !!d.concern, onclick: async () => {
      let pw; try { pw = await askPassword('Prepare the exact coin', 'Unlock to sign the payment to yourself'); } catch { return; }
      x.phase = 'working'; render();
      api('send/confirm', { draft: d.draft, password: pw, acceptFee: fee.ok, acceptMix: true }).then(r => { x.txid = r.txid; x.phase = 'sent'; loadWallet().catch(() => {}); render(); })
        .catch(e => { x.phase = 'review'; toast(e.message); render(); });
    } });
    return panel(accent, head,
      t(`to ${shortAddress(d.to)} · from ${d.inputs} coin(s) · fee ${groupSats(d.fee)} sats`, 'bs c-soft'),
      d.change > 0 ? t(`change ${groupSats(d.change)} sats back to ` + (d.changeAddress ? shortAddress(d.changeAddress) : tr('a fresh address of yours')), 'bs c-soft') : null,
      d.concern ? feeGate(d.concern, fee, () => { sign.disabled = !fee.ok; }) : null,
      spacer(6), sign, tbtn('edit coins or fee', COLORS.soft, () => { x.phase = 'edit'; render(); }, null, { full: true }));
  }
  // Coin control and the fee, then PREPARE.
  const sources = (C.st.coins || []).filter(c => !c.inRound && c.confirmations > 0).sort((a, b) => b.value - a.value);
  const picked = sources.filter(c => x.picked.includes(c.outpoint));
  const sum = picked.reduce((a, c) => a + c.value, 0);
  const mixedPicked = picked.filter(c => c.mixed).length;
  const rateF = field({ label: 'sat/vB', mode: 'decimal', size: 'bs', value: x.rate, oninput: (v, el) => { el.value = v.replace(',', '.').replace(/[^\d.]/g, ''); x.rate = el.value; prep.disabled = !okNow(); } });
  const okNow = () => { const r = Number(x.rate); return r >= 0.1 && r <= 1000 && (!x.picked.length || sum >= x.exact); };
  const prep = btn(x.picked.length ? `PREPARE WITH ${x.picked.length}` : 'PREPARE', { grow: true, color: accent, disabled: !okNow(), onclick: async () => {
    x.phase = 'working'; x.step = null; render();
    try {
      const r = await api('coinjoin/exact', { script: x.script, exact: x.exact, after: x.after, dest: x.dest });
      // Without coins ticked, the biggest never-mixed ones go first.
      let coins = x.picked;
      if (!coins.length) { let s = 0; coins = []; for (const c of sources.filter(c => !c.mixed)) { if (s >= x.exact + 500) break; coins.push(c.outpoint); s += c.value; } }
      x.draft = await api('send/prepare', { to: r.address, amount: x.exact, rate: Number(x.rate), coins });
      x.phase = 'review'; render();
    } catch (e) { x.phase = 'edit'; toast(e.message); render(); }
  } });
  return panel(accent, head,
    explain(`A payment to yourself of exactly ${groupSats(x.exact)} sats, to a fresh ${kindT} address of this wallet. It needs one confirmation before it can join; then it goes in with no change.`),
    spacer(6), label('Coin control · pay it with', accent),
    t(`Tick one or more coins, native SegWit and Taproot alike; with none ticked the biggest never-mixed ones go first. The exact coin itself is always ${x.script === 'p2tr' ? 'Taproot' : 'native SegWit'}, the pool's type.`, 'bs c-faint'),
    !sources.length ? t('No confirmed coin to pay it with.', 'bs c-warn') : null,
    sources.map(c => {
      const sel = x.picked.includes(c.outpoint);
      const r_ = row('rowtap', h('span', { style: { width: '26px', flex: 'none', color: sel ? accent : COLORS.faint } }, R(sel ? '☑' : '☐')),
        weight(row('', t(R(`${groupSats(c.value)} sats · ${c.type === 'p2tr' ? 'Taproot' : 'SegWit'}`), 'bs', { style: { color: sel ? accent : COLORS.main } }), c.mixed ? t(' · mixed', 'bs c-warn') : null),
          t(R(shortAddress(c.address)), 'bs c-faint'))).also(() => { x.picked = sel ? x.picked.filter(o => o !== c.outpoint) : x.picked.concat(c.outpoint); render(); });
      r_.style.padding = '4px 0'; return r_;
    }),
    mixedPicked ? t(picked.length > mixedPicked ? 'A mixed coin spent together with other coins ties them back together: the mix is undone for both.'
      : 'The change of this payment comes back linked to the mixed coin. Better to use coins that were never mixed.', 'bs c-warn') : null,
    picked.length ? t(`ticked: ${picked.length} coin(s), ${groupSats(sum)} sats` + (sum < x.exact ? ` — not enough for ${groupSats(x.exact)} plus the fee` : ''), 'bs', { style: { color: sum < x.exact ? COLORS.warn : accent } }) : null,
    spacer(6), t('What this payment pays to get mined:', 'bs c-main'),
    t(x.suggested === undefined ? 'asking your node how busy the mempool is…' : x.suggested ? `your node suggests ${fmtRate(x.suggested)} sat/vB for the next few blocks` : 'your node has no estimate (a quiet mempool): 1 sat/vB is usually enough', 'bs c-soft'),
    rateF, spacer(6),
    row('gap8', btn('CANCEL', { kind: 'soft', grow: true, color: COLORS.soft, onclick: cancel }), prep));
}

// ---- alerts: Telegram through your own bot, sound in this browser

function soundOn() { return safeGet('kw.cjSound') === '1'; }

/** The server's own alerts (the app has @Coinjoinpoolbot): Telegram through your bot, or this browser. */
function telegramPanel(accent) {
  const st = C.st.settings || {};
  const out = t('', 'bs c-soft');
  const token = field({ label: st.telegram_set ? 'bot token (saved; type to replace)' : 'bot token', size: 'bs' });
  const chat = field({ label: 'your chat id', size: 'bs', value: st.telegram_chat || '' });
  return panel(accent, t('🔔 Telegram alerts', 'bm c-main'),
    explain('Every pool event of yours arrives in Telegram, with sound, through your own bot: make one with @BotFather, send it any message, and put its token and your chat id here (@userinfobot tells you your id).'),
    token, chat,
    row('wrap', tbtn('SAVE', accent, () => {
      const body = { telegram_chat: chat.input.value }; if (token.input.value) body.telegram_token = token.input.value;
      api('coinjoin/settings', body).then(s => { C.st.settings = s; token.input.value = ''; out.textContent = tr('saved'); }).catch(e => { out.textContent = e.message; });
    }), tbtn('SEND A TEST', accent, () => { out.textContent = tr('sending…'); api('coinjoin/telegram/test', {}).then(() => { out.textContent = tr('sent ✓'); }).catch(e => { out.textContent = e.message; }); })),
    out, spacer(8),
    settingRow('Sound and a notification in this browser', 'On every pool event, while this page is open.', sw(soundOn(), v => {
      safeSet('kw.cjSound', v ? '1' : '0');
      if (v) { chime(); if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); }
    })));
}

/** Other wallets a coinjoin's mixed outputs can go to: a watch-only wallet's key or Jam's export (the app picks them from its own wallets). */
function destinationsPanel(accent) {
  const ds = C.st.destinations || [];
  const ks = { text: '', type: '' };
  const kType = h('div', { class: 'col' });
  const drawType = () => kType.replaceChildren(...[].concat(xpubTypeChoice(ks, accent, drawType, [['p2wpkh', 'Native SegWit · bc1q… (BIP84)'], ['p2tr', 'Taproot · bc1p… (BIP86)']]) || []));
  const text = field({ label: "zpub / xpub of a watch-only wallet, or Jam's export line", area: true, size: 'bs', oninput: v => { ks.text = v; drawType(); } });
  const lab = field({ label: 'Name (optional)', size: 'bs' });
  const since = field({ label: 'made around', type: 'date', size: 'bs' });
  const add = async () => {
    if (xpubNeedsType(ks.text) && !ks.type) return toast('Pick the address type of this xpub first.');
    let pw; try { pw = await askPassword('Add a wallet for mixed outputs', 'Unlock to add it'); } catch { return; }
    api('destinations/add', { text: text.input.value.trim(), label: lab.input.value, type: ks.type,
      since: since.input.value ? Math.floor(new Date(since.input.value + 'T00:00:00Z').getTime() / 1000) : null, password: pw })
      .then(r => { C.st.destinations = r; toast('Added. The node is looking through the chain for it: it can take a while.'); render(); }).catch(e => toast(e.message));
  };
  return panel(accent, t('📤 Other wallets for mixed outputs', 'bm c-main'),
    explain('A round\'s mixed outputs can go straight to another wallet of yours instead of this one: a watch-only wallet (its zpub, or a Taproot xpub) or your Jam wallet\'s first jar, Apricot (its "View in Kilowallet" line). The node keeps a watch-only copy of it, so only addresses that never received anything are used. Only output addresses ever leave this server.'),
    ds.map(d => row('', t(R((d.which || d.label) + ' · ' + (d.type === 'p2tr' ? 'bc1p' : 'bc1q') + (d.scanning ? tr(' · looking through the chain…') : '')), 'bs c-main grow'),
      tbtn('remove', COLORS.faint, () => api('destinations/remove', { id: d.id }).then(r => { C.st.destinations = r; render(); }).catch(e => toast(e.message)), 'bs'))),
    text, kType, lab, since,
    explain('made around: the node looks back from that day, so every address it ever used is known.'),
    tbtn('ADD', accent, add, null, { style: { alignSelf: 'flex-start' } }));
}

function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), at = ctx.currentTime + i * 0.18;
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.25, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
      o.start(at); o.stop(at + 0.32);
    });
  } catch {}
}

let lastEventAt = null;
async function pollEvents() {
  if (!S.me || !S.me.unlocked || !C.st || !C.st.enabled) return;
  try {
    const evs = await api('coinjoin/events');
    const newest = evs.length ? evs[0].at : 0;
    if (lastEventAt === null) { lastEventAt = newest; return; }
    const fresh = evs.filter(e => e.at > lastEventAt);
    lastEventAt = Math.max(lastEventAt, newest);
    if (!fresh.length) return;
    if (S.tab === 'coinjoin') { await loadCoinjoin().catch(() => {}); if (!busy()) render(); }
    if (!soundOn()) return;
    chime();
    if (window.Notification && Notification.permission === 'granted') fresh.slice(0, 3).forEach(e => new Notification(e.title, { body: e.text, tag: e.at + e.title }));
  } catch {}
}
