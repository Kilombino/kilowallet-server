// Kilowallet on a home node, as the Android app: the same screens, in the same order, with the
// same texts and languages. What the app asks the fingerprint for, this page asks the wallet's
// password for. No inline scripts (the page's CSP forbids them): every handler is attached here.
'use strict';

const $app = document.getElementById('app');
const S = { // the page's state
  me: null, w: null, tab: 'btc', sheet: null, draft: null, sent: null, psbt: null, form: null,
  street: true, fiat: localStorage.getItem('kw.fiat') || 'USD', showSettings: false,
  setup: null,      // onboarding: null home, 'dice', 'backup', 'check', 'restore'
  nextAt: 0,        // when the wallet is looked at again (the balance card's countdown)
};
const REFRESH = 30;

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {} }

async function api(path, body) {
  const r = await fetch('/api/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({ error: 'bad answer from the server' }));
  if (r.status === 401) { S.me.unlocked = false; render(); throw new Error('locked'); }
  if (r.status === 503 && j.chain) { S.me.chain = j.chain; render(); throw new Error(j.chain.title); }
  if (j.error) throw new Error(j.error);
  return j;
}

/** The accent of the part of the wallet on screen: BTC orange, Ark red (as the app's top bar). */
const accentNow = () => S.tab === 'ark' ? COLORS.ark : COLORS.btc;
const isHot = () => S.me && S.me.mode === 'hot';
const street = s => (S.street ? tr('STREET MODE') : s);

// ------------------------------------------------------------------ fiat (Fiat.kt)

const FIATS = [['USD', '$', 2], ['EUR', '€', 2], ['GBP', '£', 2], ['JPY', '¥', 0], ['CHF', null, 2], ['CNY', 'CN¥', 2], ['RON', null, 2],
  ['PLN', null, 2], ['CZK', null, 2], ['HUF', null, 0], ['SEK', null, 2], ['NOK', null, 2], ['DKK', null, 2], ['ISK', null, 0], ['TRY', '₺', 2],
  ['CAD', 'CA$', 2], ['AUD', 'A$', 2], ['NZD', 'NZ$', 2], ['BRL', 'R$', 2], ['MXN', 'MX$', 2], ['ARS', null, 2], ['CLP', null, 0], ['COP', null, 0],
  ['PEN', null, 2], ['UYU', null, 2], ['VES', null, 2], ['INR', '₹', 2], ['KRW', '₩', 0], ['HKD', 'HK$', 2], ['SGD', 'S$', 2], ['ZAR', null, 2],
  ['ILS', '₪', 2], ['THB', null, 2], ['IDR', null, 0], ['PHP', '₱', 2], ['MYR', null, 2]];
function fiatInfo(code) { const f = FIATS.find(x => x[0] === code) || [code, null, 2]; return { code: f[0], sym: f[1], dec: f[2] }; }
/** One BTC in [code] (rates from mempool.kilombino.com), or null without a price. */
function perCoin(code) {
  const p = S.w && S.w.price; if (!p || !p.usd) return null;
  if (code === 'USD') return p.usd;
  if (code === 'EUR' && p.eur) return p.eur;
  const r = p.perUsd && p.perUsd[code]; return r ? p.usd * r : null;
}
function fmtFiat(v, code, dec) {
  const f = fiatInfo(code);
  const d = dec == null ? f.dec : dec;
  const n = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  return (v < 0 ? '−' : '') + (f.sym ? f.sym + n : n + ' ' + f.code);
}
const fiatMissing = code => { const f = fiatInfo(code); return f.sym ? f.sym + ' –' : '– ' + code; };
function fiatOf(n) { const px = perCoin(S.fiat); return px == null ? null : fmtFiat(n * px / 1e8, S.fiat); }
function setFiat(f) { S.fiat = f; safeSet('kw.fiat', f); render(); }

/** USD and EUR at hand, every other currency the feed has behind a third chip (FiatPicker). */
function fiatPicker(accent) {
  const p = S.w && S.w.price;
  const avail = FIATS.filter(f => f[0] === 'USD' || f[0] === 'EUR' || (p && p.perUsd && p.perUsd[f[0]]));
  const other = S.fiat !== 'USD' && S.fiat !== 'EUR';
  const more = chip(other ? S.fiat + ' ▾' : '▾', other, () => {
    const d = dialog({ body: [h('div', { class: 'col' }, avail.map(f => h('div', { class: 'bm rowtap', style: { padding: '12px 4px', color: f[0] === S.fiat ? accent : COLORS.main },
      onclick: () => { d.close(); setFiat(f[0]); } }, R(f[0] + (f[1] ? '  ' + f[1] : '')))))] });
  }, true);
  return row('gap6', chip('USD', S.fiat === 'USD', () => setFiat('USD'), true), chip('EUR', S.fiat === 'EUR', () => setFiat('EUR'), true), more);
}
/** A typed amount: "12.5", "12,5", "1,234.56" or "1.234,56". Null if it is not a number. */
function parseFiat(text) {
  const s = String(text).trim().replace(/\s/g, ''); if (!s) return null;
  const dot = s.lastIndexOf('.'), comma = s.lastIndexOf(',');
  let n = s;
  if (dot >= 0 && comma >= 0) n = dot > comma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  else if (comma >= 0) n = (s.split(',').length === 2) ? s.replace(',', '.') : s.replace(/,/g, '');
  else if (s.split('.').length > 2) n = s.replace(/\./g, '');
  const v = Number(n); return isFinite(v) && v >= 0 ? v : null;
}
/**
 * The amount in the chosen currency, bound to a sats field (FiatAmountField): typing here fills the
 * sats, typing sats fills this. Disabled while there is no price.
 */
function fiatField(satsField, onSats, style) {
  const px = perCoin(S.fiat), dec = fiatInfo(S.fiat).dec;
  const f = field({ label: px == null ? `≈ ${S.fiat} (no price yet)` : `≈ ${S.fiat}`, mode: 'decimal', disabled: px == null, style });
  const fromSats = () => { const v = Number(satsField.input.value || 0); f.input.value = v > 0 && px ? (v * px / 1e8).toFixed(dec) : ''; };
  satsField.input.addEventListener('input', fromSats); fromSats();
  f.input.addEventListener('input', () => {
    const v = parseFiat(f.input.value); const s = v == null || !px ? '' : String(Math.round(v / px * 1e8));
    satsField.input.value = s; onSats(s);
  });
  return f;
}

// ------------------------------------------------------------------ boot

async function boot() {
  await i18nInit();
  S.me = await api('state');
  if (S.me.unlocked) await loadWallet().catch(() => {});
  render();
  // While the node is not known to be on the BLAKE2b chain, keep asking: the page opens by itself once it is.
  setInterval(async () => {
    if (!S.me || !S.me.chain || S.me.chain.ok) return;
    const me = await api('state').catch(() => null); if (!me) return;
    S.me = me; if (me.chain.ok && me.unlocked) await loadWallet().catch(() => {});
    render();
  }, 20000);
  // The balance card counts down to the next look, as the app's "↻ 0:29".
  setInterval(async () => {
    const el = document.getElementById('countdown');
    const left = Math.max(0, Math.round((S.nextAt - Date.now()) / 1000));
    if (el) el.textContent = left >= 60 ? `↻ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : `↻ ${left}s`;
    if (!S.me || !S.me.unlocked || document.visibilityState !== 'visible' || Date.now() < S.nextAt) return;
    if (busy()) { S.nextAt = Date.now() + 5000; return; }
    await loadWallet().catch(() => {});
    if (!busy()) render();
  }, 1000);
  startCoinjoinTimers();
  // Leaving the page puts street mode back on (as the app does when it leaves the screen).
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && S.w && S.w.settings) { S.street = S.w.settings.streetDefault !== false; render(); } });
}
window.addEventListener('load', () => boot().catch(e => { $app.replaceChildren(h('div', { class: 'screen' }, panel(COLORS.bad, t(e.message, 'bs c-bad')))); }));

async function loadWallet() {
  S.w = await api('wallet');
  S.nextAt = Date.now() + REFRESH * 1000;
  if (!C.st) loadCoinjoin().catch(() => {});
  if (!loadWallet.done && S.w.settings) S.street = S.w.settings.streetDefault !== false;
  loadWallet.done = true;
}

/** Something is being typed or chosen: a refresh would wipe it, so it waits. */
function busy() {
  const a = document.activeElement;
  if (a && a !== document.body && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName)) return true;
  return !!(S.sheet || C.create || C.join || C.pick || K.sheet || dialogsOpen > 0);
}

function render() {
  const y = window.scrollY;
  $app.replaceChildren();
  if (!S.me) return;
  if (S.me.chain && !S.me.chain.ok) return $app.append(chainView());
  if (!S.me.mode) return $app.append(onboarding());
  if (!S.me.unlocked) return $app.append(unlockView());
  $app.append(walletScreen());
  window.scrollTo(0, y);
}

// ------------------------------------------------------------------ the node's chain

function header(sub) {
  return [h('div', { class: 'row', style: { justifyContent: 'center' } }, h('img', { src: 'logo.png', class: 'logo', width: 160, height: 160, alt: '', onclick: aboutDialog })),
    t(R('Kilowallet'), 'dl', { style: { color: COLORS.btc } }),
    t('BITCOIN BLAKE2b (BTC) WALLET', 'tl c-soft'), sub || null];
}

// The node follows another chain (or is not past the BLAKE2b fork yet): nothing else opens.
function chainView() {
  const c = S.me.chain;
  const wait = c.state === 'syncing' || c.state === 'unreachable';
  const col_ = wait ? COLORS.warn : COLORS.bad;
  const again = () => api('state').then(async me => { S.me = me; if (me.chain.ok && me.unlocked) await loadWallet().catch(() => {}); render(); }).catch(e => toast(e.message));
  return h('div', { class: 'screen wide' }, spacer(40), header(),
    panel(col_, label('Your node', col_), spacer(8), t(c.title, 'bm', { style: { color: col_ } }), spacer(4), explain(c.message), spacer(10),
      btn('CHECK AGAIN', { kind: 'soft', full: true, cls: 'tm', onclick: again })));
}

// ------------------------------------------------------------------ onboarding (MainActivity.OnboardingScreen)

function onboarding() {
  if (S.setup === 'dice') return diceScreen();
  if (S.setup === 'backup') return seedBackup();
  if (S.setup === 'check') return wordsCheck();
  if (S.setup === 'restore') return restoreScreen();
  const ks = { text: S.watchKey || '', type: '' };
  const kType = h('div', {});
  const key = field({ label: 'xpub / ypub / zpub', area: true, value: ks.text, oninput: v => { ks.text = v; S.watchKey = v; drawType(); watchBtn.disabled = !canWatch(); } });
  const canWatch = () => ks.text.trim() && (ks.type || !xpubNeedsType(ks.text));
  const drawType = () => kType.replaceChildren(...[].concat(xpubTypeChoice(ks, COLORS.btc, drawType) || []));
  const scan = hasCamera() ? tbtn('📷  Scan a QR with the camera', COLORS.btc, () => scanQr(v => {
    const m = /(?:[xyz]pub)[1-9A-HJ-NP-Za-km-z]+/.exec(v); ks.text = m ? m[0] : v.trim(); key.input.value = ks.text; drawType(); watchBtn.disabled = !canWatch();
  }), 'bs', { style: { alignSelf: 'flex-start' } }) : null;
  const watchBtn = btn('WATCH IT', { full: true, cls: 'tm', color: COLORS.btc, disabled: !canWatch(), onclick: async () => {
    let pw;
    try { pw = await askPassword('Protect your wallet', 'Choose the password that opens it on this server', { repeat: true, label: 'new password (8+)', autocomplete: 'new-password', note: PASSWORD_NOTE }); } catch { return; }
    await setupDone(api('setup/watch', { password: pw, key: ks.text.trim(), type: ks.type }));
  } });
  drawType();
  return h('div', { class: 'screen wide' }, spacer(40), header(
    explain('This server holds one wallet: a HOT wallet you spend from, or a WATCH-ONLY one that only looks at another wallet. Its coins are read from your own node.')),
    panel(COLORS.btc, label('Hot wallet'), spacer(8),
      explain('Create a wallet you can send from. Its seed is generated on THIS server — roll real dice, SeedSigner-style — and stored encrypted, unlocked only by your password when you spend. Native SegWit (bc1q) by default.'),
      spacer(10),
      row('gap8', btn('NEW (DICE)', { grow: true, cls: 'tm', onclick: () => { S.setup = 'dice'; S.rolls = ''; S.strength = 128; render(); window.scrollTo(0, 0); } }),
        btn('RESTORE', { kind: 'soft', grow: true, cls: 'tm', color: COLORS.main, onclick: () => { S.setup = 'restore'; S.restore = null; render(); window.scrollTo(0, 0); } }))),
    panel(COLORS.btc, label('Watch-only wallet', COLORS.btc), spacer(8),
      explain('Paste an extended PUBLIC key (xpub/ypub/zpub) to watch balances. It holds no keys: to send, it hands a PSBT to a separate signer. Careful: an xpub reveals every address you will ever use — keep it like a bank statement.'),
      spacer(10), key, kType, scan, spacer(10), watchBtn));
}
const PASSWORD_NOTE = 'It encrypts the wallet on this server and is asked again before every send, as the app asks for your fingerprint. There is no way to recover it: keep it with your backup.';

async function setupDone(req) {
  try {
    const r = await req;
    S.me = await api('state'); S.setup = null; S.seed = null; S.watchKey = null;
    await loadWallet().catch(() => {});
    await loadCoinjoin().catch(() => {});
    if (S.me.mode === 'hot' && C.st && !C.st.enabled && !safeGet('kw.cjAsked')) S.askCoinjoin = true;
    render(); window.scrollTo(0, 0);
    return r;
  } catch (e) { toast(e.message); }
}

/** A pasted extended public key's prefix and depth (no checksum check: only to know what to ask). */
function xpubInfo(text) {
  const s = String(text || '').replace(/\s/g, '');
  if (!/^[xyzt]pub[1-9A-HJ-NP-Za-km-z]{100,}$/.test(s)) return null;
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n; for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const hex = n.toString(16).padStart(164, '0');
  return { prefix: s.slice(0, 4), depth: parseInt(hex.slice(8, 10), 16) };
}
function xpubNeedsType(text) { const k = xpubInfo(text); return !!k && (k.prefix === 'xpub' || k.prefix === 'tpub'); }
const XPUB_TYPES = [['p2wpkh', 'Native SegWit · bc1q… (BIP84)'], ['p2tr', 'Taproot · bc1p… (BIP86)'], ['p2sh-p2wpkh', 'Nested SegWit · 3… (BIP49)'], ['p2pkh', 'Legacy · 1… (BIP44)']];
/** Under a pasted key (XpubTypeChoice): the type of a plain xpub is asked; a non-account key is pointed out. */
function xpubTypeChoice(ks, accent, redraw, types) {
  const k = xpubInfo(ks.text);
  if (!k) return null;
  const out = [];
  if (k.depth !== 3) out.push(t(`This key is at depth ${k.depth}, not an account key (m/84'/0'/0', m/86'/0'/0'…): its addresses won't match your wallet's. Export the account xpub instead.`, 'bs c-bad'));
  if (k.prefix !== 'xpub' && k.prefix !== 'tpub') { ks.type = ''; return out; }
  out.push(t("A plain xpub doesn't say which addresses it makes: pick the type your wallet uses.", 'bs c-soft'));
  (types || XPUB_TYPES).forEach(([v, name]) => out.push(radioLine(ks.type === v, name, accent, () => { ks.type = v; redraw(); })));
  return out;
}

// ---- create with dice (HotWallet.DiceScreen)

function setupTop(title) {
  return [spacer(30), row('', t(title, 'tl grow', { style: { color: COLORS.btc } }), tbtn('back', COLORS.soft, () => { S.setup = null; S.seed = null; render(); }, 'bs'))];
}

function diceScreen() {
  const needed = S.strength === 256 ? 99 : 50;
  const rolls = S.rolls || '';
  const err = S.diceError ? t(S.diceError, 'bs c-bad') : null;
  const count = t(`${rolls.length} / ${needed} rolls`, 'tm', { style: { color: COLORS.btc } });
  const last = t(rolls ? '… ' + rolls.slice(-12).split('').join(' ') : 'tap the number on the die', 'bm c-soft');
  const gen = btn('GENERATE SEED', { full: true, cls: 'tm', disabled: rolls.length !== needed, onclick: async () => {
    S.diceError = null;
    let r; try { r = await api('setup/dice', { rolls: S.rolls, count: S.strength === 256 ? 24 : 12 }); } catch (e) { S.diceError = e.message; return render(); }
    const go = () => { S.seed = { words: r.words.split(' '), passphrase: '', repeat: '' }; S.setup = 'backup'; render(); window.scrollTo(0, 0); };
    // Rolls that look made up get a warning before they become a seed (DiceCheck, as Coldcard does).
    if (r.problems.length) {
      const d = dialog({ title: "These don't look like real dice", body: [r.problems.map(p => t('• ' + p, 'bs')),
        t('Numbers made up by hand are far easier to guess than real rolls, and anyone who guesses your seed takes your coins. Roll a real die for every number.', 'bs c-warn')],
        buttons: [tbtn('I ROLLED REAL DICE', COLORS.faint, () => { d.close(); go(); }), tbtn('ROLL AGAIN', COLORS.good, () => { d.close(); S.rolls = ''; render(); })] });
    } else go();
  } });
  const dice = [1, 2, 3, 4, 5, 6].map(n => h('button', { class: 'die', disabled: rolls.length >= needed, onclick: () => {
    if ((S.rolls || '').length < needed) { S.rolls = (S.rolls || '') + n; render(); }
  } }, R(String(n))));
  return h('div', { class: 'screen wide' }, setupTop('New wallet'),
    panel(COLORS.btc, label('Roll dice for your seed'), spacer(8),
      explain(`Tap the number each roll of a real die shows. ${needed} rolls become your seed by SHA-256 — the same rolls give the same seed on a SeedSigner, so you can verify this offline. The rolls go to this server only, never further.`)),
    row('gap8', h('div', { class: 'wordchip' + (S.strength !== 256 ? ' on' : ''), onclick: () => { S.strength = 128; S.rolls = ''; render(); } }, '12 words'),
      h('div', { class: 'wordchip' + (S.strength === 256 ? ' on' : ''), onclick: () => { S.strength = 256; S.rolls = ''; render(); } }, '24 words')),
    panel(COLORS.btc, count, last, spacer(10), row('gap6', dice), spacer(36),
      row('', tbtn('⌫ undo last', COLORS.soft, () => { S.rolls = (S.rolls || '').slice(0, -1); render(); }, 'bs'), h('div', { class: 'grow' }),
        tbtn('clear all', COLORS.faint, () => {
          if (!rolls) return;
          const d = dialog({ title: `Clear all ${rolls.length} rolls?`, body: [t('You would start again from the first roll.', 'bs')],
            buttons: [tbtn('KEEP THEM', COLORS.soft, () => d.close()), tbtn('CLEAR', COLORS.bad, () => { d.close(); S.rolls = ''; render(); })] });
        }, 'bs'))),
    err, gen);
}

/** Seed words in two columns read top to bottom (WordColumns): never translated. */
function wordColumns(words) {
  const half = Math.ceil(words.length / 2), w = String(words.length).length;
  const rows = [];
  for (let r = 0; r < half; r++) rows.push(row('', ...[r, r + half].map(i => h('div', { class: 'bm c-main grow', style: { whiteSpace: 'pre' } },
    i < words.length ? R(String(i + 1).padStart(w) + '. ' + words[i]) : ''))));
  return col('gap4', rows);
}

/** The optional passphrase (PassphraseFields): twice when creating, once when restoring, with the fingerprint. */
function passphraseFields(st, words, withRepeat, onChange) {
  const box = h('div', { class: 'col' });
  let visible = false;
  const fp = t('', 'bs c-soft');
  let fpTimer;
  const showFp = () => {
    clearTimeout(fpTimer);
    if (!words || !words.length) return;
    fp.textContent = tr('Wallet fingerprint: {0}').replace('{0}', '…');
    fpTimer = setTimeout(() => api('setup/fingerprint', { words: words.join(' '), passphrase: st.passphrase })
      .then(r => { fp.textContent = tr(`Wallet fingerprint: ${r.fingerprint}`); }).catch(() => { fp.textContent = ''; }), 300);
  };
  const notes = h('div', { class: 'col' });
  const drawNotes = () => {
    const p = st.passphrase, rep = st.repeat;
    const kids = [];
    if (withRepeat && p) kids.push(t(!rep ? 'Type it again to confirm it. The wallet is not created until both match.' : rep !== p ? 'The two passphrases do not match.' : 'Both match.', 'bs',
      { style: { color: rep && rep !== p ? COLORS.bad : rep === p ? COLORS.good : COLORS.faint } }));
    if (p && p.length < 12) kids.push(t(`Short passphrase (${p.length} characters): someone who finds your words could guess it. Use at least 12 characters, or several words.`, 'bs c-warn'));
    if (p && p !== p.trim()) kids.push(t('It starts or ends with a space. That space is part of the passphrase and you will have to type it every time.', 'bs c-warn'));
    kids.push(row('', t(p ? `${p.length} characters` : 'No passphrase.', 'bs c-faint grow'),
      p ? tbtn(visible ? 'hide' : 'show', COLORS.btc, () => { visible = !visible; pf.input.type = visible ? 'text' : 'password'; if (rf) rf.input.type = pf.input.type; drawNotes(); }, 'bs') : null));
    notes.replaceChildren(...kids);
    if (rf) rf.classList.toggle('hidden', !p);
    if (rf) rf.classList.toggle('err', !!(rep && rep !== p));
    onChange && onChange();
  };
  const pf = field({ label: 'passphrase (empty = none)', type: 'password', size: 'bm', value: st.passphrase, autocomplete: 'off',
    oninput: v => { st.passphrase = v.replace(/\n/g, ''); drawNotes(); showFp(); } });
  const rf = withRepeat ? field({ label: 'repeat passphrase', type: 'password', size: 'bm', value: st.repeat, oninput: v => { st.repeat = v; drawNotes(); } }) : null;
  box.append(panel(COLORS.btc, label('Passphrase (optional)', COLORS.btc), spacer(6),
    explain('Leave it EMPTY for a wallet without a passphrase, the usual choice. If you add one, read this first:'), spacer(4),
    ['Without the passphrase, your words open a different wallet: an empty one. Words alone are no longer a backup.',
      'If you lose the passphrase, you lose the funds. Nobody can recover it, not even with the words.',
      'Write it down, and keep it apart from the words: whoever finds both has everything.',
      'Every character counts: upper and lower case, spaces (also at the start or the end) and accents.'].map(x => t('•  ' + x, 'bs c-soft')),
    spacer(8), pf, rf, notes, words ? fp : null,
    words ? t('Write it down too: the same words and passphrase always give this fingerprint (Sparrow and SeedSigner show the same one).', 'bs c-faint') : null));
  drawNotes(); showFp();
  box.refreshFp = showFp;
  return box;
}

/** Write the words down, then create (HotWallet.SeedBackup). */
function seedBackup() {
  const st = S.seed;
  const ok = () => !st.passphrase || st.repeat === st.passphrase;
  const create = btn('', { full: true, cls: 'tm', onclick: () => createHot() });
  const check = tbtn('CHECK MY WORDS FIRST (optional)', COLORS.btc, () => { S.setup = 'check'; st.check = null; render(); window.scrollTo(0, 0); }, 'bm', { full: true });
  const upd = () => { create.disabled = !ok(); check.disabled = !ok(); create.textContent = tr(st.passphrase ? "I'VE WRITTEN BOTH DOWN — CREATE" : "I'VE WRITTEN IT DOWN — CREATE"); };
  const pass = passphraseFields(st, st.words, true, upd);
  upd();
  return h('div', { class: 'screen wide' }, setupTop('New wallet'),
    panel(COLORS.bad, label(`Write these ${st.words.length} words down`, COLORS.bad), spacer(6),
      explain('This is the ONLY backup of your money. Anyone who sees it can take your coins; if you lose it, no one can recover them. Write it on paper — never a photo or the cloud.')),
    spacer(10 - 14 + 14), panel(COLORS.btc, wordColumns(st.words)),
    spacer(12), pass, spacer(12), check, create,
    tbtn('start over', COLORS.faint, () => { S.seed = null; S.rolls = ''; S.setup = 'dice'; render(); }, 'bs', { full: true }));
}

async function createHot() {
  const st = S.seed;
  let pw;
  try { pw = await askPassword('Protect your seed', 'Choose the password that encrypts and stores it', { repeat: true, label: 'new password (8+)', autocomplete: 'new-password', note: PASSWORD_NOTE }); } catch { return; }
  const r = await setupDone(api('setup/new', { password: pw, words: st.words.join(' '), passphrase: st.passphrase }));
  if (r) safeSet('kw.cjAsked', null);
}

/** Three of the words asked back (WordsCheck), with the restore boxes' suggestions. */
function wordsCheck() {
  const st = S.seed;
  if (!st.check) {
    const idx = st.words.map((_, i) => i).sort(() => Math.random() - 0.5).slice(0, 3).sort((a, b) => a - b);
    st.check = { picks: idx, typed: ['', '', ''], wrong: false };
  }
  const c = st.check;
  const go = btn('CHECK — CREATE', { full: true, cls: 'tm', disabled: c.typed.some(x => !x.trim()), onclick: () => {
    if (c.picks.every((i, k) => c.typed[k] === st.words[i])) createHot(); else { c.wrong = true; render(); }
  } });
  const boxes = c.picks.map((i, k) => {
    const sugg = h('div', { class: 'scrollx' });
    const f = field({ label: `word ${i + 1}`, size: 'bm', value: c.typed[k], attrs: { autocapitalize: 'none' }, oninput: v => {
      c.typed[k] = v.trim().toLowerCase(); c.wrong = false; drawSugg(); go.disabled = c.typed.some(x => !x.trim());
    } });
    const drawSugg = () => {
      const typed = c.typed[k];
      const m = typed.length >= 2 && !BIP39.includes(typed) ? BIP39.filter(w => w.startsWith(typed)).slice(0, 4) : [];
      sugg.replaceChildren(...m.map(w => tbtn(R(w), COLORS.btc, () => { c.typed[k] = w; f.input.value = w; drawSugg(); go.disabled = c.typed.some(x => !x.trim()); }, 'bs')));
    };
    drawSugg();
    return [f, sugg];
  });
  return h('div', { class: 'screen wide' }, setupTop('New wallet'),
    panel(COLORS.btc, label('Check your words'), spacer(6),
      explain('From what you wrote down, type these words. If one does not match, go back and correct your copy. This check is optional: you can also go back and create the wallet straight away.'),
      spacer(8), boxes, c.wrong ? t('At least one does not match. Check your copy against the words shown.', 'bs c-bad') : null),
    go, tbtn('show the words again', COLORS.faint, () => { S.setup = 'backup'; render(); }, 'bs', { full: true }));
}

// ---- restore (HotWallet.RestoreScreen, SeedWordsInput)

let BIP39 = [];
fetch('bip39.json').then(r => r.json()).then(l => { BIP39 = l; }).catch(() => {});
const possibleWord = w => !w || BIP39.some(x => x.startsWith(w));

function restoreScreen() {
  const st = S.restore || (S.restore = { words: Array(12).fill(''), passphrase: '', focused: -1, since: '' });
  const err = t('', 'bs c-bad');
  const wordsBox = h('div', { class: 'col gap6' });
  const restoreBtn = btn('RESTORE', { full: true, cls: 'tm', onclick: async () => {
    const ws = st.words.map(w => w.trim().toLowerCase());
    if (ws.some(w => !BIP39.includes(w))) { err.textContent = tr('Fill in every word with a BIP-39 word.'); return; }
    let pw;
    try { pw = await askPassword('Protect your seed', 'Choose the password that encrypts and stores it', { repeat: true, label: 'new password (8+)', autocomplete: 'new-password', note: PASSWORD_NOTE }); } catch { return; }
    const since = st.since ? Math.floor(new Date(st.since + 'T00:00:00Z').getTime() / 1000) : 0;
    await setupDone(api('setup/restore', { password: pw, words: ws.join(' '), passphrase: st.passphrase, since }));
  } });
  const pass = h('div', {});
  const drawPass = () => {
    const ws = st.words.map(w => w.trim().toLowerCase());
    const valid = ws.every(w => BIP39.includes(w));
    pass.replaceChildren(passphraseFields(st, valid ? ws : null, false));
  };
  const drawWords = () => {
    const n = st.words.length, half = n / 2;
    const kids = [row('gap8', t('Number of words:', 'bs c-soft'), ...[12, 24].map(k => h('span', { class: 'ts tap', style: {
      color: n === k ? COLORS.ink : COLORS.btc, background: n === k ? COLORS.btc : 'var(--panel-soft)', borderRadius: '8px', padding: '6px 14px' },
      onclick: () => { while (st.words.length < k) st.words.push(''); st.words.length = k; drawWords(); } }, R(String(k)))))];
    const fields = [];
    for (let r = 0; r < half; r++) {
      const pair = [r, r + half].map(i => {
        const f = field({ label: R(String(i + 1)), size: 'bm', value: st.words[i], error: !possibleWord(st.words[i]), style: { flex: '1 1 0', marginTop: '2px' },
          attrs: { autocapitalize: 'none' }, oninput: v => typeWord(i, v) });
        f.input.addEventListener('focus', () => { if (st.focused !== i) { st.focused = i; drawSugg(); } });
        f.input.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Tab') {
          const m = BIP39.filter(w => w.startsWith(st.words[i])); if (st.words[i] && m.length === 1) { st.words[i] = m[0]; f.input.value = m[0]; }
          if (e.key === 'Enter' && fields[i + 1]) { e.preventDefault(); fields[i + 1].input.focus(); }
        } });
        fields[i] = f;
        return f;
      });
      kids.push(row('gap8', ...pair));
      const sugg = h('div', { class: 'scrollx', 'data-row': r });
      kids.push(sugg);
    }
    const wrong = st.words.map((w, i) => possibleWord(w) ? 0 : i + 1).filter(Boolean);
    kids.push(t(!wrong.length ? '' : (wrong.length === 1 ? `Word ${wrong[0]} is` : `Words ${wrong.join(', ')} are`) + ' not in the BIP-39 word list. Check the spelling.', 'bs c-bad'));
    wordsBox.replaceChildren(...kids);
    wordsBox.fields = fields;
    drawSugg(); drawPass(); upd();
  };
  // A pasted phrase fills the boxes from this one on, growing to 24 if it needs to.
  const typeWord = (i, raw) => {
    const parts = raw.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (parts.length > 1) {
      if (i + parts.length > st.words.length && i + parts.length <= 24) while (st.words.length < 24) st.words.push('');
      parts.forEach((p, k) => { if (i + k < st.words.length) st.words[i + k] = p; });
      return drawWords();
    }
    st.words[i] = raw.toLowerCase().replace(/[^a-z]/g, '');
    const f = wordsBox.fields[i]; if (f.input.value !== st.words[i]) f.input.value = st.words[i];
    f.classList.toggle('err', !possibleWord(st.words[i]));
    drawSugg(); upd();
    if (st.words.every(w => BIP39.includes(w))) drawPass();
  };
  const drawSugg = () => {
    const half = st.words.length / 2;
    wordsBox.querySelectorAll('[data-row]').forEach(el => el.replaceChildren());
    const f = st.focused;
    if (f < 0 || f >= st.words.length) return;
    const typed = st.words[f];
    const m = typed ? BIP39.filter(w => w.startsWith(typed)) : [];
    if (!m.length || (m.length === 1 && m[0] === typed)) return;
    const box = wordsBox.querySelector(`[data-row="${f % half}"]`);
    box.replaceChildren(...m.slice(0, 12).map(w => h('span', { class: 'sugg', onmousedown: e => e.preventDefault(), onclick: () => {
      st.words[f] = w; wordsBox.fields[f].input.value = w; wordsBox.fields[f].classList.remove('err');
      if (wordsBox.fields[f + 1]) wordsBox.fields[f + 1].input.focus(); else drawSugg();
      upd(); if (st.words.every(x => BIP39.includes(x))) drawPass();
    } }, R(w))), m.length > 12 ? t(R('+' + (m.length - 12)), 'bs c-faint', { style: { padding: '8px' } }) : null);
  };
  const upd = () => { restoreBtn.disabled = st.words.some(w => !w.trim()); };
  drawWords();
  const since = field({ label: 'created on (optional)', type: 'date', size: 'bm', value: st.since, oninput: v => { st.since = v; } });
  return h('div', { class: 'screen wide' }, setupTop('Restore wallet'),
    panel(COLORS.btc, label('Enter your seed words'), spacer(8),
      explain('Type your 12 or 24 BIP-39 words, one per box (or paste them all in the first). Tap a suggestion to fill a word in. They are checked before anything is stored, and then encrypted with your password. If the wallet had a passphrase, type it below exactly; if it had none, leave it empty.')),
    wordsBox, pass,
    panel(COLORS.btc, label('Its history'), spacer(6),
      explain('When the wallet was made, if you know it: your node then looks for its movements from that day on. Without it, the node looks back from the oldest coin the wallet still holds. A pruned node can only look back as far as it keeps.'),
      since),
    err, restoreBtn);
}

// ------------------------------------------------------------------ unlock (the app's fingerprint at the door)

function unlockView() {
  const f = field({ label: 'password', type: 'password', size: 'bl', autocomplete: 'current-password', cls: 'onink', onenter: () => go() });
  const err = t('', 'bs c-bad');
  const go = () => api('unlock', { password: f.input.value }).then(async () => { S.me = await api('state'); await loadWallet().catch(e => toast(e.message)); render(); })
    .catch(e => { err.textContent = tr(e.message); });
  setTimeout(() => f.input.focus(), 0);
  return h('div', { class: 'screen wide' }, spacer(40), header(),
    panel(COLORS.btc, label('Unlock your wallet'), spacer(8),
      explain(isHotMode() ? 'Your hot wallet is on this server, encrypted: its password opens it here, as your fingerprint does in the app.' : 'Your watch-only wallet is on this server: its password opens it here.'),
      f, err, spacer(10), btn('UNLOCK', { full: true, cls: 'tm', onclick: go })));
}
const isHotMode = () => S.me && S.me.mode === 'hot';

function aboutDialog() {
  const d = dialog({ title: R(`Kilowallet ${S.me && S.me.version || ''}`), body: [
    t('A wallet for Bitcoin BLAKE2b, made by Kilombino.', 'bs'),
    t('Open source and reproducible: anyone can rebuild this app from its code and check it is byte for byte the one published. No account, no tracking.', 'bs'),
    h('a', { class: 'bm', href: 'https://kilombino.com', target: '_blank', rel: 'noopener noreferrer', style: { color: COLORS.btc, textDecoration: 'none' } }, R('kilombino.com')),
    h('a', { class: 'bs', href: 'https://github.com/Kilombino/kilowallet-server', target: '_blank', rel: 'noopener noreferrer', style: { color: COLORS.soft, textDecoration: 'none' } }, R('github.com/Kilombino/kilowallet-server'))],
    buttons: [tbtn('CLOSE', COLORS.soft, () => d.close())] });
}

// ------------------------------------------------------------------ the wallet screen (MainActivity.WalletScreen)

function walletScreen() {
  const accent = accentNow();
  const top = row('', h('div', { class: 'grow row' }, walletSwitch(accent)),
    tbtn(R(S.showSettings ? '✕' : '⚙'), COLORS.soft, () => toggleSettings(), 'tm', { style: { padding: '8px 6px', fontSize: '18px' } }),
    h('button', { class: 'iconbtn', 'aria-label': 'Close Kilowallet?', onclick: quitDialog }, powerGlyph()),
    hspace(4), h('img', { src: 'logo.png', class: 'logo', width: 34, height: 34, alt: '', onclick: aboutDialog }));
  const parts = [spacer(28), top];
  if (S.askCoinjoin) setTimeout(askCoinjoinOnce, 0);
  if (S.showSettings) {
    parts.push(settingsPanel(accent), isHot() ? hotWordsPanel(accent) : null, spacer(30));
    return h('div', { class: 'screen', style: { '--a': accent } }, parts);
  }
  // A watch-only wallet stays that: no Ark, no coinjoin (it cannot sign).
  if (!isHot() && S.tab !== 'btc') S.tab = 'btc';
  parts.push(advancedTabs());
  if (S.tab === 'coinjoin') parts.push(coinjoinScreen(COLORS.cj));
  else if (S.tab === 'ark') parts.push(arkView(COLORS.ark));
  else parts.push(btcTab(accent));
  parts.push(spacer(30));
  return h('div', { class: 'screen', style: { '--a': accent } }, parts);
}

/** The wallet switch (WalletModeSwitch): the server keeps one wallet, so it shows that one. */
function walletSwitch(accent) {
  return h('div', { class: 'wswitch', style: { '--a': accent } }, h('span', { class: 'on' }, isHot() ? '🔥 HOT' : '👁 WATCH'));
}

/** The power symbol, drawn (some fonts have no ⏻). */
function powerGlyph() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('width', '14'); svg.setAttribute('height', '14'); svg.setAttribute('viewBox', '0 0 14 14');
  const a = document.createElementNS(ns, 'path'); a.setAttribute('d', 'M4.2 3.4 A5.2 5.2 0 1 0 9.8 3.4'); a.setAttribute('fill', 'none');
  const l = document.createElementNS(ns, 'path'); l.setAttribute('d', 'M7 1 V6.3');
  [a, l].forEach(p => { p.setAttribute('stroke', COLORS.soft); p.setAttribute('stroke-width', '1.8'); p.setAttribute('stroke-linecap', 'round'); svg.append(p); });
  return svg;
}

/** ⏻: here it locks the wallet (the app closes itself); rounds and Ark go on on the server. */
function quitDialog() {
  const d = dialog({ title: 'Lock Kilowallet?', body: [t('The wallet locks: opening it again asks for its password. Your coinjoin rounds and Ark go on running on this server, as they do with the app closed.', 'bs')],
    buttons: [tbtn('CANCEL', COLORS.soft, () => d.close()), tbtn('LOCK', accentNow(), () => {
      d.close(); api('lock', {}).then(() => { S.me.unlocked = false; S.w = null; S.showSettings = false; render(); }).catch(e => toast(e.message));
    })] });
}

/** Opening the settings is a step back can undo: the browser's back closes them. */
function toggleSettings(open = !S.showSettings) {
  if (open === S.showSettings) return;
  S.showSettings = open;
  if (open) { try { history.pushState({ kwSettings: true }, ''); } catch {} }
  else if (history.state && history.state.kwSettings) { try { history.back(); } catch {} }
  render(); window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => { if (S.showSettings) { S.showSettings = false; render(); } });

/** BTC | COINJOIN | ARK (AdvancedTabs): each its symbol over its name; the server has no Lightning node. */
function advancedTabs() {
  const tabs = [['btc', '⛓', 'BTC', COLORS.btc]];
  if (isHot()) tabs.push(['coinjoin', '🌀', 'COINJOIN', COLORS.cj], ['ark', '⛵', 'ARK', COLORS.ark]);
  return h('div', { class: 'tabs' }, tabs.map(([k, icon, name, c]) => h('div', { class: S.tab === k ? 'on' : '', style: { '--tc': c }, onclick: () => openTab(k) },
    h('div', { class: 'tm', style: { color: S.tab === k ? c : null } }, R(icon)),
    h('div', { class: tabs.length > 3 ? 'ls' : 'ts', style: { color: S.tab === k ? c : null } }, name))));
}

async function openTab(k) {
  S.tab = k; S.sheet = null; render();
  if (k === 'ark') { await loadArk().catch(e => toast(e.message)); render(); }
  if (k === 'coinjoin') { await loadCoinjoin().catch(e => toast(e.message)); render(); reloadPools(); }
  if (k === 'btc') { await loadWallet().catch(() => {}); render(); }
}

// ------------------------------------------------------------------ BTC

function btcTab(accent) {
  const w = S.w || {};
  const parts = [scanStatus(w, accent)];
  if (w.error || w.importing || !S.w) return parts;
  parts.push(balanceCard(w, accent));
  if (S.sheet === 'send') parts.push(sendSheet(accent));
  else if (S.sheet === 'receive') parts.push(receiveSheet(accent));
  else parts.push(row('gap8', btn('RECEIVE', { kind: 'soft', grow: true, cls: 'tm', onclick: () => { S.sheet = 'receive'; S.recvIdx = null; render(); } }),
    btn('SEND', { grow: true, cls: 'tm', onclick: () => { S.sheet = 'send'; S.draft = null; S.sent = null; S.psbt = null; S.form = null; render(); } })));
  parts.push(addressList(w, accent), movementsCard(w, accent));
  return parts;
}

/** How the look is going (ScanStatus). Here the node does the looking: its own wallet for these keys. */
function scanStatus(w, accent) {
  if (!S.w) return panel(accent, row('gap10', dot(accent, true), t('connecting to your node', 'bm', { style: { color: accent } })));
  if (w.error) return panel(accent, t('could not complete', 'bm c-bad'), spacer(4), explain(w.error),
    tbtn('retry', accent, () => loadWallet().then(render).catch(e => toast(e.message)), 'bs', { style: { alignSelf: 'flex-start' } }));
  if (w.importing) return panel(accent, row('gap10', dot(accent, true), col('', t('reading your history', 'bm', { style: { color: accent } }),
    explain("The node is looking through the chain for this wallet's coins and movements. It can take from a minute to a while; this page updates by itself."))));
  return panel(accent, row('gap10', dot(COLORS.good, false), t('scan complete', 'bm c-good')),
    spacer(6), t(R(tr('server: ') + tr('your node')), 'bs c-soft'),
    t(R(tr('node wallet: ') + (w.node || '')), 'bs c-faint'));
}

function balanceCard(w, accent) {
  const total = (w.confirmed || 0) + (w.pending || 0);
  const left = Math.max(0, Math.round((S.nextAt - Date.now()) / 1000));
  const value = fiatOf(total);
  const usedCount = (w.receive ? w.receive.index : 0) + (w.receiveTr ? w.receiveTr.index : 0);
  const type = (S.me.mode === 'watch' ? w.type : (isHot() && safeGet('kw.recvTr') === '1' && w.taproot) ? 'P2TR' : 'P2WPKH');
  return panel(accent,
    row('', label('BTC balance', accent), h('div', { class: 'grow' }), streetEye(),
      t(R(left >= 60 ? `↻ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : `↻ ${left}s`), 'bs c-faint', { id: 'countdown' }), hspace(8), dot(COLORS.good, false, 7)),
    spacer(6),
    S.street ? t('STREET MODE', 'hm', { style: { color: accent } })
      : row('bottom wrap', t(R(groupSats(total)), 'dl', { style: { color: accent } }), hspace(8), t('sats', 'tl', { style: { color: accent, opacity: .7, paddingBottom: '6px' } })),
    t(street(btcAmount(total)), 'bs c-faint'),
    spacer(8),
    row('', t(street('≈ ' + (value || fiatMissing(S.fiat))), 'hs c-main grow'), fiatPicker(accent)),
    w.pending ? [spacer(4), t(street(`unconfirmed: ${groupSats(w.pending)} sats`), 'bs c-warn')] : null,
    spacer(10),
    t(`${usedCount} used addresses · height ${w.height || 0}`, 'bs c-soft'),
    t(SCRIPT_TYPES[type] ? `${SCRIPT_TYPES[type][0]} — ${SCRIPT_TYPES[type][1]}` : '', 'bs c-faint'),
    spacer(6), explain('BTC: Bitcoin with BLAKE2b proof of work. 164-byte headers.'));
}
const SCRIPT_TYPES = { P2PKH: ['Legacy', "Addresses that start with 1. Bitcoin's original format."], P2SH_P2WPKH: ['Nested SegWit', 'Addresses that start with 3. SegWit wrapped for older wallets.'],
  P2WPKH: ['Native SegWit', 'Addresses that start with bc1q. The most widely used.'], P2TR: ['Taproot', 'Addresses that start with bc1p. The newest, and cheaper to spend.'] };

/** The eye next to a balance: show asks for the password, as the app asks for the fingerprint. */
function streetEye() {
  return tbtn(S.street ? '👁 show' : '🙈 hide', COLORS.soft, async () => {
    if (!S.street) { S.street = true; return render(); }
    try { await verifyPassword('Unlock street mode', 'Show your balances and movements'); S.street = false; render(); } catch {}
  }, 'bs');
}
/** The password asked and checked, for what the app asks the fingerprint for. */
async function verifyPassword(title, sub) {
  const pw = await askPassword(title, sub);
  try { await api('unlock', { password: pw }); } catch (e) { toast(e.message); throw e; }
  return pw;
}

// ---- receive (ReceiveSheet)

function receiveSheet(accent) {
  const w = S.w;
  const tr_ = isHot() && w.taproot && safeGet('kw.recvTr') === '1';
  const r = tr_ ? w.receiveTr : w.receive;
  const purpose = tr_ ? 86 : ({ P2PKH: 44, P2SH_P2WPKH: 49, P2WPKH: 84, P2TR: 86 }[w.type] || 84);
  // Addresses handed out in this sheet: ◀ goes back among them (the node's wallet only moves forward).
  S.recvHist = S.recvHist && S.recvHist.base === r.address ? S.recvHist : { base: r.address, list: [r], at: 0 };
  const hist = S.recvHist;
  const cur = hist.list[hist.at];
  const request = () => { const a = Number(S.recvAmt || 0); return a > 0 ? 'bitcoin:' + cur.address + '?amount=' + (a / 1e8).toFixed(8).replace(/\.?0+$/, '') : cur.address; };
  const qrBox = h('div', { class: 'qr', onclick: () => copyText(request()).then(ok => ok && toast('COPIED ✓')) }, qrImg(request(), 200));
  const redraw = () => qrBox.replaceChildren(qrImg(request(), 200));
  const ask = field({ label: 'amount to ask (sats, optional)', mode: 'numeric', value: S.recvAmt || '', style: { flex: '1 1 0' },
    oninput: (v, el) => { el.value = v.replace(/\D/g, ''); S.recvAmt = el.value; redraw(); } });
  const copyBtn = btn('COPY', { grow: true, cls: 'tm', onclick: async () => {
    if (await copyText(request())) { copyBtn.textContent = tr('COPIED ✓'); copyBtn.style.background = COLORS.good; setTimeout(() => { copyBtn.textContent = tr('COPY'); copyBtn.style.background = ''; }, 2000); }
  } });
  return panel(accent,
    row('', label('receive', accent), h('div', { class: 'grow' }), tbtn(R('✕'), COLORS.soft, () => { S.sheet = null; render(); }, 'tl')),
    spacer(8),
    col('ac', qrBox, spacer(10), t(R(cur.address), 'bm c-main brk center tap', { onclick: () => copyText(cur.address).then(ok => ok && toast('COPIED ✓')) }), spacer(4),
      t(`unused · m/${purpose}'/0'/0'/0/${cur.index}`, 'bs c-faint center')),
    spacer(8),
    row('gap8', ask, fiatField(ask, v => { S.recvAmt = v; redraw(); }, { flex: '1 1 0' })),
    spacer(10), row('gap8', copyBtn), spacer(8),
    row('gap8', btn('◀ PREVIOUS', { kind: 'soft', grow: true, cls: 'tm', disabled: hist.at === 0, onclick: () => { hist.at--; render(); } }),
      btn('NEXT ▶', { kind: 'soft', grow: true, cls: 'tm', onclick: () => {
        if (hist.at < hist.list.length - 1) { hist.at++; return render(); }
        api('receive/next', { type: tr_ ? 'p2tr' : 'p2wpkh' }).then(n => { hist.list.push(n); hist.at = hist.list.length - 1; render(); }).catch(e => toast(e.message));
      } })),
    hist.at !== 0 ? tbtn('back to the next unused', COLORS.faint, () => { hist.at = 0; render(); }, 'bs', { full: true }) : null);
}

// ---- send (SendSheet)

function sendSheet(accent) {
  const close = tbtn(R('✕'), COLORS.soft, () => { S.sheet = null; S.draft = null; S.psbt = null; S.sent = null; S.form = null; render(); }, 'tl');
  const head = [row('', label('send', accent), h('div', { class: 'grow' }), close), spacer(8)];
  if (S.sent) return panel(accent, head, sentView(accent));
  if (S.psbt) return panel(accent, head, psbtView(S.draft, accent));
  if (S.draft) return panel(accent, head, reviewView(S.draft, accent));
  return panel(accent, head, sendForm(accent));
}

function contactName(dest, accent) {
  const c = (S.w.contacts || []).find(x => x.address === (dest || '').trim());
  return c ? t(R('→ ' + c.name), 'bs', { style: { color: accent } }) : null;
}
function contactsButton(accent, onPick) {
  return tbtn('CONTACTS', accent, () => {
    const list = S.w.contacts || [];
    const body = h('div', { class: 'col gap4' });
    const draw = () => body.replaceChildren(
      !list.length ? t('No contacts yet. After you pay a BTC address, the wallet offers to save it with a name.', 'bs') : null,
      list.map(c => row('', h('div', { class: 'grow col rowtap', style: { padding: '6px 0' }, onclick: () => { d.close(); onPick(c.address); } },
        t(R(c.name), 'bm c-main'), t(R('BTC · ' + shortAddress(c.address)), 'bs c-faint')),
        tbtn(R('✕'), COLORS.soft, () => api('contacts', { address: c.address, delete: true }).then(l => { S.w.contacts = l; list.splice(list.indexOf(c), 1); draw(); }).catch(e => toast(e.message))))));
    draw();
    const d = dialog({ title: 'Contacts', body: [body], buttons: [tbtn('CLOSE', accent, () => d.close())] });
  }, 'bs');
}
const cleanDest = v => { let s = (v || '').trim(); const i = s.indexOf(':'); if (i >= 1 && i <= 10 && s.slice(0, i).toLowerCase() === 'bitcoin') s = s.slice(i + 1); return s.split('?')[0].trim(); };
const hasCamera = () => 'BarcodeDetector' in window && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

function sendForm(accent) {
  const f = S.form || (S.form = { to: '', amount: '', rate: '', max: false, coinControl: false, coins: new Set(), extra: [] });
  if (S.sendError) { var failed = t(S.sendError, 'bs c-bad'); S.sendError = null; }
  const nameBox = h('div', {});
  const to = field({ label: 'recipient address', value: f.to, style: { flex: '1 1 0' }, oninput: v => { f.to = v; nameBox.replaceChildren(contactName(v, accent) || ''); upd(); } });
  const paste = tbtn('PASTE', accent, async () => { try { f.to = cleanDest(await navigator.clipboard.readText()); to.input.value = f.to; nameBox.replaceChildren(contactName(f.to, accent) || ''); upd(); } catch { toast('Paste it into the box.'); } }, 'bs');
  const cam = hasCamera() ? tbtn(R('📷'), accent, () => scanQr(v => { f.to = cleanDest(v); to.input.value = f.to; upd(); }), 'tm') : null;
  nameBox.append(contactName(f.to, accent) || '');
  const amount = field({ label: 'amount (sats)', mode: 'numeric', value: f.amount, style: { flex: '2 1 0' }, oninput: (v, el) => { el.value = v.replace(/\D/g, ''); f.amount = el.value; f.max = false; upd(); } });
  const rate = field({ label: 'sat/vB', mode: 'decimal', value: f.rate, style: { flex: '1 1 0' }, oninput: (v, el) => { el.value = v.replace(',', '.').replace(/[^\d.]/g, ''); f.rate = el.value; } });
  if (!f.rate) api('fee').then(r => { if (!f.rate) { f.rate = String(Math.max(1, Math.round((r.suggested || 2) * 10) / 10)); rate.input.value = f.rate; } }).catch(() => {});
  const maxBtn = f.extra.length ? null : tbtn('MAX', accent, async () => {
    if (!f.to.trim()) return toast('Type where to send.');
    try {
      const d = await api('send/prepare', { to: f.to.trim(), max: true, rate: Number(f.rate || 2), coins: f.coinControl ? [...f.coins] : [] });
      f.amount = String(d.amount); f.max = true; amount.input.value = f.amount; amount.input.dispatchEvent(new Event('input'));
      f.max = true;
    } catch (e) { toast(e.message); }
  }, 'bm');
  // More recipients, all paid by this one transaction.
  const extra = f.extra.map((x, i) => {
    const xName = h('div', {}, contactName(x.to, accent) || '');
    const xt = field({ label: 'address', value: x.to, style: { flex: '2 1 0' }, oninput: v => { x.to = v; xName.replaceChildren(contactName(v, accent) || ''); upd(); } });
    const xa = field({ label: 'sats', mode: 'numeric', value: x.amount, style: { flex: '1 1 0' }, oninput: (v, el) => { el.value = v.replace(/\D/g, ''); x.amount = el.value; upd(); } });
    return [spacer(8), row('', t(`recipient ${i + 2}`, 'bs c-soft grow'),
      tbtn('PASTE', accent, async () => { try { x.to = cleanDest(await navigator.clipboard.readText()); xt.input.value = x.to; upd(); } catch { toast('Paste it into the box.'); } }, 'bs'),
      contactsButton(accent, v => { x.to = v; xt.input.value = v; upd(); }),
      tbtn(R('✕'), COLORS.bad, () => { f.extra.splice(i, 1); render(); }, 'bm')),
      row('gap8', xt, xa), xName];
  });
  // Coin control: pick exactly which coins to spend, or leave it off.
  const coinBox = h('div', { class: 'col' });
  const drawCoins = () => {
    if (!f.coinControl) return coinBox.replaceChildren();
    const coins = S.w.coins || [];
    const kids = [];
    if (!coins.length) kids.push(t('No spendable coins on this chain.', 'bs c-faint'));
    coins.forEach(c => {
      const sel = f.coins.has(c.outpoint);
      kids.push(row('rowtap', h('span', { style: { width: '26px', flex: 'none', color: sel ? accent : COLORS.faint } }, R(sel ? '☑' : '☐')),
        weight(t(R(`${groupSats(c.value)} sats`), 'bm', { style: { color: sel ? accent : COLORS.main } }),
          t(R(shortAddress(c.address) + ' · m/…/' + (c.path || '').split('/').slice(-2).join('/') + (c.confirmations ? '' : ' · 0 conf')), 'bs c-faint'),
          c.mixed || c.inRound ? t([c.mixed ? '🌀 mixed' : null, c.inRound ? 'in a pool waiting for people: sending it leaves that pool' : null].filter(Boolean).join(' · '), 'bs', { style: { color: c.inRound ? COLORS.warn : COLORS.good } }) : null)
      ).also(() => { sel ? f.coins.delete(c.outpoint) : f.coins.add(c.outpoint); drawCoins(); upd(); }));
      kids[kids.length - 1].style.padding = '4px 0';
    });
    if (f.coins.size) {
      kids.push(t(`selected: ${groupSats(coins.filter(c => f.coins.has(c.outpoint)).reduce((a, c) => a + c.value, 0))} sats`, 'bs', { style: { color: accent } }));
      const byTx = {}; coins.filter(c => f.coins.has(c.outpoint) && c.mixed).forEach(c => { const tx = c.outpoint.split(':')[0]; byTx[tx] = (byTx[tx] || 0) + 1; });
      if (Object.values(byTx).some(n => n > 1)) kids.push(t('Two or more of these coins came out of the same coinjoin round: spending them together links them, and shows they were one person\'s.', 'bs c-warn'));
    }
    coinBox.replaceChildren(...kids);
  };
  drawCoins();
  const payBox = h('div', { class: 'col' });
  const review = btn('REVIEW', { full: true, cls: 'tm', onclick: () => api('send/prepare', {
    to: f.to.trim(), amount: Number(f.amount || 0), max: f.max, rate: Number(f.rate || 2), coins: f.coinControl ? [...f.coins] : [],
    extra: f.extra.map(x => ({ to: x.to.trim(), amount: Number(x.amount || 0) })) })
    .then(d => { S.draft = d; render(); }).catch(e => { S.sendError = e.message; render(); }) });
  const upd = () => {
    review.disabled = !(f.to.trim() && Number(f.amount) > 0 && f.extra.every(x => x.to.trim() && Number(x.amount) > 0) && (!f.coinControl || f.coins.size));
    payCheck(f, payBox, accent);
  };
  upd();
  return [failed ? [failed, spacer(6)] : null,
    row('', to, paste, cam), nameBox,
    row('', t('address', 'bs c-faint grow'), contactsButton(accent, v => { f.to = v; to.input.value = v; nameBox.replaceChildren(contactName(v, accent) || ''); upd(); })),
    spacer(8), row('gap8', amount, rate),
    fiatField(amount, v => { f.amount = v; f.max = false; upd(); }, { width: '66%' }),
    row('', t(f.extra.length ? 'fee 0.1–1000 sat/vB' : 'fee 0.1–1000 sat/vB · MAX sends everything minus fee', 'bs c-faint grow'), maxBtn),
    extra,
    tbtn('＋ ADD RECIPIENT', accent, () => { f.extra.push({ to: '', amount: '' }); f.max = false; render(); }, 'bm', { style: { alignSelf: 'flex-start' } }),
    spacer(8),
    row('', t('Coin control', 'bm c-main grow'), sw(f.coinControl, v => { f.coinControl = v; drawCoins(); upd(); })),
    coinBox, payBox, spacer(10), review];
}

/**
 * Paying through a new coinjoin pool (SendSheet), offered once every recipient row is filled in:
 * equal amounts of one address type make a pool of equal outputs going straight to the
 * recipients; different ones (or by choice) a payment pool, Kilojoin v5.
 */
function payCheck(f, box, accent) {
  clearTimeout(payCheck.t);
  const rows = [{ to: f.to, amount: f.amount }].concat(f.extra || []);
  const filled = rows.every(r => (r.to || '').trim() && Number(r.amount || 0) > 0);
  const cj = C.st;
  if (!filled || !isHot() || !cj || !cj.enabled || cj.blocker) { box.replaceChildren(); return; }
  payCheck.t = setTimeout(async () => {
    let c;
    try { c = await api('coinjoin/pay/check', { recipients: rows.map(r => ({ to: r.to.trim(), amount: Number(r.amount) })) }); } catch { return; }
    if (!c.any) return box.replaceChildren(spacer(8), t('Pay through a coinjoin: not available. ' + (c.reason || ''), 'bs c-faint'));
    box.replaceChildren(spacer(8),
      h('button', { class: 'obtn bm', onclick: () => payThroughPool(f, c, !c.ok) }, c.ok ? '🌀 PAY THROUGH A NEW COINJOIN POOL' : '🌀 PAY THROUGH A NEW PAYMENT POOL'),
      t(c.ok ? "The payment goes out only when the pool closes, which can take hours. If it doesn't fill, nothing is paid and you can send normally."
        : "Different amounts: the others in the pool each put in the same total and get it back in equal outputs. Your payments still show on the chain as odd amounts, and as one person's; which coins paid them stays hidden among the members (best when everyone uses perfect coins), and the others mix among themselves. It goes out only when the pool closes; if it doesn't fill, nothing is paid.", 'bs c-faint'),
      c.ok && c.paymentOk ? tbtn('or as a payment pool (the others get the total back in equal outputs)', accent, () => payThroughPool(f, c, true), 'ls', { style: { padding: '0', alignSelf: 'flex-start' } }) : null);
  }, 250);
}

/** SEND hands its payment to the coinjoin tab: a new pool's sheet for it, with BACK to SEND as it was. */
function payThroughPool(f, c, v5) {
  const rows = [{ to: f.to.trim(), amount: Number(f.amount) }].concat((f.extra || []).map(x => ({ to: x.to.trim(), amount: Number(x.amount) })));
  const draft = { to: f.to, amount: f.amount, rate: f.rate, max: false, coinControl: f.coinControl, coins: new Set(f.coins), extra: (f.extra || []).map(x => ({ to: x.to, amount: x.amount })) };
  const rate = Math.max(1, Number(String(f.rate || '1').replace(',', '.')) || 1);
  const pay = { v5, recipients: rows, amounts: c.amounts, total: c.total, amount: c.amount, script: c.type, coins: f.coinControl ? [...f.coins] : [], draft };
  C.create = { pay, fromCoins: false, amount: String(v5 ? c.total : c.amount), rate: fmtRate(rate), min: '2', max: '5', hours: '6', inputs: '5',
    outputs: v5 ? '1' : String(rows.length), password: '', script: c.type, picked: [] };
  C.pick = null; C.join = null; C.chosen = [];
  S.sheet = null; S.draft = null; S.form = null;
  openTab('coinjoin');
}

/** BACK from a payment's pool sheet: SEND again, with the payment as it was typed and ticked. */
function backToSend(pay) {
  C.create = null; C.pick = null; C.chosen = [];
  S.form = pay.draft; S.tab = 'btc'; S.sheet = 'send'; S.draft = null; S.sent = null; S.psbt = null;
  render(); window.scrollTo(0, 0);
}

function rowLine(lab, value, accent) {
  return row('', t(lab, 'bs c-faint grow'), t(R(value), 'bm b', { style: { color: accent } })).also(null);
}
function feeGate(concern, state, onToggle) {
  const box = h('div', { class: 'col' });
  const draw = () => box.replaceChildren(t(`⚠ ${concern} Check it before signing: a fee can't be taken back.`, 'bs c-bad'),
    checkLine(state.ok, 'Yes, I want to pay this fee', COLORS.bad, () => { state.ok = !state.ok; draw(); onToggle(); }));
  draw();
  return box;
}

/** REVIEW (SendSheet's Review): what goes where, the fee, the change; then sign with the password. */
function reviewView(d, accent) {
  const lines = [];
  if (d.cpfpParent) lines.push(t('Pulls the stuck payment along: a payment to yourself that spends what it brought you, with a fee big enough for both. Miners take the two together.', 'bs c-soft'));
  else if (d.cancels) lines.push(t('Replaces the payment with one that sends everything back to a fresh address of yours. The recipients get nothing, unless the original confirms first: then this one is refused.', 'bs c-soft'));
  else if (d.replaces) lines.push(t('Replaces the stuck send with the same payment and a higher fee, taken from your change.', 'bs c-soft'));
  const recips = d.recipients && d.recipients.length ? d.recipients : [{ to: d.to, amount: d.amount }];
  recips.forEach((r, i) => {
    lines.push(rowLine(i === 0 ? (d.cpfpParent || d.cancels ? 'Back to you' : 'To') : `To ${i + 1}`, shortAddress(r.to), accent));
    lines.push(rowLine(i === 0 ? 'Amount' : `Amount ${i + 1}`, `${groupSats(r.amount)} sats`, accent));
  });
  if (recips.length > 1) lines.push(rowLine('Total sent', `${groupSats(recips.reduce((a, r) => a + r.amount, 0))} sats`, accent));
  lines.push(t("Signed with the unified sighash: valid only on BTC, it can't be replayed on the spamchain.", 'bs c-faint'));
  lines.push(rowLine('Fee', (d.replaces ? `${groupSats(d.replacedFee)} → ` : '') + `${groupSats(d.fee)} sats`, accent));
  if (d.cpfpParent) lines.push(t(`both together ${d.packageRate.toFixed(1)} sat/vB`, 'bs c-faint end'));
  lines.push(rowLine('Change', d.change && !d.cpfpParent ? `${groupSats(d.change)} sats` : '—', accent));
  if (d.changeAddress && d.change && !d.cpfpParent) lines.push(t(`back to your ${d.changeAddress.startsWith('bc1p') || d.changeAddress.startsWith('bcrt1p') ? 'Taproot' : 'SegWit'} address ${shortAddress(d.changeAddress)}`, 'bs c-faint end'));
  lines.push(rowLine('Inputs', String(d.inputs), accent));
  const fee = { ok: false }, mix = { ok: false };
  const sign = btn(isHot() ? 'CONFIRM & SIGN' : 'EXPORT PSBT', { full: true, cls: 'tm' });
  const upd = () => { sign.disabled = !!(d.concern && !fee.ok) || !!(d.mixWarning && !mix.ok); };
  if (d.concern) lines.push(spacer(6), feeGate(d.concern, fee, upd));
  if (d.mixWarning) {
    const box = h('div', { class: 'col' });
    const draw = () => box.replaceChildren(t('⚠ ' + d.mixWarning, 'bs c-warn'), checkLine(mix.ok, 'I understand, send it anyway', COLORS.warn, () => { mix.ok = !mix.ok; draw(); upd(); }));
    draw(); lines.push(spacer(6), box);
  }
  upd();
  const edit = tbtn('edit', COLORS.faint, () => { S.draft = null; render(); }, 'bs', { full: true });
  if (isHot()) {
    sign.addEventListener('click', async () => {
      let pw; try { pw = await askPassword(d.cancels ? 'Cancel payment' : d.replaces || d.cpfpParent ? 'Speed up payment' : 'Confirm payment', d.cancels ? 'Unlock to sign the cancellation' : d.replaces || d.cpfpParent ? 'Unlock to sign the speed-up' : 'Unlock to sign and send'); } catch { return; }
      sign.disabled = true;
      api('send/confirm', { draft: d.draft, password: pw, acceptFee: fee.ok, acceptMix: mix.ok })
        .then(r => { S.sent = { txid: r.txid, to: d.to, kind: d.cancels ? 'cancel' : d.cpfpParent ? 'cpfp' : d.replaces ? 'rbf' : 'send' }; S.draft = null; S.form = null; loadWallet().then(render).catch(() => {}); render(); })
        .catch(e => { sign.disabled = false; toast(e.message); });
    });
    return [lines, spacer(10), sign, edit];
  }
  // Watch-only: the keys are elsewhere. Hand the signer a PSBT.
  const origin = field({ label: "key origin (optional), e.g. [d34db33f/84'/0'/0']", value: (S.w.settings || {}).keyOrigin || '' });
  sign.addEventListener('click', () => api('psbt/export', { draft: d.draft, origin: origin.input.value, acceptFee: fee.ok, acceptMix: mix.ok })
    .then(r => { S.psbt = r.psbt; render(); }).catch(e => toast(e.message)));
  return [lines, spacer(10), origin, t('Signers need it to find their key. Left empty, the usual path for this address type is used and SeedSigner fills in the fingerprint.', 'bs c-faint'), spacer(6), sign, edit];
}

/** Give the signer the PSBT (QR, copy, file) and take the signed one back (paste, file). */
function psbtView(d, accent) {
  const back = field({ label: 'the signed PSBT (base64 or hex)', area: true, rows: 3 });
  const file = h('input', { type: 'file', class: 'hidden', onchange: async e => {
    const b = new Uint8Array(await e.target.files[0].arrayBuffer());
    const isBin = b[0] === 0x70 && b[1] === 0x73 && b[2] === 0x62 && b[3] === 0x74 && b[4] === 0xff;
    back.input.value = isBin ? btoa(String.fromCharCode(...b)) : new TextDecoder().decode(b).trim();
  } });
  const dl = () => { const a = h('a', { href: 'data:application/octet-stream;base64,' + S.psbt, download: `kilowallet-${d.amount}.psbt` }); document.body.append(a); a.click(); a.remove(); };
  return [t('1. Sign it elsewhere', 'ts', { style: { color: accent } }),
    t('Take this PSBT to your signer: SeedSigner (BLAKE2b) or Bitcoin Knots (walletprocesspsbt). It must sign with the BLAKE2b unified sighash (0x21): an old-style signature would also be valid on the spamchain, so it is refused.', 'bs c-soft'),
    spacer(8),
    S.psbt.length <= 2500 ? h('div', { class: 'row', style: { justifyContent: 'center' } }, h('div', { class: 'qr' }, qrImg(S.psbt, 300))) : t('Too big for one QR: copy it or save it as a file.', 'bs c-faint'),
    row('gap8', copyButton('COPY', () => S.psbt, accent), tbtn('SAVE FILE', accent, dl)),
    spacer(10),
    t('2. Bring the signed PSBT back', 'ts', { style: { color: accent } }),
    t('Only this same transaction is accepted, and every signature is checked here before it is sent.', 'bs c-soft'),
    back, file,
    row('gap8', tbtn('PASTE', accent, async () => { try { back.input.value = (await navigator.clipboard.readText()).trim(); } catch { toast('Paste it into the box.'); } }),
      tbtn('OPEN FILE', accent, () => file.click())),
    btn('BROADCAST', { full: true, cls: 'tm', onclick: () => api('psbt/import', { draft: d.draft, psbt: back.input.value })
      .then(r => { S.sent = { txid: r.txid, to: d.to, kind: 'send' }; S.draft = null; S.psbt = null; S.form = null; loadWallet().then(render).catch(() => {}); render(); }).catch(e => toast(e.message)) }),
    tbtn('cancel', COLORS.faint, () => { S.psbt = null; S.draft = null; render(); }, 'bs', { full: true })];
}

function sentView(accent) {
  const s = S.sent;
  // A payment to someone else can be kept as a contact (SaveContactPrompt).
  if (s.kind === 'send' && s.to && !(S.w.contacts || []).some(c => c.address === s.to) && !s.asked) { s.asked = true; setTimeout(() => saveContactPrompt(s.to, accent), 50); }
  return [t('Broadcast ✓', 'tm c-good'), spacer(6),
    t(R(s.txid), 'bs c-soft brk tap', { onclick: () => txDetail({ txid: s.txid, confirmations: 0, net: 0 }, accent, 'just sent · in the mempool') }),
    row('gap8', copyButton('📋 COPY TXID', () => s.txid, accent), tbtn('🔎 DETAILS', accent, () => txDetail({ txid: s.txid, confirmations: 0, net: 0 }, accent, 'just sent · in the mempool'))),
    spacer(8), btn('DONE', { full: true, cls: 'tm', onclick: () => { S.sheet = null; S.sent = null; render(); } })];
}

function saveContactPrompt(dest, accent) {
  const name = field({ label: 'Name', size: 'bl', cls: 'ondlg' });
  const err = t('', 'bs c-bad');
  const d = dialog({ title: 'Save as a contact?', body: [t('Give ' + shortAddress(dest) + ' a name to pick it from CONTACTS next time.', 'bs'), name, err],
    buttons: [tbtn('NOT NOW', COLORS.soft, () => d.close()), tbtn('SAVE', accent, () => {
      const n = name.input.value.trim(); if (!n) return;
      api('contacts', { name: n.slice(0, 40), address: dest }).then(l => { S.w.contacts = l; d.close(); }).catch(e => { err.textContent = e.message; });
    })] });
}

// ---- lists

/** Only the addresses that hold something now, in derivation order, with their coins (AddressList). */
function addressList(w, accent) {
  const coins = w.coins || [];
  if (!coins.length) return null;
  const by = new Map();
  for (const c of coins) { if (!by.has(c.address)) by.set(c.address, []); by.get(c.address).push(c); }
  const pathKey = p => (p || '').split('/').map(x => parseInt(x, 10) || 0);
  const held = [...by.entries()].sort((a, b) => { const x = pathKey(a[1][0].path), y = pathKey(b[1][0].path); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; });
  S.unfolded = S.unfolded || new Set();
  const confText = c => c.confirmations === 0 ? 'in mempool · 0 conf' : `${c.confirmations} conf` + (c.confirmations >= 6 ? '  ✓' : '');
  const kind = c => c.change ? 'change' : 'receive';
  const notes = cs => [cs.some(c => c.mixed) ? t('🌀 mixed', 'bs c-good') : null,
    cs.some(c => c.inRound) ? t('in a pool waiting for people: sending it leaves that pool', 'bs c-warn') : null];
  const open = (addr, cs) => txDetail(null, accent, `${cs[0].path} · ${kind(cs[0])} · ` + street(`${groupSats(cs.reduce((a, c) => a + c.value, 0))} sats`), {
    kind: 'address', id: addr, extra: cs.map(c => [t(R(street(`${groupSats(c.value)} sats`) + ' · ' + tr(confText(c)) + ` · ${c.outpoint.slice(0, 8)}…:${c.outpoint.split(':')[1]}`), 'bs c-soft'),
      c.mixed ? t('🌀 mixed', 'bs c-good') : null, c.inRound ? t('in a pool waiting for people: sending it leaves that pool', 'bs c-warn') : null]) });
  const coinRow = (addr, c, inner) => row('rowtap', weight(t(R(shortAddress(addr)), 'bm c-main'), t(R(`${c.path}  ·  ${tr(kind(c))}`), 'bs c-faint'), notes([c])),
    col('ae', t(R(street(`${groupSats(c.value)} sats`)), 'bm b', { style: { color: accent } }), t(confText(c), 'bs c-good'))).also(() => open(addr, [c]));
  const rows = [];
  held.forEach(([addr, cs]) => {
    const many = cs.length > 1, isOpen = many && S.unfolded.has(addr);
    const least = cs.reduce((m, c) => (c.confirmations < m.confirmations ? c : m), cs[0]);
    const total = cs.reduce((a, c) => a + c.value, 0);
    const r = row('rowtap', weight(t(R(shortAddress(addr)), 'bm c-main'), t(R(`${cs[0].path}  ·  ${tr(kind(cs[0]))}`), 'bs c-faint'), notes(cs),
      many ? t(R((isOpen ? '▾ ' : '▸ ') + tr(`${cs.length} coins`)), 'bs', { style: { color: accent, padding: '2px 0' }, onclick: e => {
        e.stopPropagation(); isOpen ? S.unfolded.delete(addr) : S.unfolded.add(addr); render(); } }) : null),
      col('ae', t(R(street(`${groupSats(total)} sats`)), 'bm b', { style: { color: accent } }),
        t(confText(least), 'bs', { style: { color: least.confirmations === 0 ? COLORS.warn : least.confirmations >= 6 ? COLORS.good : COLORS.soft } }))).also(() => open(addr, cs));
    r.style.padding = '6px 0'; rows.push(r);
    if (isOpen) cs.forEach(c => { const x = coinRow(addr, c, true); x.style.padding = '6px 0 6px 16px'; rows.push(x); });
  });
  return panel(accent, label('addresses with balance · confirmations', accent), spacer(4),
    t('tap an address to copy it or open it on the explorer', 'bs c-faint'), spacer(6), rows);
}

/** Movements, newest first, with what was left after each (MovementsCard). */
function movementsCard(w, accent) {
  const txs = w.transactions || [];
  if (!txs.length) return null;
  const site = explorer().replace(/^https?:\/\//, '');
  const rows = txs.slice(0, 15).map(tx => {
    const pending = !tx.confirmations;
    const right = pending ? col('ae', t('in mempool · 0 conf', 'bs c-warn'), isHot() ? row('', tbtn('⚡ speed up', accent, e => { e.stopPropagation(); bumpDialog(tx, tx.net > 0 ? 'cpfp' : 'rbf', accent); }, 'bs'),
      tx.net <= 0 ? tbtn('✕ cancel', COLORS.warn, e => { e.stopPropagation(); bumpDialog(tx, 'cancel', accent); }, 'bs') : null) : null)
      : t(`${tx.confirmations} conf` + (tx.confirmations >= 6 ? '  ✓' : ''), 'bs', { style: { color: tx.confirmations >= 6 ? COLORS.good : COLORS.soft } });
    const r = row('rowtap', weight(
      t(R(street((tx.net >= 0 ? '+' : '−') + groupSats(Math.abs(tx.net)) + ' sats')), 'bm', { style: { color: tx.net >= 0 ? COLORS.good : COLORS.main } }),
      t(street(`(left: ${groupSats(tx.left)} sats)`), 'bs c-soft'),
      t(R(tx.txid.slice(0, 8) + '…' + tx.txid.slice(-6)), 'bs c-faint')), right).also(() => txDetail(tx, accent));
    r.style.padding = '3px 0';
    return r;
  });
  return panel(accent, label('movements · confirmations', accent), spacer(8),
    t(`tap a movement for its details: copy the txid or open it on ${site}`, 'bs c-faint'), spacer(4), rows,
    txs.length > 15 ? t(`… and ${txs.length - 15} more`, 'bs c-faint') : null);
}

const explorer = () => ((S.w && S.w.settings && S.w.settings.explorer) || 'https://mempool.kilombino.com').replace(/\/$/, '');
const explorerChosen = () => safeGet('kw.explorerChosen') === '1';

/**
 * A transaction's (or address's) details (TxDetailDialog): the full id to copy with one tap, and
 * opening it on the block explorer after a warning the first time.
 */
function txDetail(tx, accent, statusText, o) {
  o = o || {};
  const kind = o.kind || 'tx';
  const id = o.id || tx.txid;
  const pending = tx && !tx.confirmations;
  const status = statusText || (pending ? 'in mempool · 0 confirmations' : `${tx.confirmations} confirmation` + (tx.confirmations === 1 ? '' : 's'));
  const confirmBox = h('div', { class: 'col gap8' });
  const openIt = base => window.open(`${base}/${kind}/${id}`, '_blank', 'noopener');
  const askExplorer = () => {
    const own = field({ label: 'your explorer (https://…)', cls: 'ondlg' });
    const save = tbtn('SAVE AND OPEN', COLORS.faint, () => {
      const u = own.input.value.trim().replace(/\/$/, '');
      api('settings', { explorer: u }).then(s => { S.w.settings = s; safeSet('kw.explorerChosen', '1'); openIt(u); d.close(); }).catch(e => toast(e.message));
    });
    save.disabled = true;
    own.input.addEventListener('input', () => { const u = own.input.value.trim(); const ok = u.startsWith('https://') || (u.startsWith('http://') && u.includes('.onion')); save.disabled = !ok; save.style.color = ok ? accent : COLORS.faint; });
    confirmBox.replaceChildren(t(`This opens an EXTERNAL block explorer: the site sees which ${kind === 'address' ? 'address' : 'transaction'} you look up (and so which addresses are yours). Use your own if you run one; it is saved and this will not be asked again. You can change it in settings.`, 'bs c-warn'),
      own, save, tbtn(R(tr("USE KILOMBINO'S ({0})").replace('{0}', 'mempool.kilombino.com')), COLORS.soft, () => {
        api('settings', { explorer: 'https://mempool.kilombino.com' }).then(s => { S.w.settings = s; safeSet('kw.explorerChosen', '1'); openIt('https://mempool.kilombino.com'); d.close(); }).catch(e => toast(e.message));
      }));
  };
  const body = [t(status, 'bs', { style: { color: accent } }), o.extra || null, t(R(id), 'bs c-main brk'),
    row('gap8 wrap', copyButton(kind === 'address' ? '📋 COPY ADDRESS' : '📋 COPY TXID', () => id, accent),
      tbtn('🔎 EXPLORER', accent, () => explorerChosen() ? openIt(explorer()) : askExplorer())),
    confirmBox];
  if (tx && pending && isHot() && kind === 'tx' && tx.net !== undefined && !o.noBump) {
    body.push(tbtn(tx.net > 0 ? '⚡ SPEED UP (CPFP)' : '⚡ SPEED UP (RBF)', accent, () => { d.close(); bumpDialog(tx, tx.net > 0 ? 'cpfp' : 'rbf', accent); }));
    if (tx.net <= 0) body.push(tbtn('✕ CANCEL (RBF)', COLORS.warn, () => { d.close(); bumpDialog(tx, 'cancel', accent); }));
  }
  const d = dialog({ title: kind === 'address' ? 'Address' : 'Transaction', body, buttons: [tbtn('CLOSE', COLORS.soft, () => d.close())] });
}

/** Speed up an unconfirmed send (RBF), pull a payment along (CPFP), or cancel a send (BumpDialog). */
function bumpDialog(tx, mode, accent) {
  const cpfp = mode === 'cpfp', cancel = mode === 'cancel';
  const st = { rate: '3', draft: null, error: null, fee: { ok: false } };
  const body = h('div', { class: 'col gap6' });
  const btns = h('div', { class: 'row gap8' });
  const draw = () => {
    const d = st.draft;
    if (st.sent) {
      body.replaceChildren(t((cpfp ? 'Speed-up sent ✓' : cancel ? 'Cancellation sent ✓' : 'Replacement sent ✓') + '\n', 'bs c-good pre'), t(R(st.sent), 'bs c-good brk'));
      btns.replaceChildren(tbtn('CLOSE', COLORS.soft, () => dlg.close()), tbtn('DONE', accent, () => dlg.close()));
      return;
    }
    if (d) {
      const kids = [];
      if (d.cancels) kids.push(t('Replaces the payment with one that sends everything back to a fresh address of yours. The recipients get nothing, unless the original confirms first: then this one is refused.', 'bs'),
        t(`Back to you: ${shortAddress(d.to)} · ${groupSats(d.amount)} sats`, 'bs'), t(`Fee: ${groupSats(d.replacedFee)} → ${groupSats(d.fee)} sats`, 'bs', { style: { color: accent } }));
      else if (d.cpfpParent) kids.push(t('Pulls the stuck payment along: a payment to yourself that spends what it brought you, with a fee big enough for both. Miners take the two together.', 'bs'),
        t(`Back to you: ${groupSats(d.amount)} sats`, 'bs'), t(`Fee: ${groupSats(d.fee)} sats · both together ${d.packageRate.toFixed(1)} sat/vB`, 'bs', { style: { color: accent } }));
      else kids.push(t('Replaces the stuck send with the same payment and a higher fee, taken from your change.', 'bs'),
        t(`To: ${shortAddress(d.to)} · ${groupSats(d.amount)} sats`, 'bs'), t(`Fee: ${groupSats(d.replacedFee)} → ${groupSats(d.fee)} sats`, 'bs', { style: { color: accent } }),
        t(`Change: ${groupSats(d.change)} sats`, 'bs'));
      const sign = tbtn('CONFIRM & SIGN', accent, async () => {
        let pw; try { pw = await askPassword(cancel ? 'Cancel payment' : 'Speed up payment', cancel ? 'Unlock to sign the cancellation' : 'Unlock to sign the speed-up'); } catch { return; }
        api('send/confirm', { draft: d.draft, password: pw, acceptFee: st.fee.ok }).then(r => { st.sent = r.txid; draw(); loadWallet().then(render).catch(() => {}); }).catch(e => toast(e.message));
      });
      if (d.concern) kids.push(feeGate(d.concern, st.fee, () => { sign.disabled = !st.fee.ok; }));
      sign.disabled = !!(d.concern && !st.fee.ok);
      body.replaceChildren(...kids);
      btns.replaceChildren(tbtn('CLOSE', COLORS.soft, () => dlg.close()), sign);
      return;
    }
    const rate = field({ label: 'sat/vB', mode: 'decimal', value: st.rate, cls: 'ondlg', oninput: v => { st.rate = v.replace(',', '.'); } });
    body.replaceChildren(st.error ? t(st.error, 'bs c-bad') : '',
      t(cpfp ? 'Fee rate for the stuck payment and the speed-up together. Most pools only mine from 1 sat/vB.'
        : cancel ? 'Fee rate for the cancellation. It must beat the old fee by at least 1 sat/vB of its size, and the higher it is, the likelier it gets mined before the original.'
          : 'New fee rate. It must beat the old fee by at least 1 sat/vB of the transaction\'s size; most pools only mine from 1 sat/vB.', 'bs'), rate);
    btns.replaceChildren(tbtn('CLOSE', COLORS.soft, () => dlg.close()), tbtn('REVIEW', accent, () => {
      body.replaceChildren(t('working…', 'bs', { style: { color: accent } }));
      api(cancel ? 'cancel' : cpfp ? 'cpfp' : 'bump', { txid: tx.txid, rate: Number(st.rate) || 3 }).then(d2 => { st.draft = d2; draw(); }).catch(e => { st.error = e.message; draw(); });
    }));
  };
  const dlg = dialog({ title: R(tr(cancel ? `Cancel ${tx.txid.slice(0, 8)}…` : `Speed up ${tx.txid.slice(0, 8)}…`)), body: [body] });
  dlg.querySelector('.dialog').append(h('div', { class: 'dbtns' }, btns));
  draw();
}

// ------------------------------------------------------------------ settings (SettingsPanel)

function settingsPanel(accent) {
  const st = S.w && S.w.settings || {};
  const set = (k, v) => api('settings', { [k]: v }).then(s => { S.w.settings = s; render(); }).catch(e => toast(e.message));
  const hot = isHot();
  const parts = [label('settings', accent), spacer(10),
    t('Language', 'bm c-main'),
    h('div', { class: 'row wrap gap6' }, chip('Automatic', I18N.choice === I18N.AUTO, () => i18nSet(I18N.AUTO).then(render)),
      I18N.LANGUAGES.map(([code, name]) => chip(name, I18N.choice === code, () => i18nSet(code).then(render), true))),
    spacer(10)];
  if (hot) {
    const ark = K.st || {};
    parts.push(settingRow('Ark', ark.enabled ? 'Active: instant payments and Lightning through Ark.' : 'Off. Instant payments and Lightning through an Ark server: read how it works first.',
      tbtn(ark.enabled ? 'OPEN' : 'LEARN MORE', accent, () => { S.showSettings = false; openTab('ark'); window.scrollTo(0, 0); }, 'bs')), spacer(10));
    const cj = C.st || {};
    const cs = cj.settings || {};
    parts.push(settingRow('Coinjoin', cj.enabled ? 'On. Mix your coins with other people\'s in pools.' : 'Off. Read how it works first.',
      tbtn(cj.enabled ? 'TURN OFF' : 'LEARN MORE', accent, () => {
        if (cj.enabled) api('coinjoin/enable', { on: false }).then(r => { C.st = r; C.pools = null; render(); }).catch(e => toast(e.message));
        else { S.showSettings = false; openTab('coinjoin'); window.scrollTo(0, 0); }
      }, 'bs')));
    if (cj.enabled) {
      parts.push(settingRow('Notify open coinjoin pools', 'Looked up every 5 minutes by this server: StartOS notifications, and Telegram or this browser if you set them up (COINJOIN tab). Your own rounds always notify.',
        sw(cs.notify_new_pools !== false, v => api('coinjoin/settings', { notify_new_pools: v }).then(s => { C.st.settings = s; }).catch(e => toast(e.message)))));
      parts.push(spacer(10), autoSetting(accent));
    }
  }
  parts.push(spacer(14), t(hot ? 'Address type for new addresses' : 'Address type (derivation)', 'bm c-main'));
  if (hot) {
    parts.push(explain('Native SegWit (bc1q) by default. With Taproot (bc1p), new receive and change addresses are Taproot: its coins are cheaper to spend, so a send with several of them pays less. Both kinds are always scanned and spent, so switching never hides a coin. Coinjoin pools use only your bc1q coins.'), spacer(4));
    const taproot = safeGet('kw.recvTr') === '1';
    [[false, "BIP84 · Native SegWit (bc1q)  (m/84'/0'/0')"], [true, "BIP86 · Taproot (bc1p)  (m/86'/0'/0')"]].forEach(([v, l]) =>
      parts.push(radioLine(taproot === v, l, accent, () => { if (v && !S.w.taproot) return toast('Unlock the wallet once to set up its Taproot addresses.'); safeSet('kw.recvTr', v ? '1' : null); render(); })));
  } else {
    const p = { P2PKH: 44, P2SH_P2WPKH: 49, P2WPKH: 84, P2TR: 86 };
    parts.push(explain('How the keys are read from your xpub. It was chosen when the wallet was added: to read it another way, forget it and add the key again.'), spacer(4));
    Object.keys(p).forEach(k => parts.push(radioLine(S.w.type === k, `BIP${p[k]} · ${SCRIPT_TYPES[k][0]}  (m/${p[k]}'/0'/0')`, accent, () => {}, S.w.type !== k)));
  }
  // The node's look: from a block height on (the app's full rescan).
  const height = field({ label: 'from block height, e.g. 961640', mode: 'numeric', style: { flex: '1 1 0' } });
  parts.push(spacer(10), settingRow('Full rescan', 'Makes your node read the chain again from a block height for this wallet: it finds payments the node missed, such as those older than the wallet on this server. Slow (hours from far back); a pruned node can only go back as far as it keeps.', null),
    row('gap8', height, tbtn('RESCAN', accent, () => api('rescan', { from: Number(height.input.value || 0) }).then(() => toast('Rescan started on the node.')).catch(e => toast(e.message)), 'bs')));
  // Node and explorer, folded: they matter once and take a lot of room.
  parts.push(spacer(14), row('rowtap', t('BTC node & explorer', 'bm c-main grow'), t(R(S.nodeOpen ? '▾' : '▸'), 'tm', { style: { color: accent } })).also(() => { S.nodeOpen = !S.nodeOpen; render(); }));
  if (S.nodeOpen) {
    const exp = field({ label: R('https://…'), value: st.explorer || '' });
    const msg = t('', 'bs c-faint');
    parts.push(t('Your own BTC node', 'bm c-main'),
      explain('This wallet reads the chain only from your node, through its RPC, with a watch-only wallet of its own inside it: ' + (S.w.node || '') + '. No Electrum server, no third party.'),
      spacer(14), t('BTC block explorer', 'bm c-main'),
      explain('Where a movement opens when you tap it. Default: https://mempool.kilombino.com.'), spacer(6), exp,
      row('', tbtn('save', accent, () => {
        const u = exp.input.value.trim().replace(/\/$/, '');
        if (!(u.startsWith('https://') || (u.startsWith('http://') && u.includes('.onion')))) { msg.textContent = tr('use an https:// address (http:// only for .onion)'); return; }
        api('settings', { explorer: u }).then(s => { S.w.settings = s; safeSet('kw.explorerChosen', '1'); msg.textContent = tr('saved'); }).catch(e => toast(e.message));
      }, 'bs'), tbtn('default', COLORS.soft, () => api('settings', { explorer: 'https://mempool.kilombino.com' }).then(s => { S.w.settings = s; exp.input.value = s.explorer; msg.textContent = tr('back to default'); }).catch(e => toast(e.message)), 'bs')),
      msg);
  }
  // The extended public key, behind the password: QR and text, a tap copies it.
  const key = S.w.accountKey || '';
  parts.push(spacer(10), t(R(key.slice(0, 24) + '…' + key.slice(-10)), 'bs c-faint brk'));
  if (key) {
    parts.push(spacer(10), tbtn(R(S.showKey ? tr('hide ' + key.slice(0, 4)) : tr(`SHOW ${key.slice(0, 4).toUpperCase()} (QR)`)), accent, async () => {
      if (S.showKey) { S.showKey = false; return render(); }
      try { await verifyPassword('Show the public key', 'It reveals every address of this wallet'); S.showKey = true; render(); } catch {}
    }, 'bs', { style: { alignSelf: 'flex-start' } }));
    if (S.showKey) parts.push(explain('Anyone with it sees every address and payment of this wallet (but cannot spend). Share it only with software you trust, e.g. to watch this wallet from another phone.'),
      h('div', { class: 'row', style: { justifyContent: 'center' } }, h('div', { class: 'qr' }, qrImg(key, 240))),
      t(R(key), 'bs c-main brk tap', { onclick: () => copyText(key).then(ok => ok && toast('copied ✓')) }), t('tap the key to copy it', 'bs c-faint'));
  }
  parts.push(spacer(10),
    settingRow('Street mode', 'On: balances and amounts are hidden every time the app opens, until you unlock them with the eye. Off: they always show (turning it off asks for your password).',
      sw(st.streetDefault !== false, async v => {
        if (!v) { try { await verifyPassword('Turn street mode off', 'Amounts will show without asking'); } catch { return render(); } }
        set('streetDefault', v);
      })),
    spacer(10),
    settingRow('Prices in your currency', 'From mempool.kilombino.com: it sees this server asking, nothing about your wallet.', sw(st.prices !== false, v => set('prices', v))),
    spacer(10), passwordChange(accent));
  parts.push(spacer(14), switchWalletButton(accent), forgetButton(accent),
    t(R(`Kilowallet server ${S.me.version} · ` + tr('updates come from the StartOS or Umbrel store')), 'bs c-faint'));
  return panel(accent, parts);
}

/** "Run the round on its own" (CoinjoinAutoSetting), as this server does it. */
function autoSetting(accent) {
  const cs = (C.st && C.st.settings) || {};
  return settingRow('Run the round on its own', cs.auto_sign
    ? 'One password when you join; then it accepts closing and signs by itself, only if the transaction pays your exact output and change. It carries on with this page closed: the keys of the round\'s coins stay in the server\'s memory until the round ends. If the service restarts, unlock Kilowallet once to let it sign.'
    : 'Off: you accept closing and sign yourself, with your password, at each step.',
  sw(!!cs.auto_sign, v => api('coinjoin/settings', { auto_sign: v }).then(s => { C.st.settings = s; render(); }).catch(e => toast(e.message))));
}

function passwordChange(accent) {
  return settingRow('Password', 'The one that opens this wallet here and signs its payments.', tbtn('CHANGE', accent, async () => {
    let old, neu;
    try { old = await askPassword('Change the password', 'Your password now'); neu = await askPassword('Change the password', 'The new one', { repeat: true, label: 'new password (8+)', autocomplete: 'new-password' }); } catch { return; }
    api('password', { password: old, newPassword: neu }).then(() => toast('Password changed.')).catch(e => toast(e.message));
  }, 'bs'));
}

function forgetDialog(accent, thenSetup) {
  const hot = isHot();
  const st = { words: !hot };
  const body = h('div', { class: 'col gap8' });
  const go = tbtn(thenSetup ? 'GO ON' : 'FORGET', COLORS.faint, async () => {
    if (!st.words) return;
    let pw; try { pw = await askPassword('Forget this wallet', hot ? 'Its seed is deleted from this server' : 'It is removed from this server'); } catch { return; }
    d.close();
    api('forget', { password: pw }).then(async () => { S.me = await api('state'); S.w = null; S.showSettings = false; S.tab = 'btc'; S.setup = null; render(); window.scrollTo(0, 0); }).catch(e => toast(e.message));
  });
  const draw = () => {
    body.replaceChildren(
      t(thenSetup ? 'Creating or restoring another spending wallet REPLACES this one\'s seed on this server. The coins stay on-chain, but the only way back to them is your recovery words (and passphrase, if it has one). Without them, the money is lost.'
        : hot ? 'This DELETES the wallet\'s seed from this server. The coins stay on-chain, but the only way back to them is your recovery words (and passphrase, if it has one). Without them, the money is lost.'
          : 'This removes the watch-only wallet from this server. Nothing on-chain changes; you can add the xpub again.', 'bs'),
      hot ? t('Before that: have your recovery words written on paper, the safest backup there is. This wallet\'s coinjoin rounds must be over, and its Ark wallet is set aside (not deleted) on this server.', 'bs c-warn') : null,
      hot ? checkLine(st.words, 'I have my recovery words written down', COLORS.bad, () => { st.words = !st.words; draw(); }) : null);
    go.style.color = st.words ? COLORS.bad : COLORS.faint; go.disabled = !st.words;
  };
  draw();
  const d = dialog({ title: thenSetup ? 'Switch to another wallet?' : 'Forget this wallet?', body: [body],
    buttons: [tbtn(thenSetup ? 'STAY' : 'KEEP IT', COLORS.soft, () => d.close()), go] });
}
function switchWalletButton(accent) {
  return btn(isHot() ? 'SWITCH / NEW WALLET' : 'CREATE A DIFFERENT HOT WALLET', { kind: 'soft', full: true, cls: 'tm', onclick: () => forgetDialog(accent, true) });
}
function forgetButton(accent) {
  return tbtn('forget this wallet', COLORS.bad, () => forgetDialog(accent, false), 'bs', { style: { alignSelf: 'flex-start' } });
}

/** The recovery words, at the very end of settings (HotWordsPanel). */
function hotWordsPanel(accent) {
  const words = S.shownWords;
  return [tbtn(words ? 'HIDE WORDS' : 'RECOVERY WORDS', COLORS.soft, () => {
    if (words) { S.shownWords = null; return render(); }
    const d = dialog({ title: 'Show recovery words?', body: [t('Anyone who sees these words can take your money — in your BTC wallet and in Ark, which uses the same words. Make sure no one is looking and nothing is recording the screen. Never type them into a website or share them with anyone, including support.', 'bs')],
      buttons: [tbtn('CANCEL', COLORS.soft, () => d.close()), tbtn('SHOW', COLORS.bad, async () => {
        d.close();
        let pw; try { pw = await askPassword('Unlock your wallet', 'Show your recovery words'); } catch { return; }
        api('secret/words', { password: pw }).then(r => { S.shownWords = { words: r.words.split(' '), passphrase: r.passphrase }; render(); }).catch(e => toast(e.message));
      })] });
  }, 'bs', { full: true }),
  words ? panel(COLORS.btc, wordColumns(words.words)) : null,
  words && words.passphrase ? panel(COLORS.btc, label('+ passphrase', COLORS.btc), spacer(4), explain('The words alone open a different, empty wallet: keep the passphrase too.')) : null];
}

/** A new spending wallet is asked once whether it wants coinjoins (the app's CoinjoinIntro dialog). */
function askCoinjoinOnce() {
  if (!S.askCoinjoin || dialogsOpen) return;
  S.askCoinjoin = false; safeSet('kw.cjAsked', '1');
  const d = dialog({ cls: '', body: [coinjoinIntro(COLORS.good, () => d.close(), 'NO THANKS', () => d.close())] });
  d.querySelector('.dialog').style.padding = '0';
  d.querySelector('.dialog').style.borderRadius = '14px';
  d.querySelector('.dialog').style.background = 'transparent';
}

// ------------------------------------------------------------------ camera

async function scanQr(done) {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); } catch { return toast('No camera (it needs https).'); }
  const v = h('video', { autoplay: true, playsinline: true, class: 'cam' }); v.srcObject = stream;
  const det = new BarcodeDetector({ formats: ['qr_code'] });
  const stop = () => { stream.getTracks().forEach(x => x.stop()); m.close(); };
  const m = dialog({ body: [v], buttons: [tbtn('CANCEL', COLORS.soft, stop)] });
  const tick = async () => { if (!m.isConnected) return; try { const r = await det.detect(v); if (r.length) { stop(); return done(r[0].rawValue); } } catch {} requestAnimationFrame(tick); };
  tick();
}
