/**
 * SafeDrop Hub Frontend Responsive Controller
 * Features radar canvas animation, device topology discovery, 1MB chunked streaming upload,
 * Reed-Solomon QR code matrix generator, vault storage management, three-state theme switcher, and cross-platform interaction.
 */

(function () {
  'use strict';

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
  };

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
    refreshDevicesBtn: document.getElementById('refreshDevicesBtn'),
    refreshFilesBtn: document.getElementById('refreshFilesBtn'),
    openDirFromFilesBtn: document.getElementById('openDirFromFilesBtn'),
    clearCompletedTasksBtn: document.getElementById('clearCompletedTasksBtn'),
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
    chatClearHistoryBtn: document.getElementById('chatClearHistoryBtn'),
    chatQuickSendBtn: document.getElementById('chatQuickSendBtn'),
    chatStreamContainer: document.getElementById('chatStreamContainer'),
    chatDropOverlay: document.getElementById('chatDropOverlay'),
    chatTimeline: document.getElementById('chatTimeline'),
    chatFileInput: document.getElementById('chatFileInput'),
    chatAttachBtn: document.getElementById('chatAttachBtn'),
    chatTextInput: document.getElementById('chatTextInput'),
    chatSendTextBtn: document.getElementById('chatSendTextBtn'),
  };

  // 1. Initialization
  async function init() {
    initTheme();
    initNavigation();
    initRadarCanvas();
    initDragAndDrop();
    initModalEvents();
    initSettingsEvents();
    initChatEvents();

    if (state.isMobile) {
      if (dom.currentRoleBadge) dom.currentRoleBadge.textContent = '移动便携端';
      if (dom.radarCenterLabel) dom.radarCenterLabel.textContent = '手机本机';
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

    // Mobile device heartbeat announcement
    if (state.isMobile) {
      announceMobileDevice();
    }
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
        const targetTab = btn.getAttribute('data-tab');
        switchTab(targetTab);
      });
    });
  }

  function switchTab(tabId) {
    state.currentTab = tabId;

    // Switch active tab pane
    document.querySelectorAll('.tab-pane').forEach(pane => {
      pane.classList.toggle('active', pane.id === tabId);
    });

    // Switch active nav item
    document.querySelectorAll('.nav-item, .bottom-nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
    });
  }

  // 4. Fetch server system info
  async function fetchSystemInfo() {
    try {
      const res = await fetch('/api/v1/info');
      const data = await res.json();
      state.info = data;

      if (dom.sidebarIpText) dom.sidebarIpText.textContent = `${data.localIp}:${data.port}`;
      const localIpBadge = document.getElementById('hubLocalIpBadge');
      if (localIpBadge) localIpBadge.textContent = `${data.localIp}:${data.port}`;
      if (dom.settingsFingerprintText) dom.settingsFingerprintText.textContent = data.fingerprint;
      if (dom.settingsPinText) dom.settingsPinText.textContent = data.pin;
      if (dom.modalPinCode) dom.modalPinCode.textContent = data.pin;
      if (dom.modalDirectUrl) dom.modalDirectUrl.textContent = data.webUrl;
      if (dom.sandboxDirText) dom.sandboxDirText.textContent = `落盘沙箱目录: ${data.downloadDir}`;
      if (dom.settingsDirDisplay) dom.settingsDirDisplay.textContent = data.downloadDir;
      if (dom.customDownloadDirInput && !dom.customDownloadDirInput.value) {
        dom.customDownloadDirInput.value = data.downloadDir;
      }

      // Render pairing QR code
      renderQrCode();
    } catch (e) {
      console.warn('Fetch info failed:', e);
    }
  }

  // 4.1 Refresh dynamic pairing PIN
  async function refreshPin() {
    try {
      const res = await fetch('/api/v1/pin/refresh', { method: 'POST' });
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
      showToast(`动态配对 PIN 码已刷新: ${data.pin}`);
    } catch (e) {
      await fetchSystemInfo();
      showToast('动态 PIN 码已重新获取');
    }
  }

  // 5. Mobile self-announcement
  async function announceMobileDevice() {
    try {
      await fetch('/api/v1/devices/announce', {
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

  // 6. Device topology discovery and smart merging
  async function fetchDevices() {
    try {
      const res = await fetch('/api/v1/devices');
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

      if (dom.onlineDeviceCountTag) {
        dom.onlineDeviceCountTag.textContent = `${state.devices.length} 台在线`;
      }

      renderDevicesGrid();
      renderChatPeersList();
    } catch (_) {}
  }

  function renderDevicesGrid() {
    if (!dom.devicesGrid) return;

    if (state.devices.length === 0) {
      dom.devicesGrid.innerHTML = `
        <div class="empty-state" style="grid-column: 1/-1;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:42px;height:42px;margin-bottom:8px;opacity:0.5;">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
          </svg>
          <p>未发现其他局域网节点</p>
          <span>确保设备接入同一 Wi-Fi 或扫描上方二维码配对</span>
        </div>
      `;
      return;
    }

    dom.devicesGrid.innerHTML = state.devices.map(dev => {
      const isPc = dev.os === 'windows' || dev.isHost;
      const isSelectedTarget = state.targetDevice && (state.targetDevice.ip === dev.ip || state.targetDevice.id === dev.id);
      const platformName = isPc ? '电脑端' : '手机端';
      const fpText = dev.fingerprint ? dev.fingerprint : 'LAN';

      return `
        <div class="device-card ${isSelectedTarget ? 'selected-target' : ''}" data-device-id="${dev.id}">
          <div class="device-left">
            <div class="device-avatar-wrap">
              <div class="device-avatar ${isPc ? 'pc' : ''}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
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
                <span class="device-name" title="${escapeHtml(dev.name)}">${escapeHtml(dev.name)}</span>
                <span class="device-platform-tag ${isPc ? 'pc' : 'mobile'}">${platformName}</span>
                <span class="device-status-pill online"><span class="pill-dot"></span>在线</span>
              </div>
              <div class="device-meta-row">
                <span class="device-meta-chip ip-chip" title="IP地址与端口">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
                  ${escapeHtml(dev.ip)}:${escapeHtml(dev.port)}
                </span>
                <span class="device-meta-chip fp-chip" title="设备安全指纹">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
                  指纹: ${escapeHtml(fpText)}
                </span>
              </div>
            </div>
          </div>
          <div class="device-actions-group">
            <button class="btn btn-ghost open-chat-btn" data-device-id="${escapeHtml(dev.id)}" title="进入独立互传会话窗口">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              </svg>
              <span>会话</span>
            </button>
            <button class="btn btn-primary send-to-device-btn ${isSelectedTarget ? 'selected' : ''}" data-device-id="${escapeHtml(dev.id)}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="send-btn-icon">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
              <span>${isSelectedTarget ? '已选定 / 投送' : '投送文件'}</span>
            </button>
          </div>
        </div>
      `;
    }).join('');

    // Bind open-chat buttons
    document.querySelectorAll('.open-chat-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const devId = btn.getAttribute('data-device-id');
        openChatForDevice(devId);
      });
    });

    // Bind send-to-device buttons
    document.querySelectorAll('.send-to-device-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const devId = btn.getAttribute('data-device-id');
        const dev = state.devices.find(d => d.id === devId);
        if (dev) {
          state.targetDevice = dev;
          renderDevicesGrid();
          showToast(`已选定目标设备: ${dev.name} (${dev.ip}:${dev.port})，请选择要投送的文件`);
        }
        dom.filePickerInput.click();
      });
    });

    // Selecting device when card is clicked
    document.querySelectorAll('.device-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.send-to-device-btn') || e.target.closest('.open-chat-btn')) return;
        const devId = card.getAttribute('data-device-id');
        const dev = state.devices.find(d => d.id === devId);
        if (dev) {
          state.targetDevice = dev;
          renderDevicesGrid();
          showToast(`已选定目标设备: ${dev.name} (${dev.ip}:${dev.port})`);
        }
      });
    });
  }

  // 7. Modern device discovery hub beacon initialization
  function initRadarCanvas() {
    // Canvas animation loop removed; replaced with high-performance CSS3 GPU-accelerated discovery beacon
  }

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

  // 9. Handle selected files and start 1MB chunked streaming upload
  function handleFilesSelected(files) {
    if (files.length === 0) return;

    files.forEach(file => {
      startChunkedUploadTask(file);
    });

    switchTab('transfersTab');
    showToast(`已加入 ${files.length} 个传输任务`);
  }

  async function startChunkedUploadTask(file, specificTargetDev = null) {
    const targetDev = specificTargetDev || state.targetDevice;
    const CHUNK_SIZE = 1024 * 1024; // 1MB chunk size
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    const taskObj = {
      id: taskId,
      fileName: file.name,
      fileSize: file.size,
      totalChunks: totalChunks,
      currentChunk: 0,
      bytesUploaded: 0,
      status: 'transferring', // transferring | done | failed
      speed: '0 KB/s',
      targetName: targetDev ? targetDev.name : '电脑安全沙箱',
      isOutgoing: !!targetDev,
      startTime: Date.now()
    };

    state.tasks.unshift(taskObj);
    renderTransfersList();
    updateTaskBadges();

    // Link file transfer into peer chat timeline if targetDev exists
    let chatFileItem = null;
    if (targetDev && targetDev.id) {
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
      saveChatHistories();
      if (state.activeChatPeerId === targetDev.id) {
        renderChatConversation();
      }
      renderChatPeersList();
    }

    let lastBytes = 0;
    let lastTime = Date.now();

    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      if (taskObj.status === 'cancelled') break;

      const start = chunkIdx * CHUNK_SIZE;
      const end = Math.min(file.size, start + CHUNK_SIZE);
      const chunkBlob = file.slice(start, end);

      try {
        const headers = {
          'Content-Type': 'application/octet-stream',
          'x-task-id': taskId,
          'x-file-name': encodeURIComponent(file.name),
          'x-file-size': file.size.toString(),
          'x-chunk-index': chunkIdx.toString(),
          'x-chunk-count': totalChunks.toString()
        };

        if (targetDev && targetDev.ip) {
          headers['x-target-ip'] = targetDev.ip;
          headers['x-target-port'] = (targetDev.port || 8899).toString();
          headers['x-target-name'] = encodeURIComponent(targetDev.name || 'Mobile');
        }

        const res = await fetch('/api/v1/transfer/upload', {
          method: 'POST',
          headers: headers,
          body: chunkBlob
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
          taskObj.speed = formatSpeed(deltaBytes / Math.max(0.1, deltaSec));
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
        taskObj.status = 'failed';
        taskObj.speed = '0 B/s';
        renderTransfersList();
        updateTaskBadges();
        if (chatFileItem) {
          chatFileItem.status = 'failed';
          chatFileItem.speed = '中断';
          saveChatHistories();
          if (state.activeChatPeerId === targetDev?.id) {
            renderChatConversation();
          }
        }
        showToast(`文件 "${file.name}" 传输中断: ${err.message}`);
        return;
      }
    }

    taskObj.status = 'done';
    taskObj.speed = '传输完成';
    renderTransfersList();
    updateTaskBadges();

    if (chatFileItem) {
      chatFileItem.status = 'done';
      chatFileItem.progress = 100;
      chatFileItem.speed = '已落盘';
      saveChatHistories();
      if (state.activeChatPeerId === targetDev?.id) {
        renderChatConversation();
      }
      renderChatPeersList();
    }

    if (targetDev) {
      showToast(`文件 "${file.name}" 已成功投送到目标设备: ${targetDev.name}！`);
    } else {
      showToast(`文件 "${file.name}" 已成功存入电脑安全沙箱！`);
      fetchFiles();
    }
  }

  function renderTransfersList() {
    if (!dom.transfersList) return;

    if (state.tasks.length === 0) {
      dom.noTransfersEmpty.style.display = 'flex';
      return;
    }

    dom.noTransfersEmpty.style.display = 'none';
    dom.transfersList.innerHTML = state.tasks.map(t => {
      const pct = t.fileSize === 0 ? 100 : Math.min(100, Math.round((t.bytesUploaded / t.fileSize) * 100));
      const isDone = t.status === 'done';
      const isFailed = t.status === 'failed';

      return `
        <div class="transfer-item">
          <div class="transfer-head">
            <span class="transfer-file-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                <polyline points="13 2 13 9 20 9"></polyline>
              </svg>
              <span>${escapeHtml(t.fileName)}</span>
              ${t.targetName ? `<span style="font-size:11px;color:var(--accent);margin-left:6px;font-weight:600;">[${escapeHtml(t.targetName)}]</span>` : ''}
            </span>
            <span class="transfer-status-badge ${isDone ? 'status-done' : (isFailed ? 'status-failed' : 'status-transferring')}">
              ${isDone ? '已完成' : (isFailed ? '失败' : `${pct}%`)}
            </span>
          </div>
          <div class="progress-track">
            <div class="progress-fill" style="width: ${pct}%;"></div>
          </div>
          <div class="transfer-foot">
            <span>${formatBytes(t.bytesUploaded)} / ${formatBytes(t.fileSize)} (${t.currentChunk}/${t.totalChunks} 块)</span>
            <span>${escapeHtml(t.speed || '')}</span>
          </div>
        </div>
      `;
    }).join('');
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
          showToast('请先选择对端设备开启会话');
          return;
        }
        if (dom.chatFileInput) dom.chatFileInput.click();
      });
    }
    if (dom.chatQuickSendBtn) {
      dom.chatQuickSendBtn.addEventListener('click', () => {
        if (!state.activeChatPeerId) {
          showToast('请先选择对端设备开启会话');
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
          showToast('目标设备已离线，无法投送');
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
        if (confirm('确认清空此设备的互传与会话记录？')) {
          delete state.peerHistories[state.activeChatPeerId];
          saveChatHistories();
          renderChatConversation();
          showToast('已清空当前会话记录');
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
          showToast('请先选择对端设备');
          return;
        }
        const targetDev = state.devices.find(d => d.id === state.activeChatPeerId);
        if (!targetDev) {
          showToast('目标设备已离线');
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
          showToast(`已复制文本: "${textToCopy.length > 25 ? textToCopy.slice(0, 25) + '...' : textToCopy}"`);
        }).catch(() => {
          showToast('复制成功');
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m5.66 2.83a2 2 0 0 1 0 2.83"></path>
          </svg>
          <p>暂无互联设备</p>
          <span>请在“设备发现”页点击“进入会话”或等待手机上线</span>
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
      const history = state.peerHistories[dev.id] || [];
      const lastItem = history[history.length - 1];
      let lastText = '暂无互传记录';
      if (lastItem) {
        if (lastItem.type === 'file') {
          lastText = `[文件] ${lastItem.fileName}`;
        } else {
          lastText = lastItem.text || '';
        }
      }

      return `
        <div class="chat-peer-item ${isActive ? 'active' : ''}" data-peer-id="${escapeHtml(dev.id)}">
          <div class="chat-peer-avatar ${isPc ? 'pc' : 'mobile'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              ${isPc ? `
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                <line x1="8" y1="21" x2="16" y2="21"></line>
                <line x1="12" y1="17" x2="12" y2="21"></line>
              ` : `
                <rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect>
                <line x1="12" y1="18" x2="12.01" y2="18"></line>
              `}
            </svg>
            <span class="chat-peer-status-dot online"></span>
          </div>
          <div class="chat-peer-info">
            <div class="chat-peer-name-row">
              <span class="chat-peer-name">${escapeHtml(dev.name)}</span>
              <span class="device-platform-tag ${isPc ? 'pc' : 'mobile'}" style="font-size:10px;padding:1px 5px;">${isPc ? 'PC' : '手机'}</span>
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
    if (dom.chatActiveName) dom.chatActiveName.textContent = dev.name;
    if (dom.chatActiveTag) {
      dom.chatActiveTag.className = `device-platform-tag ${isPc ? 'pc' : 'mobile'}`;
      dom.chatActiveTag.textContent = isPc ? '电脑端' : '手机端';
    }
    if (dom.chatActiveMeta) {
      dom.chatActiveMeta.textContent = `IP: ${dev.ip}:${dev.port} | 指纹: ${dev.fingerprint || 'LAN'}`;
    }

    // Render timeline
    if (!dom.chatTimeline) return;
    const history = state.peerHistories[dev.id] || [];
    if (history.length === 0) {
      dom.chatTimeline.innerHTML = `
        <div class="chat-timeline-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
          </svg>
          <p>已与 ${escapeHtml(dev.name)} 建立加密传输通道</p>
          <span>可在此窗口直接拖入文件投送，或在下方输入消息</span>
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
        const pct = item.progress !== undefined ? item.progress : (isDone ? 100 : 0);
        return `
          <div class="chat-file-card ${isOutgoing ? 'outgoing' : 'incoming'}" data-task-id="${escapeHtml(item.id)}">
            <div class="chat-file-header">
              <div class="chat-file-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                  <polyline points="13 2 13 9 20 9"></polyline>
                </svg>
              </div>
              <div class="chat-file-info">
                <div class="chat-file-name" title="${escapeHtml(item.fileName)}">${escapeHtml(item.fileName)}</div>
                <div class="chat-file-meta">
                  <span>${formatBytes(item.fileSize)}</span>
                  <span>•</span>
                  <span>${isOutgoing ? '投送至对端' : '来自对端'}</span>
                </div>
              </div>
              <span class="chat-file-status-tag ${isDone ? 'done' : (isFailed ? 'failed' : 'transferring')}">
                ${isDone ? '传输完成' : (isFailed ? '中断' : `${pct}%`)}
              </span>
            </div>
            ${!isDone && !isFailed ? `
              <div class="chat-file-progress-track">
                <div class="chat-file-progress-fill" style="width: ${pct}%;"></div>
              </div>
            ` : ''}
            <div class="chat-file-footer">
              <span>${escapeHtml(item.speed || (isDone ? '已落盘' : ''))}</span>
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
      showToast('请先选择对端设备');
      return;
    }

    const targetDev = state.devices.find(d => d.id === state.activeChatPeerId);
    if (!targetDev) {
      showToast('目标设备已离线');
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
      await fetch('/api/v1/message/send', {
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
          senderName: state.info?.host?.name || '纸鸢 (Desktop Hub)'
        })
      });
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
      const res = await fetch(`/api/v1/messages/list?since=${state.lastMessageTimestamp}`);
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

  // 10. File vault listing and download
  async function fetchFiles() {
    try {
      const res = await fetch('/api/v1/files/list');
      const data = await res.json();
      if (data.downloadDir) {
        if (dom.sandboxDirText) dom.sandboxDirText.textContent = `落盘沙箱路径: ${data.downloadDir}`;
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
          <p>保险箱中暂无文件</p>
          <span>从手机或电脑投送的文件将安全保存在此</span>
        </div>
      `;
      return;
    }

    dom.filesList.innerHTML = files.map(f => {
      return `
        <div class="file-item">
          <div class="file-head">
            <span class="transfer-file-title">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
              </svg>
              <span>${escapeHtml(f.name)}</span>
            </span>
            <a href="/api/v1/files/download/${encodeURIComponent(f.name)}" download class="btn btn-secondary btn-sm">
              下载
            </a>
          </div>
          <div class="transfer-foot">
            <span>大小: ${formatBytes(f.size)}</span>
            <span>修改时间: ${new Date(f.mtime).toLocaleString()}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // 11. Render ISO/IEC 18004 Standard QR Code (uses qrcode.js engine)
  function renderQrCode() {
    const canvas = dom.qrCanvas;
    if (!canvas || !state.info) return;

    // Select target URI to encode
    const targetText = state.qrMode === 'app'
      ? (state.info.qrUri || `safedrop://pair?ip=${state.info.localIp}&port=${state.info.port}&fp=${state.info.fingerprint}&token=${state.info.token}&pin=${state.info.pin}`)
      : (state.info.webUrl || `http://${state.info.localIp}:${state.info.port}/portal?pin=${state.info.pin}&token=${state.info.token}&fp=${state.info.fingerprint}`);

    if (dom.modalDirectUrl) {
      dom.modalDirectUrl.textContent = targetText;
    }

    try {
      if (typeof window.qrcode !== 'function') {
        console.warn('Standard qrcode generator not found on window, retrying...');
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

      // Micro center anchor dot badge (compact 3x3 modules to preserve error-correction margin)
      const isEyecare = document.body.classList.contains('eyecare-theme');
      const badgeModules = 3;
      const badgeSize = cellSize * badgeModules;
      const bx = (displaySize - badgeSize) / 2;
      const by = (displaySize - badgeSize) / 2;

      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(bx - 1.5, by - 1.5, badgeSize + 3, badgeSize + 3);

      ctx.fillStyle = isEyecare ? '#2E7D56' : '#2563EB';
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
          showToast('配对地址已成功复制到剪贴板！');
        }).catch(() => {
          showToast(`地址: ${textToCopy}`);
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
        showToast('已切换为 SafeDrop App 专享协议二维码');
      });

      dom.qrModeWebBtn.addEventListener('click', () => {
        state.qrMode = 'web';
        dom.qrModeWebBtn.classList.add('active');
        dom.qrModeAppBtn.classList.remove('active');
        renderQrCode();
        showToast('已切换为通用手机相机/网页直连二维码');
      });
    }

    // Refresh PIN inside modal
    if (dom.modalRefreshPinBtn) {
      dom.modalRefreshPinBtn.addEventListener('click', () => {
        refreshPin();
      });
    }

    dom.refreshDevicesBtn.addEventListener('click', () => {
      fetchDevices();
      showToast('正在主动探活局域网设备...');
    });

    dom.refreshFilesBtn.addEventListener('click', () => {
      fetchFiles();
      showToast('文件列表已刷新');
    });

    if (dom.openDirFromFilesBtn) {
      dom.openDirFromFilesBtn.addEventListener('click', () => {
        openStorageDir();
      });
    }

    dom.clearCompletedTasksBtn.addEventListener('click', () => {
      state.tasks = state.tasks.filter(t => t.status === 'transferring');
      updateTaskBadges();
      renderTransfersList();
      showToast('已清理已完成任务');
    });

    dom.refreshPinBtn.addEventListener('click', () => {
      refreshPin();
    });
  }

  // 13. Vault storage settings management
  function initSettingsEvents() {
    if (dom.saveDownloadDirBtn && dom.customDownloadDirInput) {
      dom.saveDownloadDirBtn.addEventListener('click', async () => {
        const newDir = dom.customDownloadDirInput.value.trim();
        if (!newDir) {
          showToast('请输入有效的目录路径');
          return;
        }
        try {
          const res = await fetch('/api/v1/settings/dir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir: newDir })
          });
          const data = await res.json();
          if (res.ok && data.code === 0) {
            if (state.info) state.info.downloadDir = data.downloadDir;
            if (dom.settingsDirDisplay) dom.settingsDirDisplay.textContent = data.downloadDir;
            if (dom.sandboxDirText) dom.sandboxDirText.textContent = `落盘沙箱路径: ${data.downloadDir}`;
            dom.customDownloadDirInput.value = data.downloadDir;
            showToast('文件储存目录已成功更新！');
            fetchFiles();
          } else {
            showToast(data.error || '保存目录失败');
          }
        } catch (e) {
          showToast(`更新目录失败: ${e.message}`);
        }
      });
    }

    if (dom.openDirBtn) {
      dom.openDirBtn.addEventListener('click', () => {
        openStorageDir();
      });
    }

    // Preset shortcut chips
    document.querySelectorAll('.preset-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const presetType = chip.getAttribute('data-path');
        const currentPath = dom.customDownloadDirInput ? dom.customDownloadDirInput.value : '';
        let targetPath = '';

        // Derive user home directory from current path
        const userHomeMatch = currentPath.match(/^([A-Za-z]:\\[Uu]sers\\[^\\]+)/);
        const home = userHomeMatch ? userHomeMatch[1] : 'C:\\SafeDrop';

        if (presetType === 'downloads') {
          targetPath = `${home}\\Downloads\\SafeDrop`;
        } else if (presetType === 'documents') {
          targetPath = `${home}\\Documents\\SafeDrop`;
        } else if (presetType === 'desktop') {
          targetPath = `${home}\\Desktop\\SafeDrop`;
        }

        if (dom.customDownloadDirInput && targetPath) {
          dom.customDownloadDirInput.value = targetPath;
          showToast(`已填入预设路径: ${presetType}`);
        }
      });
    });
  }

  async function openStorageDir() {
    try {
      await fetch('/api/v1/settings/open-dir', { method: 'POST' });
      showToast('已在系统文件资源管理器中打开沙箱目录');
    } catch (e) {
      showToast('打开目录失败');
    }
  }

  // Toast notifications
  function showToast(msg) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    dom.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
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
