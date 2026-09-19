/*
 * Desktop hub: theme + device-display contract.
 *
 * These are structural invariants, not palette snapshots. None of them names a hex
 * value or a px value that the design is allowed to change; they assert what a user
 * or a maintainer actually needs to hold:
 *
 *   - the three themes are the same contract (no theme missing a token components read)
 *   - everything the UI paints with comes from that contract, not from an inline hue
 *   - nothing is fetched over the network (this product is sold as LAN-only)
 *   - neutral surfaces carry structure, chromatic colour is reserved for state
 *   - the primary action is an ink plate: no gradient, no coloured glow
 *   - state and selection survive a colour-blind user and a greyscale screen
 *   - the device grid cannot force its own tracks open
 *
 * Run: node test/e2e/theme_and_device_display.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PUB = path.join(ROOT, 'apps', 'desktop', 'desktop_hub', 'public');

const THEMES = ['dark', 'eyecare', 'light'];
const themeClass = t => `body.${t}-theme`;

let passed = 0;
let failed = 0;
const notes = [];

function it(desc, fn) {
  try {
    const detail = fn();
    passed++;
    console.log(`[ ok ] ${desc}${detail ? `  (${detail})` : ''}`);
  } catch (err) {
    failed++;
    console.error(`[FAIL] ${desc}\n       ${String(err.message).split('\n').join('\n       ')}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function readRel(p) {
  return fs.readFileSync(path.join(ROOT, p), 'utf8');
}

/* ------------------------------------------------------------------ css --- */

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Brace-accurate rule scanner. Keeps the @media context each rule sat in. */
function parseRules(css, media) {
  const out = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const close = matchBrace(css, open);
    const prelude = css.slice(i, open).trim();
    const body = css.slice(open + 1, close);
    if (prelude.startsWith('@')) {
      if (/^@(media|supports|container)\b/.test(prelude)) out.push(...parseRules(body, prelude.replace(/\s+/g, ' ')));
    } else if (prelude) {
      out.push({
        selectors: prelude.split(',').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean),
        media: media || '',
        decls: parseDecls(body)
      });
    }
    i = close + 1;
  }
  return out;
}

function matchBrace(css, open) {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") { const end = css.indexOf(c, i + 1); i = end === -1 ? i : end; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return css.length;
}

function parseDecls(body) {
  const decls = [];
  let buf = '';
  let depth = 0;
  for (const c of body) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (c === ';' && depth <= 0) { push(); buf = ''; continue; }
    buf += c;
  }
  push();
  return decls;

  function push() {
    const text = buf.trim();
    if (!text || !text.includes(':')) return;
    const k = text.slice(0, text.indexOf(':')).trim().toLowerCase();
    const v = text.slice(text.indexOf(':') + 1).trim();
    if (k && v && !k.startsWith('@')) decls.push([k, v]);
  }
}

function loadStylesheet(css) {
  const rules = parseRules(stripCssComments(css));
  const root = new Map();
  const theme = {};
  THEMES.forEach(t => theme[t] = new Map());

  for (const rule of rules) {
    const custom = rule.decls.filter(([k]) => k.startsWith('--'));
    if (!custom.length) continue;
    const themeScoped = rule.selectors.filter(s => /body\.[a-z]+-theme\b/.test(s));
    if (themeScoped.length && themeScoped.length === rule.selectors.length) {
      // A block listing several themes contributes to each of them, so the shared
      // alias block ("body.dark-theme, body.eyecare-theme, body.light-theme") counts.
      for (const t of THEMES) {
        if (!themeScoped.some(s => new RegExp(`body\\.${t}-theme\\b`).test(s))) continue;
        for (const [k, v] of custom) theme[t].set(k, v);
      }
    } else if (!rule.media && rule.selectors.some(s => /^(:root|html)$/.test(s))) {
      for (const [k, v] of custom) root.set(k, v);
    }
  }
  return { rules, root, theme };
}

function lookup(sh, t, name) {
  const v = sh.theme[t].get(name);
  if (v) return v;
  return sh.root.get(name) || null;
}

/** Resolve var()/token chains down to a raw colour-ish value. */
function resolve(sh, t, value, depth = 0) {
  if (!value || depth > 6) return value;
  const m = value.trim().match(/^var\((--[\w-]+)\s*(?:,\s*([\s\S]*))?\)$/);
  if (!m) return value;
  const next = lookup(sh, t, m[1]) || m[2];
  return next ? resolve(sh, t, next, depth + 1) : null;
}

function colorOf(sh, t, value) {
  const raw = resolve(sh, t, value);
  return parseColor(raw);
}

function parseColor(raw) {
  if (!raw) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === 'transparent') return [0, 0, 0, 0];
  if (v === 'none' || v === 'inherit' || v === 'currentcolor') return null;
  let m = v.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16),
      h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  m = v.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
    if (parts.some(Number.isNaN)) return null;
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
  }
  return null;
}

function over(fg, bg) {
  if (!fg) return bg;
  if (fg[3] >= 1) return fg;
  return [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat([1]);
}

function lum(c) {
  const f = [0, 1, 2].map(i => {
    const v = c[i] / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
}

function contrast(a, b) {
  const l1 = lum(a);
  const l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const chroma = c => (c ? Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) : 0);

function hue(c) {
  const [r, g, b] = c.map(x => x / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return -1;
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

function hueGap(a, b) {
  const d = Math.abs(hue(a) - hue(b)) % 360;
  return d > 180 ? 360 - d : d;
}

/** Declarations that win for `prop` on a compound selector (".device-name",
 *  "#discoveryStatusText"), taking a theme-scoped override over the base rule. */
function effective(sh, t, compound, prop) {
  const esc = compound.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[\\s>+~])${esc}(?![\\w-])`);
  const own = [];
  const base = [];
  for (const rule of sh.rules) {
    for (const sel of rule.selectors) {
      const isThemeScoped = /body\.[a-z]+-theme\b/.test(sel);
      if (isThemeScoped && !new RegExp(`body\\.${t}-theme\\b`).test(sel)) continue;
      if (!re.test(sel)) continue;
      for (const [k, v] of rule.decls) if (k === prop) (isThemeScoped ? own : base).push(v);
    }
  }
  const list = own.length ? own : base;
  return list.length ? list[list.length - 1] : null;
}

function isControlSelector(sel) {
  return /\bbtn\b|button|\.nav-item|\.theme-seg-btn|\.icon-btn|-tab\b|-chip\b|\.pill\b|input|textarea|select/i.test(sel);
}

/* ------------------------------------------------------------- sources --- */

const styleCss = readRel('apps/desktop/desktop_hub/public/style.css');
const portalHtml = readRel('apps/desktop/desktop_hub/public/portal.html');
const indexHtml = readRel('apps/desktop/desktop_hub/public/index.html');
const appJs = readRel('apps/desktop/desktop_hub/public/app.js');
const hub = loadStylesheet(styleCss);
const portalInline = portalHtml.match(/<style>([\s\S]*?)<\/style>/);
const portal = loadStylesheet(portalInline ? portalInline[1] : '');

/* ============================================================== checks === */

console.log('=== SafeDrop desktop hub - theme & device display contract ===\n');

it('the themes the CSS paints are exactly the themes the UI can select', () => {
  const inCss = THEMES.filter(t => hub.theme[t].size > 0);
  assert(inCss.length === 3, `style.css defines ${inCss.length} theme blocks (${inCss.join(', ')})`);
  const selectable = [...indexHtml.matchAll(/data-theme="([\w-]+)"/g)].map(m => m[1]);
  const classes = new Set(selectable);
  for (const t of THEMES) assert(classes.has(`${t}-theme`), `index.html offers no button selecting "${t}-theme"`);
  const cycling = (appJs.match(/\['dark-theme', 'eyecare-theme', 'light-theme'\]/) || [])[0];
  assert(cycling, 'app.js has no theme cycle list for the compact toggle');
  return `3 blocks, 3 buttons, 1 cycle list`;
});

function tokenSymmetry(sh, label) {
  const sets = THEMES.map(t => [t, new Set(sh.theme[t].keys())]);
  const diffs = [];
  for (const [a, setA] of sets) {
    for (const [b, setB] of sets) {
      if (a === b) continue;
      for (const k of setA) if (!setB.has(k)) diffs.push(`${k} is defined for ${a} but not for ${b}`);
    }
  }
  assert(diffs.length === 0, diffs.join('\n'));
  return `${label}: ${sets[0][1].size} tokens x ${sets.length} themes, identical key sets`;
}

it('all three desktop themes define the same token set', () => tokenSymmetry(hub, 'style.css'));

it('all three portal themes define the same token set', () => {
  assert(portalInline, 'portal.html has no inline <style> block to check');
  return tokenSymmetry(portal, 'portal.html');
});

function tokenResolution(sh, label) {
  const unresolved = new Set();
  for (const rule of sh.rules) {
    for (const [k, v] of rule.decls) {
      if (k.startsWith('--') && !/var\(/.test(v)) continue;
      for (const m of v.matchAll(/var\((--[\w-]+)/g)) {
        const name = m[1];
        if (sh.root.has(name)) continue;
        if (!THEMES.every(t => sh.theme[t].has(name))) unresolved.add(`${label}: ${name} is read by \`${rule.selectors[0]}\` (${k}) but not defined by every theme`);
      }
    }
  }
  assert(unresolved.size === 0, [...unresolved].join('\n'));
  return 'every var(--token) read by a rule is defined by :root or by all three themes';
}

it('no component reads a token a theme fails to define', () => tokenResolution(hub, 'style.css'));

it('the portal reads no token its themes fail to define', () => {
  assert(portalInline, 'portal.html has no inline <style> block');
  return tokenResolution(portal, 'portal.html');
});

const REQUIRED_ROLES = [
  ['page surface', ['--bg-app']],
  ['raised surface', ['--bg-surface', '--bg-raised']],
  ['input surface', ['--bg-input']],
  ['primary text', ['--text-main']],
  ['secondary text', ['--text-secondary']],
  ['muted text', ['--text-muted']],
  ['hairline border', ['--border']],
  ['interactive ink', ['--ink']],
  ['ink label colour', ['--ink-on']],
  ['focus ring', ['--focus-ring']],
  ['state: ready', ['--state-ready']],
  ['state: progress', ['--state-progress']],
  ['state: attention', ['--state-attention']],
  ['state: failure', ['--state-failure']],
  ['state: offline', ['--state-offline']],
  ['ready tint', ['--state-ready-bg']],
  ['failure tint', ['--state-failure-bg']],
  ['scrollbar track', ['--scrollbar-track']],
  ['scrollbar thumb', ['--scrollbar-thumb']],
  ['scrim', ['--scrim']]
];

it('every theme supplies the surface/text/border/ink/state roles components consume', () => {
  const missing = [];
  for (const t of THEMES) {
    for (const [role, names] of REQUIRED_ROLES) {
      if (!names.some(n => lookup(hub, t, n))) missing.push(`${t} is missing ${role}`);
    }
  }
  assert(missing.length === 0, missing.join('; '));
  return `${REQUIRED_ROLES.length} roles x 3 themes`;
});

it('body text stays legible on every surface in every theme', () => {
  const worst = { main: { r: 99, where: '' }, secondary: { r: 99, where: '' } };
  for (const t of THEMES) {
    const surfaces = ['--bg-app', '--bg-surface', '--bg-raised', '--bg-input'];
    for (const [textRole, floor, bucket] of [['--text-main', 4.5, 'main'], ['--text-secondary', 3.0, 'secondary']]) {
      const fg = parseColor(resolve(hub, t, `var(${textRole})`));
      assert(fg, `${t} ${textRole} does not resolve to a colour`);
      for (const s of surfaces) {
        const bg = over(parseColor(resolve(hub, t, `var(${s})`)), parseColor(resolve(hub, t, 'var(--bg-app)')) || [0, 0, 0, 1]);
        if (!bg) continue;
        const c = contrast(over(fg, bg), bg);
        if (c < worst[bucket].r) worst[bucket] = { r: c, where: `${textRole} on ${s} in ${t}` };
        assert(c >= floor, `${textRole} on ${s} in ${t} is ${c.toFixed(2)}:1, needs ${floor}:1`);
      }
    }
  }
  return `worst ${worst.main.r.toFixed(1)}:1 main, ${worst.secondary.r.toFixed(1)}:1 secondary`;
});

it('text sitting on the interactive ink is legible in every theme', () => {
  const worst = THEMES.map(t => {
    const ink = over(parseColor(resolve(hub, t, 'var(--ink)')), [255, 255, 255, 1]);
    const onInk = parseColor(resolve(hub, t, 'var(--ink-on)'));
    assert(ink && onInk, `${t}: --ink/--ink-on do not resolve`);
    return { t, c: contrast(over(onInk, ink), ink) };
  });
  for (const w of worst) assert(w.c >= 4.5, `label on ink in ${w.t} is ${w.c.toFixed(2)}:1, needs 4.5:1`);
  return worst.map(w => `${w.t[0]}=${w.c.toFixed(1)}`).join(' ');
});

it('structure is neutral and colour is reserved for state', () => {
  const offenders = [];
  for (const t of THEMES) {
    // Ink, hairlines and body text carry no hue at all: they are the structure.
    for (const name of ['--ink', '--ink-hover', '--text-main', '--border', '--border-strong', '--border-hover', '--state-offline']) {
      const c = parseColor(lookup(hub, t, name));
      if (!c) continue;
      if (chroma(c) > 16) offenders.push(`${t} ${name} is ${c.slice(0, 3).join(',')} (chroma ${chroma(c)}), and structure must be neutral`);
    }
    // Secondary/muted text may keep a whisper of the paper's warmth, but not a hue.
    for (const name of ['--text-secondary', '--text-muted', '--text-dimmed']) {
      const c = parseColor(lookup(hub, t, name));
      if (c && chroma(c) > 24) offenders.push(`${t} ${name} is tinted to a hue (chroma ${chroma(c)})`);
    }
    for (const name of ['--bg-app', '--bg-surface', '--bg-raised', '--bg-input', '--scrollbar-track', '--scrollbar-thumb']) {
      const c = parseColor(lookup(hub, t, name));
      if (!c) continue;
      // A tinted *surface* is a lighting choice; keep it within a warm-paper band, not a hue.
      if (chroma(c) > 45) offenders.push(`${t} ${name} is too saturated for a surface (chroma ${chroma(c)})`);
    }
    for (const name of ['--state-ready', '--state-progress', '--state-attention', '--state-failure']) {
      const c = parseColor(lookup(hub, t, name));
      assert(c, `${t} ${name} does not resolve to a colour`);
      if (chroma(c) < 30) offenders.push(`${t} ${name} is not saturated enough to read as state`);
    }
  }
  assert(offenders.length === 0, offenders.join('\n'));
  return 'ink/text/border achromatic, 4 state hues chromatic per theme';
});

it('the four state hues are four different hues, and each tint shares its base hue', () => {
  const problems = [];
  for (const t of THEMES) {
    const states = ['ready', 'progress', 'attention', 'failure'].map(s => ({ s, c: parseColor(lookup(hub, t, `--state-${s}`)) }));
    for (let i = 0; i < states.length; i++) {
      for (let j = i + 1; j < states.length; j++) {
        const g = hueGap(states[i].c, states[j].c);
        if (g < 25) problems.push(`${t}: ${states[i].s} and ${states[j].s} are only ${g.toFixed(0)} degrees apart`);
      }
    }
    for (const { s, c } of states) {
      const tint = parseColor(lookup(hub, t, `--state-${s}-bg`));
      if (!tint || tint[3] >= 1) { problems.push(`${t}: --state-${s}-bg is not a translucent wash`); continue; }
      if (hueGap(c, tint) > 12) problems.push(`${t}: --state-${s}-bg is a different hue from --state-${s}`);
    }
  }
  assert(problems.length === 0, problems.join('\n'));
  return 'hue gaps >= 25 deg, tints match their base';
});

it('state colour clears the surface it is painted on', () => {
  const worst = [];
  for (const t of THEMES) {
    const page = parseColor(resolve(hub, t, 'var(--bg-app)'));
    for (const s of ['ready', 'progress', 'attention', 'failure']) {
      const c = parseColor(lookup(hub, t, `--state-${s}`));
      for (const surfaceName of ['--bg-app', '--bg-surface', '--bg-raised']) {
        const base = over(parseColor(lookup(hub, t, surfaceName)), page);
        const ratio = contrast(over(c, base), base);
        assert(ratio >= 3.0, `--state-${s} on ${surfaceName} in ${t} is ${ratio.toFixed(2)}:1, needs 3:1 for an icon or a rule`);
        worst.push(ratio);
      }
    }
  }
  return `worst state/surface ratio ${Math.min(...worst).toFixed(2)}:1`;
});

it('no hue lives outside the token blocks', () => {
  const offenders = [];
  for (const rule of hub.rules) {
    const isTokenBlock = rule.selectors.every(s => /^:root$|^body\.[a-z]+-theme$/.test(s)) && rule.decls.every(([k]) => k.startsWith('--'));
    if (isTokenBlock) continue;
    for (const [k, v] of rule.decls) {
      if (/^(--|\+|-moz|-ms)/.test(k) || !/(color|background|border|fill|stroke|shadow|outline)/.test(k)) continue;
      for (const m of v.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)) {
        const c = parseColor(m[0]);
        if (!c) continue;
        if (chroma(c) > 20) offenders.push(`\`${rule.selectors[0]} { ${k}: ${v} }\` hard-codes a hue`);
      }
    }
  }
  assert(offenders.length === 0, `hue literals must be named by a token, not written in a component:\n${offenders.join('\n')}`);
  return 'every literal outside the token blocks is achromatic';
});

const LOCAL_HOST = /^(localhost|0\.0\.0\.0|(\d{1,3}\.){3}\d{1,3}|::1|\[::1\])$/;
// XML namespaces are identifiers, not fetches.
const NOT_A_HOST = /^(www\.)?w3\.org$/;
const FONT_SERVICE = /fonts\.googleapis|fonts\.gstatic|typekit|use\.fountain|fontawesome|cdn\.jsdelivr|unpkg\.com|googleapis\.com/gi;

/**
 * Drop JS comments so a licence URL in a header is not read as a fetch. This walks the
 * file with a string state instead of matching between two markers, because a string can
 * hold a comment opener - and because stripping `"https://..."` inside a string literal
 * would hide the exact thing this check is looking for.
 */
function stripJsComments(src) {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        j++;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      out += '\n';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function remoteHosts(text) {
  const src = stripJsComments(text);
  const found = [];
  for (const m of src.matchAll(/\bhttps?:\/\/([^\s"'`)>\]]+)/gi)) {
    const host = m[1].split(':')[0].replace(/^\/*/, '');
    // `${host}` inside a template literal is a LAN address built at runtime, not a fetch.
    if (!/^[\w.-]+$/.test(host) || LOCAL_HOST.test(host) || NOT_A_HOST.test(host)) continue;
    found.push(m[0]);
  }
  return found;
}

it('no UI file fetches a font or any other resource over the network', () => {
  const offenders = [];
  for (const [name, src] of Object.entries({ 'index.html': indexHtml, 'portal.html': portalHtml })) {
    for (const m of src.matchAll(/<(?:link|script|img|source|video|audio|iframe|use)\b[^>]*\b(?:href|src|xlink:href)\s*=\s*["']([^"']+)["']/gi)) {
      const ref = m[1];
      if (/^(https?:)?\/\//i.test(ref)) offenders.push(`${name} loads a remote resource: ${ref}`);
      else if (!/^(data:|#|javascript:)/.test(ref) && !fs.existsSync(path.join(PUB, ref))) offenders.push(`${name} references a local file that is not there: ${ref}`);
    }
    if (/@import\b/.test(src)) offenders.push(`${name} uses @import, which pulls a file over the network`);
    if (/@font-face\b/.test(src)) offenders.push(`${name} declares an @font-face`);
    for (const u of remoteHosts(src)) offenders.push(`${name} points at ${u}`);
  }
  for (const m of styleCss.matchAll(/url\(\s*["']?([^"')]+)/gi)) {
    if (!/^(data:|#)/.test(m[1])) offenders.push(`style.css pulls in url(${m[1]})`);
  }
  for (const u of remoteHosts(appJs, { stripJs: true })) offenders.push(`app.js fetches ${u}`);
  if (/new FontFace\(|@font-face|createElement\(['"]link['"]\)/.test(appJs)) offenders.push(`app.js injects a webfont or a stylesheet at runtime`);
  assert(offenders.length === 0, offenders.join('\n'));
  return 'no remote href/src, no @import, no @font-face, no url(), no remote host in JS';
});

const OS_SAFE_GENERIC = /^(system-ui|ui-monospace|ui-sans-serif|ui-serif|sans-serif|serif|monospace|cursive|fantasy)$/i;
const OS_SAFE_NAMED = ['segoe ui variable text', 'segoe ui', 'pingfang sc', 'microsoft yahei', 'sf mono', 'consolas', 'cascadia mono', 'liberation mono', '-apple-system', 'blinkmacsystemfont'];

function facesOf(value) {
  return value.split(',').map(f => f.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

it('every face the UI asks for ships with the OS', () => {
  const offenders = [];
  const check = (label, where, value) => {
    for (const fam of facesOf(value)) {
      if (OS_SAFE_GENERIC.test(fam) || fam === 'inherit' || fam.startsWith('var(')) continue;
      if (OS_SAFE_NAMED.includes(fam.toLowerCase())) continue;
      offenders.push(`${label}: ${where} asks for "${fam}", which is neither a generic nor an OS-shipped face`);
    }
  };
  for (const [label, sh] of [['style.css', hub], ['portal.html', portal]]) {
    for (const [k, v] of sh.root) if (/font/.test(k)) check(label, `token ${k}`, v);
    for (const rule of sh.rules) {
      for (const [k, v] of rule.decls) {
        if (k !== 'font-family') continue;
        check(label, `\`${rule.selectors[0]}\``, v);
      }
    }
  }
  assert(offenders.length === 0, offenders.join('\n'));
  return 'only system-ui / Segoe UI / YaHei / monospace fallbacks, all reached through --font-* tokens';
});

it('the primary action is an ink plate: no gradient, no coloured glow', () => {
  const offenders = [];
  const primaries = hub.rules.filter(r => r.selectors.some(s => /\.btn-primary\b|^\.send-to-device-btn\b|^\.drop-action-btn\b/.test(s)));
  assert(primaries.length > 0, 'no .btn-primary rule found at all');
  for (const rule of primaries) {
    for (const [k, v] of rule.decls) {
      if (/gradient/.test(v)) offenders.push(`\`${rule.selectors[0]} { ${k}: ${v} }\` paints the primary action with a gradient`);
      if (k === 'box-shadow' && v !== 'none') {
        for (const m of v.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)) {
          const c = parseColor(m[0]);
          if (c && chroma(c) > 16) offenders.push(`\`${rule.selectors[0]}\` gives the primary action a coloured glow`);
        }
      }
      if (k === 'background' || k === 'background-color') {
        assert(/var\(/.test(v) || v === 'none' || v === 'transparent',
          `\`${rule.selectors[0]} { ${k}: ${v} }\` hard-codes the primary plate instead of taking it from a token`);
      }
    }
  }
  for (const [k, v] of hub.root) {
    if (/^--shadow-(primary|button)/.test(k)) assert(parseColor(v) === null && /none|var\(--/.test(v), `${k} still casts a glow: ${v}`);
  }
  assert(offenders.length === 0, offenders.join('\n'));
  const plate = THEMES.map(t => {
    const decl = hub.rules.find(r => r.selectors.some(s => s === '.btn-primary')).decls.find(([k]) => k === 'background')[1];
    const c = colorOf(hub, t, decl);
    assert(c && chroma(c) <= 16, `${t}: the primary plate resolves to a chromatic colour (${c ? c.slice(0, 3).join(',') : 'unresolved'})`);
    return `${t} chroma ${chroma(c)}`;
  });
  return `plate takes --ink (no gradient, no glow): ${plate.join(', ')}`;
});

it('gradients are decoration, never a control', () => {
  const offenders = [];
  for (const [label, sh] of [['style.css', hub], ['portal.html', portal]]) {
    for (const rule of sh.rules) {
      for (const [k, v] of rule.decls) {
        if (!/gradient\(/.test(v)) continue;
        if (isControlSelector(rule.selectors.join(', '))) offenders.push(`${label}: \`${rule.selectors[0]}\` fills a control with a gradient`);
        if (/\blinear-gradient\(|\bradial-gradient\(/.test(v)) offenders.push(`${label}: \`${rule.selectors[0]}\` uses a ${v.match(/(linear|radial)-gradient/)[0]} - the ink system has none`);
        const declarative = rule.decls.some(([kk, vv]) => kk === 'pointer-events' && vv === 'none');
        if (!declarative) offenders.push(`${label}: the gradient on \`${rule.selectors[0]}\` is not marked pointer-events:none, so it is an element the user can hit`);
      }
    }
  }
  assert(offenders.length === 0, offenders.join('\n'));
  const sweeps = hub.rules.filter(r => r.decls.some(([, v]) => /gradient\(/.test(v))).map(r => r.selectors[0]);
  return `only ${sweeps.length ? sweeps.join(', ') : 'no'} gradient rule(s), decorative`;
});

it('no control box is lifted with a coloured shadow', () => {
  const offenders = [];
  for (const rule of hub.rules) {
    for (const [k, v] of rule.decls) {
      if (k !== 'box-shadow' || v === 'none' || /\binset\b/.test(v)) continue;
      const colours = [...v.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|var\(--[\w-]+\)/g)]
        .map(m => (m[0].startsWith('var(') ? colorOf(hub, 'dark', m[0]) || colorOf(hub, 'light', m[0]) : parseColor(m[0])))
        .filter(Boolean);
      const blurred = /\b\d+px\b[^,]*\b[1-9]\d*px\b/.test(v.replace(/\binset\b/, ''));
      if (!blurred) continue; // 0-blur rings are focus/hairline treatments, not glows
      for (const c of colours) if (chroma(c) > 20) offenders.push(`\`${rule.selectors[0]} { box-shadow: ${v} }\` glows`);
    }
  }
  assert(offenders.length === 0, offenders.join('\n'));
  return 'every blurred shadow resolves to a neutral';
});

it('the device grid cannot force its own tracks open', () => {
  const grid = hub.rules.find(r => r.selectors.some(s => s === '.devices-grid') && !r.media);
  assert(grid, 'no base (unmedia-queried) .devices-grid rule');
  const tmpl = (grid.decls.find(([k]) => k === 'grid-template-columns') || [])[1];
  assert(tmpl, '.devices-grid sets no grid-template-columns');
  assert(/repeat\(\s*auto-fill\s*,\s*minmax\(/.test(tmpl), `.devices-grid must auto-fill minmax() tracks, got "${tmpl}"`);
  const min = parseInt(tmpl.match(/minmax\(\s*(\d+(?:\.\d+)?)px/)[1], 10);
  assert(min <= 320, `the grid's minimum track is ${min}px; at or above 320 a card can force its own track open and push its neighbour out`);
  const card = hub.rules.find(r => r.selectors.some(s => /^\.device-card$/.test(s)) && !r.media);
  assert(card, 'no base .device-card rule');
  const minW = (card.decls.find(([k]) => k === 'min-width') || [])[1];
  assert(minW === '0', `.device-card must set min-width: 0 so its content cannot widen the track (found "${minW}")`);
  // The shrink chain: anything between the card and its text has to give the same way.
  const chain = ['.device-left', '.device-info', '.device-name']
    .filter(cls => {
      const r = hub.rules.find(rr => rr.selectors.some(s => s === cls) && !rr.media);
      return r && !/0/.test((r.decls.find(([k]) => k === 'min-width') || ['', ''])[1]);
    });
  assert(chain.length === 0, `${chain.join(', ')} sit between the card and its text but keep min-width:auto`);
  const collapse = hub.rules.filter(r => r.media.includes('max-width') && r.selectors.some(s => s === '.devices-grid'));
  assert(collapse.length, '.devices-grid never collapses to a single column, so a narrow window has to scroll sideways');
  const bp = Math.max(...collapse.map(r => parseFloat(r.media.match(/(\d+(?:\.\d+)?)px/)[1])));
  assert(bp >= min, `the single-column collapse happens at ${bp}px, below the ${min}px minimum track`);
  const single = collapse.some(r => /(^|\s)1fr($|\s)/.test((r.decls.find(([k]) => k === 'grid-template-columns') || ['', ''])[1]));
  assert(single, 'the collapse rule does not switch to a single 1fr column');
  return `minmax min ${min}px, min-width:0 chain intact, single column <= ${bp}px`;
});

it('truncated text is really truncated (ellipsis needs overflow + nowrap)', () => {
  const offenders = [];
  for (const rule of hub.rules) {
    if (!rule.decls.some(([k, v]) => k === 'text-overflow' && v === 'ellipsis')) continue;
    for (const [prop, want] of [['overflow', /hidden|clip/], ['white-space', /nowrap|^pre$/]]) {
      const inRule = rule.decls.some(([k, v]) => k === prop && want.test(v));
      const merged = rule.selectors.some(s => want.test(effective(hub, 'dark', s.split(' ').pop(), prop) || ''));
      if (!inRule && !merged) offenders.push(`\`${rule.selectors[0]}\` fades text with text-overflow:ellipsis but never sets ${prop}`);
    }
  }
  assert(offenders.length === 0, offenders.join('\n'));
  return `${hub.rules.filter(r => r.decls.some(([k, v]) => k === 'text-overflow' && v === 'ellipsis')).length} ellipsis rules all carry their pair`;
});

it('long device names and addresses collapse to one line, not to a wrapped block', () => {
  const oneLine = ['.device-name-row', '.device-meta-row', '.device-meta-chip', '.send-to-device-btn', '.radar-status-bar', '.device-name', '.chat-peer-name'];
  const missing = oneLine.filter(cls => !/nowrap/.test(effective(hub, 'dark', cls, 'white-space') || ''));
  assert(missing.length === 0, `${missing.join(', ')} can wrap onto a second line and break the card height`);
  const clips = ['.device-name', '#discoveryStatusText', '.chat-peer-name'].filter(sel =>
    !/ellipsis/.test(effective(hub, 'dark', sel, 'text-overflow') || '') || !/hidden/.test(effective(hub, 'dark', sel, 'overflow') || ''));
  assert(clips.length === 0, `${clips.join(', ')} are width-clamped but do not fade to an ellipsis`);
  return `${oneLine.length} single-line rules, ${clips.length === 0 ? 3 : 0} ellipsis clips`;
});

it('the theme picker says which mode is on without using colour', () => {
  const baseWeight = parseInt((hub.rules.find(r => r.selectors.some(s => s === '.theme-seg-btn'))?.decls.find(([k]) => k === 'font-weight') || ['', '0'])[1], 10);
  const activeWeight = parseInt((hub.rules.find(r => r.selectors.some(s => s === '.theme-seg-btn.active'))?.decls.find(([k]) => k === 'font-weight') || ['', '0'])[1], 10);
  assert(activeWeight > baseWeight, `the selected button is not emphasised by weight (${baseWeight} -> ${activeWeight}), so colour is the only cue`);
  const gliderMoves = /glider\.style\.transform\s*=/.test(appJs) && /glider\.style\.width\s*=/.test(appJs);
  assert(gliderMoves, 'app.js no longer slides the glider, so the selected pill has no position cue');
  const labels = [...indexHtml.matchAll(/class="theme-seg-btn[^"]*"[^>]*>([\s\S]*?)<\/button>/g)]
    .map(m => (m[1].match(/<span>([^<]+)<\/span>/) || [])[1]);
  assert(labels.every(Boolean), 'a theme button has no text label');
  assert(new Set(labels).size === labels.length, `theme labels are not distinct: ${labels.join('/')}`);
  return `weight ${baseWeight}->${activeWeight}, sliding plate, labels: ${labels.join('/')}`;
});

it('the selected pill is distinguishable from the control plate in every theme', () => {
  const detail = [];
  for (const t of THEMES) {
    const rule = hub.rules.find(r => r.selectors.some(s => s === themeClass(t) + ' .theme-seg-glider'));
    assert(rule, `${t} has no .theme-seg-glider background rule`);
    const bg = rule.decls.find(([k]) => k === 'background' || k === 'background-color');
    assert(bg, `${t} glider declares no background`);
    const plate = parseColor(resolve(hub, t, 'var(--bg-input)'));
    const glider = over(parseColor(bg[1]), plate);
    const ringed = /\binset\b/.test((rule.decls.find(([k]) => k === 'box-shadow') || ['', ''])[1]);
    const ratio = contrast(glider, plate);
    assert(ratio >= 1.15 || ringed, `${t}: the glider is ${ratio.toFixed(2)}:1 off its plate and draws no inset ring, so the selection is invisible`);
    detail.push(`${t}=${ratio.toFixed(2)}${ringed ? '+ring' : ''}`);
  }
  return detail.join(' ');
});

function deviceCardTemplate() {
  const start = appJs.indexOf('state.devices.map(dev =>');
  assert(start > -1, 'app.js has no device grid renderer');
  const end = appJs.indexOf("}).join('')", start);
  assert(end > start, 'the device grid renderer is not built from a template');
  return appJs.slice(start, end);
}

it('device state is readable without its colour: the action says what it does', () => {
  const template = deviceCardTemplate();
  const sendBtn = template.slice(template.indexOf('send-to-device-btn'));
  const labels = [...sendBtn.slice(0, sendBtn.indexOf('</button>')).matchAll(/'([^']{1,20})'/g)]
    .map(m => m[1])
    .filter(s => /^[^\s{}$`'"]+$/.test(s) && !/^[\w-]+$/.test(s));
  assert(new Set(labels).size >= 2, `the send button only ever says "${labels[0] || ''}", so pairing state is carried by colour alone`);
  assert(labels.some(l => /配对/.test(l)), 'the unpaired label that names the next step ("配对并发送") is gone');
  assert(/class="avatar-status-dot[^"]*"[^>]*title="[^"]+"/.test(template), 'the status dot has no title, so "online" has no text equivalent');
  const needsPairing = hub.rules.some(r => r.selectors.some(s => /\.needs-pairing\b/.test(s)));
  assert(needsPairing, 'the unpaired styling has been dropped from the stylesheet');
  return `button labels: ${[...new Set(labels)].join(' / ')}; dot carries a title`;
});

it('device rows keep their avatar square and their status dot a dot', () => {
  const square = cls => {
    const r = hub.rules.find(rr => rr.selectors.some(s => s === cls) && !rr.media);
    assert(r, `no ${cls} rule`);
    const w = (r.decls.find(([k]) => k === 'width') || ['', ''])[1];
    const h = (r.decls.find(([k]) => k === 'height') || ['', ''])[1];
    assert(w && w === h, `${cls} is ${w}x${h}; a non-square avatar stretches its glyph`);
    return parseFloat(w);
  };
  const avatar = square('.device-avatar');
  const dot = square('.avatar-status-dot');
  assert(avatar >= 40, `the device avatar is only ${avatar}px, too small to read the platform glyph`);
  assert(dot > 0 && dot < avatar, 'the status dot is not smaller than the avatar it rides on');
  const dotRadius = (hub.rules.find(r => r.selectors.some(s => s === '.avatar-status-dot')).decls.find(([k]) => k === 'border-radius') || ['', ''])[1];
  assert(/var\(--radius-full\)|%/.test(dotRadius), `the status dot is not round (border-radius: ${dotRadius})`);
  const dotColour = (hub.rules.find(r => r.selectors.some(s => s === '.avatar-status-dot')).decls.find(([k]) => k === 'background') || ['', ''])[1];
  assert(/var\(--state-/.test(dotColour), `the online dot takes ${dotColour}; state colour must come from a --state-* token`);
  return `avatar ${avatar}px square, dot ${dot}px round and token-painted`;
});

it('the theme cross-fade is a fade, and motion is opt-out', () => {
  const vt = hub.rules.filter(r => r.selectors.some(s => /::view-transition-(old|new)\(root\)/.test(s)) && !r.media);
  assert(vt.length, 'the view-transition rules are gone, so a theme switch snaps');
  const names = vt.flatMap(r => r.decls.filter(([k]) => k === 'animation-name').map(([, v]) => v));
  assert(names.length, 'the view-transition layers name no keyframes, so nothing animates');
  const durations = vt.flatMap(r => r.decls.filter(([k]) => k === 'animation-duration').map(([, v]) => parseFloat(v)));
  assert(durations.length, 'no view-transition layer sets a duration, so it never fades');
  assert(durations.every(d => d > 0), `a view-transition layer is ${durations.join('/')}s`);
  assert(new Set(durations).size === 1, `out and back differ (${durations.join('/')}); the panel flashes mid-switch`);
  assert(Math.max(...durations) <= 0.4, `${Math.max(...durations)}s is a wait, not a cross-fade`);
  const reduced = hub.rules.some(r => /prefers-reduced-motion/.test(r.media));
  assert(reduced, 'nothing honours prefers-reduced-motion, so the radar sweeps forever for users who asked it not to');
  const bodyFade = hub.rules.some(r => r.selectors.some(s => s === 'body') && r.decls.some(([k, v]) => k === 'transition' && /var\(--transition-theme\)|background-color/.test(v)));
  assert(bodyFade, 'the app background no longer transitions, so themes snap while everything else fades');
  return `${durations[0]}s both ways, ${names.length} keyframe layers, reduced-motion honored`;
});

it('the browser chrome colour tracks an app surface and stays neutral', () => {
  const declared = [
    ...[...indexHtml.matchAll(/<meta name="theme-color" content="([^"]+)"/g)].map(m => ['index.html', m[1]]),
    ...[...portalHtml.matchAll(/<meta name="theme-color" content="([^"]+)"/g)].map(m => ['portal.html', m[1]]),
    ...[...appJs.matchAll(/metaThemeColor\.setAttribute\('content',\s*'([^']+)'\)/g)].map(m => ['app.js applyTheme', m[1]])
  ];
  assert(declared.length >= 4, `only ${declared.length} theme-color declarations found`);
  const pageBgs = THEMES.map(t => parseColor(lookup(hub, t, '--bg-app')));
  const drift = [];
  for (const [where, hex] of declared) {
    const c = parseColor(hex);
    assert(c, `${where} declares a theme-color that is not a colour: ${hex}`);
    assert(chroma(c) <= 45, `${where} sets a chromatic theme-color (${hex}); the chrome may only match a neutral app surface`);
    const nearest = Math.min(...pageBgs.map(bg => Math.max(...[0, 1, 2].map(i => Math.abs(bg[i] - c[i])))));
    assert(nearest <= 24, `${where} sets ${hex}, which is ${nearest} steps off every theme's --bg-app - the browser bar will not match the page`);
    drift.push(`${hex}(${nearest})`);
  }
  notes.push(`theme-color drift from the current --bg-app values: ${drift.join(' ')} (0 = exact). The three per-theme colours set in app.js applyTheme are still on the pre-redesign palette - see the metaThemeColor block in apps/desktop/desktop_hub/public/app.js.`);
  return `4 chrome colours, each within 24 of a --bg-app`;
});

it('a device card renders the name, address and fingerprint the peer announced, escaped', () => {
  const template = deviceCardTemplate();
  const html = [...template.matchAll(/`([\s\S]*?)`/g)].map(m => m[1]).filter(f => /class="/.test(f)).join('\n');
  assert(html.length > 200, 'the device renderer builds no markup');
  const raw = [...html.matchAll(/\$\{\s*((?:dev|fpShort)[\w.]*)\s*\}/g)].map(m => m[1]);
  assert(raw.length === 0, `interpolated unescaped: ${raw.join(', ')} - a peer picks its own device name on the LAN`);
  assert(/class="device-name"[^>]*>\$\{escapeHtml\(/.test(html), 'the device name is no longer rendered');
  assert(/\$\{escapeHtml\(dev\.ip\)\}:\$\{escapeHtml\(dev\.port\)\}/.test(html), 'the address:port reading is no longer rendered');
  assert(/class="device-meta-chip fp-chip"[^>]*title="[^"]*\$\{escapeHtml\(dev\.fingerprint[^>]*/.test(html), 'the fingerprint chip lost its full-value title');
  assert(/const platformName = isPc \? '[^']+' : '[^']+'/.test(template.replace(/\s+/g, ' ')), 'the platform tag no longer names the kind of device');
  return 'name, ip:port and fingerprint rendered through escapeHtml';
});

/* -------------------------------------------------------------- summary --- */

if (notes.length) {
  console.log('');
  for (const n of notes) console.log(`[note] ${n}`);
}
console.log('\n========================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('========================================\n');

process.exitCode = failed > 0 ? 1 : 0;
