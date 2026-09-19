/*
 * Per-device chat window and layout contract (desktop hub + Android).
 *
 * What these checks are for: the chat window has to keep working as a two-pane,
 * scrolling, never-overlapping UI in all three appearance modes, on both ends, and
 * it has to say who sent a message without relying on colour. None of it pins a hex
 * value or a dp value: the assertions read the token blocks and the source structure,
 * so re-toning the palette cannot turn them red and dropping a theme can.
 *
 * The message-relay section talks to a running hub on 127.0.0.1:8899. When nothing is
 * listening it is reported as a skip with the reason, never as a pass.
 *
 * Run: node test/e2e/new_chat_and_layout_features.js
 */
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PUB = path.join(ROOT, 'apps', 'desktop', 'desktop_hub', 'public');
const ANDROID = path.join(ROOT, 'apps', 'android', 'com', 'app', 'src', 'main');
const HUB = { host: '127.0.0.1', port: 8899 };
const THEMES = ['dark', 'eyecare', 'light'];

let passed = 0;
let failed = 0;
let skipped = 0;

function it(desc, fn) {
  try {
    const detail = fn();
    passed++;
    console.log(`[ ok ] ${desc}${detail ? `  (${detail})` : ''}`);
    return true;
  } catch (err) {
    failed++;
    console.error(`[FAIL] ${desc}\n       ${String(err.message).split('\n').join('\n       ')}`);
    return false;
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

/* ------------------------------------------------------ android helpers --- */

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

/** The body of the function whose declaration starts at or after `from`. */
function bracedBody(src, from) {
  const at = src.indexOf('{', from);
  if (at === -1) return null;
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at + 1, i);
  }
  return null;
}

function paletteFields(src, mode) {
  const at = src.indexOf(`${mode} -> Palette(`);
  assert(at > -1, `Palette has no "${mode}" branch`);
  const body = insideBrackets(src, at) || '';
  const fields = {};
  for (const m of body.matchAll(/(\w+)\s*=\s*c\(R\.color\.([\w]+)\)/g)) fields[m[1]] = m[2];
  return fields;
}

function colorRes(colorsXml, name, seen = 0) {
  const raw = (colorsXml.match(new RegExp(`<color name="${name}">([^<]+)</color>`)) || [])[1];
  if (!raw) return null;
  const alias = raw.match(/^@color\/([\w]+)$/);
  if (alias && seen < 5) return colorRes(colorsXml, alias[1], seen + 1);
  return parseColor(raw);
}

/* ------------------------------------------------------------- transport --- */

function requestJson(urlPath, options = {}, body) {
  return new Promise((resolveFn, reject) => {
    const req = http.request({ ...HUB, path: urlPath, method: options.method || 'GET' }, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          resolveFn({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolveFn({ status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* ================================================================ sources === */

const indexHtml = read(PUB, 'index.html');
const appJs = read(PUB, 'app.js');
const hub = loadStylesheet(read(PUB, 'style.css'));
const mainXml = read(ANDROID, 'res', 'layout', 'activity_main.xml');
const itemDeviceXml = read(ANDROID, 'res', 'layout', 'item_device.xml');
const mainKt = stripCodeComments(read(ANDROID, 'java', 'com', 'safedrop', 'mobile', 'ui', 'MainActivity.kt'));
const paletteKt = stripCodeComments(read(ANDROID, 'java', 'com', 'safedrop', 'mobile', 'ui', 'ThemeTokens.kt'));
const msgAdapterKt = stripCodeComments(read(ANDROID, 'java', 'com', 'safedrop', 'mobile', 'ui', 'adapter', 'ChannelMessageAdapter.kt'));
const colorsXml = read(ANDROID, 'res', 'values', 'colors.xml');
const dimensXml = read(ANDROID, 'res', 'values', 'dimens.xml');

async function main() {
  console.log('=== SafeDrop - per-device chat window and layout contract ===\n');

  /* ------------------------------------------------- 1. desktop chat frame -- */
  console.log('-- desktop chat window: structure');

  it('the chat tab is reachable and owns a peers list, a stream and an input bar', () => {
    assert(/data-tab="chatTab"/.test(indexHtml), 'no nav button opens the chat tab');
    for (const id of ['chatTab', 'chatPeersList', 'chatTimeline', 'chatFileInput']) {
      assert(indexHtml.includes(`id="${id}"`), `#${id} is gone from index.html`);
    }
    assert(/class="chat-input-bar"/.test(indexHtml), 'the chat input bar is gone from index.html');
    return 'tab, peers list, timeline, file picker, input bar';
  });

  it('the two-pane chat cannot be forced open by its own children', () => {
    const layout = hub.rules.find(r => r.selectors.some(s => s === '.chat-layout'));
    assert(layout, '.chat-layout has no rule');
    const d = Object.fromEntries(layout.decls);
    assert(/flex|grid/.test(d.display || ''), `.chat-layout is display:${d.display}; the panes are not laid out side by side`);
    assert(d.overflow === 'hidden', 'the layout does not clip, so a wide pane can push the window');
    const sidebar = hub.rules.find(r => r.selectors.some(s => s === '.chat-sidebar'));
    const pane = hub.rules.find(r => r.selectors.some(s => s === '.chat-main-pane'));
    assert(sidebar && pane, 'one of the two chat panes lost its rule');
    assert(/0/.test((pane.decls.find(([k]) => k === 'min-width') || ['', ''])[1]), '.chat-main-pane keeps min-width:auto, so a long message widens the whole window');
    const input = hub.rules.find(r => r.selectors.some(s => s === '.chat-text-input'));
    assert(input && /0/.test((input.decls.find(([k]) => k === 'min-width') || ['', ''])[1]), 'the message input cannot shrink, so a typed URL pushes the send button out of view');
    return 'layout clips, pane and text input both take min-width: 0';
  });

  it('a long thread scrolls instead of pushing the input bar away', () => {
    const stream = hub.rules.find(r => r.selectors.some(s => s === '.chat-stream-container'));
    assert(stream, '.chat-stream-container has no rule');
    const d = Object.fromEntries(stream.decls);
    assert(/auto|scroll/.test(d['overflow-y'] || ''), `the stream is overflow-y:${d['overflow-y']}; messages cannot scroll`);
    assert(/1/.test(d.flex || ''), 'the stream does not grow, so it cannot absorb the available height');
    const bar = hub.rules.find(r => r.selectors.some(s => s === '.chat-input-bar'));
    assert(bar, '.chat-input-bar has no rule');
    const bd = Object.fromEntries(bar.decls);
    assert(/var\(--bg-/.test(bd.background || ''), 'the input bar has no opaque surface, so scrolled text shows through it');
    assert(/var\(--border\)/.test(bd['border-top'] || ''), 'the input bar lost the hairline that separates it from the thread');
    return 'scrolling stream over an opaque, divided bar';
  });

  /* ------------------------------------- 2. sender identity without colour -- */
  console.log('\n-- desktop chat bubbles: who sent it, without colour');

  it('direction is carried by position and corner geometry, not only by hue', () => {
    const out = hub.rules.find(r => r.selectors.some(s => s === '.chat-bubble.outgoing'));
    const inc = hub.rules.find(r => r.selectors.some(s => s === '.chat-bubble.incoming'));
    assert(out && inc, 'the incoming/outgoing bubble rules are gone');
    const ao = Object.fromEntries(out.decls)['align-self'];
    const ai = Object.fromEntries(inc.decls)['align-self'];
    assert(ao && ai && ao !== ai, `outgoing is align-self:${ao} and incoming is ${ai}; the two no longer sit apart`);
    const outContent = hub.rules.find(r => r.selectors.some(s => /\.chat-bubble\.outgoing \.chat-bubble-content$/.test(s)));
    const inContent = hub.rules.find(r => r.selectors.some(s => /\.chat-bubble\.incoming \.chat-bubble-content$/.test(s)));
    assert(outContent && inContent, 'the bubble plates lost their rules');
    const oc = Object.fromEntries(outContent.decls)['border-bottom-right-radius'];
    const ic = Object.fromEntries(inContent.decls)['border-bottom-left-radius'];
    assert(oc && ic && oc === ic, 'the tails no longer point at the sender side of the thread');
    assert(oc !== Object.fromEntries(outContent.decls)['border-radius'], 'the tail corner equals the plate corner, so no tail is drawn');
    return `${ao}/${ai}, tail radius ${oc}`;
  });

  it('my own bubble is the loudest surface, and it is not a colour', () => {
    for (const t of THEMES) {
      const rule = hub.rules.find(r => r.selectors.some(s => s === '.chat-bubble.outgoing .chat-bubble-content'));
      const decls = Object.fromEntries(rule.decls);
      const ink = colorOf(hub, t, decls.background);
      assert(ink, `${t}: the outgoing plate does not resolve to a colour`);
      assert(chroma(ink) <= 16, `${t}: the outgoing plate is a hue (chroma ${chroma(ink)}); "mine" must read as ink, not as brand colour`);
      assert(/var\(--ink\)/.test(decls.background), `${t}: the outgoing plate is ${decls.background}, no longer the ink token`);
      const label = colorOf(hub, t, decls.color);
      const ratio = contrast(over(label, ink), ink);
      assert(ratio >= 4.5, `${t}: text on an outgoing bubble is ${ratio.toFixed(2)}:1`);
    }
    return 'ink plate, label >= 4.5:1 in all three themes';
  });

  it('their bubble is a surface with a hairline, and its text is legible', () => {
    const detail = [];
    for (const t of THEMES) {
      const rule = hub.rules.find(r => r.selectors.some(s => s === '.chat-bubble.incoming .chat-bubble-content'));
      const decls = Object.fromEntries(rule.decls);
      const plate = over(colorOf(hub, t, decls.background), colorOf(hub, t, 'var(--bg-app)'));
      const label = colorOf(hub, t, decls.color);
      assert(plate && label, `${t}: the incoming bubble does not resolve`);
      const ratio = contrast(over(label, plate), plate);
      assert(ratio >= 4.5, `${t}: text on an incoming bubble is ${ratio.toFixed(2)}:1`);
      assert(/var\(--border\)/.test(decls.border || ''), `${t}: the incoming bubble lost its hairline, so the two surfaces merge`);
      detail.push(`${t}=${ratio.toFixed(1)}`);
    }
    return `label contrast ${detail.join(' ')}`;
  });

  it('the chat block reads only tokens every theme defines', () => {
    const unresolved = new Set();
    const chromaticLiterals = [];
    for (const rule of hub.rules) {
      if (!rule.selectors.some(s => /\.chat-|^#chat/.test(s))) continue;
      for (const [k, v] of rule.decls) {
        for (const m of v.matchAll(/var\((--[\w-]+)/g)) {
          if (!hub.root.has(m[1]) && !THEMES.every(t => hub.theme[t].has(m[1]))) unresolved.add(m[1]);
        }
        if (/^(--|\+)/.test(k)) continue;
        for (const m of v.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)) {
          const c = parseColor(m[0]);
          if (c && chroma(c) > 20) chromaticLiterals.push(`${rule.selectors[0]} { ${k}: ${v} }`);
        }
      }
    }
    assert(unresolved.size === 0, `chat rules read tokens no theme defines: ${[...unresolved].join(', ')}`);
    assert(chromaticLiterals.length === 0, `chat rules hard-code a hue:\n${chromaticLiterals.join('\n')}`);
    return 'no dangling token, no inline hue in any chat rule';
  });

  it('the renderer emits the same bubble classes the stylesheet paints', () => {
    const emitted = [...appJs.matchAll(/class="chat-bubble \$\{[^}]*?'([\w-]+)'[^}]*?'([\w-]+)'/g)]
      .flatMap(m => [`.chat-bubble.${m[1]}`, `.chat-bubble.${m[2]}`]);
    assert(emitted.length >= 2, 'the renderer no longer picks a bubble class by direction');
    const styled = hub.rules.flatMap(r => r.selectors);
    const missing = [...new Set(emitted)].filter(c => !styled.some(s => s.includes(c)));
    assert(missing.length === 0, `emitted by app.js but never styled: ${missing.join(', ')}`);
    return [...new Set(emitted)].join(', ');
  });

  /* --------------------------------------------------------- 3. relay API -- */
  console.log('\n-- desktop hub message relay');

  let reachable = true;
  try {
    await requestJson('/api/v1/ping');
  } catch (err) {
    reachable = false;
    skip('the message relay round-trips a text message',
      `no desktop hub is answering on http://${HUB.host}:${HUB.port}/ (${err.code || err.message}). ` +
      'Start the hub and re-run this suite; this is reported as a skip so a fresh clone still passes, never as a pass.');
  }

  if (reachable) {
    const peer = `layout-test-${Date.now()}`;
    const text = 'Hello from the layout contract test';
    try {
      const res = await requestJson('/api/v1/message/send', { method: 'POST' }, JSON.stringify({
        targetPeerId: peer,
        text,
        senderId: 'layout-test',
        senderName: 'Desktop Hub test'
      }));
      it('POST /api/v1/message/send accepts a text message', () => {
        assert(res.status === 200, `HTTP ${res.status}`);
        assert(res.data && res.data.code === 0, `the relay answered ${JSON.stringify(res.data)}`);
      });
      const list = await requestJson(`/api/v1/messages/list?peerId=${peer}`);
      it('the stored message comes back for that peer', () => {
        assert(list.status === 200, `HTTP ${list.status}`);
        assert(Array.isArray(list.data.messages), 'messages is not an array');
        assert(list.data.messages.some(m => m.text === text), 'the message that was sent is not in the history');
        assert(list.data.messages.every(m => m.text), 'the history leaks empty rows');
      });
    } catch (err) {
      failed++;
      console.error(`[FAIL] the message relay round-trip\n       ${err.message}`);
    }
  }

  /* --------------------------------------- 4. mobile top bar & peer window -- */
  console.log('\n-- mobile top bar and per-device chat window');

  it('the compact top buttons are icon-only but still say what they do', () => {
    const ids = ['btnShowMyQr', 'btnInputPin', 'btnScanQr'];
    const problems = [];
    for (const id of ids) {
      const el = elementAttrs(mainXml, id);
      assert(el, `${id} is gone from activity_main.xml`);
      if (/android:text="/.test(el)) problems.push(`${id} carries a text label again, so the bar is not compact`);
      if (!/android:contentDescription="[^"]+"/.test(el)) problems.push(`${id} is icon-only with no contentDescription, so it is announced as nothing`);
      if (!/app:icon="@drawable\/[\w.]+"/.test(el)) problems.push(`${id} has no icon, so it is an empty button`);
    }
    assert(problems.length === 0, problems.join('\n'));
    return `${ids.length} icon-only buttons, each with a content description`;
  });

  it('the radar card and its online-count tag exist and are repainted per mode', () => {
    assert(mainXml.includes('id="@+id/cardRadar"'), 'cardRadar is gone');
    assert(mainXml.includes('id="@+id/tvOnlineCountTag"'), 'the online-count tag is gone');
    assert(/b\.cardRadar/.test(mainKt) && /tvOnlineCountTag\.setTextColor\(p\./.test(mainKt), 'the radar card or its tag is no longer painted from the palette');
    return 'card + tag, both palette-fed';
  });

  it('a section eyebrow leaves real space above it, from the spacing scale', () => {
    const el = elementAttrs(mainXml, 'tvDeviceSectionTitle');
    assert(el, 'tvDeviceSectionTitle is gone');
    const raw = (el.match(/android:layout_marginTop="([\d.]+)(dp|@dimen\/([\w.]+))"/) || []);
    let dp;
    if (raw[2] === 'dp') dp = Number(raw[1]);
    else {
      const dimenName = raw[3];
      dp = Number((dimensXml.match(new RegExp(`<dimen name="${dimenName}">([\\d.]+)dp`)) || [])[1]);
      assert(!Number.isNaN(dp), `@dimen/${dimenName} is not defined`);
    }
    assert(dp >= 16, `the eyebrow sits only ${dp}dp under the card above it, so the section reads as part of it`);
    return `top inset ${dp}dp`;
  });

  it('page 2 is one merged transfer + chat window', () => {
    const ids = ['layoutTransferPage', 'rvPeerChips', 'cardActivePeerInfo', 'rvChannelMessages', 'layoutChatInputBar', 'btnChannelPickFile', 'etChannelMessage', 'btnChannelSendMessage'];
    const missing = ids.filter(id => !mainXml.includes(`id="@+id/${id}"`));
    assert(missing.length === 0, `missing: ${missing.join(', ')}`);
    const chips = elementAttrs(mainXml, 'rvPeerChips');
    assert(/android:orientation="horizontal"/.test(chips), 'the peer selector is not a horizontal strip');
    const order = ['rvPeerChips', 'rvChannelMessages', 'layoutChatInputBar'].map(id => mainXml.indexOf(`@+id/${id}`));
    assert(order[0] < order[1] && order[1] < order[2], 'chips, thread and input bar are out of order, so the selector is buried');
    return `${ids.length} ids present, strip/thread/bar in order`;
  });

  it('the device row offers both actions a peer needs, with names', () => {
    const chat = elementAttrs(itemDeviceXml, 'btnOpenChat');
    const send = elementAttrs(itemDeviceXml, 'btnConnectDevice');
    assert(chat && send, 'the device row lost one of its two actions');
    assert(/android:text="[^"]+"/.test(chat), 'the chat action has no label');
    assert(/android:text="[^"]+"|android:contentDescription="[^"]+"/.test(send), 'the transfer action has no label');
    for (const [id, el] of [['btnOpenChat', chat], ['btnConnectDevice', send]]) {
      const h = (el.match(/android:layout_height="(?:(\d+(?:\.\d+)?)dp|@dimen\/([\w.]+))"/) || []);
      const px = h[1] ? Number(h[1]) : Number((dimensXml.match(new RegExp(`<dimen name="${h[2]}">([\\d.]+)dp`)) || [])[1]);
      assert(!Number.isNaN(px), `${id} has no resolvable height`);
      assert(px >= 36, `${id} is ${px}dp tall, under the 36dp the touch target needs`);
    }
    return 'both actions labelled and tappable';
  });

  /* ------------------------------------------------ 5. theme adaptation ---- */
  console.log('\n-- mobile theme adaptation across all three modes');

  it('switching mode repaints every list, not just some of them', () => {
    const body = bracedBody(mainKt, mainKt.indexOf('private fun applyThemeMode')) || '';
    const adapters = ['deviceAdapter', 'transferTaskAdapter', 'vaultFileAdapter', 'peerChipAdapter', 'channelMessageAdapter'];
    const missed = adapters.filter(a => !new RegExp(`${a}\\.setThemeMode\\(theme\\)`).test(body));
    assert(missed.length === 0, `${missed.join(', ')} keep the old palette after a mode switch`);
    assert(/applyChrome\(Palette\.of\(this, theme\)\)/.test(body), 'the chrome is not rebuilt from the palette for the new mode');
    assert(/prefs\.edit\(\)\.putString\("theme_mode"/.test(body), 'the chosen mode is not persisted, so the next launch reverts');
    return `${adapters.length} adapters + chrome + persistence`;
  });

  it('the active-peer banner is one of the cards the palette paints', () => {
    const cards = insideBrackets(mainKt, mainKt.indexOf('val cards = listOf(')) || '';
    assert(/b\.cardActivePeerInfo/.test(cards), 'cardActivePeerInfo left the list of palette-painted cards');
    assert(/card\.setCardBackgroundColor\(p\.surface\)/.test(mainKt), 'the card list is no longer painted from the palette surface');
    const surfaces = ['EYECARE', 'LIGHT', 'else'].map(m => paletteFields(paletteKt, m).surface);
    assert(surfaces.every(Boolean), 'a mode has no surface colour');
    assert(new Set(surfaces).size >= 2, 'all three modes paint the same surface, so switching mode shows nothing');
    for (const s of surfaces) assert(new RegExp(`<color name="${s}">`).test(colorsXml), `colors.xml has no ${s}`);
    return `banner follows p.surface, modes resolve to ${surfaces.join('/')}`;
  });

  it('every mode defines the same palette roles, from named colours', () => {
    const roles = ['page', 'surface', 'raised', 'hairline', 'ink', 'inkMuted', 'inkFaint', 'onInk', 'ready', 'active', 'attention', 'failure'];
    const maps = ['EYECARE', 'LIGHT', 'else'].map(m => paletteFields(paletteKt, m));
    const problems = [];
    maps.forEach((fields, i) => {
      const mode = ['EYECARE', 'LIGHT', 'dark'][i];
      for (const r of roles) {
        if (!fields[r]) problems.push(`${mode} has no ${r}`);
        else if (!new RegExp(`<color name="${fields[r]}">`).test(colorsXml)) problems.push(`${mode}.${r} -> R.color.${fields[r]} is not in colors.xml`);
      }
    });
    assert(problems.length === 0, problems.join('\n'));
    return `${roles.length} roles x 3 modes, all resolved through @color`;
  });

  it('the send control is ink, on both ends of the wire', () => {
    assert(/val ctaBackground: Int get\(\) = ink/.test(paletteKt), 'the CTA no longer takes the ink of its mode');
    assert(/val ctaText: Int get\(\) = onInk/.test(paletteKt), 'the CTA label no longer takes the knocked-out ink');
    const inks = ['EYECARE', 'LIGHT', 'else'].map(m => colorRes(colorsXml, paletteFields(paletteKt, m).ink));
    const texts = ['EYECARE', 'LIGHT', 'else'].map(m => colorRes(colorsXml, paletteFields(paletteKt, m).onInk));
    inks.forEach((c, i) => {
      assert(c, `mode ${i} has no resolvable ink colour`);
      assert(chroma(c) <= 16, `${['eyecare', 'light', 'dark'][i]}: the CTA plate is a hue (chroma ${chroma(c)})`);
      const ratio = contrast(over(texts[i], c), c);
      assert(ratio >= 4.5, `${['eyecare', 'light', 'dark'][i]}: CTA label on plate is ${ratio.toFixed(2)}:1`);
    });
    assert(/btnChannelSendMessage\.backgroundTintList = p\.states\(p\.ctaBackground\)/.test(mainKt), 'the chat send button no longer takes the CTA plate');
    return 'plate = mode ink, label >= 4.5:1, no hue anywhere';
  });

  it('a chat row says who sent it without needing its colour', () => {
    const at = msgAdapterKt.indexOf('if (msg.isOutgoing)');
    assert(at > -1, 'the message row no longer branches on who sent it');
    const block = msgAdapterKt.slice(at, at + 320);
    assert(/spacerTextLeft\.visibility = View\.VISIBLE/.test(block) && /spacerTextRight\.visibility = View\.GONE/.test(block), 'outgoing rows are no longer pushed to one side by a spacer');
    assert(/cardTextBubble\.setCardBackgroundColor\(if \(msg\.isOutgoing\)/.test(msgAdapterKt), 'the plate no longer differs by direction');
    return 'spacer + plate both carry direction';
  });

  it('the desktop and the phone agree on what each state colour means', () => {
    const desktop = THEMES.map(t => ({
      ready: colorOf(hub, t, 'var(--state-ready)'),
      progress: colorOf(hub, t, 'var(--state-progress)'),
      attention: colorOf(hub, t, 'var(--state-attention)'),
      failure: colorOf(hub, t, 'var(--state-failure)')
    }));
    const android = {
      ready: colorRes(colorsXml, 'state_ready'),
      progress: colorRes(colorsXml, 'state_active'),
      attention: colorRes(colorsXml, 'state_attention'),
      failure: colorRes(colorsXml, 'state_failure')
    };
    const problems = [];
    for (const role of Object.keys(android)) {
      assert(android[role], `colors.xml has no state colour for ${role}`);
      desktop.forEach((set, i) => {
        assert(set[role], `${THEMES[i]} has no --state colour for ${role}`);
        const gap = hueGap(set[role], android[role]);
        assert(gap <= 22, `${role}: the desktop ${THEMES[i]} hue is ${gap.toFixed(0)} degrees from the Android one - the same badge means two different things on the two ends`);
      });
      const others = Object.keys(android).filter(r => r !== role);
      for (const other of others) assert(hueGap(android[role], android[other]) > 25, `Android ${role} and ${other} are the same hue`);
    }
    return '4 roles, same hue family on desktop and Android';
  });

  it('a device row reaches the chat window in one tap, without a menu', () => {
    const adapterKt = stripCodeComments(read(ANDROID, 'java', 'com', 'safedrop', 'mobile', 'ui', 'adapter', 'DeviceAdapter.kt'));
    assert(/onChatClick:\s*\(DiscoveredDevice\)\s*->\s*Unit/.test(adapterKt), 'the device adapter no longer takes a chat callback');
    assert(/btnOpenChat\.setOnClickListener\s*\{\s*onChat/.test(adapterKt), 'the row chat button is bound to nothing');
    const at = mainKt.indexOf('deviceAdapter = DeviceAdapter(');
    assert(at > -1, 'MainActivity no longer builds the device adapter');
    const wiring = insideBrackets(mainKt, at) || '';
    assert(/onChatClick = \{ dev ->\s*openPeerChatWindow\(dev\)/.test(wiring), 'the row chat button does not open the chat window');
    assert(/onDeviceClick = \{ dev ->\s*openPeerChatWindow\(dev\)/.test(wiring), 'tapping the row itself no longer opens the chat window');
    assert(/rvPeerChips\.adapter = peerChipAdapter/.test(mainKt), 'the peer strip is never bound');
    assert(/rvChannelMessages\.adapter = channelMessageAdapter/.test(mainKt), 'the thread is never bound');
    return 'row tap and row chat button both land in the chat window';
  });

  console.log('\n====================================================');
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('====================================================\n');

  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
