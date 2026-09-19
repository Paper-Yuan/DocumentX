/*
 * Scrollbar theming, text copy/selection, and the mobile chat bar.
 *
 * Two things changed shape here when the ink-first system landed, and this file is
 * written around them:
 *
 *  - The scrollbar colours are tokens. The old suite pinned six hex values, which is
 *    a palette snapshot: any re-tone turns it red without anything being wrong. What
 *    actually matters is that every theme defines a track and a thumb, that the
 *    scrollbar rules read those tokens instead of a literal, and that the thumb is
 *    distinguishable from its own track (that was the point of the "no white bar" fix).
 *  - Depth no longer comes from elevation. The old suite asserted `elevation="6dp"` on
 *    the chat input bar; the redesign separates that bar with a hairline instead, so the
 *    assertion is now "the bar is divided from the list, painted an opaque surface, and
 *    never overlapped by the bottom navigation" - the user-visible property - rather than
 *    "the bar casts a 6dp shadow".
 *
 * The release APK check is an explicit skip when the file is not there: it is a gitignored
 * local build product, so a fresh clone and CI can never have it. It never silently passes.
 *
 * Run: node test/e2e/scrollbar_and_copy_features.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PUB = path.join(ROOT, 'apps', 'desktop', 'desktop_hub', 'public');
const ANDROID = path.join(ROOT, 'apps', 'android', 'com', 'app', 'src', 'main');
const THEMES = ['dark', 'eyecare', 'light'];

let passed = 0;
let failed = 0;
let skipped = 0;
const defects = [];

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

function skip(desc, reason) {
  skipped++;
  console.log(`[skip] ${desc}\n       reason: ${reason}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function read(...p) {
  return fs.readFileSync(path.join(...p), 'utf8');
}

/* ---------------------------------------------------------- css helpers --- */

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
    if (c === ';' && depth <= 0) { flush(); buf = ''; continue; }
    buf += c;
  }
  flush();
  return decls;

  function flush() {
    const text = buf.trim();
    if (!text || !text.includes(':')) return;
    const k = text.slice(0, text.indexOf(':')).trim().toLowerCase();
    const v = text.slice(text.indexOf(':') + 1).trim();
    if (k && v && !k.startsWith('@')) decls.push([k, v]);
  }
}

function loadStylesheet(css) {
  const rules = parseRules(css.replace(/\/\*[\s\S]*?\*\//g, ''));
  const root = new Map();
  const theme = {};
  THEMES.forEach(t => theme[t] = new Map());
  for (const rule of rules) {
    const custom = rule.decls.filter(([k]) => k.startsWith('--'));
    if (!custom.length) continue;
    const themed = rule.selectors.filter(s => /body\.[a-z]+-theme\b/.test(s));
    if (themed.length === rule.selectors.length && themed.length) {
      for (const t of THEMES) {
        if (!themed.some(s => new RegExp(`body\\.${t}-theme\\b`).test(s))) continue;
        for (const [k, v] of custom) theme[t].set(k, v);
      }
    } else if (!rule.media && rule.selectors.some(s => /^(:root|html)$/.test(s))) {
      for (const [k, v] of custom) root.set(k, v);
    }
  }
  return { rules, root, theme };
}

function token(sh, t, name) {
  return sh.theme[t].get(name) || sh.root.get(name) || null;
}

function resolve(sh, t, value, depth = 0) {
  if (!value || depth > 6) return value;
  const m = value.trim().match(/^var\((--[\w-]+)\s*(?:,\s*([\s\S]*))?\)$/);
  if (!m) return value;
  const next = token(sh, t, m[1]) || m[2];
  return next ? resolve(sh, t, next, depth + 1) : null;
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
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
    if (p.some(Number.isNaN)) return null;
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  return null;
}

function colorOf(sh, t, value) {
  return parseColor(resolve(sh, t, value));
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

const chroma = c => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);

/** The winning declaration for `prop` on `compound`, theme overrides first. */
function effective(sh, t, compound, prop) {
  const esc = compound.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[\\s>+~])${esc}(?![\\w-])`);
  const own = [];
  const base = [];
  for (const rule of sh.rules) {
    for (const sel of rule.selectors) {
      const scoped = /body\.[a-z]+-theme\b/.test(sel);
      if (scoped && !new RegExp(`body\\.${t}-theme\\b`).test(sel)) continue;
      if (!re.test(sel)) continue;
      for (const [k, v] of rule.decls) if (k === prop) (scoped ? own : base).push(v);
    }
  }
  const list = own.length ? own : base;
  return list.length ? list[list.length - 1] : null;
}

/* ------------------------------------------------------- android helpers --- */

/** Attribute text of the element that declares @+id/<id>. */
function elementAttrs(xml, id) {
  const at = xml.indexOf(`android:id="@+id/${id}"`);
  if (at === -1) return null;
  const start = xml.lastIndexOf('<', at);
  const end = xml.indexOf('>', at);
  return xml.slice(start, end === -1 ? xml.length : end);
}

/**
 * Drop Kotlin comments so prose about the old design is never read as code. This walks
 * the file with a string state instead of matching between two markers, because a raw
 * string can hold a comment opener and a regex would then swallow real code.
 */
function stripCodeComments(src) {
  const TRIPLE = '"""';
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    if (c === '"' || c === "'") {
      const quote = src.startsWith(TRIPLE, i) ? TRIPLE : c;
      let j = i + quote.length;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src.startsWith(quote, j)) { j += quote.length; break; }
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

/** The text inside the bracket pair that opens at or after `from`. */
function insideBrackets(src, from, open = '(', close = ')') {
  const o = src.indexOf(open, from);
  if (o === -1) return null;
  let depth = 0;
  for (let i = o; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close && --depth === 0) return src.slice(o + 1, i);
  }
  return null;
}

/** The `Palette(...)` call a mode branch builds, as field -> R.color.name. */
function paletteFields(src, mode) {
  const at = src.indexOf(`${mode} -> Palette(`);
  assert(at > -1, `Palette has no "${mode}" branch`);
  const body = insideBrackets(src, at) || '';
  const fields = {};
  for (const m of body.matchAll(/(\w+)\s*=\s*c\(R\.color\.([\w]+)\)/g)) fields[m[1]] = m[2];
  return fields;
}

function walk(dir, filter, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, filter, out);
    else if (filter.test(entry.name)) out.push(p);
  }
  return out;
}

/* ============================================================== sources === */

const styleCss = read(PUB, 'style.css');
const appJs = read(PUB, 'app.js');
const hub = loadStylesheet(styleCss);
const mainXml = read(ANDROID, 'res', 'layout', 'activity_main.xml');
const mainKt = stripCodeComments(read(ANDROID, 'java', 'com', 'safedrop', 'mobile', 'ui', 'MainActivity.kt'));
const msgXml = read(ANDROID, 'res', 'layout', 'item_channel_message.xml');
const adapterKt = stripCodeComments(read(ANDROID, 'java', 'com', 'safedrop', 'mobile', 'ui', 'adapter', 'ChannelMessageAdapter.kt'));
const paletteKt = stripCodeComments(read(ANDROID, 'java', 'com', 'safedrop', 'mobile', 'ui', 'ThemeTokens.kt'));
const colorsXml = read(ANDROID, 'res', 'values', 'colors.xml');
const dimensXml = read(ANDROID, 'res', 'values', 'dimens.xml');

/* =================================================== 1. desktop scrollbar === */

console.log('=== SafeDrop - scrollbars, copy/selection, chat bar contract ===\n');
console.log('-- desktop scrollbars');

it('every theme defines the whole scrollbar role set', () => {
  const roles = ['--scrollbar-track', '--scrollbar-thumb', '--scrollbar-thumb-hover'];
  const missing = [];
  for (const t of THEMES) for (const r of roles) if (!token(hub, t, r)) missing.push(`${t} has no ${r}`);
  assert(missing.length === 0, missing.join('\n'));
  return `${roles.length} roles x ${THEMES.length} themes`;
});

it('scrollbar rules take their paint from the tokens, never a literal', () => {
  const offenders = [];
  const scrollRules = hub.rules.filter(r => /scrollbar/.test(r.selectors.join(',')));
  assert(scrollRules.length >= 5, `only ${scrollRules.length} scrollbar rules found`);
  for (const rule of scrollRules) {
    for (const [k, v] of rule.decls) {
      if (!/background|color/.test(k)) continue;
      if (!/var\(--scrollbar-/.test(v) && parseColor(v) && v !== 'transparent') offenders.push(`\`${rule.selectors[0]} { ${k}: ${v} }\` hard-codes a scrollbar colour`);
    }
  }
  assert(offenders.length === 0, offenders.join('\n'));
  return `${scrollRules.length} rules, all token-fed`;
});

it('the thumb is visible against its own track in every theme', () => {
  const detail = [];
  for (const t of THEMES) {
    const track = colorOf(hub, t, 'var(--scrollbar-track)');
    const thumb = colorOf(hub, t, 'var(--scrollbar-thumb)');
    assert(track && thumb, `${t}: scrollbar tokens do not resolve to colours`);
    const ratio = contrast(over(thumb, track), track);
    assert(ratio >= 1.2, `${t}: thumb sits ${ratio.toFixed(2)}:1 off its track, so the bar reads as a blank gutter`);
    assert(chroma(track) <= 45 && chroma(thumb) <= 45, `${t}: a scrollbar carries a hue (track ${chroma(track)}, thumb ${chroma(thumb)})`);
    detail.push(`${t}=${ratio.toFixed(2)}`);
  }
  return `thumb/track contrast ${detail.join(' ')}`;
});

it('the thumb answers the pointer: hover is a different value in every theme', () => {
  const detail = THEMES.map(t => {
    const rest = colorOf(hub, t, 'var(--scrollbar-thumb)');
    const hover = colorOf(hub, t, 'var(--scrollbar-thumb-hover)');
    assert(rest && hover, `${t}: scrollbar thumb/hover tokens do not resolve`);
    const moved = Math.max(...[0, 1, 2].map(i => Math.abs(rest[i] - hover[i])));
    assert(moved >= 8, `${t}: the hover thumb is only ${moved} steps from the resting thumb, so there is no grab affordance`);
    return `${t}+${moved}`;
  });
  return `hover deltas ${detail.join(' ')}`;
});

it('both scrollbar dialects are declared, and the chat stream keeps its own', () => {
  const standard = hub.rules.filter(r => r.decls.some(([k, v]) => k === 'scrollbar-color' && /var\(--scrollbar-/.test(v)));
  assert(standard.length >= 2, `${standard.length} rules set scrollbar-color from the tokens (WebKit-only styling leaves Firefox a native white bar)`);
  const width = hub.rules.some(r => r.decls.some(([k]) => k === 'scrollbar-width'));
  assert(width, 'scrollbar-width is not set, so the bar keeps its native fat chrome shape');
  const webkit = ['::-webkit-scrollbar', '::-webkit-scrollbar-track', '::-webkit-scrollbar-thumb', '::-webkit-scrollbar-corner']
    .filter(sel => !hub.rules.some(r => r.selectors.some(s => s === sel)));
  assert(webkit.length === 0, `no WebKit rule for ${webkit.join(', ')}`);
  const stream = hub.rules.filter(r => r.selectors.some(s => s.startsWith('.chat-stream-container::-webkit-scrollbar')));
  assert(stream.length >= 3, `.chat-stream-container has ${stream.length} scrollbar rules; a nested scroller falls back to the native bar`);
  const parts = new Set(hub.rules.flatMap(r => r.selectors.filter(s => /::-webkit-scrollbar/.test(s)))).size;
  return `${standard.length} standard rules, ${stream.length} stream overrides, ${parts} distinct webkit scrollbar selectors`;
});

/* ==================================================== 2. copy & selection === */

console.log('\n-- desktop copy & selection');

it('message text can be selected even though the app chrome cannot', () => {
  const bodyRule = hub.rules.find(r => r.selectors.some(s => s === 'body'));
  const bodySelect = (bodyRule.decls.find(([k]) => k === 'user-select') || ['', ''])[1];
  assert(bodySelect === 'none', `body user-select is "${bodySelect}"; the no-accidental-highlight protection is gone`);
  const bubble = effective(hub, 'dark', '.chat-bubble-content', 'user-select');
  assert(bubble === 'text', `.chat-bubble-content user-select resolves to "${bubble}"; message text cannot be selected`);
  const cursor = effective(hub, 'dark', '.chat-bubble-content', 'cursor');
  assert(/text/.test(cursor || ''), 'the bubble does not advertise that its text is selectable');
  return `body: ${bodySelect}, bubble: ${bubble}`;
});

it('the copy menu is a floating layer, not a frosted panel', () => {
  const menu = hub.rules.find(r => r.selectors.some(s => s === '.chat-context-menu'));
  assert(menu, '.chat-context-menu is no longer styled');
  const d = Object.fromEntries(menu.decls);
  assert(d.position === 'fixed', `the menu is position:${d.position}, so it is clipped by the scroll container it opens from`);
  assert(parseInt(d['z-index'], 10) >= 1000, `z-index ${d['z-index']} puts the menu under the panels`);
  assert(/var\(--bg-(raised|surface|elevated)\)/.test(d.background || ''), `the menu background is "${d.background}", not a surface token`);
  assert(d['box-shadow'] === 'var(--shadow-float)', 'the floating layer no longer carries the float shadow, so it reads as inline content');
  const item = hub.rules.find(r => r.selectors.some(s => s === '.chat-context-menu-item'));
  assert(item, '.chat-context-menu-item is no longer styled');
  const hover = hub.rules.find(r => r.selectors.some(s => /\.chat-context-menu-item:hover$/.test(s)));
  assert(hover, 'a menu item has no hover state, so nothing tracks the pointer');
  const glass = hub.rules.filter(r => r.decls.some(([k]) => k === 'backdrop-filter'));
  assert(glass.length === 0, `${glass.length} rules still use backdrop-filter (frosted panels were removed with the old design)`);
  return 'fixed layer on a raised surface with a float shadow and a hover state';
});

it('the copy path is wired: hold right-click, select, write to clipboard', () => {
  assert(/function selectBubbleText/.test(appJs), 'selectBubbleText is gone');
  const sel = appJs.slice(appJs.indexOf('function selectBubbleText'), appJs.indexOf('function showChatContextMenu'));
  assert(/createRange\(\)/.test(sel) && /setStart|selectNodeContents/.test(sel), 'selectBubbleText no longer builds a DOM Range, so "select" does nothing');
  assert(/function showChatContextMenu/.test(appJs), 'showChatContextMenu is gone');
  assert(/rightClickTimer/.test(appJs) && /e\.button === 2/.test(appJs), 'the hold-right-click gesture is no longer detected on button 2');
  assert(/addEventListener\(['"]contextmenu['"]/.test(appJs), 'the contextmenu event is no longer bound on the timeline');
  const ctx = appJs.slice(appJs.indexOf("addEventListener('contextmenu'") - 200, appJs.indexOf("addEventListener('contextmenu'") + 400);
  assert(/preventDefault\(\)/.test(ctx), 'the native browser menu is not suppressed');
  assert(/navigator\.clipboard\.writeText/.test(appJs), 'nothing is written to the clipboard');
  assert(/setTimeout\(\s*\(\)\s*=>\s*\{\s*const text = currentSel \|\| selectBubbleText/.test(appJs) || /currentSel \|\| selectBubbleText/.test(appJs), 'the hold gesture no longer falls back to selecting the bubble');
  return 'range selection, held right button, prevented native menu, clipboard write';
});

/* ============================================= 3. mobile chat bar & overlap === */

console.log('\n-- mobile chat bar and overlap');

it('the page inset and the navigation bar share one height token', () => {
  const pages = elementAttrs(mainXml, 'pagesContainer');
  assert(pages, 'no pagesContainer in activity_main.xml');
  const margin = (pages.match(/android:layout_marginBottom="([^"]+)"/) || [])[1];
  assert(margin, 'pagesContainer sets no bottom margin, so content scrolls under the bottom bar');
  assert(/^@dimen\/[\w.]+$/.test(margin), `the fallback margin is "${margin}"; it must name a dimen, not an ad-hoc dp, so the two cannot disagree`);
  const name = margin.replace('@dimen/', '');
  const value = (dimensXml.match(new RegExp(`<dimen name="${name}">(\\d+)dp</dimen>`)) || [])[1];
  assert(value, `${name} is not defined in dimens.xml`);
  assert(Number(value) >= 48, `${name} is ${value}dp, below the 48dp minimum touch target the bar has to hold`);
  const nav = elementAttrs(mainXml, 'bottomNavigation');
  assert(nav, 'no bottomNavigation in activity_main.xml');
  assert(new RegExp(`android:layout_height="@dimen/${name}"`).test(nav), 'the bottom navigation does not use the same height the pages container reserves');
  return `both reference @dimen/${name} = ${value}dp`;
});

it('the fallback is corrected to the bar height the framework actually laid out', () => {
  const listener = /bottomNavigation\.addOnLayoutChangeListener\s*\{[\s\S]*?bottom - top[\s\S]*?\}/.test(mainKt);
  assert(listener, 'MainActivity no longer listens for the navigation bar laying itself out');
  assert(/pagesContainer\.layoutParams as\? ViewGroup\.MarginLayoutParams/.test(mainKt), 'the measured height is not applied to the pages container margin');
  assert(/lp\.bottomMargin = navHeight/.test(mainKt), 'the measured nav height is never written into the margin');
  assert(/if \(navHeight > 0\)/.test(mainKt), 'the listener does not guard against a zero-height pass, which would collapse the page inset');
  assert(/lp\.bottomMargin != navHeight/.test(mainKt), 'the listener re-requests layout on every pass instead of only when the margin changes');
  return 'measured height wins over the static fallback, guarded and idempotent';
});

it('the input bar is divided from the list, opaque, and above it in the tree', () => {
  const divider = elementAttrs(mainXml, 'chatInputBarDivider');
  assert(divider, 'chatInputBarDivider is gone: the bar no longer separates itself from the timeline');
  const h = (divider.match(/android:layout_height="([^"]+)"/) || [])[1];
  assert(h === '@dimen/hairline_width', `the divider is ${h}, not the hairline dimen`);
  assert(/android:background="@color\/[\w.]+"/.test(divider), 'the divider paints a literal instead of a named colour');
  const bar = elementAttrs(mainXml, 'layoutChatInputBar');
  assert(bar, 'no layoutChatInputBar');
  assert(/android:background="@color\/[\w.]+"/.test(bar), 'the input bar has no opaque surface behind the text');
  const elevation = (bar.match(/android:elevation="(-?[\d.]+)dp"/) || [])[1];
  assert(!elevation || Number(elevation) === 0, `the input bar casts a ${elevation}dp shadow; in this design structure is drawn by hairlines, and elevation is reserved for floating layers`);
  const order = ['rvChannelMessages', 'chatInputBarDivider', 'layoutChatInputBar'].map(id => mainXml.indexOf(`@+id/${id}`));
  assert(order.every(i => i > -1), 'the message list / divider / input bar chain is broken');
  assert(order[0] < order[1] && order[1] < order[2], 'the divider no longer sits between the message list and the input bar');
  assert(/layoutChatInputBar\.setBackgroundColor\(p\.surface\)/.test(mainKt) && /chatInputBarDivider\.setBackgroundColor\(p\.hairline\)/.test(mainKt), 'the bar and its hairline are no longer repainted per theme mode');
  return 'hairline divider over an opaque bar, in order, repainted per mode';
});

it('cards and the bottom bar keep depth out of the design', () => {
  const cardElevation = (dimensXml.match(/<dimen name="card_elevation">(\d+(?:\.\d+)?)dp/) || [])[1];
  assert(cardElevation !== undefined && Number(cardElevation) === 0, `card_elevation is ${cardElevation}dp; cards are drawn with a hairline, not a shadow`);
  const nav = elementAttrs(mainXml, 'bottomNavigation');
  assert(!/android:elevation="[1-9]/.test(nav), 'the bottom navigation floats again');
  const stroke = /name="strokeWidth">\@dimen\/hairline_width</.test(read(ANDROID, 'res', 'values', 'themes.xml'));
  assert(stroke, 'the card style no longer takes its structure from a hairline stroke');
  assert(/card\.cardElevation = 0f/.test(mainKt), 'MainActivity does not flatten the cards it paints');
  return '0dp elevation on cards and the nav bar, hairline stroke instead';
});

/* ================================================== 4. mobile select & copy === */

console.log('\n-- mobile long-press selection and copy');

it('message text is selectable from layout and from bind', () => {
  const tv = elementAttrs(msgXml, 'tvMessageContent');
  assert(tv, 'no tvMessageContent in item_channel_message.xml');
  assert(/android:textIsSelectable="true"/.test(tv), 'the layout dropped textIsSelectable');
  assert(/tvMessageContent\.setTextIsSelectable\(true\)/.test(adapterKt), 'bind() no longer re-asserts selectability (RecyclerView reuses holders, and the flag does not survive every rebind)');
  return 'attribute and bind both set it';
});

it('long-press gives copy and select, and copy reaches the clipboard', () => {
  assert(/cardTextBubble\.setOnLongClickListener/.test(adapterKt), 'the bubble no longer responds to a long press');
  assert(/ClipboardManager/.test(adapterKt) && /ClipData\.newPlainText\(/.test(adapterKt), 'the copy action no longer writes a plain-text clip');
  assert(/Selection\.selectAll/.test(adapterKt), 'the "select" half of the long-press menu is gone');
  const at = adapterKt.indexOf('val items = arrayOf(');
  assert(at > -1, 'the long-press menu no longer builds its action list');
  const actions = insideBrackets(adapterKt, at) || '';
  assert((actions.match(/R\.string\./g) || []).length >= 2, 'the long-press menu offers no named actions');
  assert(/\.setItems\(items\)/.test(adapterKt), 'the action list is never shown as a choice');
  assert(/AlertDialog\.Builder\(context\)/.test(adapterKt), 'the long-press menu is not a dialog, so it inherits no theme');
  return 'copy + select offered, plain-text clip written';
});

it('the selection highlight follows the theme instead of an inline colour', () => {
  assert(/val p = Palette\.of\(ctx, theme\)/.test(adapterKt), 'the adapter no longer takes its paint from the shared Palette');
  // Capture the whole assignment, not one dotted word: a palette-derived expression with an alpha
  // applied is still from the palette, and that is the property being guarded.
  const highlight = (adapterKt.match(/tvMessageContent\.highlightColor = (.+)/) || [])[1];
  assert(highlight && /\bp\./.test(highlight), `the highlight is set to "${highlight}"; it must come from the palette`);
  assert(!/(#[0-9A-Fa-f]{6}|0xFF[0-9A-Fa-f]{6})/.test(highlight), `the highlight hardcodes a colour again: ${highlight}`);
  assert(!/Color\.parseColor\(/.test(adapterKt), 'the adapter paints with an inline hex again');
  // The token the highlight is built from, ignoring any alpha wrapper applied around it.
  const field = (highlight.match(/\bp\.(\w+)/) || [])[1];
  const plates = adapterKt.match(/cardTextBubble\.setCardBackgroundColor\(if \(msg\.isOutgoing\) ([\w.]+) else ([\w.]+)\)/);
  assert(plates, 'the bubble plate is no longer chosen per direction');
  const detail = [];
  for (const mode of ['EYECARE', 'LIGHT', 'else']) {
    const fields = paletteFields(paletteKt, mode);
    const name = fields[field];
    assert(name, `Palette.${mode} gives no ${field}`);
    assert(new RegExp(`<color name="${name}">`).test(colorsXml), `R.color.${name} is not defined in colors.xml`);
    for (const f of ['page', 'surface', 'raised', 'hairline', 'ink', 'onInk']) assert(fields[f], `Palette.${mode} is missing ${f}`);
    detail.push(`${mode === 'else' ? 'dark' : mode.toLowerCase()}:${name}`);
  }
  // The property the old "highlight colors are customized per theme" check was reaching for:
  // marking text has to show a mark, so the highlight must differ from the plate behind it.
  if (plates[1] === `p.${field}`) {
    defects.push(`apps/android/com/app/src/main/java/com/safedrop/mobile/ui/adapter/ChannelMessageAdapter.kt - the outgoing bubble plate and the selection highlight both resolve to "${field}", so selecting your own message shows no mark at all. The highlight needs its own token, or an alpha, to stay visible on both plates.`);
  }
  return `${highlight} resolved through Palette for 3 modes (${detail.join(' ')})`;
});

/* ================================================ 5. colour-literal ratchet === */

console.log('\n-- shared design contract: where a colour may live');

// Files that still own un-tokened paint. Each entry is debt the ink-first redesign has not
// paid off yet; the check prints it on every run and fails if the set changes either way, so
// it cannot grow and cannot rot into a lie. Delete an entry when its file is converted.
const COLOUR_DEBT = [
  { file: 'apps/android/com/app/src/main/java/com/safedrop/mobile/ui/radar/RadarView.kt', why: 'the radar still paints its own Tailwind-era slate/indigo/emerald hexes instead of Palette colours' },
  { file: 'apps/android/com/app/src/main/res/layout/dialog_transfer_sheet.xml', why: 'the sheet handle is a raw slate-600' },
  { file: 'apps/android/com/app/src/main/res/layout/activity_qr_scanner.xml', why: 'the camera scrim is a raw ARGB literal' }
];

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

it('the themed paint path takes every colour by name, never as a literal', () => {
  const alwaysClean = [
    'apps/android/com/app/src/main/java/com/safedrop/mobile/ui/MainActivity.kt',
    'apps/android/com/app/src/main/java/com/safedrop/mobile/ui/ThemeTokens.kt',
    'apps/android/com/app/src/main/java/com/safedrop/mobile/ui/adapter/ChannelMessageAdapter.kt',
    'apps/android/com/app/src/main/java/com/safedrop/mobile/ui/adapter/PeerChipAdapter.kt',
    'apps/android/com/app/src/main/java/com/safedrop/mobile/ui/adapter/DeviceAdapter.kt'
  ].filter(p => fs.existsSync(path.join(ROOT, p)));
  const offenders = [];
  for (const p of alwaysClean) {
    const src = stripCodeComments(read(ROOT, p));
    for (const m of src.matchAll(/Color\.parseColor\(\s*"#[0-9A-Fa-f]{3,8}"\s*\)|0xFF[0-9A-Fa-f]{6}/g)) offenders.push(`${p}: ${m[0]}`);
  }
  assert(offenders.length === 0, `these files are inside the Palette contract and must not name a colour:\n${offenders.join('\n')}`);
  // Every @color the palette references has to exist, or the build breaks at inflation time.
  const referenced = [...paletteKt.matchAll(/R\.color\.([\w]+)/g)].map(m => m[1]);
  const undefined = referenced.filter(n => !new RegExp(`<color name="${n}">`).test(colorsXml));
  assert(undefined.length === 0, `Palette points at colours colors.xml does not define: ${undefined.join(', ')}`);
  return `${alwaysClean.length} themed-paint files clean, ${new Set(referenced).size} @color references resolve`;
});

it('un-tokened paint is only where the debt registry already says it is', () => {
  const files = [
    ...walk(path.join(ANDROID, 'java'), /\.kt$/),
    ...walk(path.join(ANDROID, 'res', 'layout'), /\.xml$/)
  ];
  const found = new Map();
  for (const f of files) {
    const src = f.endsWith('.kt') ? stripCodeComments(read(f)) : read(f);
    const hits = [...src.matchAll(/Color\.parseColor\(\s*"#[0-9A-Fa-f]{3,8}"\s*\)|="#[0-9A-Fa-f]{3,8}"/g)];
    if (hits.length) found.set(rel(f), hits.length);
  }
  const known = new Set(COLOUR_DEBT.map(d => d.file));
  const added = [...found.keys()].filter(f => !known.has(f));
  const stale = [...known].filter(f => !found.has(f));
  const lines = [];
  for (const [f, n] of found) {
    if (!known.has(f)) continue;
    lines.push(`${f} (${n} literal${n > 1 ? 's' : ''}) - ${COLOUR_DEBT.find(d => d.file === f).why}`);
  }
  if (lines.length) console.log(`[debt] ${lines.length} file(s) still hold colour outside the shared token set:`);
  for (const l of lines) console.log(`       ${l}`);
  const problems = [];
  if (added.length) problems.push(`new un-tokened paint: ${added.join(', ')}`);
  if (stale.length) problems.push(`the registry lists ${stale.join(', ')} as debt, but those files are clean now - drop them from COLOUR_DEBT`);
  assert(problems.length === 0, problems.join('\n'));
  return `${found.size} file(s) in debt, exactly as registered`;
});

/* ======================================================== 6. build product === */

console.log('\n-- build artifact');

const apkPath = path.join(ROOT, 'apps', 'android', 'SafeDrop-release.apk');

if (fs.existsSync(apkPath)) {
  it('the local release APK is there and is a real APK', () => {
    const stat = fs.statSync(apkPath);
    assert(stat.size > 1024 * 1024, `the APK is only ${stat.size} bytes, which is not a built app`);
    const head = Buffer.alloc(4);
    const fd = fs.openSync(apkPath, 'r');
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    assert(head.toString('latin1') === 'PK\x03\x04', 'the file is not a zip container, so it is not an APK');
    return `apps/android/SafeDrop-release.apk ${(stat.size / 1024 / 1024).toFixed(2)} MB`;
  });
} else {
  skip('the release APK is built and loadable',
    'apps/android/SafeDrop-release.apk is a gitignored local build product, so a fresh clone and CI have no such file. ' +
    'Build it with the Gradle assembleRelease task and re-run this suite to get this check back.');
}

/* =============================================================== summary === */

if (defects.length) {
  console.log('');
  for (const d of defects) console.log(`[defect] ${d}`);
}
console.log('\n====================================================');
console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped, ${defects.length} known defect(s)`);
console.log('====================================================\n');

process.exitCode = failed > 0 ? 1 : 0;
