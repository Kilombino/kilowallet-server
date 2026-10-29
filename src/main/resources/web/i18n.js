// The app's language, as Kilowallet's I18n.kt: the code is written in English and every text shown
// goes through tr(), which looks it up in the language's table (i18n/<lang>.json, the app's own
// tables). Strings built with values match as templates; joined ones are translated piece by piece.
// Anything not found stays in English. The texts only this page has come from i18n-web.js.
'use strict';

const I18N = {
  AUTO: 'auto',
  // Each named in its own language, in the app's order.
  LANGUAGES: [['es', 'Español'], ['en', 'English'], ['zh', '中文'], ['fr', 'Français'], ['it', 'Italiano'],
    ['de', 'Deutsch'], ['ca', 'Català'], ['pt', 'Português']],
  lang: 'en', choice: 'auto', table: null, cache: new Map(),
};

function i18nSystem() {
  const langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en']);
  for (const l of langs) { const c = String(l).slice(0, 2).toLowerCase(); if (I18N.LANGUAGES.some(x => x[0] === c)) return c; }
  return 'en';
}

/** Once, at start: the language chosen before (this browser), or the browser's. */
async function i18nInit() {
  let saved = null;
  try { saved = localStorage.getItem('kw.lang'); } catch {}
  I18N.choice = saved && I18N.LANGUAGES.some(x => x[0] === saved) ? saved : I18N.AUTO;
  await i18nLoad(I18N.choice === I18N.AUTO ? i18nSystem() : I18N.choice);
}

/** [l]: a language's code, or 'auto' to follow the browser. */
async function i18nSet(l) {
  I18N.choice = l;
  try { if (l === I18N.AUTO) localStorage.removeItem('kw.lang'); else localStorage.setItem('kw.lang', l); } catch {}
  await i18nLoad(l === I18N.AUTO ? i18nSystem() : l);
}

async function i18nLoad(l) {
  I18N.cache.clear();
  if (l === 'en') { I18N.lang = 'en'; I18N.table = null; document.documentElement.lang = 'en'; return; }
  try {
    const r = await fetch('i18n/' + l + '.json');
    const o = await r.json();
    // The page's own texts, where the app's table has none (the app's wording always wins).
    for (const [k, v] of Object.entries((typeof WEB_I18N !== 'undefined' && WEB_I18N[l]) || {})) if (!(k in o)) o[k] = v;
    I18N.table = i18nBuild(o);
    I18N.lang = l;
  } catch { I18N.lang = 'en'; I18N.table = null; }
  document.documentElement.lang = I18N.lang;
}

const reEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PLACEHOLDER = /\{\d+\}/;
const hasLower = s => s !== s.toUpperCase();

function i18nBuild(o) {
  const exact = new Map(), upper = new Map(), templates = [], prefixes = [], suffixes = [];
  for (const en of Object.keys(o)) {
    const out = o[en];
    if (PLACEHOLDER.test(en)) {
      const parts = en.split(/\{\d+\}/);
      const last = en[en.length - 1];
      const frag = /\s/.test(last) || '(≈:—-'.includes(last);
      const mk = (ps, o2) => ({ head: ps[0], src: '^' + ps.map(reEscape).join('(.+?)') + (frag ? '' : '$'), out: o2, frag, re: null, len: 0 });
      const t = mk(parts, out); t.len = t.src.length; templates.push(t);
      // "EXACT COIN · 12 345 SATS": a section label upper-cases a template's text too.
      if (hasLower(en)) { const u = mk(parts.map(p => p.toUpperCase()), out.toUpperCase()); u.len = u.src.length; templates.push(u); }
    } else {
      exact.set(en, out);
      // "BEFORE YOU TURN IT ON": the code upper-cases a mixed-case string.
      if (hasLower(en) && !upper.has(en.toUpperCase())) upper.set(en.toUpperCase(), out.toUpperCase());
      const l = en[en.length - 1], f = en[0];
      if (en.length >= 3 && (/\s/.test(l) || en.endsWith(': ') || en.endsWith('('))) prefixes.push([en, out]);
      if (en.length >= 3 && (/\s/.test(f) || '.,)—'.includes(f))) suffixes.push([en, out]);
    }
  }
  prefixes.sort((a, b) => b[0].length - a[0].length); suffixes.sort((a, b) => b[0].length - a[0].length);
  templates.sort((a, b) => b.len - a.len); // the most specific first
  return { exact, upper, templates, prefixes, suffixes };
}

/** One piece of a joined string, its surrounding spaces kept. */
function i18nPiece(t, p, depth) {
  const core = p.trim();
  if (!core) return p;
  const i = p.indexOf(core);
  return p.slice(0, i) + i18nTranslate(t, core, depth + 1) + p.slice(i + core.length);
}

function i18nTranslate(t, s, depth) {
  if (t.exact.has(s)) return t.exact.get(s);
  if (t.upper.has(s)) return t.upper.get(s);
  if (depth > 4 || !s) return s;
  for (const tp of t.templates) {
    if (!s.startsWith(tp.head)) continue;
    if (!tp.re) tp.re = new RegExp(tp.src, 's');
    const m = tp.re.exec(s);
    if (!m) continue;
    // A template that starts with its value must not swallow the pieces before it in a line joined with " · ".
    if (tp.head === '' && m[1].includes(' · ')) continue;
    let out = tp.out;
    m.slice(1).forEach((v, i) => { out = out.split('{' + i + '}').join(i18nTranslate(t, v, depth + 1)); });
    return tp.frag ? out + i18nTranslate(t, s.slice(m.index + m[0].length), depth + 1) : out;
  }
  const b = /^([•·\-–]\s+)(.+)$/s.exec(s);
  if (b) return b[1] + i18nTranslate(t, b[2], depth + 1);
  if (s.includes(' · ')) return s.split(' · ').map(p => i18nPiece(t, p, depth)).join(' · ');
  if (s.includes('\n\n')) return s.split('\n\n').map(p => i18nPiece(t, p, depth)).join('\n\n');
  for (const [en, out] of t.prefixes) if (s.startsWith(en)) return out + i18nTranslate(t, s.slice(en.length), depth + 1);
  for (const [en, out] of t.suffixes) if (s.endsWith(en)) return i18nTranslate(t, s.slice(0, s.length - en.length), depth + 1) + out;
  return s;
}

/** [s] in the page's language (as is in English, or when there is no translation). */
function tr(s) {
  if (s == null) return '';
  s = String(s);
  if (!I18N.table || !s.trim()) return s;
  const c = I18N.cache.get(s);
  if (c !== undefined) return c;
  const out = i18nTranslate(I18N.table, s, 0);
  if (window.__kwMiss && out === s && /[a-z]{3}/.test(s)) window.__kwMiss.add(s); // the page's own checks find untranslated texts
  if (I18N.cache.size > 20000) I18N.cache.clear();
  I18N.cache.set(s, out);
  return out;
}

/** Numbers as the app shows them: "%.8f" follows the phone's language (0,00000000 in Spanish). */
function decimalComma() { return ['es', 'ca', 'fr', 'it', 'de', 'pt'].includes(I18N.lang); }
