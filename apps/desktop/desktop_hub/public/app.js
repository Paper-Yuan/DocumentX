/**
 * SafeDrop Hub front end.
 *
 * Visual language: "本地仪表台" - neutral surfaces, ink for interaction, colour
 * only for state. Everything machine-readable (addresses, sizes, speeds, chunk
 * counts, codes, fingerprints, timestamps) renders in mono with tabular figures.
 *
 * What this file owns: device discovery, the encrypted relay upload path, the
 * per-device conversation window, the received-file list, and settings.
 */

(function () {
  'use strict';

  /**
   * Browser-side mirror of apps/desktop/desktop_hub/crypto_protocol.js.
   *
   * Used when the desktop UI relays to a device that the hub holds no key for (a phone):
   * the UI negotiates its own session with that peer, seals the chunks with the peer's key,
   * and the hub forwards the sealed bytes untouched.
   */
  const SafeDropCrypto = (() => {
    const PROTOCOL = 'safedrop-e2e-v2';
    const NONCE_LEN = 12;
    const enc = new TextEncoder();

    let curve = 'x25519';

    function toHex(buf) {
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    function fromHex(hex) {
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
      return out;
    }

    function concat(...parts) {
      const total = parts.reduce((n, p) => n + p.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const p of parts) { out.set(p, offset); offset += p.length; }
      return out;
    }

    async function deriveSalt(sessionId) {
      return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${PROTOCOL}|salt|${sessionId}`)));
    }

    async function generateKeyPair() {
      try {
        const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
        curve = 'x25519';
        return pair;
      } catch (_) {
        const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
        curve = 'p-256';
        return pair;
      }
    }

    async function exportPublicKey(pair) {
      return new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    }

    async function importPeerPublicKey(raw) {
      return curve === 'x25519'
        ? crypto.subtle.importKey('raw', raw, { name: 'X25519' }, false, [])
        : crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    }

    async function deriveSharedSecret(pair, serverRawPub) {
      const serverKey = await importPeerPublicKey(serverRawPub);
      const algorithm = curve === 'x25519'
        ? { name: 'X25519', public: serverKey }
        : { name: 'ECDH', public: serverKey };
      return new Uint8Array(await crypto.subtle.deriveBits(algorithm, pair.privateKey, 256));
    }

    async function deriveSessionKeyBytes(sharedSecret, sessionId, pairingSecret) {
      const hkdfKey = await crypto.subtle.importKey('raw', sharedSecret, 'HKDF', false, ['deriveBits']);
      const salt = await deriveSalt(sessionId);
      const info = enc.encode(`${PROTOCOL}|key|${pairingSecret}`);
      const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, hkdfKey, 256);
      return new Uint8Array(bits);
    }

    async function hmac(keyBytes, message) {
      const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
    }

    function clientProof(keyBytes, sessionId) {
      return hmac(keyBytes, `${PROTOCOL}|verify|${sessionId}`);
    }

    function serverProof(keyBytes, sessionId) {
      return hmac(keyBytes, `${PROTOCOL}|server|${sessionId}`);
    }

    /**
     * Seal one chunk. `index`, `count` and `chunkSize` all belong in the AAD: the receiver decides
     * when the file is complete from those two headers, and anything it does not authenticate it
     * cannot trust. `chunkSize` is the sender's slice size, i.e. the stride between chunk offsets.
     */
    async function encryptChunk(keyBytes, data, taskId, index, count, chunkSize) {
      const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LEN));
      const aad = enc.encode(`${PROTOCOL}|chunk|${taskId}|${index}|${count}|${chunkSize}`);
      const sealed = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
        key,
        data
      ));
      return concat(nonce, sealed);
    }

    function available() {
      return !!(window.crypto && window.crypto.subtle);
    }

    return {
      PROTOCOL,
      toHex,
      fromHex,
      available,
      getCurve: () => curve,
      generateKeyPair,
      exportPublicKey,
      deriveSharedSecret,
      deriveSessionKeyBytes,
      clientProof,
      serverProof,
      encryptChunk
    };
  })();

  /**
   * Slice size this client uploads with. One definition, because the task's chunk count and the
   * per-chunk offset must agree with each other and with the sender that sealed the AAD.
   */
  const UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024;

  /**
   * Sessions with relay destinations, keyed by "host:port". The hub holds no key for a
   * phone, so the UI must negotiate one directly before it can send encrypted chunks.
   *
   * This Map is the only place a session lives, and it is process memory: the pairing code
   * is the shared secret that derives the key, so persisting either one (localStorage,
   * sessionStorage, anywhere on disk) would let anyone who opens this profile later finish
   * the handshake as us. A page reload therefore asks for the code again, on purpose.
   */
  const peerSessions = new Map();

  /**
   * Establish (or reuse) an encrypted session with a peer device.
   *
   * The pairing code is read off the peer's own screen, so the ask happens in an inline
   * sheet rather than window.prompt(): a prompt cannot name the device it is asking about,
   * cannot accept a pasted pairing link, and turns a rejected code into a sentence the user
   * cannot act on.
   */
  async function ensurePeerSession(dev) {
    if (!dev || !dev.ip) return null;
    const key = `${dev.ip}:${dev.port || 8899}`;
    const existing = peerSessions.get(key);
    if (existing) return existing;

    if (!SafeDropCrypto.available()) {
      showToast('当前页面无法加密：请通过 https:// 门户地址打开', 'error');
      return null;
    }

    // Several files queued at the same unpaired device should ask for the code once.
    if (pairing.pending && pairing.pending.key === key) return pairing.pending.promise;

    const promise = openPairSheet(dev);
    pairing.pending = { key, promise };
    promise.finally(() => {
      if (pairing.pending && pairing.pending.promise === promise) pairing.pending = null;
    });
    return promise;
  }

  /** Pairing sheet state. Nothing here survives a reload, by design. */
  const pairing = {
    dev: null,
    host: '',
    port: 8899,
    busy: false,
    resolve: null,
    pending: null,
    restoredFor: null
  };

  /**
   * How long to wait for a peer that may simply not be there any more. Without a ceiling a
   * device that went to sleep leaves the sheet sitting on "连接中…" until the browser gives
   * up on the TCP connect, which on Windows is tens of seconds and reads as a hang.
   */
  const PAIRING_TIMEOUT_MS = 8000;

  /**
   * The pairing handshake, split out from the sheet so the sheet stays about input and
   * errors. Returns a result object instead of throwing: every failure here has a next
   * action, and the whole point is to name it.
   */
  async function runPairingHandshake(host, port, pairingSecret) {
    const origin = `http://${host}:${port}`;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, PAIRING_TIMEOUT_MS);

    try {
      const pair = await SafeDropCrypto.generateKeyPair();
      const rawPub = await SafeDropCrypto.exportPublicKey(pair);

      const initRes = await fetch(`${origin}/api/v1/handshake/init`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_key: SafeDropCrypto.toHex(rawPub), curve: SafeDropCrypto.getCurve() })
      });
      if (!initRes.ok) return httpFailure('init', initRes.status);
      const initData = await initRes.json();

      // The version marker is hashed into the key derivation, so a peer on another version would
      // go on to fail the proof below - which reads exactly like a mistyped pairing code. Naming
      // the real cause here is the difference between a fixable error and a confusing one.
      if (initData.protocol !== SafeDropCrypto.PROTOCOL) {
        return {
          ok: false,
          message: '两端的传输协议版本不一样，连不上。',
          hint: `对方是 ${initData.protocol || '未知'}，本机是 ${SafeDropCrypto.PROTOCOL}。升级其中一端后重试。`
        };
      }

      const shared = await SafeDropCrypto.deriveSharedSecret(pair, SafeDropCrypto.fromHex(initData.server_public_key));
      const sessionKey = await SafeDropCrypto.deriveSessionKeyBytes(shared, initData.session_id, pairingSecret);

      const proof = SafeDropCrypto.toHex(await SafeDropCrypto.clientProof(sessionKey, initData.session_id));
      const verifyRes = await fetch(`${origin}/api/v1/handshake/verify`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: initData.session_id, proof })
      });
      if (!verifyRes.ok) {
        return {
          ok: false,
          message: '对方不认这个配对码。',
          hint: '最常见的原因是配对码已经换过一组。让对方重新显示配对码，或者点下面的「重新获取」。'
        };
      }

      const verifyData = await verifyRes.json();
      const expected = SafeDropCrypto.toHex(await SafeDropCrypto.serverProof(sessionKey, initData.session_id));
      if (verifyData.server_proof !== expected) {
        return {
          ok: false,
          message: '对方身份没有对上，已停止连接。',
          hint: '两端算出的会话密钥不一致。确认你们输入的是同一台设备显示的配对码，然后重试。'
        };
      }

      const session = { id: initData.session_id, key: sessionKey };
      peerSessions.set(`${host}:${port}`, session);
      return { ok: true, session };
    } catch (err) {
      if (timedOut) {
        return {
          ok: false,
          message: `等 ${PAIRING_TIMEOUT_MS / 1000} 秒，${host}:${port} 没有回应。`,
          hint: '对方可能已经休眠或退出了 SafeDrop。让它回到前台后再点一次「连接」。'
        };
      }
      // A rejected fetch is the browser refusing to reach the address at all; the raw
      // message is "Failed to fetch", which tells the user nothing.
      return {
        ok: false,
        message: `连不上 ${host}:${port}。`,
        hint: '确认这台设备开着 SafeDrop、和你在同一个网络，地址没有写错。'
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Turn an HTTP status into wording that names the next action. */
  function httpFailure(stage, status) {
    if (status === 401 || status === 403) {
      return {
        ok: false,
        message: '对方拒绝了这个请求。',
        hint: '这台设备可能已经把配对码换掉了，或者还没准备好接收。让对方重新打开配对界面再试。'
      };
    }
    if (status === 404) {
      return {
        ok: false,
        message: '这个地址上没有 SafeDrop 服务。',
        hint: '地址或端口写错了。检查上面的连接地址，或者从设备列表里重新选一台。'
      };
    }
    if (status >= 500) {
      return {
        ok: false,
        message: '对方端处理失败了。',
        hint: `对方返回了 ${status}。稍等几秒点「连接」再试；一直这样的话，让对方重启 SafeDrop。（握手 ${stage}）`
      };
    }
    return {
      ok: false,
      message: '握手没有完成。',
      hint: `对方返回了 ${status}。让对方重新显示配对码后再试一次。（握手 ${stage}）`
    };
  }

  /** Open the sheet for a device and resolve with a session, or null if the user bails. */
  function openPairSheet(dev, overrides = {}) {
    closePairSheet(null);
    pairing.dev = dev;
    pairing.host = overrides.host || dev.ip;
    pairing.port = Number(overrides.port || dev.port || 8899);

    if (dom.pairSheetTitle) dom.pairSheetTitle.textContent = getDeviceDisplayName(dev);
    if (dom.pairSheetAddr) dom.pairSheetAddr.textContent = `${pairing.host}:${pairing.port}`;
    if (dom.pairHostInput) dom.pairHostInput.value = pairing.host;
    if (dom.pairPortInput) dom.pairPortInput.value = String(pairing.port);
    if (dom.pairTechPeer) dom.pairTechPeer.textContent = `${pairing.host}:${pairing.port}`;
    if (dom.pairUriInput) dom.pairUriInput.value = '';
    setPairUriError('');
    setPairError('');
    clearPairCells();

    if (dom.pairSheetOverlay) dom.pairSheetOverlay.classList.add('open');
    focusPairCell(0);

    return new Promise(resolve => { pairing.resolve = resolve; });
  }

  function closePairSheet(value) {
    if (dom.pairSheetOverlay) dom.pairSheetOverlay.classList.remove('open');
    // Wipe the typed code even on success: it is the shared secret, and the field is
    // still in the DOM after the sheet slides away.
    clearPairCells();
    setPairError('');
    const resolve = pairing.resolve;
    pairing.resolve = null;
    pairing.dev = null;
    if (resolve) resolve(value);
  }

  function pairCellInputs() {
    return dom.pairCells ? Array.from(dom.pairCells.querySelectorAll('.pin-cell')) : [];
  }

  function readPairCode() {
    return pairCellInputs().map(i => (i.value || '').trim()).join('');
  }

  function clearPairCells() {
    pairCellInputs().forEach(i => { i.value = ''; i.classList.remove('filled'); });
    if (dom.pairCells) dom.pairCells.classList.remove('has-error');
  }

  function focusPairCell(index) {
    const cells = pairCellInputs();
    const target = cells[Math.max(0, Math.min(index, cells.length - 1))];
    if (target) { target.focus(); target.select(); }
  }

  /** Spread a digit string across the cells, starting at `from`. */
  function fillPairCells(digits, from = 0) {
    const cells = pairCellInputs();
    let i = from;
    for (const ch of digits) {
      if (i >= cells.length) break;
      if (!/\d/.test(ch)) continue;
      cells[i].value = ch;
      cells[i].classList.add('filled');
      i++;
    }
    return i;
  }

  function setPairError(message, hint) {
    if (!dom.pairError) return;
    dom.pairError.replaceChildren();
    if (!message && !hint) {
      dom.pairError.classList.remove('visible');
      if (dom.pairCells) dom.pairCells.classList.remove('has-error');
      return;
    }
    if (message) {
      const head = document.createElement('span');
      head.textContent = message;
      dom.pairError.appendChild(head);
    }
    if (hint) {
      const sub = document.createElement('span');
      sub.className = 'field-error-hint';
      sub.textContent = hint;
      dom.pairError.appendChild(sub);
    }
    dom.pairError.classList.add('visible');
    if (dom.pairCells) dom.pairCells.classList.toggle('has-error', !!message);
  }

  function setPairUriError(message) {
    if (!dom.pairUriError) return;
    dom.pairUriError.textContent = message || '';
    dom.pairUriError.classList.toggle('visible', !!message);
  }

  function setPairBusy(busy) {
    pairing.busy = busy;
    if (dom.pairConnectBtn) {
      dom.pairConnectBtn.disabled = busy;
      dom.pairConnectBtn.textContent = busy ? '连接中…' : '连接';
    }
    pairCellInputs().forEach(c => { c.disabled = busy; });
  }

  /**
   * Accept a whole pairing link. The QR the app shows encodes exactly
   * `safedrop://pair?ip=…&port=…&fp=…&token=…&pin=…`, so scanning or pasting it should
   * not cost the user three keystrokes they already had.
   */
  function applyPairUri(raw) {
    const text = String(raw || '').trim();
    if (!text) { setPairUriError('先粘贴一段链接，再点解析。'); return false; }

    const queryAt = text.indexOf('?');
    const params = new URLSearchParams(queryAt >= 0 ? text.slice(queryAt + 1) : text);
    const ip = (params.get('ip') || '').trim();
    const port = (params.get('port') || '').trim();
    const pin = (params.get('pin') || '').trim();

    if (!ip && !pin) {
      setPairUriError('这段链接里没有地址也没有配对码，换一条 safedrop:// 开头的试试。');
      return false;
    }

    setPairUriError('');
    if (ip) {
      pairing.host = ip;
      if (dom.pairHostInput) dom.pairHostInput.value = ip;
    }
    if (port && /^\d+$/.test(port)) {
      pairing.port = Number(port);
      if (dom.pairPortInput) dom.pairPortInput.value = port;
    }
    if (dom.pairTechPeer) dom.pairTechPeer.textContent = `${pairing.host}:${pairing.port}`;
    if (dom.pairSheetAddr) dom.pairSheetAddr.textContent = `${pairing.host}:${pairing.port}`;
    if (pin) {
      clearPairCells();
      const used = fillPairCells(pin, 0);
      focusPairCell(used >= 6 ? 5 : used);
      if (used >= 6) submitPairing();
    } else {
      focusPairCell(0);
    }
    return true;
  }

  /** Read the address fields, so a hand-corrected value is honoured. */
  function syncPairAddress() {
    const host = dom.pairHostInput ? dom.pairHostInput.value.trim() : pairing.host;
    const port = dom.pairPortInput ? dom.pairPortInput.value.trim() : String(pairing.port);
    if (host) pairing.host = host;
    if (/^\d+$/.test(port)) pairing.port = Number(port);
    if (dom.pairTechPeer) dom.pairTechPeer.textContent = `${pairing.host}:${pairing.port}`;
    if (dom.pairSheetAddr) dom.pairSheetAddr.textContent = `${pairing.host}:${pairing.port}`;
  }

  async function submitPairing() {
    if (!pairing.dev || pairing.busy) return;
    syncPairAddress();
    const code = readPairCode();
    if (code.length !== 6) {
      setPairError('配对码是 6 位数字，现在还差 ' + (6 - code.length) + ' 位。', '看一下对方设备屏幕上显示的配对码；也可以粘贴对方给的链接。');
      focusPairCell(code.length);
      return;
    }

    setPairBusy(true);
    setPairError('');
    const result = await runPairingHandshake(pairing.host, pairing.port, code);
    setPairBusy(false);

    if (result.ok) {
      const name = getDeviceDisplayName(pairing.dev);
      closePairSheet(result.session);
      showToast(`已与 ${name} 建立加密会话`, 'ready');
      renderDevicesGrid();
      return;
    }

    setPairError(result.message, result.hint);
    clearPairCells();
    focusPairCell(0);
  }

  function initPairSheet() {
    const cells = pairCellInputs();

    cells.forEach((input, idx) => {
      input.addEventListener('input', () => {
        const value = (input.value || '').replace(/\D/g, '');
        if (value.length > 1) {
          // Autocomplete / IME can hand us the whole code in one go.
          input.value = value[0];
          fillPairCells(value.slice(1), idx + 1);
        } else {
          input.value = value;
        }
        input.classList.toggle('filled', !!input.value);
        if (input.value && idx < cells.length - 1) {
          cells[idx + 1].focus();
          return;
        }
        if (readPairCode().length === 6) submitPairing();
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !input.value && idx > 0) {
          e.preventDefault();
          cells[idx - 1].focus();
          cells[idx - 1].value = '';
          cells[idx - 1].classList.remove('filled');
        } else if (e.key === 'ArrowLeft' && idx > 0) {
          e.preventDefault();
          cells[idx - 1].focus();
        } else if (e.key === 'ArrowRight' && idx < cells.length - 1) {
          e.preventDefault();
          cells[idx + 1].focus();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          submitPairing();
        }
      });

      input.addEventListener('paste', (e) => {
        const text = (e.clipboardData || window.clipboardData).getData('text');
        if (!text) return;
        e.preventDefault();
        if (text.indexOf('safedrop://') !== -1 || text.indexOf('pin=') !== -1) {
          applyPairUri(text);
        } else {
          clearPairCells();
          const used = fillPairCells(text.replace(/\D/g, ''), 0);
          if (used >= 6) submitPairing();
          else focusPairCell(used);
        }
      });
    });

    if (dom.pairUriApplyBtn) dom.pairUriApplyBtn.addEventListener('click', () => applyPairUri(dom.pairUriInput.value));
    if (dom.pairUriInput) {
      dom.pairUriInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); applyPairUri(dom.pairUriInput.value); }
      });
    }
    if (dom.pairHostInput) dom.pairHostInput.addEventListener('change', syncPairAddress);
    if (dom.pairPortInput) dom.pairPortInput.addEventListener('change', syncPairAddress);

    if (dom.pairConnectBtn) dom.pairConnectBtn.addEventListener('click', submitPairing);
    if (dom.pairCancelBtn) dom.pairCancelBtn.addEventListener('click', () => closePairSheet(null));
    if (dom.pairSheetClose) dom.pairSheetClose.addEventListener('click', () => closePairSheet(null));
    if (dom.pairSheetOverlay) {
      dom.pairSheetOverlay.addEventListener('click', (e) => {
        if (e.target === dom.pairSheetOverlay) closePairSheet(null);
      });
    }

    // "对方换了一组？重新获取": the hub rotates its own code whenever a device finishes
    // pairing, so the code on screen may already be a generation old. This cannot read the
    // peer's code for us - that would make it no secret at all - so it resets the sheet and
    // sends the user back to the peer's screen with a clean field.
    if (dom.pairRetryFetch) {
      dom.pairRetryFetch.addEventListener('click', () => {
        clearPairCells();
        setPairError('', '请在对方设备的屏幕上读取新的 6 位配对码。');
        focusPairCell(0);
      });
    }
  }

  /**
   * Backend origin for API calls.
   *
   * In a release Tauri build the window loads the bundled frontend from the `tauri://`
   * scheme, so a relative `/api/...` URL would resolve against that scheme and never reach
   * the Node backend. The desktop UI is always served by the backend itself when running in
   * a browser, so the relative form stays correct there and this only rewrites the cases
   * where the page is not an HTTP(S) document.
   */
  const BACKEND_ORIGIN = 'http://localhost:8899';

  function apiUrl(pathname) {
    const overHttp = location.protocol === 'http:' || location.protocol === 'https:';
    return overHttp ? pathname : `${BACKEND_ORIGIN}${pathname}`;
  }

  // Global state
  const state = {
    currentTab: 'radarTab',
    devices: [],
    tasks: [],
    info: null,
    targetDevice: null,
    isMobile: /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent),
    qrMode: 'app', // 'app' (safedrop://) or 'web' (http://)
    currentTheme: 'dark-theme',
    activeChatPeerId: null,
    peerHistories: (() => {
      try { return JSON.parse(localStorage.getItem('safedrop_chat_histories') || '{}'); } catch (_) { return {}; }
    })(),
    lastMessageTimestamp: 0,
    // When the discovery list last answered, for the "N 秒前更新" readout. The poller is
    // the refresh, so the user reads a timestamp instead of pressing a button.
    devicesUpdatedAt: 0,
    filesUpdatedAt: 0,
    // NEW: Concurrent transfer queue management
    transferQueue: [],
    activeTransfers: 0,
    maxConcurrentTransfers: 3,
    // NEW: Compression settings
    compressionEnabled: (() => {
      try { return localStorage.getItem('safedrop_compression_enabled') !== 'false'; } catch (_) { return true; }
    })(),
  };

  /**
   * What this app remembers between visits, and what it refuses to.
   *
   * Safe: the last device you picked and the panel you were on, so reopening the hub
   * puts you back where you were. Not safe: the pairing code or any session derived
   * from it - the code is the only thing separating a paired peer from anyone else on
   * this network, so writing it to disk would hand that out to whoever opens the profile.
   */
  const RECENT_DEVICE_KEY = 'safedrop_recent_device_id';
  const ACTIVE_TAB_KEY = 'safedrop_active_tab';

  function readStored(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (_) {
      return fallback;
    }
  }

  function writeStored(key, value) {
    try { localStorage.setItem(key, value); } catch (_) {}
  }

  // DOM element references
  const dom = {
    radarCanvas: document.getElementById('radarCanvas'),
    devicesGrid: document.getElementById('devicesGrid'),
    transfersList: document.getElementById('transfersList'),
    filesList: document.getElementById('filesList'),
    dropZoneCard: document.getElementById('dropZoneCard'),
    filePickerInput: document.getElementById('filePickerInput'),
    chooseFileBtn: document.getElementById('chooseFileBtn'),
    themeToggleBtn: document.getElementById('themeToggleBtn'),
    themeSegmented: document.getElementById('themeSegmented'),
    openQrModalBtn: document.getElementById('openQrModalBtn'),
    closeQrModalBtn: document.getElementById('closeQrModalBtn'),
    modalDoneBtn: document.getElementById('modalDoneBtn'),
    qrModalOverlay: document.getElementById('qrModalOverlay'),
    qrCanvas: document.getElementById('qrCanvas'),
    modalPinCode: document.getElementById('modalPinCode'),
    modalDirectUrl: document.getElementById('modalDirectUrl'),
    copyUrlBtn: document.getElementById('copyUrlBtn'),
    modalRefreshPinBtn: document.getElementById('modalRefreshPinBtn'),
    qrModeAppBtn: document.getElementById('qrModeAppBtn'),
    qrModeWebBtn: document.getElementById('qrModeWebBtn'),
    refreshPinBtn: document.getElementById('refreshPinBtn'),
    deviceListUpdatedAgo: document.getElementById('deviceListUpdatedAgo'),
    radarBlips: document.getElementById('radarBlips'),
    openDirFromFilesBtn: document.getElementById('openDirFromFilesBtn'),
    clearCompletedTasksBtn: document.getElementById('clearCompletedTasksBtn'),
    noTransfersPickBtn: document.getElementById('noTransfersPickBtn'),
    toastContainer: document.getElementById('toastContainer'),
    onlineDeviceCountTag: document.getElementById('onlineDeviceCountTag'),
    sidebarIpText: document.getElementById('sidebarIpText'),
    settingsFingerprintText: document.getElementById('settingsFingerprintText'),
    settingsPinText: document.getElementById('settingsPinText'),
    sandboxDirText: document.getElementById('sandboxDirText'),
    settingsDirDisplay: document.getElementById('settingsDirDisplay'),
    customDownloadDirInput: document.getElementById('customDownloadDirInput'),
    saveDownloadDirBtn: document.getElementById('saveDownloadDirBtn'),
    openDirBtn: document.getElementById('openDirBtn'),
    currentRoleBadge: document.getElementById('currentRoleBadge'),
    radarCenterLabel: document.getElementById('radarCenterLabel'),
    noTransfersEmpty: document.getElementById('noTransfersEmpty'),
    activeTaskCountBadge: document.getElementById('activeTaskCountBadge'),
    mobileTaskBadge: document.getElementById('mobileTaskBadge'),
    chatTab: document.getElementById('chatTab'),
    chatPeersList: document.getElementById('chatPeersList'),
    chatPeerCountBadge: document.getElementById('chatPeerCountBadge'),
    chatNoPeersHint: document.getElementById('chatNoPeersHint'),
    chatUnselectedState: document.getElementById('chatUnselectedState'),
    chatActiveState: document.getElementById('chatActiveState'),
    chatActiveAvatar: document.getElementById('chatActiveAvatar'),
    chatActiveName: document.getElementById('chatActiveName'),
    chatActiveTag: document.getElementById('chatActiveTag'),
    chatActiveMeta: document.getElementById('chatActiveMeta'),
    chatSecurityTag: document.getElementById('chatSecurityTag'),
    chatClearHistoryBtn: document.getElementById('chatClearHistoryBtn'),
    chatQuickSendBtn: document.getElementById('chatQuickSendBtn'),
    chatStreamContainer: document.getElementById('chatStreamContainer'),
    chatDropOverlay: document.getElementById('chatDropOverlay'),
    chatTimeline: document.getElementById('chatTimeline'),
    chatFileInput: document.getElementById('chatFileInput'),
    chatAttachBtn: document.getElementById('chatAttachBtn'),
    chatTextInput: document.getElementById('chatTextInput'),
    chatSendTextBtn: document.getElementById('chatSendTextBtn'),
    chatSecurityTagText: document.getElementById('chatSecurityTagText'),
    // Pairing sheet (replaces window.prompt)
    pairSheetOverlay: document.getElementById('pairSheetOverlay'),
    pairSheetTitle: document.getElementById('pairSheetTitle'),
    pairSheetAddr: document.getElementById('pairSheetAddr'),
    pairSheetClose: document.getElementById('pairSheetClose'),
    pairCells: document.getElementById('pairPinCells'),
    pairError: document.getElementById('pairError'),
    pairUriDetails: document.getElementById('pairUriDetails'),
    pairUriInput: document.getElementById('pairUriInput'),
    pairUriApplyBtn: document.getElementById('pairUriApplyBtn'),
    pairUriError: document.getElementById('pairUriError'),
    pairHostInput: document.getElementById('pairHostInput'),
    pairPortInput: document.getElementById('pairPortInput'),
    pairTechPeer: document.getElementById('pairTechPeer'),
    pairConnectBtn: document.getElementById('pairConnectBtn'),
    pairCancelBtn: document.getElementById('pairCancelBtn'),
    pairRetryFetch: document.getElementById('pairRetryFetch'),
  };

  // 1. Initialization
  async function init() {
    initTheme();
    initNavigation();
    initDragAndDrop();
    initModalEvents();
    initPairSheet();
    initSettingsEvents();
    initChatEvents();
    initShortcuts();
    restoreLastPanel();
    loadDeviceNamesManager(); // NEW: Load device names manager on init

    if (state.isMobile) {
      if (dom.currentRoleBadge) dom.currentRoleBadge.textContent = '移动便携端';
      if (dom.radarCenterLabel) dom.radarCenterLabel.textContent = '这台电脑';
    }

    await fetchSystemInfo();
    await fetchDevices();
    await fetchFiles();

    renderChatPeersList();
    renderChatConversation();

    // Periodic device polling (every 4 seconds)
    setInterval(fetchDevices, 4000);
    // Periodic file vault query
    setInterval(fetchFiles, 6000);
    // Periodic messages query (every 1.2 seconds for real-time chat)
    setInterval(fetchMessages, 1200);
    // The "N 秒前更新" readouts tick on their own, so they stay honest between polls.
    setInterval(updatePollStamps, 1000);
    // Periodic system info refresh. The hub rotates the pairing PIN every time a device
    // completes the handshake, so a value fetched once at startup goes stale after the first
    // successful pairing and every later device that reads the on-screen PIN or scans the
    // displayed QR code is rejected with "Pairing proof verification failed". Polling keeps
    // the shown PIN, QR payload and portal link in step with what the hub will actually
    // accept. Off the mobile role, where this page is the target rather than the initiator.
    if (!state.isMobile) {
      setInterval(fetchSystemInfo, 3000);
    }

    // Mobile device heartbeat announcement
    if (state.isMobile) {
      announceMobileDevice();
    }
  }

  /**
   * Bridge for global-shortcuts.js, which runs outside this closure and is loaded by the
   * Tauri shell. Without these the shortcut handlers in that file fall back to clicking
   * ids that do not exist in this page.
   */
  function initShortcuts() {
    window.SafeDropUI = {
      refreshDevices: () => fetchDevices(),
      pickFiles: () => dom.filePickerInput && dom.filePickerInput.click(),
      openPairingFor: (deviceId) => {
        const dev = state.devices.find(d => d.id === deviceId);
        if (dev) openPairSheet(dev);
      },
      switchTab,
      hasSessionFor: (deviceId) => {
        const dev = state.devices.find(d => d.id === deviceId);
        return dev ? peerSessions.has(`${dev.ip}:${dev.port || 8899}`) : false;
      }
    };
  }

  // 2. Theme management (Dark / Eye-Care / Light three-state switcher)
  function initTheme() {
    const savedTheme = localStorage.getItem('safedrop_theme') || 'dark-theme';
    applyTheme(savedTheme, true);

    // Segmented button click
    if (dom.themeSegmented) {
      dom.themeSegmented.querySelectorAll('.theme-seg-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const t = btn.getAttribute('data-theme');
          applyTheme(t);
        });
      });
    }

    // Mobile/compact screen toggle
    if (dom.themeToggleBtn) {
      dom.themeToggleBtn.addEventListener('click', () => {
        const themes = ['dark-theme', 'eyecare-theme', 'light-theme'];
        const currentIdx = themes.indexOf(state.currentTheme);
        const nextIdx = (currentIdx + 1) % themes.length;
        applyTheme(themes[nextIdx]);
      });
    }

    // Window resize / layout shift listener to keep glider aligned
    window.addEventListener('resize', () => {
      updateGliderPosition();
    });
    window.addEventListener('load', () => {
      updateGliderPosition();
    });
    setTimeout(updateGliderPosition, 50);
    setTimeout(updateGliderPosition, 250);
  }

  function updateGliderPosition() {
    if (!dom.themeSegmented) return;
    const glider = dom.themeSegmented.querySelector('.theme-seg-glider');
    const activeBtn = dom.themeSegmented.querySelector('.theme-seg-btn.active');
    if (glider && activeBtn) {
      const left = activeBtn.offsetLeft;
      const width = activeBtn.offsetWidth;
      glider.style.transform = `translateX(${left}px)`;
      glider.style.width = `${width}px`;
      glider.style.opacity = '1';
    }
  }

  function applyTheme(themeName, isInit = false) {
    if (!isInit && state.currentTheme === themeName && document.body.classList.contains(themeName)) {
      updateGliderPosition();
      return;
    }

    state.currentTheme = themeName;
    localStorage.setItem('safedrop_theme', themeName);

    const updateDOM = () => {
      document.body.className = themeName;

      // Update segmented button active state
      if (dom.themeSegmented) {
        dom.themeSegmented.querySelectorAll('.theme-seg-btn').forEach(btn => {
          btn.classList.toggle('active', btn.getAttribute('data-theme') === themeName);
        });
        updateGliderPosition();
      }

      // Update browser theme-color meta tag
      const metaThemeColor = document.querySelector('meta[name="theme-color"]');
      if (metaThemeColor) {
        if (themeName === 'eyecare-theme') {
          metaThemeColor.setAttribute('content', '#EDE4D0');
        } else if (themeName === 'light-theme') {
          metaThemeColor.setAttribute('content', '#F1F4F9');
        } else {
          metaThemeColor.setAttribute('content', '#0F0F12');
        }
      }
    };

    // Use native View Transition API for silky smooth cross-fade animation
    if (!isInit && typeof document.startViewTransition === 'function') {
      document.startViewTransition(() => {
        updateDOM();
      });
    } else {
      updateDOM();
    }
  }

  // 3. Navigation and tab switching (Desktop sidebar + mobile bottom nav)
  function initNavigation() {
    const navButtons = document.querySelectorAll('.nav-item, .bottom-nav-item');
    navButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        switchTab(btn.getAttribute('data-tab'));
      });
    });

    // Escape closes the topmost layer. Nothing else in this app is modal, so there is
    // no stack to unwind.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (dom.pairSheetOverlay && dom.pairSheetOverlay.classList.contains('open')) {
        closePairSheet(null);
      } else if (dom.qrModalOverlay && dom.qrModalOverlay.classList.contains('open')) {
        dom.qrModalOverlay.classList.remove('open');
      }
    });
  }

  function switchTab(tabId) {
    if (!tabId) return;
    state.currentTab = tabId;
    writeStored(ACTIVE_TAB_KEY, tabId);

    // Switch active tab pane
    document.querySelectorAll('.tab-pane').forEach(pane => {
      pane.classList.toggle('active', pane.id === tabId);
    });

    // Switch active nav item
    document.querySelectorAll('.nav-item, .bottom-nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
    });
  }

  /** Restore the panel the user was on, if it still exists in this build. */
  function restoreLastPanel() {
    const saved = readStored(ACTIVE_TAB_KEY, 'radarTab');
    if (document.getElementById(saved)) switchTab(saved);
  }

  // 4. Fetch server system info
  async function fetchSystemInfo() {
    try {
      const res = await fetch(apiUrl('/api/v1/info'));
      const data = await res.json();
      // Redrawing the QR canvas is only needed when the payload it encodes changed;
      // this runs on a timer, so skip the work otherwise.
      const qrChanged = !state.info || state.info.qrUri !== data.qrUri || state.info.webUrl !== data.webUrl;
      state.info = data;

      if (dom.sidebarIpText) dom.sidebarIpText.textContent = `${data.localIp}:${data.port}`;
      const localIpBadge = document.getElementById('hubLocalIpBadge');
      if (localIpBadge) localIpBadge.textContent = `${data.localIp}:${data.port}`;
      if (dom.radarCenterLabel && !state.isMobile) {
        dom.radarCenterLabel.textContent = data.host?.name || '这台电脑';
      }
      if (dom.settingsFingerprintText) dom.settingsFingerprintText.textContent = data.fingerprint;
      if (dom.settingsPinText) dom.settingsPinText.textContent = data.pin;
      if (dom.modalPinCode) dom.modalPinCode.textContent = data.pin;
      if (dom.modalDirectUrl) dom.modalDirectUrl.textContent = data.webUrl;
      if (dom.sandboxDirText) dom.sandboxDirText.textContent = data.downloadDir;
      if (dom.settingsDirDisplay) dom.settingsDirDisplay.textContent = data.downloadDir;
      if (dom.customDownloadDirInput && !dom.customDownloadDirInput.value) {
        dom.customDownloadDirInput.value = data.downloadDir;
      }
      markActivePreset();

      // Render pairing QR code
      if (qrChanged) renderQrCode();
    } catch (e) {
      console.warn('Fetch info failed:', e);
    }
  }

  // 4.1 Refresh dynamic pairing PIN
  async function refreshPin() {
    try {
      const res = await fetch(apiUrl('/api/v1/pin/refresh'), { method: 'POST' });
      const data = await res.json();
      if (state.info) {
        state.info.localIp = data.localIp || state.info.localIp;
        state.info.pin = data.pin;
        state.info.token = data.token;
        state.info.qrUri = data.qrUri;
        state.info.webUrl = data.webUrl;
      }
      if (dom.modalDirectUrl) dom.modalDirectUrl.textContent = state.info.webUrl;
      if (dom.settingsPinText) dom.settingsPinText.textContent = data.pin;
      if (dom.modalPinCode) dom.modalPinCode.textContent = data.pin;
      renderQrCode();
      showToast(`已换一组配对码：${data.pin}`, 'attention');
    } catch (e) {
      await fetchSystemInfo();
      showToast('已重新获取配对码', 'attention');
    }
  }

  // 5. Mobile self-announcement
  async function announceMobileDevice() {
    try {
      await fetch(apiUrl('/api/v1/devices/announce'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: /Android/i.test(navigator.userAgent) ? 'Android 便携手机' : 'iPhone 便携设备',
          os: /Android/i.test(navigator.userAgent) ? 'android' : 'ios',
          port: 8899,
          fingerprint: 'MOBILE-FP-' + Math.random().toString(36).substring(2, 6).toUpperCase()
        })
      });
    } catch (_) {}
  }

  // Helper function to get device display name with priority: customName > name > IP
  function getDeviceDisplayName(device) {
    if (device.customName) return device.customName;
    if (device.name) return device.name;
    return `设备 (${device.ip})`;
  }

  // 6. Device topology discovery and smart merging
  async function fetchDevices() {
    try {
      const res = await fetch(apiUrl('/api/v1/devices'));
      const data = await res.json();
      const rawDevices = data.devices || [];

      // Smart merging: ensure previous and current connection records of the same physical device are merged
      const mergedMap = new Map();
      for (const dev of rawDevices) {
        if (!dev || !dev.ip) continue;
        const ip = String(dev.ip).replace(/^.*:/, '').trim();
        if (dev.isHost || ip === '127.0.0.1' || ip === state.info?.localIp) continue;

        const key = dev.id || `ip_${ip}_${dev.port || 8899}`;

        if (mergedMap.has(key)) {
          // Merge directly
          const existing = mergedMap.get(key);
          const isGeneric = (n) => !n || n.startsWith('Remote Client') || n.startsWith('Device (') || n.startsWith('局域网设备');
          if (dev.name && (isGeneric(existing.name) || dev.name.length > existing.name.length)) {
            existing.name = dev.name;
          }
          if (dev.port) existing.port = dev.port;
          if (dev.os && dev.os !== 'unknown') existing.os = dev.os;
          existing.lastSeen = Math.max(existing.lastSeen || 0, dev.lastSeen || 0);
        } else {
          mergedMap.set(key, { ...dev, ip: ip });
        }
      }

      state.devices = Array.from(mergedMap.values());

      // Reopen where you left off. The device you last sent to is selected again if it is
      // still on the network; its session is not restored, because a session key cannot be
      // stored without storing the pairing code it came from.
      if (!state.targetDevice) {
        const rememberedId = readStored(RECENT_DEVICE_KEY, '');
        if (rememberedId) {
          const remembered = state.devices.find(d => d.id === rememberedId);
          if (remembered) state.targetDevice = remembered;
        }
      }

      // If a target device was previously selected, verify it's still online or merge reference
      if (state.targetDevice) {
        const stillOnline = state.devices.find(d =>
          d.id === state.targetDevice.id ||
          d.ip === state.targetDevice.ip ||
          (d.fingerprint && state.targetDevice.fingerprint && d.fingerprint === state.targetDevice.fingerprint)
        );
        if (stillOnline) {
          state.targetDevice = stillOnline; // Seamlessly keep up-to-date
        } else {
          state.targetDevice = null; // Stale device has disconnected, do not retain!
        }
      }

      state.devicesUpdatedAt = Date.now();
      updatePollStamps();

      if (dom.onlineDeviceCountTag) {
        dom.onlineDeviceCountTag.textContent = `${state.devices.length} 台在线`;
      }

      const statusText = document.getElementById('discoveryStatusText');
      if (statusText) {
        statusText.textContent = state.devices.length === 0
          ? '正在查找同一网络里的设备…'
          : `已找到 ${state.devices.length} 台，仍在持续查找`;
      }

      renderDevicesGrid();
      renderChatPeersList();
      offerPairingForRememberedDevice();
    } catch (_) {}
  }

  /**
   * One nudge per page load: if the device you came back for is reachable but the session
   * is gone, put the pairing sheet up prefilled for it rather than leaving you to discover
   * which button asks. Cancelling is remembered too - it will not reopen itself.
   */
  function offerPairingForRememberedDevice() {
    const dev = state.targetDevice;
    if (!dev || !dev.ip || pairing.restoredFor) return;
    if (peerSessions.has(`${dev.ip}:${dev.port || 8899}`)) return;
    if (dom.pairSheetOverlay && dom.pairSheetOverlay.classList.contains('open')) return;
    pairing.restoredFor = dev.id;
    openPairSheet(dev);
  }

  /** The poller is the refresh button, so report when it last spoke. */
  function updatePollStamps() {
    if (dom.deviceListUpdatedAgo) dom.deviceListUpdatedAgo.textContent = agoText(state.devicesUpdatedAt);
  }

  function agoText(timestamp) {
    if (!timestamp) return '等待第一次搜索';
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 2) return '刚刚更新';
    if (seconds < 60) return `${seconds} 秒前更新`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes} 分钟前更新`;
  }

  /**
   * Plot discovered peers on the dial. The bearing is the address (a stable hash, so a
   * device does not jump between polls) and the radius is how long ago it last answered,
   * which is the one thing the dial can honestly encode.
   */
  function renderRadarBlips() {
    if (!dom.radarBlips) return;
    dom.radarBlips.replaceChildren();
    if (state.devices.length === 0) return;

    const box = 148;
    const centre = box / 2;
    state.devices.forEach(dev => {
      let hash = 0;
      for (let i = 0; i < dev.ip.length; i++) hash = (hash * 31 + dev.ip.charCodeAt(i)) % 360;
      const ageSeconds = state.devicesUpdatedAt ? (Date.now() - state.devicesUpdatedAt) / 1000 : 0;
      const ratio = Math.min(0.86, 0.34 + Math.min(ageSeconds, 12) / 12 * 0.5);
      const radius = centre * ratio;
      const dot = document.createElement('span');
      dot.className = 'radar-blip';
      const isSelected = state.targetDevice && state.targetDevice.ip === dev.ip;
      if (isSelected) dot.className += ' selected';
      dot.style.left = `${(centre + Math.cos(hash * Math.PI / 180) * radius).toFixed(1)}px`;
      dot.style.top = `${(centre + Math.sin(hash * Math.PI / 180) * radius).toFixed(1)}px`;
      dot.title = getDeviceDisplayName(dev);
      dom.radarBlips.appendChild(dot);
    });
  }

  function renderDevicesGrid() {
    if (!dom.devicesGrid) return;

    renderRadarBlips();

    const hintText = document.getElementById('radarHintText');
    if (hintText) {
      hintText.textContent = state.devices.length === 0
        ? '把另一台设备连到同一个 Wi-Fi，或在它上面打开配对码，它就会出现在这里。'
        : '点一台设备选中它，然后选文件；没选设备时文件存到本机。';
    }

    if (state.devices.length === 0) {
      dom.devicesGrid.innerHTML = `
        <div class="empty-state" style="grid-column: 1/-1;">
          <p>还没有别的设备出现</p>
          <span>把另一台设备连到同一个 Wi-Fi，或在它上面打开配对码。设备互相找不到时，用右上角的配对码扫码直连。</span>
          <button class="btn btn-secondary btn-sm" data-action="show-my-code">显示我的配对码</button>
        </div>
      `;
      const codeBtn = dom.devicesGrid.querySelector('[data-action="show-my-code"]');
      if (codeBtn) codeBtn.addEventListener('click', () => {
        if (dom.qrModalOverlay) {
          dom.qrModalOverlay.classList.add('open');
          renderQrCode();
        }
      });
      return;
    }

    dom.devicesGrid.innerHTML = state.devices.map(dev => {
      const isPc = dev.os === 'windows' || dev.isHost;
      const isSelectedTarget = state.targetDevice && (state.targetDevice.ip === dev.ip || state.targetDevice.id === dev.id);
      const platformName = isPc ? '电脑端' : '手机端';
      const paired = peerSessions.has(`${dev.ip}:${dev.port || 8899}`);
      // The card only renders devices the hub saw in the last few seconds, so a second
      // "在线" chip would restate the green dot and steal the room the name needs.
      const fpShort = dev.fingerprint ? String(dev.fingerprint).slice(0, 8) : 'LAN';

      return `
        <div class="device-card ${isSelectedTarget ? 'selected-target' : ''}" data-device-id="${escapeHtml(dev.id)}">
          <div class="device-left">
            <div class="device-avatar-wrap">
              <div class="device-avatar ${isPc ? 'pc' : ''}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  ${isPc ? `
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                    <line x1="8" y1="21" x2="16" y2="21"></line>
                    <line x1="12" y1="17" x2="12" y2="21"></line>
                  ` : `
                    <rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect>
                    <line x1="12" y1="18" x2="12.01" y2="18"></line>
                  `}
                </svg>
              </div>
              <span class="avatar-status-dot online" title="在线"></span>
            </div>
            <div class="device-info">
              <div class="device-name-row">
                <span class="device-name" title="${escapeHtml(getDeviceDisplayName(dev))}">${escapeHtml(getDeviceDisplayName(dev))}</span>
                <span class="device-platform-tag ${isPc ? 'pc' : 'mobile'}">${platformName}</span>
              </div>
              <div class="device-meta-row">
                <span class="device-meta-chip ip-chip" title="地址与端口">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
                  ${escapeHtml(dev.ip)}:${escapeHtml(dev.port)}
                </span>
                <span class="device-meta-chip fp-chip" title="设备指纹：${escapeHtml(dev.fingerprint || '')}">${escapeHtml(fpShort)}</span>
              </div>
            </div>
          </div>
          <div class="device-actions-group">
            <button class="btn btn-ghost open-chat-btn" data-device-id="${escapeHtml(dev.id)}" title="和这台设备开会话窗口">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              </svg>
              <span>会话</span>
            </button>
            <button class="btn btn-secondary send-to-device-btn ${isSelectedTarget ? 'is-selected' : ''} ${paired ? '' : 'needs-pairing'}" data-device-id="${escapeHtml(dev.id)}">
              <span>${paired ? (isSelectedTarget ? '发送到这台' : '发送') : '配对并发送'}</span>
            </button>
          </div>
        </div>
      `;
    }).join('');

    // Bind open-chat buttons
    document.querySelectorAll('.open-chat-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openChatForDevice(btn.getAttribute('data-device-id'));
      });
    });

    // Bind send-to-device buttons
    document.querySelectorAll('.send-to-device-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        selectDevice(btn.getAttribute('data-device-id'));
        dom.filePickerInput.click();
      });
    });

    // Selecting device when card is clicked
    document.querySelectorAll('.device-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.send-to-device-btn') || e.target.closest('.open-chat-btn')) return;
        selectDevice(card.getAttribute('data-device-id'));
      });
    });
  }

  /**
   * Pick the device files go to. Selection is shown by the card itself, so this does not
   * also raise a toast - the two would say the same thing and one of them is noise.
   */
  function selectDevice(devId) {
    const dev = state.devices.find(d => d.id === devId);
    if (!dev) return;
    state.targetDevice = dev;
    writeStored(RECENT_DEVICE_KEY, dev.id);
    renderDevicesGrid();
  }

  // 4. (removed) The radar used to run a canvas animation loop; the dial is CSS and the
  // blips are drawn by renderRadarBlips() from the same data the list uses.

  // 8. Drag and drop file picker
  function initDragAndDrop() {
    const dropZone = dom.dropZoneCard;
    const fileInput = dom.filePickerInput;

    // Click to choose file
    dom.chooseFileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });

    dropZone.addEventListener('click', () => {
      fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files.length > 0) {
        handleFilesSelected(Array.from(e.target.files));
        fileInput.value = '';
      }
    });

    // Drag and drop event listeners
    ['dragenter', 'dragover'].forEach(eventName => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('drag-over');
      }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
      dropZone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('drag-over');
      }, false);
    });

    dropZone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (dt && dt.files && dt.files.length > 0) {
        handleFilesSelected(Array.from(dt.files));
      }
    });
  }

  // 9. Handle selected files and start concurrent transfer queue
  function handleFilesSelected(files) {
    if (files.length === 0) return;

    files.forEach(file => {
      enqueueTransferTask(file);
    });

    switchTab('transfersTab');
    if (state.targetDevice) {
      showToast(`已排进 ${files.length} 个任务，发给 ${getDeviceDisplayName(state.targetDevice)}`, 'progress');
    } else {
      showToast(`已排进 ${files.length} 个任务，保存到本机`, 'progress');
    }
    processTransferQueue();
  }

  // NEW: Enqueue file transfer task
  function enqueueTransferTask(file, specificTargetDev = null) {
    const targetDev = specificTargetDev || state.targetDevice;
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    const taskObj = {
      id: taskId,
      file: file,
      fileName: file.name,
      fileSize: file.size,
      totalChunks: Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_SIZE)),
      currentChunk: 0,
      bytesUploaded: 0,
      status: 'queued', // queued | transferring | done | failed | cancelled
      speed: '等待中',
      eta: '',
      error: '',
      nextAction: '',
      targetName: targetDev ? getDeviceDisplayName(targetDev) : '本机接收目录',
      targetDev: targetDev,
      isOutgoing: !!targetDev,
      startTime: null,
      queuePosition: state.transferQueue.length + 1
    };

    state.tasks.unshift(taskObj);
    state.transferQueue.push(taskObj);
    renderTransfersList();
    updateTaskBadges();
  }

  // NEW: Process transfer queue with max concurrent limit
  async function processTransferQueue() {
    while (state.transferQueue.length > 0 && state.activeTransfers < state.maxConcurrentTransfers) {
      const taskObj = state.transferQueue.shift();
      if (taskObj && taskObj.status === 'queued') {
        state.activeTransfers++;
        taskObj.status = 'transferring';
        taskObj.startTime = Date.now();
        taskObj.speed = '0 KB/s';
        renderTransfersList();
        updateTaskBadges();
        
        // Execute transfer asynchronously without blocking queue
        executeChunkedUpload(taskObj).finally(() => {
          state.activeTransfers--;
          processTransferQueue(); // Process next in queue
        });
      }
    }
  }

  // NEW: Check if file should be compressed based on extension
  function shouldCompressFile(fileName, fileSize) {
    if (!state.compressionEnabled) return false;
    if (fileSize < 1024 * 1024) return false; // Skip files < 1MB
    
    const ext = fileName.toLowerCase().split('.').pop();
    const compressibleExts = [
      'txt', 'log', 'json', 'xml', 'md', 'js', 'jsx', 'ts', 'tsx',
      'css', 'scss', 'sass', 'html', 'htm', 'csv', 'sql', 'sh',
      'yaml', 'yml', 'toml', 'ini', 'conf', 'config', 'py', 'java',
      'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'rb', 'php', 'vue', 'svelte'
    ];
    
    return compressibleExts.includes(ext);
  }

  // NEW: Execute chunked upload with compression support
  async function executeChunkedUpload(taskObj) {
    const file = taskObj.file;
    const targetDev = taskObj.targetDev;
    const totalChunks = taskObj.totalChunks;
    const taskId = taskObj.id;
    const useCompression = shouldCompressFile(file.name, file.size);

    if (useCompression) {
      taskObj.compressionEnabled = true;
      taskObj.originalSize = file.size;
    }

    // Link file transfer into peer chat timeline if targetDev exists. A retry reuses the
    // card that is already in the history instead of stacking a second copy of the same file.
    let chatFileItem = taskObj.chatItem || null;
    if (targetDev && targetDev.id) {
      if (!chatFileItem) {
        chatFileItem = {
          id: taskId,
          type: 'file',
          direction: 'outgoing',
          fileName: file.name,
          fileSize: file.size,
          status: 'transferring',
          progress: 0,
          speed: '0 KB/s',
          timestamp: Date.now()
        };
        if (!state.peerHistories[targetDev.id]) state.peerHistories[targetDev.id] = [];
        state.peerHistories[targetDev.id].push(chatFileItem);
      } else {
        chatFileItem.status = 'transferring';
        chatFileItem.progress = 0;
        chatFileItem.speed = '0 KB/s';
      }
      taskObj.chatItem = chatFileItem;
      saveChatHistories();
      if (state.activeChatPeerId === targetDev.id) {
        renderChatConversation();
      }
      renderChatPeersList();
    }

    let lastBytes = 0;
    let lastTime = Date.now();

    // When relaying to a peer the hub has no key for, negotiate a session with that peer up
    // front so every chunk can be sealed with a key the receiver actually holds.
    let targetSession = null;
    if (targetDev && targetDev.ip) {
      taskObj.speed = '等待配对码';
      renderTransfersList();
      targetSession = await ensurePeerSession(targetDev);
      if (!targetSession) {
        failTask(taskObj, '还没有和这台设备配对，内容没法加密发送。', '输入对方屏幕上显示的配对码，然后点重试。');
        return;
      }
    }

    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      if (taskObj.status === 'cancelled') break;

      const start = chunkIdx * UPLOAD_CHUNK_SIZE;
      const end = Math.min(file.size, start + UPLOAD_CHUNK_SIZE);
      const chunkBlob = file.slice(start, end);

      try {
        const headers = {
          'Content-Type': 'application/octet-stream',
          'x-task-id': taskId,
          'x-file-name': encodeURIComponent(file.name),
          'x-file-size': file.size.toString(),
          'x-chunk-index': chunkIdx.toString(),
          'x-chunk-count': totalChunks.toString(),
          'x-chunk-size': UPLOAD_CHUNK_SIZE.toString()
        };

        // NEW: Add compression flag to headers
        if (useCompression) {
          headers['x-compressed'] = 'gzip';
          headers['x-original-size'] = file.size.toString();
        }

        if (targetDev && targetDev.ip) {
          headers['x-target-ip'] = targetDev.ip;
          headers['x-target-port'] = (targetDev.port || 8899).toString();
          headers['x-target-name'] = encodeURIComponent(targetDev.name || 'Mobile');
          // The hub has no key for a phone, so relayed chunks must be sealed with a key the
          // phone itself holds. Without a session the phone will (correctly) refuse the chunk.
          if (!targetSession) {
            throw new Error('尚未与目标设备建立加密会话');
          }
          headers['x-target-session-id'] = targetSession.id;
        }

        // NEW: Compress chunk if enabled (client-side using CompressionStream API)
        let bodyToSend = chunkBlob;
        if (useCompression && typeof CompressionStream !== 'undefined') {
          try {
            const stream = chunkBlob.stream().pipeThrough(new CompressionStream('gzip'));
            bodyToSend = await new Response(stream).blob();
          } catch (compressionErr) {
            console.warn('Compression failed, sending uncompressed:', compressionErr);
            headers['x-compressed'] = 'none';
          }
        }

        // Seal the chunk when the destination is a relay peer: whichever key the receiver
        // holds must be the one used here.
        if (targetSession) {
          bodyToSend = await SafeDropCrypto.encryptChunk(
            targetSession.key,
            new Uint8Array(await bodyToSend.arrayBuffer()),
            taskId,
            chunkIdx,
            totalChunks,
            UPLOAD_CHUNK_SIZE
          );
          headers['x-encrypted'] = '1';
        }

        const res = await fetch(apiUrl('/api/v1/transfer/upload'), {
          method: 'POST',
          headers: headers,
          body: bodyToSend
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.error || `HTTP ${res.status}`);
        }

        taskObj.currentChunk = chunkIdx + 1;
        taskObj.bytesUploaded = end;

        const now = Date.now();
        const deltaSec = (now - lastTime) / 1000;
        if (deltaSec >= 0.5 || chunkIdx === totalChunks - 1) {
          const deltaBytes = taskObj.bytesUploaded - lastBytes;
          const speedBytesPerSec = deltaBytes / Math.max(0.1, deltaSec);
          taskObj.speed = formatSpeed(speedBytesPerSec);
          
          const remainingBytes = file.size - taskObj.bytesUploaded;
          taskObj.eta = formatETA(remainingBytes, speedBytesPerSec);
          
          lastBytes = taskObj.bytesUploaded;
          lastTime = now;
          renderTransfersList();

          // Live update progress in peer chat window if open
          if (chatFileItem) {
            chatFileItem.progress = file.size === 0 ? 100 : Math.min(100, Math.round((taskObj.bytesUploaded / file.size) * 100));
            chatFileItem.speed = taskObj.speed;
            if (state.activeChatPeerId === targetDev.id && dom.chatTimeline) {
              const activeCard = dom.chatTimeline.querySelector(`[data-task-id="${taskId}"]`);
              if (activeCard) {
                const fill = activeCard.querySelector('.chat-file-progress-fill');
                const tag = activeCard.querySelector('.chat-file-status-tag');
                const sp = activeCard.querySelector('.chat-file-footer span');
                if (fill) fill.style.width = `${chatFileItem.progress}%`;
                if (tag) tag.textContent = `${chatFileItem.progress}%`;
                if (sp) sp.textContent = chatFileItem.speed;
              }
            }
          }
        }
      } catch (err) {
        console.error(err);
        failTask(taskObj, uploadFailureText(err), '文件还在原来的位置，没有改动。点重试会从头再传一次。');
        return;
      }
    }

    if (taskObj.status === 'cancelled') {
      taskObj.speed = '已取消';
      syncChatTask(taskObj, 'cancelled', '已取消');
      renderTransfersList();
      updateTaskBadges();
      return;
    }

    taskObj.status = 'done';
    taskObj.speed = '传输完成';
    taskObj.error = '';
    taskObj.nextAction = '';
    renderTransfersList();
    updateTaskBadges();
    syncChatTask(taskObj, 'done', '已保存');
    renderChatPeersList();

    if (targetDev) {
      showToast(`已把「${file.name}」送到 ${getDeviceDisplayName(targetDev)}`, 'ready');
    } else {
      showToast(`已保存「${file.name}」`, 'ready');
      fetchFiles();
    }
  }

  /** Plain wording for the reasons an upload can stop mid-flight. */
  function uploadFailureText(err) {
    const raw = String((err && err.message) || err || '');
    if (raw.indexOf('Failed to fetch') !== -1) return '和本机的传输服务断开了。';
    if (raw.indexOf('尚未与目标设备建立加密会话') !== -1) return '这台设备还没有配对。';
    if (raw.indexOf('HTTP') !== -1) return `对方没有收下这个分块（${raw}）。`;
    return raw ? `传输没有完成：${raw}` : '传输没有完成。';
  }

  /**
   * A failed task is not a dead end: it keeps its File handle, so the row can offer a real
   * retry instead of sending the user back to the file picker.
   */
  function failTask(taskObj, message, nextAction) {
    taskObj.status = 'failed';
    taskObj.speed = '已中断';
    taskObj.error = message;
    taskObj.nextAction = nextAction;
    renderTransfersList();
    updateTaskBadges();
    syncChatTask(taskObj, 'failed', '已中断');
    showToast(`「${taskObj.fileName}」没有传完`, 'error');
  }

  function syncChatTask(taskObj, status, speed) {
    const item = taskObj.chatItem;
    if (!item) return;
    item.status = status;
    item.speed = speed;
    if (status === 'done') item.progress = 100;
    saveChatHistories();
    if (state.activeChatPeerId === (taskObj.targetDev && taskObj.targetDev.id)) {
      renderChatConversation();
    }
  }

  function retryTask(taskId) {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;

    if (task.targetDev && !state.devices.some(d => d.id === task.targetDev.id)) {
      task.error = '对方已经不在这个网络里了。';
      task.nextAction = '等它重新出现，或者选一台在线的设备再传。';
      renderTransfersList();
      return;
    }

    task.status = 'queued';
    task.speed = '等待中';
    task.error = '';
    task.nextAction = '';
    task.bytesUploaded = 0;
    task.currentChunk = 0;
    task.eta = '';
    task.queuePosition = state.transferQueue.length + 1;
    if (task.chatItem) {
      task.chatItem.status = 'transferring';
      task.chatItem.progress = 0;
      task.chatItem.speed = '0 KB/s';
    }
    state.transferQueue.push(task);
    renderTransfersList();
    updateTaskBadges();
    processTransferQueue();
  }

  function cancelTask(taskId) {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task) return;
    if (task.status === 'queued') {
      state.transferQueue = state.transferQueue.filter(t => t.id !== taskId);
      task.speed = '已取消';
      syncChatTask(task, 'cancelled', '已取消');
    }
    // A transfer already in flight is flagged and stops before its next chunk; letting the
    // current request finish keeps the peer from holding a partial file it never agreed to.
    task.status = 'cancelled';
    renderTransfersList();
    updateTaskBadges();
  }

  // Legacy function for chat file transfers - now uses queue system
  async function startChunkedUploadTask(file, specificTargetDev = null) {
    enqueueTransferTask(file, specificTargetDev);
    processTransferQueue();
  }

  function renderTransfersList() {
    if (!dom.transfersList) return;

    if (state.tasks.length === 0) {
      dom.transfersList.innerHTML = '';
      if (dom.noTransfersEmpty) dom.noTransfersEmpty.style.display = 'flex';
      return;
    }

    if (dom.noTransfersEmpty) dom.noTransfersEmpty.style.display = 'none';
    dom.transfersList.innerHTML = state.tasks.map(t => {
      const pct = t.fileSize === 0 ? 100 : Math.min(100, Math.round((t.bytesUploaded / t.fileSize) * 100));
      const isDone = t.status === 'done';
      const isFailed = t.status === 'failed';
      const isCancelled = t.status === 'cancelled';
      const isQueued = t.status === 'queued';
      const isTransferring = t.status === 'transferring';

      let statusBadgeText = '';
      let statusClass = 'status-transferring';
      if (isDone) { statusBadgeText = '已完成'; statusClass = 'status-done'; }
      else if (isFailed) { statusBadgeText = '失败'; statusClass = 'status-failed'; }
      else if (isCancelled) { statusBadgeText = '已取消'; statusClass = 'status-queued'; }
      else if (isQueued) {
        const position = state.transferQueue.findIndex(task => task.id === t.id);
        statusBadgeText = position >= 0 ? `排队 ${position + 1}` : '排队中';
        statusClass = 'status-queued';
      } else { statusBadgeText = `${pct}%`; }

      const fillState = isDone ? 'is-done' : ((isFailed || isCancelled) ? 'is-failed' : '');
      const compressionNote = t.compressionEnabled
        ? `<span class="compression-note">文本已压缩</span>`
        : '';

      // A failed row is the one place the app must not just report: it says what to do
      // next and offers the two actions that actually exist.
      let foot = '';
      if (isFailed) {
        foot = `
          <p class="transfer-error"><span>${escapeHtml(t.error || '传输没有完成。')}</span></p>
          ${t.nextAction ? `<p class="transfer-error"><span class="field-error-hint">${escapeHtml(t.nextAction)}</span></p>` : ''}
          <div class="transfer-actions">
            <button class="btn btn-primary btn-sm retry-task-btn" data-task-id="${escapeHtml(t.id)}">重试</button>
            <button class="btn btn-ghost btn-sm cancel-task-btn" data-task-id="${escapeHtml(t.id)}">取消</button>
          </div>
        `;
      } else if (isTransferring || isQueued) {
        foot = `
          <div class="transfer-actions">
            <button class="btn btn-ghost btn-sm cancel-task-btn" data-task-id="${escapeHtml(t.id)}">取消</button>
          </div>
        `;
      }

      return `
        <div class="transfer-item ${isFailed ? 'status-failed-row' : ''}">
          <div class="transfer-head">
            <span class="transfer-file-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                <polyline points="13 2 13 9 20 9"></polyline>
              </svg>
              <span title="${escapeHtml(t.fileName)}">${escapeHtml(t.fileName)}</span>
              <span class="transfer-target-name">到 ${escapeHtml(t.targetName || '本机')}</span>
            </span>
            <span class="transfer-status-badge ${statusClass}">${statusBadgeText}</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill ${fillState}" style="width: ${pct}%;"></div>
          </div>
          <div class="transfer-foot">
            <span>${formatBytes(t.bytesUploaded)} / ${formatBytes(t.fileSize)} · ${t.currentChunk}/${t.totalChunks} 块</span>
            <span>${escapeHtml(t.speed || '')}${t.eta ? ' · ' + escapeHtml(t.eta) : ''}${compressionNote}</span>
          </div>
          ${foot}
        </div>
      `;
    }).join('');

    dom.transfersList.querySelectorAll('.retry-task-btn').forEach(btn => {
      btn.addEventListener('click', () => retryTask(btn.getAttribute('data-task-id')));
    });
    dom.transfersList.querySelectorAll('.cancel-task-btn').forEach(btn => {
      btn.addEventListener('click', () => cancelTask(btn.getAttribute('data-task-id')));
    });
  }

  function updateTaskBadges() {
    const activeCount = state.tasks.filter(t => t.status === 'transferring').length;
    if (dom.activeTaskCountBadge) {
      dom.activeTaskCountBadge.textContent = activeCount;
      dom.activeTaskCountBadge.style.display = activeCount > 0 ? 'inline-block' : 'none';
    }
    if (dom.mobileTaskBadge) {
      dom.mobileTaskBadge.textContent = activeCount;
      dom.mobileTaskBadge.style.display = activeCount > 0 ? 'inline-block' : 'none';
    }
  }

  // 9.1 Per-Device File Transfer & Chat Windows
  function initChatEvents() {
    // Send text message
    if (dom.chatSendTextBtn) {
      dom.chatSendTextBtn.addEventListener('click', sendChatMessage);
    }
    if (dom.chatTextInput) {
      dom.chatTextInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          sendChatMessage();
        }
      });
    }

    // Attach file
    if (dom.chatAttachBtn) {
      dom.chatAttachBtn.addEventListener('click', () => {
        if (!state.activeChatPeerId) {
          showToast('先选一台设备');
          switchTab('radarTab');
          return;
        }
        if (dom.chatFileInput) dom.chatFileInput.click();
      });
    }
    if (dom.chatQuickSendBtn) {
      dom.chatQuickSendBtn.addEventListener('click', () => {
        if (!state.activeChatPeerId) {
          showToast('先选一台设备');
          switchTab('radarTab');
          return;
        }
        if (dom.chatFileInput) dom.chatFileInput.click();
      });
    }

    // File input change in chat
    if (dom.chatFileInput) {
      dom.chatFileInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files || []);
        if (files.length === 0) return;
        const targetDev = state.devices.find(d => d.id === state.activeChatPeerId);
        if (!targetDev) {
          showToast('这台设备已经不在这个网络里了', 'error');
          return;
        }
        for (const f of files) {
          startChunkedUploadTask(f, targetDev);
        }
        dom.chatFileInput.value = '';
      });
    }

    // Clear history
    if (dom.chatClearHistoryBtn) {
      dom.chatClearHistoryBtn.addEventListener('click', () => {
        if (!state.activeChatPeerId) return;
        if (confirm('清空这台设备的文件和消息记录？文件本身不会被删除。')) {
          delete state.peerHistories[state.activeChatPeerId];
          saveChatHistories();
          renderChatConversation();
          renderChatPeersList();
        }
      });
    }

    // Drag & drop over chat conversation stream
    const container = dom.chatStreamContainer;
    if (container && dom.chatDropOverlay) {
      ['dragenter', 'dragover'].forEach(ev => {
        container.addEventListener(ev, (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (state.activeChatPeerId) {
            dom.chatDropOverlay.classList.add('visible');
          }
        });
      });

      ['dragleave', 'drop'].forEach(ev => {
        container.addEventListener(ev, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dom.chatDropOverlay.classList.remove('visible');
        });
      });

      container.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dom.chatDropOverlay.classList.remove('visible');
        if (!state.activeChatPeerId) {
          showToast('先选一台设备');
          return;
        }
        const targetDev = state.devices.find(d => d.id === state.activeChatPeerId);
        if (!targetDev) {
          showToast('这台设备已经不在这个网络里了', 'error');
          return;
        }
        const files = Array.from(e.dataTransfer.files || []);
        for (const f of files) {
          startChunkedUploadTask(f, targetDev);
        }
      });
    }

    // Context menu and text selection logic: Long-press right click or right click to select text and copy
    let activeContextMenu = null;
    let rightClickTimer = null;

    function removeContextMenu() {
      if (activeContextMenu) {
        activeContextMenu.remove();
        activeContextMenu = null;
      }
      if (rightClickTimer) {
        clearTimeout(rightClickTimer);
        rightClickTimer = null;
      }
    }

    function selectBubbleText(bubbleEl) {
      const contentEl = bubbleEl.querySelector('.chat-bubble-content') || bubbleEl;
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(contentEl);
      selection.removeAllRanges();
      selection.addRange(range);
      return contentEl.textContent.trim();
    }

    function showChatContextMenu(x, y, textToCopy, targetBubble) {
      removeContextMenu();
      if (!textToCopy) return;

      const menu = document.createElement('div');
      menu.className = 'chat-context-menu';

      // Keep menu within viewport boundaries
      const menuWidth = 150;
      const menuHeight = 85;
      const posX = Math.min(x, window.innerWidth - menuWidth - 10);
      const posY = Math.min(y, window.innerHeight - menuHeight - 10);

      menu.style.left = `${posX}px`;
      menu.style.top = `${posY}px`;

      menu.innerHTML = `
        <button class="chat-context-menu-item" id="menuCopyBtn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
          <span>复制文本</span>
        </button>
        <button class="chat-context-menu-item" id="menuSelectAllBtn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="4 7 4 4 7 4"></polyline>
            <line x1="9" y1="20" x2="15" y2="20"></line>
            <line x1="12" y1="4" x2="12" y2="20"></line>
            <polyline points="20 7 20 4 17 4"></polyline>
            <polyline points="4 17 4 20 7 20"></polyline>
            <polyline points="20 17 20 20 17 20"></polyline>
          </svg>
          <span>全选此条</span>
        </button>
      `;

      document.body.appendChild(menu);
      activeContextMenu = menu;

      const copyBtn = menu.querySelector('#menuCopyBtn');
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(textToCopy).then(() => {
          showToast('已复制', 'ready');
        }).catch(() => {
          showToast('浏览器不允许复制，文本已经帮你选中了', 'attention');
        });
        removeContextMenu();
      });

      const selectAllBtn = menu.querySelector('#menuSelectAllBtn');
      selectAllBtn.addEventListener('click', () => {
        if (targetBubble) {
          selectBubbleText(targetBubble);
        }
        removeContextMenu();
      });
    }

    if (dom.chatTimeline) {
      // 1. Long-press right click detection (mousedown with button 2)
      dom.chatTimeline.addEventListener('mousedown', (e) => {
        if (e.button === 2) { // Right click
          const bubble = e.target.closest('.chat-bubble');
          if (bubble) {
            const content = bubble.querySelector('.chat-bubble-content');
            if (content) {
              const currentSel = window.getSelection().toString().trim();
              rightClickTimer = setTimeout(() => {
                const text = currentSel || selectBubbleText(bubble);
                showChatContextMenu(e.clientX, e.clientY, text, bubble);
              }, 220); // 220ms long-press right click
            }
          }
        }
      });

      dom.chatTimeline.addEventListener('mouseup', (e) => {
        if (e.button === 2 && rightClickTimer) {
          clearTimeout(rightClickTimer);
          rightClickTimer = null;
        }
      });

      // 2. Right click context menu
      dom.chatTimeline.addEventListener('contextmenu', (e) => {
        const bubble = e.target.closest('.chat-bubble');
        if (bubble) {
          e.preventDefault();
          const content = bubble.querySelector('.chat-bubble-content');
          if (content) {
            let selectedText = window.getSelection().toString().trim();
            if (!selectedText) {
              // Automatically select the text of this message bubble!
              selectedText = selectBubbleText(bubble);
            }
            showChatContextMenu(e.clientX, e.clientY, selectedText, bubble);
          }
        } else {
          const fileCard = e.target.closest('.chat-file-card');
          if (fileCard) {
            e.preventDefault();
            const fileNameEl = fileCard.querySelector('.chat-file-name');
            const fileName = fileNameEl ? fileNameEl.textContent.trim() : '';
            if (fileName) {
              showChatContextMenu(e.clientX, e.clientY, fileName, fileCard);
            }
          }
        }
      });
    }

    // Dismiss context menu on click elsewhere or Escape key
    document.addEventListener('click', (e) => {
      if (activeContextMenu && !activeContextMenu.contains(e.target)) {
        removeContextMenu();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        removeContextMenu();
      }
    });
  }

  function saveChatHistories() {
    try {
      localStorage.setItem('safedrop_chat_histories', JSON.stringify(state.peerHistories));
    } catch (_) {}
  }

  function openChatForDevice(devId) {
    switchTab('chatTab');
    selectChatPeer(devId);
  }

  function selectChatPeer(devId) {
    state.activeChatPeerId = devId;
    const targetDev = state.devices.find(d => d.id === devId);
    if (targetDev) {
      state.targetDevice = targetDev;
      writeStored(RECENT_DEVICE_KEY, targetDev.id);
    }
    renderChatPeersList();
    renderChatConversation();
    if (dom.chatTextInput) {
      setTimeout(() => dom.chatTextInput.focus(), 100);
    }
  }

  function renderChatPeersList() {
    if (!dom.chatPeersList) return;

    if (dom.chatPeerCountBadge) {
      dom.chatPeerCountBadge.textContent = state.devices.length;
    }

    if (state.devices.length === 0) {
      dom.chatPeersList.innerHTML = `
        <div class="chat-peer-empty" id="chatNoPeersHint">
          <p>还没有可聊天的设备</p>
          <span>把另一台设备连到同一个 Wi-Fi，它会自己出现在这里。</span>
        </div>
      `;
      if (state.activeChatPeerId) {
        state.activeChatPeerId = null;
        renderChatConversation();
      }
      return;
    }

    dom.chatPeersList.innerHTML = state.devices.map(dev => {
      const isPc = dev.os === 'windows' || dev.isHost;
      const isActive = dev.id === state.activeChatPeerId;
      const paired = peerSessions.has(`${dev.ip}:${dev.port || 8899}`);
      const history = state.peerHistories[dev.id] || [];
      const lastItem = history[history.length - 1];
      let lastText = '还没有互传记录';
      if (lastItem) {
        if (lastItem.type === 'file') {
          lastText = `文件 ${lastItem.fileName}`;
        } else {
          lastText = lastItem.text || '';
        }
      }

      return `
        <div class="chat-peer-item ${isActive ? 'active' : ''}" data-peer-id="${escapeHtml(dev.id)}">
          <div class="chat-peer-avatar ${isPc ? 'pc' : 'mobile'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              ${isPc ? `
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                <line x1="8" y1="21" x2="16" y2="21"></line>
                <line x1="12" y1="17" x2="12" y2="21"></line>
              ` : `
                <rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect>
                <line x1="12" y1="18" x2="12.01" y2="18"></line>
              `}
            </svg>
            <span class="chat-peer-status-dot ${paired ? 'online' : 'offline'}" title="${paired ? '已配对' : '未配对'}"></span>
          </div>
          <div class="chat-peer-info">
            <div class="chat-peer-name-row">
              <span class="chat-peer-name">${escapeHtml(getDeviceDisplayName(dev))}</span>
              <span class="device-platform-tag ${isPc ? 'pc' : 'mobile'}">${isPc ? '电脑' : '手机'}</span>
            </div>
            <div class="chat-peer-preview">${escapeHtml(lastText)}</div>
          </div>
        </div>
      `;
    }).join('');

    dom.chatPeersList.querySelectorAll('.chat-peer-item').forEach(item => {
      item.addEventListener('click', () => {
        const peerId = item.getAttribute('data-peer-id');
        selectChatPeer(peerId);
      });
    });
  }

  function renderChatConversation() {
    if (!state.activeChatPeerId) {
      if (dom.chatUnselectedState) dom.chatUnselectedState.style.display = 'flex';
      if (dom.chatActiveState) dom.chatActiveState.style.display = 'none';
      return;
    }

    const dev = state.devices.find(d => d.id === state.activeChatPeerId);
    if (!dev) {
      if (dom.chatUnselectedState) dom.chatUnselectedState.style.display = 'flex';
      if (dom.chatActiveState) dom.chatActiveState.style.display = 'none';
      return;
    }

    if (dom.chatUnselectedState) dom.chatUnselectedState.style.display = 'none';
    if (dom.chatActiveState) dom.chatActiveState.style.display = 'flex';

    // Update peer header
    const isPc = dev.os === 'windows' || dev.isHost;
    const paired = peerSessions.has(`${dev.ip}:${dev.port || 8899}`);
    if (dom.chatActiveName) dom.chatActiveName.textContent = getDeviceDisplayName(dev);
    if (dom.chatActiveTag) {
      dom.chatActiveTag.className = `device-platform-tag ${isPc ? 'pc' : 'mobile'}`;
      dom.chatActiveTag.textContent = isPc ? '电脑端' : '手机端';
    }
    if (dom.chatSecurityTagText) dom.chatSecurityTagText.textContent = paired ? '已配对' : '未配对';
    if (dom.chatSecurityTag) {
      dom.chatSecurityTag.style.background = paired ? 'var(--state-ready-bg)' : 'var(--state-attention-bg)';
      dom.chatSecurityTag.style.color = paired ? 'var(--state-ready)' : 'var(--state-attention)';
    }
    if (dom.chatActiveMeta) {
      dom.chatActiveMeta.textContent = `${dev.ip}:${dev.port} · ${dev.fingerprint || 'LAN'}`;
    }

    // Render timeline
    if (!dom.chatTimeline) return;
    const history = state.peerHistories[dev.id] || [];
    if (history.length === 0) {
      dom.chatTimeline.innerHTML = `
        <div class="chat-timeline-empty">
          <p>已经连上 ${escapeHtml(getDeviceDisplayName(dev))}</p>
          <span>把文件拖进这个窗口就能发，也可以在下面打字。第一次发之前需要先输入对方的配对码。</span>
        </div>
      `;
      return;
    }

    dom.chatTimeline.innerHTML = history.map(item => {
      const isOutgoing = item.direction === 'outgoing';
      const timeStr = item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

      if (item.type === 'file') {
        const isDone = item.status === 'done';
        const isFailed = item.status === 'failed';
        const isCancelled = item.status === 'cancelled';
        const pct = item.progress !== undefined ? item.progress : (isDone ? 100 : 0);
        const stateClass = isDone ? 'done' : (isFailed || isCancelled ? 'failed' : 'transferring');
        const stateText = isDone ? '已送达' : (isCancelled ? '已取消' : (isFailed ? '没传完' : `${pct}%`));
        return `
          <div class="chat-file-card ${isOutgoing ? 'outgoing' : 'incoming'}" data-task-id="${escapeHtml(item.id)}">
            <div class="chat-file-header">
              <div class="chat-file-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                  <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                  <polyline points="13 2 13 9 20 9"></polyline>
                </svg>
              </div>
              <div class="chat-file-info">
                <div class="chat-file-name" title="${escapeHtml(item.fileName)}">${escapeHtml(item.fileName)}</div>
                <div class="chat-file-meta">
                  <span>${formatBytes(item.fileSize)}</span>
                  <span>·</span>
                  <span>${isOutgoing ? '发给对方' : '对方发来'}</span>
                </div>
              </div>
              <span class="chat-file-status-tag ${stateClass}">${stateText}</span>
            </div>
            ${!isDone && !isFailed && !isCancelled ? `
              <div class="chat-file-progress-track">
                <div class="chat-file-progress-fill" style="width: ${pct}%;"></div>
              </div>
            ` : ''}
            <div class="chat-file-footer">
              <span>${escapeHtml(item.speed || '')}</span>
              <span class="chat-bubble-time">${timeStr}</span>
            </div>
          </div>
        `;
      } else {
        return `
          <div class="chat-bubble ${isOutgoing ? 'outgoing' : 'incoming'}">
            <div class="chat-bubble-content">${escapeHtml(item.text)}</div>
            <div class="chat-bubble-time">${timeStr}</div>
          </div>
        `;
      }
    }).join('');

    // Auto-scroll to bottom
    if (dom.chatStreamContainer) {
      dom.chatStreamContainer.scrollTop = dom.chatStreamContainer.scrollHeight;
    }
  }

  async function sendChatMessage() {
    if (!dom.chatTextInput) return;
    const text = dom.chatTextInput.value.trim();
    if (!text) return;

    if (!state.activeChatPeerId) {
      showToast('先选一台设备');
      return;
    }

    const targetDev = state.devices.find(d => d.id === state.activeChatPeerId);
    if (!targetDev) {
      showToast('这台设备已经不在这个网络里了', 'error');
      return;
    }

    const peerId = targetDev.id;
    const msgObj = {
      id: `msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      type: 'text',
      direction: 'outgoing',
      text: text,
      timestamp: Date.now()
    };

    if (!state.peerHistories[peerId]) state.peerHistories[peerId] = [];
    state.peerHistories[peerId].push(msgObj);
    saveChatHistories();

    dom.chatTextInput.value = '';
    renderChatConversation();
    renderChatPeersList();

    try {
      const res = await fetch(apiUrl('/api/v1/message/send'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: text,
          targetIp: targetDev.ip,
          targetPort: targetDev.port || 8899,
          targetId: targetDev.id,
          peerId: targetDev.id,
          peerName: targetDev.name,
          senderIp: state.info?.localIp || '',
          senderId: state.info?.host?.id || 'pc-hub',
          senderName: state.info?.host?.name || '本机'
        })
      });
      // The bubble was rendered optimistically. Opening this page by LAN address instead of
      // localhost means the hub treats it as an unpaired caller and answers 401, so take the
      // message back instead of leaving a delivery that never happened.
      if (!res.ok) {
        state.peerHistories[peerId] = state.peerHistories[peerId].filter(m => m.id !== msgObj.id);
        saveChatHistories();
        renderChatConversation();
        renderChatPeersList();
        showToast('这条消息没有送出去，对方可能还没配对。', 'error');
      }
    } catch (e) {
      console.warn('Message send failed:', e);
    }
  }

  // Resolve which active or discovered peer a message belongs to
  function resolveMessagePeer(m) {
    if (!m) return null;
    const hostId = state.info?.host?.id || '';
    const hostIp = state.info?.localIp || '';
    const isIncoming = (m.senderId && m.senderId !== hostId && !m.senderId.startsWith('pc-')) || (m.senderIp && m.senderIp !== hostIp && m.senderIp !== '127.0.0.1');

    if (isIncoming) {
      // Incoming message from a remote peer to PC
      // 1. Match by senderIp
      if (m.senderIp) {
        const byIp = state.devices.find(d => d.ip === m.senderIp);
        if (byIp) return byIp;
      }
      // 2. Match by exact senderId
      if (m.senderId) {
        const byId = state.devices.find(d => d.id === m.senderId);
        if (byId) return byId;
      }
      // 3. Match by partial id / IP within ID
      if (m.senderId) {
        const bySub = state.devices.find(d =>
          (d.id && d.id.includes(m.senderId)) ||
          (m.senderId && d.id && m.senderId.includes(d.id)) ||
          (d.ip && m.senderId.includes(d.ip))
        );
        if (bySub) return bySub;
      }
      // 4. Match activeChatPeer if active peer matches IP or target
      if (state.activeChatPeerId) {
        const activeDev = state.devices.find(d => d.id === state.activeChatPeerId);
        if (activeDev) {
          if ((m.senderIp && activeDev.ip === m.senderIp) || (m.targetId && activeDev.id === m.targetId)) {
            return activeDev;
          }
        }
      }
      // 5. Fallback: if only 1 device is online
      if (state.devices.length === 1) {
        return state.devices[0];
      }
    } else {
      // Outgoing message sent by PC
      if (m.targetIp) {
        const byIp = state.devices.find(d => d.ip === m.targetIp);
        if (byIp) return byIp;
      }
      if (m.targetId) {
        const byId = state.devices.find(d => d.id === m.targetId || d.id.includes(m.targetId));
        if (byId) return byId;
      }
      if (state.activeChatPeerId) {
        const activeDev = state.devices.find(d => d.id === state.activeChatPeerId);
        if (activeDev) return activeDev;
      }
    }
    return null;
  }

  async function fetchMessages() {
    try {
      const res = await fetch(apiUrl(`/api/v1/messages/list?since=${state.lastMessageTimestamp}`));
      const data = await res.json();
      const messages = data.messages || [];
      if (messages.length === 0) return;

      let hasNewForActive = false;
      for (const m of messages) {
        if (m.timestamp > state.lastMessageTimestamp) {
          state.lastMessageTimestamp = m.timestamp;
        }

        const hostId = state.info?.host?.id || '';
        const hostIp = state.info?.localIp || '';
        const isIncoming = (m.senderId && m.senderId !== hostId && !m.senderId.startsWith('pc-')) || (m.senderIp && m.senderIp !== hostIp && m.senderIp !== '127.0.0.1');

        let matchedDev = resolveMessagePeer(m);
        let peerId = matchedDev ? matchedDev.id : (isIncoming ? (m.senderId || `dev-${(m.senderIp || 'peer').replace(/\./g, '-')}`) : m.targetId);
        if (!peerId) continue;

        // If peer not yet in state.devices, dynamically register it so it displays immediately
        if (!matchedDev && m.senderIp && m.senderIp !== hostIp && m.senderIp !== '127.0.0.1') {
          const newDev = {
            id: peerId,
            name: m.senderName || `移动便携端 (${m.senderIp})`,
            ip: m.senderIp,
            port: 8899,
            os: 'android',
            fingerprint: 'MOBILE-CHAT',
            isHost: false,
            lastSeen: Date.now()
          };
          state.devices.push(newDev);
          matchedDev = newDev;
          renderDevicesGrid();
        }

        if (!state.peerHistories[peerId]) state.peerHistories[peerId] = [];
        const exists = state.peerHistories[peerId].some(x => x.id === m.id);
        if (!exists) {
          state.peerHistories[peerId].push({
            id: m.id,
            type: 'text',
            direction: isIncoming ? 'incoming' : 'outgoing',
            text: m.text,
            senderName: m.senderName,
            timestamp: m.timestamp
          });

          // Also mirror to activeChatPeerId if it corresponds to same device
          if (matchedDev && matchedDev.id !== peerId) {
            if (!state.peerHistories[matchedDev.id]) state.peerHistories[matchedDev.id] = [];
            if (!state.peerHistories[matchedDev.id].some(x => x.id === m.id)) {
              state.peerHistories[matchedDev.id].push({
                id: m.id,
                type: 'text',
                direction: isIncoming ? 'incoming' : 'outgoing',
                text: m.text,
                senderName: m.senderName,
                timestamp: m.timestamp
              });
            }
          }

          // If no active peer currently selected, automatically select this active chatter
          if (!state.activeChatPeerId) {
            state.activeChatPeerId = matchedDev ? matchedDev.id : peerId;
            hasNewForActive = true;
          } else if (peerId === state.activeChatPeerId || (matchedDev && matchedDev.id === state.activeChatPeerId)) {
            hasNewForActive = true;
          }
        }
      }

      saveChatHistories();
      renderChatPeersList();
      if (hasNewForActive) {
        renderChatConversation();
      }
    } catch (_) {}
  }

  // 10. Received files listing and download
  async function fetchFiles() {
    try {
      const res = await fetch(apiUrl('/api/v1/files/list'));
      const data = await res.json();
      state.filesUpdatedAt = Date.now();
      if (data.downloadDir) {
        if (dom.sandboxDirText) dom.sandboxDirText.textContent = data.downloadDir;
        if (dom.settingsDirDisplay) dom.settingsDirDisplay.textContent = data.downloadDir;
      }
      renderFilesList(data.files || []);
    } catch (_) {}
  }

  function renderFilesList(files) {
    if (!dom.filesList) return;

    if (files.length === 0) {
      dom.filesList.innerHTML = `
        <div class="empty-state">
          <p>还没有收到文件</p>
          <span>对方选这台电脑发出文件后，收到的东西会出现在这里。</span>
          <button class="btn btn-secondary btn-sm" data-action="open-dir">打开保存文件夹</button>
        </div>
      `;
      const openBtn = dom.filesList.querySelector('[data-action="open-dir"]');
      if (openBtn) openBtn.addEventListener('click', () => openStorageDir());
      return;
    }

    dom.filesList.innerHTML = files.map(f => {
      const downloadHref = apiUrl(`/api/v1/files/download/${encodeURIComponent(f.name)}`);
      return `
        <div class="file-item">
          <div class="file-head">
            <span class="transfer-file-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
              </svg>
              <span title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
            </span>
            <a href="${downloadHref}" download class="btn btn-secondary btn-sm">
              另存一份
            </a>
          </div>
          <div class="transfer-foot">
            <span>${formatBytes(f.size)}</span>
            <span>${escapeHtml(formatTimestamp(f.mtime))}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  function formatTimestamp(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  // 11. Render ISO/IEC 18004 Standard QR Code (uses qrcode.js engine)
  function renderQrCode() {
    const canvas = dom.qrCanvas;
    if (!canvas || !state.info) return;

    // Select target URI to encode
    const targetText = state.qrMode === 'app'
      ? (state.info.qrUri || `safedrop://pair?ip=${state.info.localIp}&port=${state.info.port}&fp=${state.info.fingerprint}&token=${state.info.token}&pin=${state.info.pin}`)
      : (state.info.webUrl || (state.info.tlsPort
        // Credentials belong in the portal URL only on a secure origin, where the browser can
        // actually encrypt; over http:// the portal refuses to pair.
        ? `https://${state.info.localIp}:${state.info.tlsPort}/portal?pin=${state.info.pin}&token=${state.info.token}&fp=${state.info.fingerprint}`
        : `http://${state.info.localIp}:${state.info.port}/portal`));

    if (dom.modalDirectUrl) {
      dom.modalDirectUrl.textContent = targetText;
    }

    try {
      // Enhanced validation: check if qrcode.js is loaded and functional
      if (typeof window.qrcode !== 'function') {
        console.error('QR code generator (qrcode.js) not loaded. Ensure <script src="qrcode.js"> is present in HTML.');
        showToast('二维码没有画出来，可以直接输入配对码', 'error');
        
        // Fallback: display text-only pairing information
        const ctx = canvas.getContext('2d');
        if (ctx) {
          canvas.width = 220;
          canvas.height = 220;
          ctx.fillStyle = '#FFFFFF';
          ctx.fillRect(0, 0, 220, 220);
          ctx.fillStyle = '#16181B';
          ctx.font = 'bold 14px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('二维码没有画出来', 110, 100);
          ctx.font = '11px system-ui, sans-serif';
          ctx.fillStyle = '#4A5158';
          ctx.fillText('改用下面的配对码', 110, 122);
        }
        return;
      }

      // Standard QR Code: Type 0 (auto-select version), Error Correction Level M (15% correction capacity)
      const qr = window.qrcode(0, 'M');
      qr.addData(targetText);
      qr.make();

      const moduleCount = qr.getModuleCount();
      const margin = 4; // ISO/IEC 18004 standard quiet zone: 4 modules
      const totalGrid = moduleCount + margin * 2;

      const dpr = window.devicePixelRatio || 1;
      const displaySize = 220;
      canvas.width = displaySize * dpr;
      canvas.height = displaySize * dpr;

      const ctx = canvas.getContext('2d');
      ctx.save();
      ctx.scale(dpr, dpr);

      // Clean crisp white background for quiet zone
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, displaySize, displaySize);

      const cellSize = displaySize / totalGrid;
      ctx.fillStyle = '#0F172A';

      for (let r = 0; r < moduleCount; r++) {
        for (let c = 0; c < moduleCount; c++) {
          if (qr.isDark(r, c)) {
            const x = (c + margin) * cellSize;
            const y = (r + margin) * cellSize;
            ctx.fillRect(Math.floor(x), Math.floor(y), Math.ceil(cellSize), Math.ceil(cellSize));
          }
        }
      }

      // Micro center anchor dot badge (compact 3x3 modules to preserve error-correction margin).
      // Neutral ink: the QR has to stay scannable, and a coloured badge is decoration that
      // costs contrast.
      const badgeModules = 3;
      const badgeSize = cellSize * badgeModules;
      const bx = (displaySize - badgeSize) / 2;
      const by = (displaySize - badgeSize) / 2;

      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(bx - 1.5, by - 1.5, badgeSize + 3, badgeSize + 3);

      ctx.fillStyle = '#16181B';
      ctx.beginPath();
      ctx.roundRect(bx, by, badgeSize, badgeSize, 2);
      ctx.fill();

      ctx.fillStyle = '#FFFFFF';
      ctx.font = `bold ${Math.round(badgeSize * 0.48)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('SD', displaySize / 2, displaySize / 2);

      ctx.restore();
    } catch (e) {
      console.error('QR Render failed:', e);
    }
  }

  // 12. Modal dialog and event bindings
  function initModalEvents() {
    dom.openQrModalBtn.addEventListener('click', () => {
      dom.qrModalOverlay.classList.add('open');
      renderQrCode();
    });

    const closeModal = () => dom.qrModalOverlay.classList.remove('open');
    dom.closeQrModalBtn.addEventListener('click', closeModal);
    dom.modalDoneBtn.addEventListener('click', closeModal);
    dom.qrModalOverlay.addEventListener('click', (e) => {
      if (e.target === dom.qrModalOverlay) closeModal();
    });

    // Copy URL or URI to clipboard
    dom.copyUrlBtn.addEventListener('click', () => {
      const textToCopy = dom.modalDirectUrl ? dom.modalDirectUrl.textContent : '';
      if (textToCopy) {
        navigator.clipboard.writeText(textToCopy).then(() => {
          showToast('配对地址已复制', 'ready');
        }).catch(() => {
          showToast('浏览器不允许复制，请手动选中地址', 'attention');
        });
      }
    });

    // QR code mode toggle (SafeDrop App / Browser)
    if (dom.qrModeAppBtn && dom.qrModeWebBtn) {
      dom.qrModeAppBtn.addEventListener('click', () => {
        state.qrMode = 'app';
        dom.qrModeAppBtn.classList.add('active');
        dom.qrModeWebBtn.classList.remove('active');
        renderQrCode();
      });

      dom.qrModeWebBtn.addEventListener('click', () => {
        state.qrMode = 'web';
        dom.qrModeWebBtn.classList.add('active');
        dom.qrModeAppBtn.classList.remove('active');
        renderQrCode();
      });
    }

    // Refresh PIN inside modal
    if (dom.modalRefreshPinBtn) {
      dom.modalRefreshPinBtn.addEventListener('click', () => {
        refreshPin();
      });
    }

    // There is no manual device refresh: fetchDevices() runs on a timer and the panel
    // shows when it last answered. A button that only re-runs a poller is a second control
    // for something already happening.

    if (dom.openDirFromFilesBtn) {
      dom.openDirFromFilesBtn.addEventListener('click', () => {
        openStorageDir();
      });
    }

    if (dom.noTransfersPickBtn) {
      dom.noTransfersPickBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dom.filePickerInput.click();
      });
    }

    // "清除已结束" drops everything that has reached a final state, including failures:
    // a failed row keeps its file handle only while it is on the list.
    dom.clearCompletedTasksBtn.addEventListener('click', () => {
      state.tasks = state.tasks.filter(t => t.status === 'transferring' || t.status === 'queued');
      updateTaskBadges();
      renderTransfersList();
    });

    dom.refreshPinBtn.addEventListener('click', () => {
      refreshPin();
    });
  }

  // 13. Storage settings management
  function initSettingsEvents() {
    // NEW: Compression toggle event listener
    const compressionToggle = document.getElementById('compressionToggle');
    if (compressionToggle) {
      compressionToggle.checked = state.compressionEnabled;
      compressionToggle.addEventListener('change', (e) => {
        state.compressionEnabled = e.target.checked;
        try {
          localStorage.setItem('safedrop_compression_enabled', state.compressionEnabled ? 'true' : 'false');
        } catch (_) {}
      });
    }

    if (dom.saveDownloadDirBtn && dom.customDownloadDirInput) {
      dom.saveDownloadDirBtn.addEventListener('click', () => {
        const newDir = dom.customDownloadDirInput.value.trim();
        if (!newDir) {
          showToast('先填一个完整的文件夹路径');
          return;
        }
        applyStorageDir(newDir);
      });
    }

    if (dom.openDirBtn) {
      dom.openDirBtn.addEventListener('click', () => {
        openStorageDir();
      });
    }

    // Preset chips. They used to paste a path into the text box and leave the user to
    // notice that nothing had been saved; now one press is the whole action.
    document.querySelectorAll('.preset-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const presetType = chip.getAttribute('data-path');
        const targetPath = presetPathFor(presetType);
        if (!targetPath) return;
        if (dom.customDownloadDirInput) dom.customDownloadDirInput.value = targetPath;
        applyStorageDir(targetPath, chip);
      });
    });

    markActivePreset();
  }

  /**
   * Resolve a preset name to an absolute path. There is no native folder picker available
   * to this page (the Tauri dialog plugin is not configured), so the text field stays as
   * the advanced route; the presets cover the three places people actually mean.
   */
  function presetPathFor(presetType) {
    const currentPath = (state.info && state.info.downloadDir) || (dom.customDownloadDirInput ? dom.customDownloadDirInput.value : '');
    const userHomeMatch = String(currentPath).match(/^([A-Za-z]:\\[Uu]sers\\[^\\]+)/i);
    const home = userHomeMatch ? userHomeMatch[1] : 'C:\\SafeDrop';
    const leaf = { downloads: 'Downloads', documents: 'Documents', desktop: 'Desktop' }[presetType];
    if (!leaf) return '';
    return `${home}\\${leaf}\\SafeDrop`;
  }

  async function applyStorageDir(newDir, sourceChip) {
    try {
      const res = await fetch(apiUrl('/api/v1/settings/dir'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: newDir })
      });
      const data = await res.json();
      if (res.ok && data.code === 0) {
        if (state.info) state.info.downloadDir = data.downloadDir;
        if (dom.settingsDirDisplay) dom.settingsDirDisplay.textContent = data.downloadDir;
        if (dom.sandboxDirText) dom.sandboxDirText.textContent = data.downloadDir;
        if (dom.customDownloadDirInput) dom.customDownloadDirInput.value = data.downloadDir;
        markActivePreset(sourceChip);
        showToast('保存位置已更新', 'ready');
        fetchFiles();
        return;
      }
      showToast(data.error || '这个路径用不了，换一个试试', 'error');
    } catch (e) {
      showToast('保存位置没有改成：本机的传输服务没有响应。', 'error');
    }
  }

  /** Show which preset is the current one, so "applied" is visible without a toast. */
  function markActivePreset(justApplied) {
    const current = String((state.info && state.info.downloadDir) || '').replace(/[\\/]+$/, '').toLowerCase();
    document.querySelectorAll('.preset-chip').forEach(chip => {
      const want = String(presetPathFor(chip.getAttribute('data-path')) || '').replace(/[\\/]+$/, '').toLowerCase();
      const on = chip === justApplied || (!!want && want === current);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  async function openStorageDir() {
    try {
      const res = await fetch(apiUrl('/api/v1/settings/open-dir'), { method: 'POST' });
      if (!res.ok) {
        showToast('打不开这个文件夹，可能路径已经不在了', 'error');
        return;
      }
      showToast('已在文件资源管理器中打开', 'ready');
    } catch (e) {
      showToast('打不开这个文件夹', 'error');
    }
  }

  // NEW: Load and render device names management UI
  async function loadDeviceNamesManager() {
    const container = document.getElementById('deviceNamesManager');
    if (!container) return;

    try {
      const [namesRes, devicesRes] = await Promise.all([
        fetch(apiUrl('/api/v1/devices/names')),
        fetch(apiUrl('/api/v1/devices'))
      ]);
      
      const namesData = await namesRes.json();
      const devicesData = await devicesRes.json();
      
      const deviceNames = namesData.deviceNames || {};
      const devices = devicesData.devices || [];
      
      const deviceMap = new Map();
      
      devices.forEach(dev => {
        if (dev.fingerprint && dev.fingerprint.length >= 8) {
          deviceMap.set(dev.fingerprint, {
            fingerprint: dev.fingerprint,
            name: dev.name || '未知设备',
            customName: deviceNames[dev.fingerprint] || '',
            ip: dev.ip,
            os: dev.os || 'unknown',
            status: 'online'
          });
        }
      });
      
      Object.keys(deviceNames).forEach(fp => {
        if (!deviceMap.has(fp)) {
          deviceMap.set(fp, {
            fingerprint: fp,
            name: '离线设备',
            customName: deviceNames[fp],
            ip: '-',
            os: 'unknown',
            status: 'offline'
          });
        }
      });
      
      if (deviceMap.size === 0) {
        container.innerHTML = '<div class="device-name-empty">还没有连过的设备。连上一次之后，就能在这里给它起名字。</div>';
        return;
      }
      
      container.innerHTML = Array.from(deviceMap.values()).map(dev => `
        <div class="device-name-card">
          <div class="device-name-header">
            <div class="device-name-icon ${dev.os === 'android' ? 'android' : 'pc'}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                ${dev.os === 'android' ? `
                  <rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect>
                  <line x1="12" y1="18" x2="12.01" y2="18"></line>
                ` : `
                  <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                  <line x1="8" y1="21" x2="16" y2="21"></line>
                  <line x1="12" y1="17" x2="12" y2="21"></line>
                `}
              </svg>
            </div>
            <div class="device-name-info">
              <div class="device-name-title">${escapeHtml(dev.name)}</div>
              <div class="device-name-meta">${escapeHtml(dev.fingerprint.substring(0, 12))} · ${dev.status === 'online' ? '在线' : '不在这个网络里'}</div>
            </div>
          </div>
          <div class="device-name-controls">
            <input type="text" class="device-name-input" placeholder="起个名字" value="${escapeHtml(dev.customName)}" data-fingerprint="${escapeHtml(dev.fingerprint)}" aria-label="设备名称"/>
            <button class="btn btn-primary btn-sm save-device-name" data-fingerprint="${escapeHtml(dev.fingerprint)}">保存</button>
            ${dev.customName ? `<button class="btn btn-secondary btn-sm delete-device-name" data-fingerprint="${escapeHtml(dev.fingerprint)}">删除</button>` : ''}
          </div>
        </div>
      `).join('');
      
      container.querySelectorAll('.save-device-name').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const fingerprint = e.target.dataset.fingerprint;
          const input = container.querySelector(`.device-name-input[data-fingerprint="${fingerprint}"]`);
          const customName = input?.value.trim();
          if (!customName) return showToast('先写一个名字');
          try {
            const res = await fetch(apiUrl(`/api/v1/devices/names/${fingerprint}`), {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ customName })
            });
            if (res.ok) {
              showToast('名字已保存', 'ready');
              loadDeviceNamesManager();
              fetchDevices();
            } else {
              const data = await res.json();
              showToast(data.error || '名字没保存上', 'error');
            }
          } catch (_) { showToast('名字没保存上', 'error'); }
        });
      });
      
      container.querySelectorAll('.delete-device-name').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const fingerprint = e.target.dataset.fingerprint;
          if (!confirm('删掉这台设备的自定义名字？')) return;
          try {
            const res = await fetch(apiUrl(`/api/v1/devices/names/${fingerprint}`), { method: 'DELETE' });
            if (res.ok) {
              showToast('名字已删除', 'ready');
              loadDeviceNamesManager();
              fetchDevices();
            } else {
              const data = await res.json();
              showToast(data.error || '名字没删掉', 'error');
            }
          } catch (_) { showToast('名字没删掉', 'error'); }
        });
      });
    } catch (err) {
      console.error('Failed to load device names:', err);
      container.innerHTML = '<div class="device-name-empty">读不到设备列表，稍后再试。</div>';
    }
  }

  // Toast notifications. `kind` maps onto the same semantic states the rest of the
  // panel uses; pairing errors never come through here - they land next to the field.
  function showToast(msg, kind) {
    if (!dom.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    if (kind === 'ready' || kind === 'success') toast.className += ' is-ready';
    else if (kind === 'progress') toast.className += ' is-progress';
    else if (kind === 'attention' || kind === 'warning') toast.className += ' is-attention';
    else if (kind === 'error' || kind === 'failed') toast.className += ' is-error';
    toast.textContent = msg;
    dom.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.2s linear';
      setTimeout(() => toast.remove(), 220);
    }, 3200);
  }

  // Formatting helpers
  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function formatSpeed(bytesPerSec) {
    if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
    if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
    return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  }

  // Calculate and format ETA (Estimated Time Remaining)
  function formatETA(remainingBytes, speedBytesPerSec) {
    if (speedBytesPerSec <= 0 || remainingBytes <= 0) return '';
    
    const remainingSeconds = Math.ceil(remainingBytes / speedBytesPerSec);
    
    if (remainingSeconds < 60) {
      return `剩余 ${remainingSeconds}秒`;
    } else if (remainingSeconds < 3600) {
      const minutes = Math.floor(remainingSeconds / 60);
      const seconds = remainingSeconds % 60;
      return `剩余 ${minutes}分${seconds}秒`;
    } else {
      const hours = Math.floor(remainingSeconds / 3600);
      const minutes = Math.floor((remainingSeconds % 3600) / 60);
      return `剩余 ${hours}小时${minutes}分`;
    }
  }

  // Parse speed string back to bytes per second for ETA calculation
  function parseSpeedToBytes(speedStr) {
    if (!speedStr || speedStr === '0 B/s') return 0;
    const match = speedStr.match(/([\d.]+)\s*(B|KB|MB)\/s/);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    const unit = match[2];
    if (unit === 'MB') return value * 1024 * 1024;
    if (unit === 'KB') return value * 1024;
    return value;
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Start application on DOMContentLoaded
  window.addEventListener('DOMContentLoaded', init);
})();
