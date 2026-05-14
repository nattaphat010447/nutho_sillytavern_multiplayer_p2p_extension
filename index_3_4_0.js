// ES6 Module imports from SillyTavern core
import { eventSource, event_types, chat, name1, name2, messageFormatting } from '../../../../script.js';

// ===== STATE: CONNECTION =====
let peer = null;
let isHost = false;
let myName = '';
let hostConn = null;
let clientConns = {};
let players = {};
let isReady = false;
let waitingBot = false;
let botReplyTimeout = null;
let lastCombinedMessage = '';
let generationStartedConfirmed = false;  // set true when ST accepts the injected message

// ===== STATE: MASQUERADE (Client only) =====
let hijackedName = null;
let hijackedAvatar = null;
let mpObserver = null;

// ===== STATE: INPUT INTEGRATION =====
let mpMainReadyBtn = null;
let mpInterceptActive = false;
let _softNewlineDetected = false;   // set true on first soft-keyboard insertLineBreak event (dynamic mobile detection)

// ===== STATE: INJECTED MESSAGE COUNTER =====
let mpInjectedMesId = 0;

// ===== STATE: LAST READY TEXT (restore on cancel) =====
let lastReadyText = '';

// ===== STATE: PERSONA DESCRIPTION (Client only) =====
let myDescription = '';

// ===== STATE: ROOM MODE =====
// 'normal' — previews shown as ghost messages when players click Ready
// 'hidden' — only ready count shown; messages revealed when bot replies
let roomMode = 'normal';

// ===== STATE: ROOM SETTINGS =====
let maxPlayers = 10;
let maxCharsPerMessage = 0;   // 0 = unlimited

// ===== STATE: UI SETTINGS =====
let panelTheme = 'auto'; // 'auto', 'dark', 'light'

// ===== STATE: IN-ROOM CHAT =====
let roomChatEnabled  = false;       // set by host option, broadcast in welcome
let chatHistory      = [];          // [{ id, peerId, name, text, ts }] max 100
let chatUnread       = 0;           // badge counter — reset on switching to chat tab
let chatTabActive    = false;       // true when chat tab is visible
let lastChatAt       = {};          // peerId → timestamp, for rate-limit 1msg/500ms
let lastChatPeerId   = null;        // for group-bubble grouping
let lastChatTs       = 0;           // timestamp of last rendered message
const CHAT_MAX       = 100;         // ring-buffer limit
const CHAT_GROUP_MS  = 60000;       // group bubbles within 1 minute from same sender

// ===== STATE: PLAYER ROLE =====
let myRole = 'player'; // 'player' | 'spectator'

// ===== STATE: READY TOGGLE GUARD =====
let isToggling = false;

// ===== STATE: GENERATION FAILURE DETECTION =====
let messageReceivedThisRound = false;  // true when MESSAGE_RECEIVED fires during waitingBot
let lastRoundTexts = new Map();        // pid → text snapshot for restore on failure
let _failureHandling = false;          // guard: prevents GENERATION_ENDED + GENERATION_STOPPED double-firing

// ===== STATE: CONNECT BUTTON GUARDS (mobile rapid-tap protection) =====
let _hostingInFlight = false;  // true while mpHost() async flow is in progress
let _joiningInFlight = false;  // true while mpJoin()  async flow is in progress

// ===== STATE: CHAT DIFF SYNC (B: Diff-based real-time sync) =====
let chatSeq = 0;                  // Host: incrementing sequence number for diff broadcasts
let clientMessageMap = new Map(); // Client: msgIndex → DOM element
let lastChatSeq = 0;              // Client: last received diff seq
let pendingDiffs = new Map();     // Host: buffered diffs waiting to flush (key: msgIndex:op)
let diffFlushTimer = null;        // Host: 300ms throttle timer

// ===== STATE: HEARTBEAT =====
const HEARTBEAT_INTERVAL = 15000;   // 15 s — send ping every 15 s
const HEARTBEAT_TIMEOUT  = 90000;   // A3: 90 s — tolerate 6 missed pings (throttled tabs)
let heartbeatTimer     = null;
let lastPongAt         = {};         // host: { peerId → timestamp of last pong }
let lastPingFromHostAt = 0;          // client: timestamp of last ping received from host
let clientWatchdog     = null;

// ===== STATE: WAKE LOCK (Phase 1 — A1) =====
let wakeLockSentinel   = null;       // Screen Wake Lock handle

// ===== STATE: VISIBILITY (Phase 1 — A2/A4) =====
let hiddenSince        = 0;          // timestamp when page became hidden
const HIDDEN_WARN_MS   = 60000;      // A4: warn after 60 s hidden

// ===== STATE: RECONNECT (Phase 2) =====
const MAX_RECONNECT_TRIES  = 3;
const RECONNECT_DELAYS     = [2000, 5000, 10000]; // ms — exponential backoff
let reconnectAttempts  = 0;
let reconnectTimer     = null;
let isReconnecting     = false;

// ===== STATE: SESSION SNAPSHOT (Phase 2 — B1) =====
const MP_SESSION_KEY = 'mp-session';    // sessionStorage key

/** Save enough state to reconnect after a tab freeze/crash */
function saveSessionSnapshot() {
    if (!peer) return;
    try {
        sessionStorage.setItem(MP_SESSION_KEY, JSON.stringify({
            roomCode:        isHost ? peer.id : (hostConn?.peer || ''),
            isHost,
            myName,
            myDescription,
            roomMode,
            myRole,
            ts:              Date.now()
        }));
    } catch {}
}

function loadSessionSnapshot() {
    try {
        const raw = sessionStorage.getItem(MP_SESSION_KEY);
        if (!raw) return null;
        const snap = JSON.parse(raw);
        // Discard stale snapshots (> 10 min)
        if (!snap || Date.now() - snap.ts > 600000) { clearSessionSnapshot(); return null; }
        return snap;
    } catch { return null; }
}

function clearSessionSnapshot() {
    try { sessionStorage.removeItem(MP_SESSION_KEY); } catch {}
}

// ===== STATE: BOT AVATAR CACHE =====
let cachedBotAvatar    = null;
let cachedBotAvatarKey = null;       // avatar filename / DOM src used as cache key

// ===== STATE: PREVIEW ORDER =====
let previewMode = 'manual';   // 'ready' (sort by readyAt asc) | 'manual' (host drag-reorder)
let manualOrder = [];         // host-only: ordered array of peerIds, index 0 = top of display
let lastPlayerList = [];      // client: last received player_update list (for inline status)

// ============================================================
// UTILITY
// ============================================================

function skvojannxlad() {
    const a = (1<<6) | (1<<3) | (1<<2) | (1<<1); // N = 78
    const b = a + 7;                              // U = 85
    const c = b - 1;                              // T = 84
    const d = a - 6;                              // H = 72
    const e = d + 7;                              // O = 79
    const f = 1 << 5;                             // space = 32
    const g = f + 26;                             // : = 58
    const h = g - 17;                             // ) = 41

    return String.fromCharCode(a,b,c,d,e,f,g,h);
}

function isNearBottom(el, threshold = 80) {
    return (el.scrollHeight - el.scrollTop - el.clientHeight) <= threshold;
}

function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Strip <!-- hidden thought --> from text before sending to other clients.
 */
function stripHiddenThoughts(text) {
    const cleaned = String(text || '').replace(/<!--[\s\S]*?-->/g, '💭').trim();
    return cleaned || '💭';
}

// ============================================================
// PERSONA HELPERS
// ============================================================

function getCurrentPersonaName() {
    const el = document.querySelector('#persona_management_current_persona #your_name');
    if (el && el.textContent.trim()) return el.textContent.trim();
    if (typeof name1 !== 'undefined' && name1) return name1;
    return '';
}

function getCurrentPersonaDescription() {
    const allDivs = document.querySelectorAll('div[style*="position: fixed"]');
    for (const d of allDivs) {
        const txt = d.textContent || '';
        if (txt.includes('{{user}}')) return txt.trim();
    }
    const descTextarea = document.querySelector('#persona_description');
    if (descTextarea && descTextarea.value) return descTextarea.value.trim();
    return '';
}

// ============================================================
// BOT INFO CAPTURE (Host only)
// ============================================================

function invalidateBotAvatarCache() {
    cachedBotAvatar    = null;
    cachedBotAvatarKey = null;
}

async function captureBotAvatarBase64() {
    // ── Cache check ───────────────────────────────────────────
    try {
        const context = SillyTavern.getContext();
        const char = context?.characters?.[context?.characterId];
        const cacheKey = char?.avatar || null;
        if (cacheKey && cacheKey === cachedBotAvatarKey && cachedBotAvatar) {
            return cachedBotAvatar;
        }
    } catch { /* fall through to fetch */ }

    // ── Primary: SillyTavern context API ─────────────────────
    try {
        const context = SillyTavern.getContext();
        if (context && context.characterId !== undefined && context.characters) {
            const char = context.characters[context.characterId];
            if (char && char.avatar) {
                const url = `/thumbnail?type=avatar&file=${encodeURIComponent(char.avatar)}`;
                const response = await fetch(url, { credentials: 'include' });
                if (response.ok) {
                    const blob = await response.blob();
                    const result = await new Promise((resolve) => {
                        const reader = new FileReader();
                        reader.onloadend = () => resolve(reader.result);
                        reader.readAsDataURL(blob);
                    });
                    cachedBotAvatarKey = char.avatar;
                    cachedBotAvatar    = result;
                    return result;
                }
            }
        }
    } catch (err) {
        console.warn('[MP-Sync] Context avatar capture failed, trying DOM fallback:', err);
    }

    // ── Fallback: DOM image ───────────────────────────────────
    const avatarImg = document.querySelector('#chat .mes:not(.user_mes) .avatar img')
                   || document.querySelector('#chat .mes .avatar img');
    if (avatarImg && avatarImg.src && avatarImg.src !== window.location.href) {
        try {
            const response = await fetch(avatarImg.src, { credentials: 'include' });
            if (response.ok) {
                const blob = await response.blob();
                const result = await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.readAsDataURL(blob);
                });
                cachedBotAvatarKey = avatarImg.src;
                cachedBotAvatar    = result;
                return result;
            }
        } catch (err) {
            console.warn('[MP-Sync] DOM avatar capture failed:', err);
        }
    }

    return null;
}

function getCurrentBotName() {
    if (typeof name2 !== 'undefined' && name2) return name2;
    const nameEl = document.querySelector('#chat .mes:not(.user_mes) .name_text');
    return nameEl ? nameEl.textContent.trim() : 'Bot';
}

// ============================================================
// MASQUERADE (Client only)
// ============================================================

// ── rAF handle for throttled masquerade ─────────────────────
let _masqRaf = 0;

function startMasquerade(botName, botAvatar) {
    hijackedName = botName || null;
    hijackedAvatar = botAvatar || null;
    // Full scan once for all existing messages on join
    applyMasquerade();

    const chatEl = document.getElementById('chat');
    if (chatEl) {
        mpObserver = new MutationObserver(records => {
            // Fast path: only apply masquerade to newly added nodes (O(1) per mutation)
            let hasAddedNodes = false;
            for (const r of records) {
                if (r.addedNodes.length > 0) {
                    hasAddedNodes = true;
                    r.addedNodes.forEach(node => _applyMasqueradeToNode(node));
                }
            }
            // Fallback: if something other than childList insertions happened
            // (e.g. ST modifying existing mes text/attrs) → do one throttled full scan
            if (!hasAddedNodes && !_masqRaf) {
                _masqRaf = requestAnimationFrame(() => { _masqRaf = 0; applyMasquerade(); });
            }
        });
        // subtree:false — we only care about direct children added to #chat
        // individual text streaming happens inside existing mes children, handled via addedNodes
        mpObserver.observe(chatEl, { childList: true, subtree: false });
    }
}

/** Apply masquerade to a single newly-added DOM node and its subtree. */
function _applyMasqueradeToNode(node) {
    if (!(node instanceof Element)) return;
    if (hijackedAvatar) {
        // Check if node itself is a mes, or contains mes children
        const imgs = node.matches('.mes[is_user="false"] .mesAvatarWrapper .avatar img')
            ? [node]
            : [...node.querySelectorAll('.mes[is_user="false"] .mesAvatarWrapper .avatar img')];
        imgs.forEach(img => { if (img.src !== hijackedAvatar) img.src = hijackedAvatar; });
    }
    if (hijackedName) {
        const spans = node.matches('.mes[is_user="false"] .name_text')
            ? [node]
            : [...node.querySelectorAll('.mes[is_user="false"] .name_text')];
        spans.forEach(span => { if (span.textContent !== hijackedName) span.textContent = hijackedName; });
    }
}

/** Full-scan masquerade — used on join and as fallback. rAF-throttled. */
function applyMasquerade() {
    if (hijackedAvatar) {
        document.querySelectorAll('#chat .mes[is_user="false"] .mesAvatarWrapper .avatar img').forEach(img => {
            if (img.src !== hijackedAvatar) img.src = hijackedAvatar;
        });
    }
    if (hijackedName) {
        document.querySelectorAll('#chat .mes[is_user="false"] .name_text').forEach(span => {
            if (span.textContent !== hijackedName) span.textContent = hijackedName;
        });
    }
}

function stopMasquerade() {
    if (mpObserver) { mpObserver.disconnect(); mpObserver = null; }
    if (_masqRaf) { cancelAnimationFrame(_masqRaf); _masqRaf = 0; }
    hijackedName = null;
    hijackedAvatar = null;
}

// ============================================================
// MAIN CHAT RENDERING (Client only)
// ============================================================

function renderMessageInMainChat(role, name, text, timestamp, msgIndex) {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;

    const isUser = role === 'user';
    const isSystem = role === 'system';
    const displayName = isUser ? name : (hijackedName || name);
    const mesId = mpInjectedMesId++;

    const tsStr = timestamp
        ? timestamp
        : new Date().toLocaleString('th-TH', { dateStyle: 'long', timeStyle: 'short' });

    let formattedText;
    try {
        formattedText = messageFormatting(text, displayName, false, isUser, null);
    } catch (e) {
        formattedText = escapeHtml(text).replace(/\n/g, '<br>');
    }

    const div = document.createElement('div');

    if (isSystem) {
        div.className = 'mes smallSysMes mp_injected';
        div.innerHTML = `
            <div class="mes_block">
                <div class="mes_text">${escapeHtml(text)}</div>
            </div>`;
    } else {
        div.className = `mes mp_injected${isUser ? ' user_mes' : ''}`;
        div.setAttribute('mesid', mesId);
        div.setAttribute('ch_name', escapeHtml(displayName));
        div.setAttribute('is_user', isUser ? 'true' : 'false');
        div.setAttribute('is_system', 'false');
        div.setAttribute('force_avatar', 'true');
        div.setAttribute('timestamp', escapeHtml(tsStr));

        const avatarInner = (!isUser && hijackedAvatar)
            ? `<img src="${escapeHtml(hijackedAvatar)}" alt="${escapeHtml(displayName)}">`
            : '';

        div.innerHTML = `
            <div class="mesAvatarWrapper">
                <div class="avatar">${avatarInner}</div>
            </div>
            <div class="mes_block">
                <div class="ch_name flex-container justifySpaceBetween">
                    <div class="flex-container flex1 alignitemscenter">
                        <div class="flex-container alignItemsBaseline">
                            <span class="name_text">${escapeHtml(displayName)}</span>
                            <small class="timestamp" title="${escapeHtml(tsStr)}">${escapeHtml(tsStr)}</small>
                        </div>
                    </div>
                </div>
                <div class="mes_text">${formattedText}</div>
                <div class="mes_bias"></div>
            </div>`;
    }

    // Phase 5: track msgIndex → DOM for diff updates
    if (msgIndex !== undefined) {
        div.dataset.mpMsgIndex = String(msgIndex);
        clientMessageMap.set(msgIndex, div);
    }

    chatEl.appendChild(div);
    chatEl.scrollTop = chatEl.scrollHeight;
}

function clearMainChatDisplay() {
    const chatEl = document.getElementById('chat');
    if (chatEl) chatEl.innerHTML = '';
    mpInjectedMesId = 0;
    clientMessageMap.clear();
    lastChatSeq = 0;
}

// ============================================================
// PREVIEW (Ghost) MESSAGES — Normal mode only
// ============================================================

function buildPreviewBlock(name, text, isFirst) {
    const sep = isFirst ? '' : '<br>';
    const hasText = text != null && text !== '';
    let bodyHtml;
    if (hasText) {
        let formatted;
        try { formatted = messageFormatting(text, name, false, true, null); }
        catch { formatted = escapeHtml(text).replace(/\n/g, '<br>'); }
        bodyHtml = `<div class="mes_text">${formatted}</div>`;
    } else {
        bodyHtml = `<div class="mes_text"><span class="mp-preview-placeholder">...</span></div>`;
    }
    const tsHtml = hasText ? '<small class="timestamp">⏳ pending...</small>' : '';
    return `${sep}
        <div class="ch_name flex-container justifySpaceBetween">
            <div class="flex-container flex1 alignitemscenter">
                <div class="flex-container alignItemsBaseline">
                    <span class="name_text">${escapeHtml(name)}</span>
                    ${tsHtml}
                </div>
            </div>
        </div>
        ${bodyHtml}`;
}

function updatePreviews(previews) {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;

    // Capture scroll position BEFORE removing/adding DOM nodes
    const stickToBottom = isNearBottom(chatEl, 80);

    document.querySelectorAll('#chat .mes.mp_preview').forEach(el => el.remove());

    if (!Array.isArray(previews) || previews.length === 0) return;

    // Allow null/empty text (renders as placeholder "...")
    const items = previews.filter(p => p && p.name);
    if (!items.length) return;

    const blocks = items
        .map((p, i) => buildPreviewBlock(p.name, p.text ?? null, i === 0))
        .join('');

    if (!blocks) return;

    const div = document.createElement('div');
    div.className = 'mes mp_injected mp_preview user_mes';
    div.setAttribute('is_user', 'true');
    div.setAttribute('is_system', 'false');
    div.innerHTML = `
        <div class="mesAvatarWrapper"><div class="avatar"></div></div>
        <div class="mes_block">${blocks}</div>`;

    chatEl.appendChild(div);

    // Only auto-scroll if user was already near the bottom
    if (stickToBottom) chatEl.scrollTop = chatEl.scrollHeight;
}

// ── Compute display order of peerIds ────────────────────────
function getOrderedPeerIds() {
    if (previewMode === 'ready') {
        const ready = manualOrder
            .filter(id => players[id]?.readyAt)
            .sort((a, b) => (players[a].readyAt || 0) - (players[b].readyAt || 0));
        const notReady = manualOrder.filter(id => players[id] && !players[id].readyAt);
        return [...ready, ...notReady];
    }
    return manualOrder.filter(id => players[id]);
}

function broadcastPreviewUpdate() {
    const ordered = getOrderedPeerIds();
    const previews = ordered
        .filter(id => players[id] && (players[id].role || 'player') === 'player')
        .map(id => ({
            peerId: id,
            name: players[id].name || '?',
            text: players[id].preview ?? null   // null → placeholder "..."
        }));
    updatePreviews(previews);
    broadcastToClients({ type: 'preview_update', previews });
}

// ============================================================
// INTEGRATED INPUT — replace Send button with Ready button
// ============================================================

function isMobileDevice() {
    // Signal 1: UA string (broad coverage incl. newer OSes)
    if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Tablet|KaiOS|HarmonyOS/i.test(navigator.userAgent)) return true;
    // Signal 2: UA Client Hints — most reliable on Chromium 90+
    if (navigator.userAgentData?.mobile === true) return true;
    // Signal 3: iPadOS 13+ reports as Mac but has multitouch
    if (navigator.maxTouchPoints > 1 && /Mac|iPhone|iPad|iPod/i.test(navigator.platform)) return true;
    // Signal 4: ontouchstart + coarse pointer — catches older/custom Android ROMs with spoofed UA
    if ('ontouchstart' in window && window.matchMedia?.('(pointer: coarse)').matches) return true;
    // Signal 5: no hover capability + touch points — Linux phones, some foldables
    if (window.matchMedia?.('(hover: none)').matches && navigator.maxTouchPoints > 0) return true;
    // Signal 6: narrow viewport + any touch support (last-resort heuristic)
    if (navigator.maxTouchPoints > 0 && Math.min(window.innerWidth, window.innerHeight) < 768) return true;
    return false;
}

/**
 * beforeinput listener — detects soft-keyboard line-break on first occurrence.
 * Sets _softNewlineDetected so mpInterceptEnter knows this device behaves mobile-like.
 */
function mpBeforeInput(e) {
    if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
        _softNewlineDetected = true;
    }
}

function mpInterceptEnter(e) {
    if (e.key !== 'Enter') return;
    // IME composition (e.g. Thai/Japanese): let confirm-Enter through normally
    if (e.isComposing || e.keyCode === 229) return;

    // Manual override from Settings
    const enterMode = localStorage.getItem('mp-enter-mode') || 'auto';
    if (enterMode === 'newline') { e.stopPropagation(); e.stopImmediatePropagation(); return; }
    if (enterMode === 'ready' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); mpToggleReady(); return; }

    // Auto-detect: static signals OR dynamic beforeinput detection
    if (isMobileDevice() || _softNewlineDetected) {
        // Mobile: block ST from sending (stopPropagation) but DON'T preventDefault
        // so the textarea still inserts a natural newline character.
        e.stopPropagation();
        e.stopImmediatePropagation();
        return;
    }

    // Desktop: Shift+Enter = newline (fall through), plain Enter = Ready
    if (!e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        mpToggleReady();
    }
}

function integrateSTInput() {
    const sendBtn = document.getElementById('send_but');
    if (!sendBtn || document.getElementById('mp-main-ready-btn')) return;

    sendBtn.dataset.mpOrigDisplay = sendBtn.style.display;
    sendBtn.style.display = 'none';

    mpMainReadyBtn = document.createElement('div');
    mpMainReadyBtn.id = 'mp-main-ready-btn';
    mpMainReadyBtn.className = 'interactable';
    mpMainReadyBtn.title = 'Multiplayer: Click when done typing';
    mpMainReadyBtn.textContent = '✅';
    mpMainReadyBtn.addEventListener('click', mpToggleReady);
    sendBtn.parentNode.insertBefore(mpMainReadyBtn, sendBtn);

    if (!document.getElementById('mp-inline-status')) {
        const inlineEl = document.createElement('div');
        inlineEl.id = 'mp-inline-status';
        inlineEl.innerHTML = '<span id="mp-inline-text" class="mp-waiting">Ready 0/0</span>';
        const nonQR = document.getElementById('nonQRFormItems');
        if (nonQR && nonQR.parentNode) nonQR.parentNode.insertBefore(inlineEl, nonQR);
        else sendBtn.parentNode.insertBefore(inlineEl, mpMainReadyBtn);
    }
    updateInlineStatus();

    const textarea = document.getElementById('send_textarea');
    if (textarea) {
        textarea.addEventListener('keydown', mpInterceptEnter, true);
        textarea.addEventListener('beforeinput', mpBeforeInput, true);
        textarea.dataset.mpOrigPlaceholder = textarea.placeholder;
        textarea.placeholder = '[Multiplayer] Type a message, or /? for help';
        mpInterceptActive = true;
    }
}

function restoreSTInput() {
    const sendBtn = document.getElementById('send_but');
    if (sendBtn && sendBtn.dataset.mpOrigDisplay !== undefined) {
        sendBtn.style.display = sendBtn.dataset.mpOrigDisplay;
        delete sendBtn.dataset.mpOrigDisplay;
    }

    document.getElementById('mp-main-ready-btn')?.remove();
    document.getElementById('mp-inline-status')?.remove();
    mpMainReadyBtn = null;

    if (mpInterceptActive) {
        const textarea = document.getElementById('send_textarea');
        if (textarea) {
            textarea.removeEventListener('keydown', mpInterceptEnter, true);
            textarea.removeEventListener('beforeinput', mpBeforeInput, true);
            if (textarea.dataset.mpOrigPlaceholder !== undefined) {
                textarea.placeholder = textarea.dataset.mpOrigPlaceholder;
                delete textarea.dataset.mpOrigPlaceholder;
            }
        }
        mpInterceptActive = false;
    }
}

function setMainReadyBtnState(enabled, readyState, role) {
    if (!mpMainReadyBtn) return;
    const r = role !== undefined ? role : myRole;
    if (r === 'spectator') {
        mpMainReadyBtn.style.opacity = '1';
        mpMainReadyBtn.style.pointerEvents = 'auto';
        mpMainReadyBtn.textContent = '👁';
        mpMainReadyBtn.title = 'Spectating — Click to resume as Player';
        return;
    }
    mpMainReadyBtn.title = 'Multiplayer: Click when done typing';
    mpMainReadyBtn.style.opacity = enabled ? '1' : '0.4';
    mpMainReadyBtn.style.pointerEvents = enabled ? 'auto' : 'none';
    if (readyState === true) mpMainReadyBtn.textContent = '❌';
    else if (readyState === false) mpMainReadyBtn.textContent = '✅';
}

// ============================================================
// SPECTATOR ROLE HELPERS
// ============================================================

/**
 * Change my own role and sync UI + notify host.
 * @param {'player'|'spectator'} role
 */
function setMyRole(role) {
    if (myRole === role) return;
    myRole = role;
    _syncRoleUI();

    if (role === 'spectator') {
        // Cancel ready state regardless of current ready state
        if (isReady) {
            isReady = false;
            lastReadyText = '';
        }
        if (isHost && peer && players[peer.id]) {
            players[peer.id].ready   = false;
            players[peer.id].text    = '';
            players[peer.id].preview = null;
            players[peer.id].readyAt = null;
            players[peer.id].role    = 'spectator';
            renderPlayerList();
            broadcastPlayerUpdate();
            if (roomMode === 'normal') broadcastPreviewUpdate();
            checkAllReady();                                        // fix(v3.1.6): trigger after host self-demotes to spectator
        } else if (hostConn && hostConn.open) {
            // Always notify host when becoming spectator (even if not ready)
            hostConn.send({ type: 'set_role', role });
        }
    } else if (role === 'player') {
        if (isHost && peer && players[peer.id]) {
            players[peer.id].role = 'player';
            renderPlayerList();
            broadcastPlayerUpdate();
            if (roomMode === 'normal') broadcastPreviewUpdate();   // Bug #2 fix: restore own preview
            checkAllReady();                                        // re-check in case others were waiting
        } else if (hostConn && hostConn.open) {
            hostConn.send({ type: 'set_role', role });
        }
    }
    updateInlineStatus();
    showToast(role === 'spectator' ? '👁 You are now Spectating' : '▶ Rejoined as Player', 'info');
}

function _syncRoleUI() {
    if (myRole === 'spectator') {
        setMainReadyBtnState(true, false, 'spectator');
        const ta = document.getElementById('send_textarea');
        if (ta) ta.disabled = true;
    } else {
        setMainReadyBtnState(true, isReady, 'player');
        if (!waitingBot) {
            const ta = document.getElementById('send_textarea');
            if (ta) ta.disabled = false;
        }
    }
}

// ============================================================
// CONFIRMATION DIALOG
// ============================================================

function showJoinConfirmation(onConfirm) {
    const ok = window.confirm(
        '⚠️ To join Multiplayer\n\n' +
        'Your current chat messages will be replaced with the host\'s history\n\n' +
        'Have you backed up your chat or created a new one?\n\n' +
        '(Select "OK" to proceed, "Cancel" to go back)'
    );
    if (ok) onConfirm();
}

// ============================================================
// BROADCAST
// ============================================================

function broadcastToClients(data) {
    Object.values(clientConns).forEach(conn => {
        if (conn && conn.open) conn.send(data);
    });
}

function getRecentChatLog() {
    if (!chat || !Array.isArray(chat)) return [];
    const start = Math.max(0, chat.length - 10);
    return chat.slice(start).map((msg, i) => ({
        msgIndex: start + i,          // absolute index in chat[] — used for diff targeting
        role: msg.is_user ? 'user' : 'bot',
        name: msg.name || 'Unknown',
        text: msg.mes || ''
    }));
}

// ============================================================
// CHAT DIFF SYNC — Host side (Phase 2-3)
// ============================================================

/**
 * Queue a diff for throttled broadcast to all clients.
 * Uses (msgIndex:op) as key so rapid edits to same msg collapse into one broadcast.
 */
function queueDiff(diff) {
    if (!isHost) return;
    pendingDiffs.set(`${diff.msgIndex}:${diff.op}`, diff);
    if (diffFlushTimer) return;
    diffFlushTimer = setTimeout(() => {
        diffFlushTimer = null;
        pendingDiffs.forEach(d => {
            broadcastToClients({ type: 'msg_diff', seq: ++chatSeq, ...d });
        });
        pendingDiffs.clear();
    }, 300);
}

function onHostMessageEdited(messageId) {
    if (!isHost || waitingBot) return;
    const msg = chat?.[messageId];
    if (!msg) return;
    queueDiff({
        op: 'edit',
        msgIndex: messageId,
        text: msg.mes || '',
        name: msg.name || '',
        role: msg.is_user ? 'user' : 'bot'
    });
}

function onHostMessageDeleted(messageId) {
    if (!isHost) return;
    queueDiff({ op: 'delete', msgIndex: messageId });
}

function onHostMessageSwiped(messageId) {
    if (!isHost || waitingBot) return;
    const msg = chat?.[messageId];
    if (!msg) return;
    queueDiff({
        op: 'edit',          // swipe = text replacement only
        msgIndex: messageId,
        text: msg.mes || '',
        name: msg.name || '',
        role: 'bot'
    });
}

function bindHostDiffEvents() {
    if (!eventSource) return;
    // Remove first to prevent double-binding on reconnect
    if (eventSource.removeListener) {
        eventSource.removeListener(event_types.MESSAGE_EDITED,   onHostMessageEdited);
        eventSource.removeListener(event_types.MESSAGE_DELETED,  onHostMessageDeleted);
        eventSource.removeListener(event_types.MESSAGE_SWIPED,   onHostMessageSwiped);
    }
    eventSource.on(event_types.MESSAGE_EDITED,   onHostMessageEdited);
    eventSource.on(event_types.MESSAGE_DELETED,  onHostMessageDeleted);
    eventSource.on(event_types.MESSAGE_SWIPED,   onHostMessageSwiped);
}

function unbindHostDiffEvents() {
    if (!eventSource || !eventSource.removeListener) return;
    eventSource.removeListener(event_types.MESSAGE_EDITED,   onHostMessageEdited);
    eventSource.removeListener(event_types.MESSAGE_DELETED,  onHostMessageDeleted);
    eventSource.removeListener(event_types.MESSAGE_SWIPED,   onHostMessageSwiped);
    // Flush any pending diffs
    if (diffFlushTimer) { clearTimeout(diffFlushTimer); diffFlushTimer = null; }
    pendingDiffs.clear();
}

// ============================================================
// CHAT DIFF SYNC — Client side (Phase 4)
// ============================================================

/**
 * Apply a diff received from host.
 * Handles: edit (text update in place) and delete (remove + re-index).
 */
function handleChatDiff(diff) {
    // Sequence gap check — if we missed a diff, fall back to full sync
    if (lastChatSeq > 0 && diff.seq !== lastChatSeq + 1) {
        console.warn(`[MP-Sync] Diff seq gap: expected ${lastChatSeq + 1}, got ${diff.seq} — requesting full sync`);
        if (hostConn?.open) hostConn.send({ type: 'request_sync' });
        lastChatSeq = diff.seq; // update anyway to avoid spam
        return;
    }
    lastChatSeq = diff.seq;

    switch (diff.op) {
        case 'edit': {
            const el = clientMessageMap.get(diff.msgIndex);
            if (!el) {
                // Unknown msgIndex (message predates join window) — request full sync
                if (hostConn?.open) hostConn.send({ type: 'request_sync' });
                return;
            }
            const textEl = el.querySelector('.mes_text');
            if (!textEl) return;
            try {
                textEl.innerHTML = messageFormatting(diff.text, diff.name, false, diff.role === 'user', null);
            } catch {
                textEl.innerHTML = escapeHtml(diff.text).replace(/\n/g, '<br>');
            }
            break;
        }
        case 'delete': {
            const el = clientMessageMap.get(diff.msgIndex);
            if (el) el.remove();
            // Re-index: every entry with index > deleted one decrements by 1
            const newMap = new Map();
            clientMessageMap.forEach((node, idx) => {
                if (idx < diff.msgIndex) {
                    newMap.set(idx, node);
                } else if (idx > diff.msgIndex) {
                    newMap.set(idx - 1, node);
                }
                // idx === diff.msgIndex → already removed above
            });
            clientMessageMap = newMap;
            break;
        }
        default:
            console.warn('[MP-Sync] Unknown diff op:', diff.op);
    }
}

// ============================================================
// STATUS & PLAYER LIST
// ============================================================

function setStatus(msg, level = 'auto') {
    const el = document.getElementById('mp-status-bar');
    if (el) el.textContent = msg;
    // Update status pill colour
    const pill = document.getElementById('mp-status-pill');
    if (!pill) return;
    pill.className = 'mp-status-pill';

    if (level === 'auto') {
        const m = msg.toLowerCase();
        // Error/negative states — checked FIRST (highest priority)
        if (m.includes('failed') || m.includes('error') || m.includes('timeout') ||
            m.includes('kicked') || m.includes('⚠') || m.includes('lost') || m.includes('unavailable')) {
            level = 'err';
        }
        // Idle/neutral states — checked BEFORE 'connected' to prevent "Not connected" false-positive
        else if (/^not connected|^left |\bf5\b|restore/.test(m)) {
            level = 'idle';
        }
        // Waiting / in-progress states
        else if (m.includes('waiting') || m.includes('connecting') || m.includes('creating') || m.includes('syncing')) {
            level = 'wait';
        }
        // OK / success states
        else if (m.includes('connected') || m.includes('joined') || m.includes('new round') ||
                 m.includes('sync') || m.includes('saved') || m.includes('type and click') ||
                 m.includes('people')) {
            level = 'ok';
        }
        // else remains 'auto' → treated as idle (no class)
    }

    if (level === 'ok')        pill.classList.add('mp-status-ok');
    else if (level === 'wait') pill.classList.add('mp-status-wait');
    else if (level === 'err')  pill.classList.add('mp-status-err');
    // 'idle' / 'auto' → no class → default grey dot

    // Sync mini dot (visible only in minimized mode)
    const miniDot = document.getElementById('mp-mini-dot');
    if (miniDot) {
        miniDot.className = 'mp-mini-dot';
        if (level === 'ok')        miniDot.classList.add('mp-mini-ok');
        else if (level === 'wait') miniDot.classList.add('mp-mini-wait');
        else if (level === 'err')  miniDot.classList.add('mp-mini-err');
    }
}

function broadcastPlayerUpdate() {
    const ordered = getOrderedPeerIds();
    broadcastToClients({
        type: 'player_update',
        players: ordered
            .filter(id => players[id])
            .map(id => ({ peerId: id, name: players[id].name, ready: players[id].ready, role: players[id].role || 'player' }))
    });
}

// ── Avatar color: deterministic hue from name ────────────────
function getAvatarColor(name) {
    let h = 0;
    for (let i = 0; i < (name || '').length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
    return `hsl(${Math.abs(h) % 360},50%,40%)`;
}

function renderPlayerList(playerArray) {
    const playersEl = document.getElementById('mp-players');
    if (!playersEl) return;

    playersEl.innerHTML = '';
    let readyCount = 0;
    let total = 0;
    let spectatorCount = 0;

    if (isHost && !Array.isArray(playerArray)) {
        // ── Host view: order toggle + reorder buttons ────────
        const orderCtrl = document.getElementById('mp-order-ctrl');
        if (orderCtrl) {
            orderCtrl.style.display = '';
            orderCtrl.querySelectorAll('.mp-order-opt').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.mode === previewMode);
            });
        }

        const ordered = getOrderedPeerIds();

        ordered.forEach((peerId, idx) => {
            const p = players[peerId];
            if (!p) return;
            const role = p.role || 'player';
            if (role === 'player') { total++; readyCount += p.ready ? 1 : 0; }
            else spectatorCount++;
            const row = document.createElement('div');
            row.className = 'mp-player-row';
            const isMe = peer && peerId === peer.id;
            const kickBtn = isMe ? '' : `<button class="mp-kick-btn" data-peer-id="${escapeHtml(peerId)}" title="Kick">✕</button>`;
            const initial = escapeHtml(((p.name || '?')[0]).toUpperCase());
            const color = getAvatarColor(p.name || peerId);

            // Drag grip — only in manual mode
            const gripHtml = previewMode === 'manual'
                ? `<span class="mp-drag-grip-row" title="Drag to reorder">⠿</span>`
                : '';

            // Status indicator (✓/…) — always a plain span, never changes to 👁
            const isSpectating = role === 'spectator';
            const statusHtml = `<span class="mp-player-status ${p.ready ? 'mp-status-ready' : 'mp-status-waiting'}">${p.ready ? '✓' : '…'}</span>`;

            // Spectate toggle button — separate column, always visible for host
            const spectateTitle = isSpectating ? 'Spectating — click to make Player' : 'Make Spectator';
            const spectateBtn = `<button class="mp-spectate-btn${isSpectating ? ' mp-spectating-active' : ''}" data-peer-id="${escapeHtml(peerId)}" title="${spectateTitle}">👁</button>`;

            row.innerHTML = `
                ${gripHtml}
                <div class="mp-avatar" style="background:${color}">${initial}</div>
                <span class="mp-player-name">${escapeHtml(p.name || 'Connecting...')}</span>
                ${statusHtml}
                ${spectateBtn}
                ${kickBtn}
            `;
            row.dataset.peerId = peerId;
            playersEl.appendChild(row);
        });

        // Kick buttons
        playersEl.querySelectorAll('.mp-kick-btn').forEach(btn => {
            btn.addEventListener('click', () => mpKickPlayer(btn.dataset.peerId));
        });

        // Spectate toggle buttons — host clicks 👁 to toggle spectator role for any player
        playersEl.querySelectorAll('.mp-spectate-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const pid = btn.dataset.peerId;
                if (!pid) return;
                // If it's the host's own row, use setMyRole
                if (peer && pid === peer.id) {
                    setMyRole(players[pid]?.role === 'spectator' ? 'player' : 'spectator');
                    return;
                }
                // Force a client's role
                const currentRole = players[pid]?.role || 'player';
                const newRole = currentRole === 'spectator' ? 'player' : 'spectator';
                if (players[pid]) {
                    players[pid].role = newRole;
                    if (newRole === 'spectator') {
                        players[pid].ready   = false;
                        players[pid].text    = '';
                        players[pid].preview = null;
                        players[pid].readyAt = null;
                    }
                }
                // Notify the client about their forced role
                if (clientConns[pid]?.open) {
                    clientConns[pid].send({ type: 'forced_role', role: newRole });
                }
                renderPlayerList();
                broadcastPlayerUpdate();
                if (roomMode === 'normal') broadcastPreviewUpdate();
                checkAllReady();
            });
        });

        // Drag-to-reorder (Pointer Events — works on mouse, touch, stylus)
        if (previewMode === 'manual') {
            attachRowDragAndDrop(playersEl, ordered);
        }

    } else {
        // ── Client view: render ordered list received from host ──
        // Order control is Host-only — always hide for clients
        const _oc = document.getElementById('mp-order-ctrl');
        if (_oc) _oc.style.display = 'none';

        const list = Array.isArray(playerArray) ? playerArray : Object.values(players);
        list.forEach(p => {
            const role = p.role || 'player';
            if (role === 'player') { total++; if (p.ready) readyCount++; }
            else spectatorCount++;
            const row = document.createElement('div');
            row.className = 'mp-player-row';
            const initial = escapeHtml(((p.name || '?')[0]).toUpperCase());
            const color = getAvatarColor(p.name || '');

            // Status indicator (✓/…) — always a plain span
            const isMe = peer && p.peerId && p.peerId === peer.id;
            const isSpectating = role === 'spectator';
            const statusClass = p.ready ? 'mp-status-ready' : 'mp-status-waiting';
            const statusHtml = `<span class="mp-player-status ${statusClass}">${p.ready ? '✓' : '…'}</span>`;

            // Spectate toggle button — only on own row
            const spectateBtn = isMe
                ? `<button class="mp-spectate-btn${isSpectating ? ' mp-spectating-active' : ''}" title="${isSpectating ? 'Spectating — click to resume as Player' : 'Become Spectator'}">👁</button>`
                : '';

            row.innerHTML = `
                <div class="mp-avatar" style="background:${color}">${initial}</div>
                <span class="mp-player-name">${escapeHtml(p.name || 'Connecting...')}</span>
                ${statusHtml}
                ${spectateBtn}
            `;
            playersEl.appendChild(row);
        });

        // Self-spectate toggle for client — own row only
        playersEl.querySelectorAll('.mp-spectate-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                setMyRole(myRole === 'spectator' ? 'player' : 'spectator');
            });
        });
    }

    // Update progress bar + label
    const barEl = document.getElementById('mp-ready-bar');
    const labelEl = document.getElementById('mp-ready-label');
    if (barEl) {
        barEl.style.width = total > 0 ? `${(readyCount / total) * 100}%` : '0%';
        barEl.className = 'mp-ready-bar-fill' + (readyCount === total && total > 0 ? ' mp-bar-full' : '');
    }
    const spectatorSuffix = spectatorCount > 0 ? ` (+${spectatorCount} 👁)` : '';
    if (labelEl) labelEl.textContent = `${readyCount}/${total} ready${spectatorSuffix}`;

    if (total > 0 && !waitingBot) setStatus(`Ready ${readyCount}/${total} people${spectatorSuffix}`);
    updateInlineStatus(readyCount, total, spectatorCount);
}

// ============================================================
// DRAG-TO-REORDER (Pointer Events — mouse + touch + stylus)
// ============================================================

function attachRowDragAndDrop(listEl, ordered) {
    // Only rows with a grip handle can be dragged
    listEl.querySelectorAll('.mp-drag-grip-row').forEach(grip => {
        grip.addEventListener('pointerdown', onGripDown, { passive: false });
    });

    let draggingRow  = null;   // the DOM row being dragged
    let draggingId   = null;   // its peerId
    let ghostEl      = null;   // floating clone following the pointer
    let startY       = 0;
    let rowHeight    = 0;
    let overRow      = null;   // last row we hovered

    function onGripDown(e) {
        // Ignore anything other than primary pointer (left mouse / first touch)
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();

        const row = e.currentTarget.closest('.mp-player-row');
        if (!row || !row.dataset.peerId) return;

        draggingId  = row.dataset.peerId;
        draggingRow = row;
        startY      = e.clientY;
        rowHeight   = row.offsetHeight;

        // Create a lightweight ghost clone
        ghostEl = row.cloneNode(true);
        ghostEl.style.cssText = `
            position: fixed;
            left: ${row.getBoundingClientRect().left}px;
            top:  ${row.getBoundingClientRect().top}px;
            width: ${row.offsetWidth}px;
            height: ${rowHeight}px;
            pointer-events: none;
            z-index: 99999;
            opacity: 0.85;
            box-shadow: 0 6px 20px rgba(0,0,0,0.45);
            border-radius: 8px;
            transition: none;
        `;
        document.body.appendChild(ghostEl);

        row.classList.add('mp-row-dragging');

        // Capture pointer so events keep firing even if pointer leaves the element
        e.currentTarget.setPointerCapture(e.pointerId);

        document.addEventListener('pointermove', onPointerMove, { passive: false });
        document.addEventListener('pointerup',   onPointerUp);
        document.addEventListener('pointercancel', onPointerUp);
    }

    function onPointerMove(e) {
        if (!draggingRow || !ghostEl) return;
        e.preventDefault();

        ghostEl.style.top = `${e.clientY - rowHeight / 2}px`;

        // Clear previous indicator
        if (overRow && overRow !== draggingRow) {
            overRow.classList.remove('mp-drag-over-top', 'mp-drag-over-bottom');
        }

        // Find which row the ghost is hovering over
        const rows = [...listEl.querySelectorAll('.mp-player-row')].filter(r => r !== draggingRow);
        let closest = null;
        let closestDist = Infinity;
        for (const r of rows) {
            const rect = r.getBoundingClientRect();
            const mid  = rect.top + rect.height / 2;
            const dist = Math.abs(e.clientY - mid);
            if (dist < closestDist) { closestDist = dist; closest = r; }
        }

        if (closest) {
            overRow = closest;
            const rect   = closest.getBoundingClientRect();
            const isAbove = e.clientY < rect.top + rect.height / 2;
            closest.classList.toggle('mp-drag-over-top',    isAbove);
            closest.classList.toggle('mp-drag-over-bottom', !isAbove);
        } else {
            overRow = null;
        }
    }

    function onPointerUp(e) {
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup',   onPointerUp);
        document.removeEventListener('pointercancel', onPointerUp);

        if (ghostEl) { ghostEl.remove(); ghostEl = null; }
        if (draggingRow) draggingRow.classList.remove('mp-row-dragging');

        // Apply reorder if we have a valid drop target
        if (overRow && overRow !== draggingRow && overRow.dataset.peerId) {
            overRow.classList.remove('mp-drag-over-top', 'mp-drag-over-bottom');

            const fromIdx = manualOrder.indexOf(draggingId);
            const toId    = overRow.dataset.peerId;
            const toIdx   = manualOrder.indexOf(toId);

            if (fromIdx >= 0 && toIdx >= 0 && fromIdx !== toIdx) {
                const rect   = overRow.getBoundingClientRect();
                const isAbove = (e.clientY || startY) < rect.top + rect.height / 2;
                // Remove from current position, insert at target
                manualOrder.splice(fromIdx, 1);
                const insertAt = manualOrder.indexOf(toId) + (isAbove ? 0 : 1);
                manualOrder.splice(insertAt, 0, draggingId);

                renderPlayerList();
                if (roomMode === 'normal') broadcastPreviewUpdate();
                broadcastPlayerUpdate();
            }
        } else if (overRow) {
            overRow.classList.remove('mp-drag-over-top', 'mp-drag-over-bottom');
        }

        draggingRow = null;
        draggingId  = null;
        overRow     = null;
    }
}

// ============================================================
// READY SYSTEM
// ============================================================

function getPlayerInput() {
    return document.getElementById('send_textarea') || document.getElementById('mp-msg-input');
}

function mpToggleReady() {
    if (waitingBot || isToggling) return;
    if (myRole === 'spectator') { setMyRole('player'); return; }
    isToggling = true;
    setTimeout(() => { isToggling = false; }, 300);

    const textarea = getPlayerInput();
    if (!textarea) return;

    if (!isReady) {
        const text = textarea.value.trim();
        if (!text) {
            alert('Please type a message before clicking Ready');
            return;
        }
        if (maxCharsPerMessage > 0 && text.length > maxCharsPerMessage) {
            showToast(`❌ Message too long: ${text.length}/${maxCharsPerMessage} chars`, 'error');
            return;
        }

        isReady = true;
        lastReadyText = text;
        textarea.value = '';
        setMainReadyBtnState(true, true);

        if (isHost && peer) {
            if (players[peer.id]) {
                players[peer.id].ready   = true;
                players[peer.id].text    = text;
                players[peer.id].readyAt = Date.now();
                if (roomMode === 'normal') players[peer.id].preview = stripHiddenThoughts(text);
            }
            renderPlayerList();
            broadcastPlayerUpdate();
            if (roomMode === 'normal') broadcastPreviewUpdate();
            checkAllReady();
        } else if (hostConn && hostConn.open) {
            hostConn.send({ type: 'ready', name: myName, text });
        }
    } else {
        isReady = false;
        const cancelTextarea = getPlayerInput();
        if (cancelTextarea && lastReadyText) cancelTextarea.value = lastReadyText;
        lastReadyText = '';
        setMainReadyBtnState(true, false);

        if (isHost && peer) {
            if (players[peer.id]) {
                players[peer.id].ready   = false;
                players[peer.id].text    = '';
                players[peer.id].preview = null;
                players[peer.id].readyAt = null;
            }
            renderPlayerList();
            broadcastPlayerUpdate();
            if (roomMode === 'normal') broadcastPreviewUpdate();
        } else if (hostConn && hostConn.open) {
            hostConn.send({ type: 'cancel', name: myName });
        }
    }
}

// ============================================================
// CHECK ALL READY (Host)
// ============================================================

function checkAllReady() {
    if (waitingBot) return;

    const keys = Object.keys(players).filter(k => (players[k].role || 'player') === 'player');
    const total = keys.length;
    if (total < 1) return;

    let readyCount = 0;
    let allReady = true;
    keys.forEach(k => {
        if (players[k].ready) readyCount++;
        else allReady = false;
    });

    setStatus(`Ready ${readyCount}/${total} people`);
    if (allReady) collectAndSend();
}

// ============================================================
// COLLECT AND SEND (Host)
// ============================================================

function collectAndSend() {
    const hostId = peer ? peer.id : null;
    const activePlayers = Object.entries(players).filter(([, p]) => (p.role || 'player') === 'player');
    const playerCount = activePlayers.length;
    let combined = `<!-- ${playerCount} player${playerCount !== 1 ? 's' : ''} in this round -->\n`;
    activePlayers.forEach(([pid, p]) => {
            const isHostPlayer = (pid === hostId);
            if (isHostPlayer) {
                combined += `**${p.name}** : ${p.text}\n`;
            } else {
                const desc = (p.description && p.description.trim()) || 'The Other Person';
                combined += `**${p.name}** <!-- (!!NOT NPC!!) Description : (${desc}) --> : ${p.text}\n`;
            }
        });
    lastCombinedMessage = combined;

    // Snapshot each player's text so we can restore them on failure
    lastRoundTexts.clear();
    activePlayers.forEach(([pid, p]) => lastRoundTexts.set(pid, p.text || ''));
    messageReceivedThisRound = false;
    _failureHandling = false;

    waitingBot = true;
    broadcastToClients({ type: 'round_start', combined: lastCombinedMessage });
    setStatus('Waiting for bot reply...');
    setMainReadyBtnState(false, false);

    // Normal mode: clear host preview immediately — combined is about to appear via ST inject
    if (roomMode === 'normal') updatePreviews([]);

    injectMessageToST(combined);

    const textarea = document.getElementById('send_textarea');
    if (textarea) textarea.disabled = true;

    botReplyTimeout = setTimeout(() => {
        if (waitingBot) {
            waitingBot = false;
            broadcastToClients({ type: 'error', message: 'Bot did not respond within the allotted time. Please try again.' });
            resetRound();
            setStatus('Bot timeout — Please try again');
        }
    }, 180000);
}

async function injectMessageToST(text, retryCount = 0) {
    const stTextarea = document.getElementById('send_textarea');
    const stSendBtn = document.getElementById('send_but');

    if (!stTextarea || !stSendBtn) {
        console.error('[MP-Sync] Cannot find ST input elements');
        setStatus('Cannot send message to ST');
        waitingBot = false;
        if (botReplyTimeout) clearTimeout(botReplyTimeout);
        return;
    }

    const sendBtnWasHidden = stSendBtn.style.display === 'none';

    stTextarea.disabled = false;
    if (sendBtnWasHidden) stSendBtn.style.display = '';

    // Use native setter so ST/jQuery/React detects the change correctly
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeSetter) {
        nativeSetter.call(stTextarea, text);
    } else {
        stTextarea.value = text;
    }
    stTextarea.dispatchEvent(new Event('input',  { bubbles: true }));
    stTextarea.dispatchEvent(new Event('change', { bubbles: true }));

    // Wait one animation frame so ST processes the input event before the click
    await new Promise(r => requestAnimationFrame(r));

    generationStartedConfirmed = false;
    stSendBtn.click();

    if (sendBtnWasHidden) stSendBtn.style.display = 'none';

    // Verify ST accepted the message — expect GENERATION_STARTED within 3s
    setTimeout(() => {
        if (!waitingBot) return;                // round ended normally — all good
        if (generationStartedConfirmed) return; // ST confirmed it started

        console.warn(`[MP-Sync] injectMessageToST: no GENERATION_STARTED after 3s (attempt ${retryCount + 1})`);

        if (retryCount < 1) {
            // One automatic retry
            showToast('⚠ Retrying send...', 'warning');
            injectMessageToST(text, retryCount + 1);
        } else {
            // Final failure — tell host and all clients to try again
            showToast('⚠ Could not send — Click Ready to retry', 'error');
            setStatus('⚠ Could not send to ST — Please try again');
            waitingBot = false;
            if (botReplyTimeout) { clearTimeout(botReplyTimeout); botReplyTimeout = null; }
            broadcastToClients({ type: 'error', message: '⚠ Host failed to send to bot. Please click Ready again.' });
            resetRound();
        }
    }, 3000);
}

function updateInlineStatus(readyCount, total, spectatorCount) {
    const el = document.getElementById('mp-inline-text');
    if (!el) return;
    if (waitingBot) {
        el.textContent = '🤖 Waiting for bot reply...';
        el.className = 'mp-bot';
        return;
    }
    let rc, tot, sc;
    if (total !== undefined) {
        rc  = readyCount;
        tot = total;
        sc  = spectatorCount || 0;
    } else {
        const activePlayers = Object.values(players).filter(p => (p.role || 'player') === 'player');
        rc  = activePlayers.filter(p => p.ready).length;
        tot = activePlayers.length;
        sc  = Object.values(players).filter(p => (p.role || 'player') === 'spectator').length;
    }
    if (myRole === 'spectator') {
        el.textContent = `👁 Spectating (Ready ${rc}/${tot})`;
        el.className = 'mp-spectating';
    } else {
        const suffix = sc > 0 ? ` (${sc} 👁)` : '';
        el.textContent = `Ready ${rc}/${tot}${suffix}`;
        el.className = (rc === tot && tot > 0) ? 'mp-all-ready' : 'mp-waiting';
    }
}

function resetRound() {
    isReady = false;
    lastReadyText = '';
    messageReceivedThisRound = false;
    _failureHandling = false;
    Object.values(players).forEach(p => { p.ready = false; p.text = ''; p.preview = null; p.readyAt = null; });
    if (roomMode === 'normal') broadcastPreviewUpdate(); else updatePreviews([]);
    renderPlayerList();
    broadcastPlayerUpdate();
    setMainReadyBtnState(true, false);
    updateInlineStatus();

    const textarea = document.getElementById('send_textarea');
    if (textarea) textarea.disabled = false;
}

// ============================================================
// GENERATION FAILURE HANDLER (Host only)
// ============================================================

/**
 * Called when ST finishes/stops generation without producing a message.
 * Deletes the combined user message we injected, restores each player's
 * original text, and resets the round so everyone can retry.
 */
async function handleGenerationFailure(reason) {
    if (!isHost || !waitingBot) return;
    if (_failureHandling) return;   // deduplicate: GENERATION_STOPPED + GENERATION_ENDED both fire on stop
    _failureHandling = true;

    // Wait 500ms to allow a late MESSAGE_RECEIVED to arrive (race guard)
    await new Promise(r => setTimeout(r, 500));

    // If round resolved during the wait (bot replied or already handled), bail out
    if (!waitingBot || messageReceivedThisRound) { _failureHandling = false; return; }

    console.warn(`[MP-Sync] Generation failed: ${reason}`);
    if (botReplyTimeout) { clearTimeout(botReplyTimeout); botReplyTimeout = null; }

    // ── 1. Delete the combined user message we injected ──────
    let deleteOk = false;
    try {
        const ctx = SillyTavern.getContext();
        if (ctx?.executeSlashCommands) {
            await ctx.executeSlashCommands('/del 1');
            deleteOk = true;
        }
    } catch (err) {
        console.warn('[MP-Sync] /del 1 failed, trying direct splice:', err);
    }
    if (!deleteOk && chat && chat.length > 0) {
        // Fallback: splice last message if it looks like our inject
        const lastIdx = chat.length - 1;
        if (chat[lastIdx]?.is_user) {
            chat.splice(lastIdx, 1);
            document.querySelector(`#chat .mes[mesid="${lastIdx}"]`)?.remove();
            // Broadcast delete diff manually (MESSAGE_DELETED may not fire on manual splice)
            queueDiff({ op: 'delete', msgIndex: lastIdx });
        }
    }
    // Note: if /del 1 succeeded, ST fires MESSAGE_DELETED → queueDiff handles broadcast automatically

    // ── 1.5 Force full resync on all clients ──────────────────
    // Belt-and-suspenders: even if diff broadcast succeeded, a full sync guarantees
    // every client is in the correct state after the failure (handles reconnects,
    // seq gaps, or late joiners). Delay 400ms to let the delete diff flush first.
    if (Object.keys(clientConns).length > 0) {
        setTimeout(() => {
            broadcastToClients({ type: 'request_resync' });
        }, 400);
    }

    // ── 2. Restore each player's text ────────────────────────
    // Host restores their own textarea
    const hostText = lastRoundTexts.get(peer?.id) || '';
    const hostTa = document.getElementById('send_textarea');
    if (hostTa && hostText) {
        hostTa.value = hostText;
        isReady = false;
        lastReadyText = '';
    }

    // Clients: send individual restore_text with their own text (spectators excluded)
    Object.entries(clientConns).forEach(([pid, conn]) => {
        if (!conn?.open) return;
        if ((players[pid]?.role || 'player') === 'spectator') return;  // spectators stay locked
        const txt = lastRoundTexts.get(pid) || '';
        conn.send({ type: 'restore_text', text: txt, reason });
    });
    lastRoundTexts.clear();

    // ── 3. Notify everyone ────────────────────────────────────
    // Reason mapping → human-readable
    const reasonMap = {
        'No message received':     'No response from AI',
        'Generation stopped':      'Generation stopped by host',
        'Timeout':                 'Timeout — no response in 3 min',
        'inject_failed':           'Failed to send to AI',
    };
    const displayReason = reasonMap[reason] || reason;

    broadcastToClients({ type: 'error', message: `⚠ AI failed to reply (${displayReason}) — your message has been restored` });
    showToast(`⚠ Generation failed: ${displayReason}`, 'error');

    // ── 4. Reset round ────────────────────────────────────────
    waitingBot = false;
    _failureHandling = false;
    resetRound();
    setStatus(`⚠ ${displayReason} — Type and click Ready to retry`);
}

// ============================================================
// BOT REPLY HANDLER (Host)
// ============================================================

function handleBotReply(messageIndex) {
    if (!isHost || !waitingBot) return;

    if (botReplyTimeout) { clearTimeout(botReplyTimeout); botReplyTimeout = null; }

    setTimeout(() => {
        if (!chat) return;
        const msg = chat[messageIndex] || chat[chat.length - 1];
        if (!msg) return;

        const botText = msg.mes || '';
        const botName = msg.name || getCurrentBotName() || 'Bot';

        broadcastToClients({
            type: 'bot_reply',
            botName,
            combined: lastCombinedMessage,
            reply: botText
        });

        waitingBot = false;
        resetRound();
        setStatus('New round — Type and click Ready');
    }, 500);
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

function handleClientMessage(peerId, data) {
    if (!data?.type) return;
    switch (data.type) {
        case 'hello':
            if (players[peerId]) {
                players[peerId].name = data.name;
                players[peerId].description = data.description || '';
            }
            broadcastPlayerUpdate();
            renderPlayerList();
            if (roomMode === 'normal') broadcastPreviewUpdate();
            break;
        case 'ready':
            if (maxCharsPerMessage > 0 && (data.text || '').length > maxCharsPerMessage) {
                if (clientConns[peerId]?.open) clientConns[peerId].send({ type: 'error', message: `❌ Message too long (${(data.text||'').length}/${maxCharsPerMessage} chars)` });
                break;
            }
            if (players[peerId]) {
                players[peerId].ready   = true;
                players[peerId].text    = data.text;
                players[peerId].readyAt = Date.now();
                if (roomMode === 'normal') players[peerId].preview = stripHiddenThoughts(data.text);
            }
            renderPlayerList();
            broadcastPlayerUpdate();
            if (roomMode === 'normal') broadcastPreviewUpdate();
            checkAllReady();
            break;
        case 'cancel':
            if (players[peerId]) {
                players[peerId].ready   = false;
                players[peerId].text    = '';
                players[peerId].preview = null;
                players[peerId].readyAt = null;
            }
            renderPlayerList();
            broadcastPlayerUpdate();
            if (roomMode === 'normal') broadcastPreviewUpdate();
            break;
        case 'set_role':
            if (players[peerId]) {
                const newRole = data.role === 'spectator' ? 'spectator' : 'player';
                players[peerId].role = newRole;
                if (newRole === 'spectator') {
                    players[peerId].ready   = false;
                    players[peerId].text    = '';
                    players[peerId].preview = null;
                    players[peerId].readyAt = null;
                }
            }
            renderPlayerList();
            broadcastPlayerUpdate();
            if (roomMode === 'normal') broadcastPreviewUpdate();
            checkAllReady();
            break;
        case 'mp_chat_send': {
            if (!roomChatEnabled) break;
            const now2 = Date.now();
            if ((lastChatAt[peerId] || 0) > now2 - 500) break;
            lastChatAt[peerId] = now2;
            const senderName = players[peerId]?.name || 'Unknown';
            const chatEntry = { id: _mpChatId(), peerId, name: senderName, text: (data.text || '').slice(0, 500), ts: now2 };
            mpChatAppend(chatEntry);
            Object.entries(clientConns).forEach(([cid, conn]) => {
                if (conn?.open) conn.send({ type: 'mp_chat_msg', entry: chatEntry });
            });
            break;
        }
        case 'pong':
            lastPongAt[peerId] = Date.now();
            break;
        case 'request_sync': {
            const syncName = getCurrentBotName();
            captureBotAvatarBase64().then(syncAv => {
                if (clientConns[peerId]?.open) {
                    clientConns[peerId].send({ type: 'sync_response', chatHistory: getRecentChatLog(), currentSeq: chatSeq, botName: syncName, botAvatar: syncAv });
                    // Bug 2 fix: Also send current preview state after sync
                    if (roomMode === 'normal') {
                        const ordered = getOrderedPeerIds();
                        const previews = ordered
                            .filter(id => players[id] && players[id].name && (players[id].role || 'player') === 'player')
                            .map(id => ({ peerId: id, name: players[id].name || '?', text: players[id].preview ?? null }));
                        clientConns[peerId].send({ type: 'preview_update', previews });
                    }
                }
            });
            break;
        }
        default:
            console.warn('[MP-Sync] Unknown client message:', data.type);
    }
}

function handleHostMessage(data) {
    if (!data?.type) return;

    const textarea = document.getElementById('send_textarea');

    switch (data.type) {
        case 'welcome':
            if (data.roomMode) roomMode = data.roomMode;
            if (typeof data.maxCharsPerMessage === 'number') maxCharsPerMessage = data.maxCharsPerMessage;
            roomChatEnabled = !!data.chatEnabled;
            {
                const chatTabBtn = document.getElementById('mp-tabBtn-chat');
                const tabbar = document.getElementById('mp-room-tabbar');
                if (chatTabBtn) chatTabBtn.style.display = roomChatEnabled ? '' : 'none';
                if (tabbar) tabbar.style.display = roomChatEnabled ? '' : 'none';
                if (roomChatEnabled && Array.isArray(data.roomChatHistory)) {
                    clearChatPanel();
                    data.roomChatHistory.forEach(e => mpChatAppend(e));
                }
            }
            startMasquerade(data.botName, data.botAvatar);
            clearMainChatDisplay();
            if (Array.isArray(data.chatHistory)) {
                data.chatHistory.forEach(msg => renderMessageInMainChat(msg.role, msg.name, msg.text, null, msg.msgIndex));
            }
            if (typeof data.currentSeq === 'number') lastChatSeq = data.currentSeq;
            setStatus('Successfully joined the room!');
            if (data.botThinking) {
                if (textarea) textarea.disabled = true;
                setMainReadyBtnState(false, false);
                setStatus('Waiting for bot reply...');
                // F3: show merged message immediately for late joiners mid-round
                if (data.combinedPending) {
                    renderMessageInMainChat('user', 'Everyone', data.combinedPending);
                }
            }
            break;

        case 'player_update': {
            // Persist lastPlayerList for inline status
            const activePl = (data.players || []).filter(p => (p.role || 'player') === 'player');
            const rc2 = activePl.filter(p => p.ready).length;
            const sc2 = (data.players || []).filter(p => (p.role || 'player') === 'spectator').length;
            renderPlayerList(data.players);
            updateInlineStatus(rc2, activePl.length, sc2);
            // Check if host forced our role
            if (data.myRole && data.myRole !== myRole) {
                myRole = data.myRole;
                _syncRoleUI();
                updateInlineStatus();
            }
            break;
        }

        case 'preview_update':
            updatePreviews(data.previews || []);
            break;

        case 'round_start':
            if (textarea) textarea.disabled = true;
            setMainReadyBtnState(false, false);
            setStatus('Waiting for bot reply...');
            // F1: clear preview and show merged message immediately (before bot replies)
            updatePreviews([]);
            if (data.combined) {
                renderMessageInMainChat('user', 'Everyone', data.combined);
            }
            break;

        case 'bot_reply':
            updatePreviews([]);
            // F4: combined was already rendered at round_start — only render bot reply now
            renderMessageInMainChat('bot', data.botName, data.reply);
            isReady = false;
            if (myRole === 'spectator') {
                // Spectator stays locked after bot reply — don't enable textarea
                setMainReadyBtnState(true, false, 'spectator');
                if (textarea) textarea.disabled = true;
            } else {
                if (textarea) { textarea.disabled = false; textarea.value = ''; }
                setMainReadyBtnState(true, false, 'player');
            }
            setStatus('New round — Type and click Ready');
            break;

        case 'restore_text': {
            // Host failed to get bot reply — restore our original text so we can retry
            const restoreTa = document.getElementById('send_textarea');
            if (restoreTa) {
                restoreTa.value = data.text || '';
                restoreTa.disabled = false;
            }
            isReady = false;
            setMainReadyBtnState(true, false);
            const reasonLabel = data.reason || 'AI error';
            showToast(`💾 Message restored (${reasonLabel}) — ready up to retry`, 'warning');
            setStatus('⚠ AI error — your message restored, click Ready to retry');
            break;
        }

        case 'mp_chat_msg':
            if (data.entry) mpChatAppend(data.entry);
            break;
        case 'ping':
            lastPingFromHostAt = Date.now();
            if (hostConn?.open) { try { hostConn.send({ type: 'pong', t: data.t }); } catch {} }
            break;
        case 'msg_diff':
            handleChatDiff(data);
            break;

        case 'sync_response':
            if (data.botName || data.botAvatar) startMasquerade(data.botName, data.botAvatar);
            clearMainChatDisplay();
            if (Array.isArray(data.chatHistory)) {
                data.chatHistory.forEach(msg => renderMessageInMainChat(msg.role, msg.name, msg.text, null, msg.msgIndex));
            }
            if (typeof data.currentSeq === 'number') lastChatSeq = data.currentSeq;
            setStatus('Message sync completed.');
            break;

        case 'kicked':
            cancelReconnect();   // Kicked = intentional, no reconnect
            renderMessageInMainChat('system', '', '⚠ ' + data.message);
            if (textarea) textarea.disabled = true;
            setMainReadyBtnState(false, false);
            setStatus('Kicked from room');
            setTimeout(() => mpDisconnect(), 2000);
            break;

        case 'forced_role': {
            const forced = data.role === 'spectator' ? 'spectator' : 'player';
            if (forced !== myRole) {
                myRole = forced;
                _syncRoleUI();
                updateInlineStatus();
                showToast(forced === 'spectator' ? '👁 Host set you as Spectator' : '▶ Host set you as Player', 'info');
                if (forced === 'spectator' && isReady) {
                    isReady = false;
                    lastReadyText = '';
                    if (hostConn?.open) hostConn.send({ type: 'cancel', name: myName });
                }
            }
            break;
        }

        case 'request_resync':
            // Host requested all clients to re-sync — send request_sync back to host
            showToast('🔁 Host requested re-sync', 'info');
            if (hostConn?.open) hostConn.send({ type: 'request_sync' });
            break;

        case 'error':
            renderMessageInMainChat('system', '', '⚠ ' + data.message);
            isReady = false;
            if (myRole === 'spectator') {
                setMainReadyBtnState(true, false, 'spectator');
                if (textarea) textarea.disabled = true;
            } else {
                if (textarea) textarea.disabled = false;
                setMainReadyBtnState(true, false, 'player');
            }
            break;

        default:
            console.warn('[MP-Sync] Unknown host message:', data.type);
    }
}

// ============================================================
// ROOM CODE GENERATOR (6-digit)
// ============================================================

function generateRoomCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

// ============================================================
// CONNECTION — HOST
// ============================================================

/** Disable/enable Create+Join+Browse buttons during async connect flows. */
function _setConnBtnState(busy) {
    const configs = { 'mp-host-btn': '⏳ Creating...', 'mp-join-btn': '⏳ Joining...', 'mp-browse-btn': null };
    Object.entries(configs).forEach(([id, busyText]) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        if (busy) {
            btn.disabled = true;
            if (busyText && !btn.dataset.origText) { btn.dataset.origText = btn.textContent; btn.textContent = busyText; }
        } else {
            btn.disabled = false;
            if (btn.dataset.origText) { btn.textContent = btn.dataset.origText; delete btn.dataset.origText; }
        }
    });
}

async function mpHost() {
    // ── Rapid-tap guard ──────────────────────────────────────
    if (_hostingInFlight) { showToast('⚠ Already creating room — please wait', 'warning'); return; }
    if (peer || isReconnecting) { showToast('⚠ Already in a room — leave first', 'warning'); return; }

    if (!chat || chat.length === 0) {
        alert('Please select or start a chat with the bot before using Multiplayer');
        return;
    }

    const modeSelect = document.getElementById('mp-room-mode');
    roomMode = modeSelect ? modeSelect.value : 'normal';

    const maxPlayersSelect = document.getElementById('mp-max-players');
    maxPlayers = maxPlayersSelect ? parseInt(maxPlayersSelect.value) : 10;

    const maxCharsInput = document.getElementById('mp-max-chars');
    maxCharsPerMessage = maxCharsInput ? Math.max(0, parseInt(maxCharsInput.value) || 0) : 0;
    roomChatEnabled = document.getElementById('mp-room-chat')?.value === 'on';

    try {
        _hostingInFlight = true;   // set here so sync validation above can still return cleanly
        _setConnBtnState(true);
        await loadPeerJS();
        const roomCode = generateRoomCode();
        const peerConfig = await buildPeerConfigAsync();
        peer = new window.Peer(roomCode, peerConfig);
        setStatus('Creating room...');

        peer.on('open', (id) => {
            const codeEl = document.getElementById('mp-room-code');
            if (codeEl) codeEl.textContent = id;

            isHost = true;
            myName = getMyName();
            players[id] = { name: myName, text: '', ready: false, description: '', preview: null, readyAt: null, role: 'player' };
            manualOrder  = [id];

            switchToRoom(true);
            renderPlayerList();
            if (roomMode === 'normal') broadcastPreviewUpdate();
            integrateSTInput();
            startHostHeartbeat();
            bindHostDiffEvents();       // B: start broadcasting edits/deletes/swipes to clients
            acquireWakeLock();          // A1
            saveSessionSnapshot();      // B1
            _hostingInFlight = false;
            _setConnBtnState(false);
            setStatus(`Waiting for players to join... (${roomMode === 'hidden' ? 'Hidden' : 'Normal'} mode)`);
        });

        peer.on('connection', conn => setupHostClientConn(conn));

        peer.on('error', err => {
            console.error('[MP-Sync] Peer error:', err);
            if (err.type === 'unavailable-id') {
                setStatus('Code unavailable. Trying a new one...');
                peer.destroy();
                peer = null;
                _hostingInFlight = false;   // reset BEFORE recurse so guard allows re-entry
                _setConnBtnState(false);
                setTimeout(() => mpHost(), 500);
            } else if (err.type === 'network' || err.type === 'server-error') {
                _hostingInFlight = false;
                _setConnBtnState(false);
                const hasPack = !!loadPackConfig();
                const hasOR = isOpenRelayEnabled();
                setStatus(hasPack
                    ? '⚠ Connection failed — check your Server Pack settings'
                    : hasOR
                        ? '⚠ Connection failed — OpenRelay may be busy, try again or use a private Pack'
                        : '⚠ Connection failed — enable Free Public TURN (Network tab) or add a Pack');
            } else {
                _hostingInFlight = false;
                _setConnBtnState(false);
                setStatus(`Failed to create room: ${err.type}`);
            }
        });
    } catch (err) {
        _hostingInFlight = false;
        _setConnBtnState(false);
        console.error(err);
        setStatus('Failed to connect to PeerJS. Please try again.');
    }
}

// ============================================================
// CONNECTION — CLIENT
// ============================================================

async function mpJoin() {
    // ── Rapid-tap guard ──────────────────────────────────────
    if (_joiningInFlight) { showToast('⚠ Already joining — please wait', 'warning'); return; }
    if (peer || isReconnecting) { showToast('⚠ Already in a room — leave first', 'warning'); return; }

    const codeInput = document.getElementById('mp-code-input');
    const roomCode = codeInput ? codeInput.value.trim() : '';
    if (!roomCode) { alert('Please enter a room code'); return; }

    // Set flag BEFORE the confirm dialog so double-tap during dialog is blocked
    _joiningInFlight = true;
    _setConnBtnState(true);

    showJoinConfirmation(async () => {
        try {
            await loadPeerJS();
            const peerConfig = await buildPeerConfigAsync();
            peer = new window.Peer(undefined, peerConfig);
            setStatus('Connecting...');

            peer.on('open', () => {
                _joiningInFlight = false;
                _setConnBtnState(false);
                hostConn = peer.connect(roomCode);
                isHost = false;
                myName = getMyName();
                setupClientConn(hostConn);
            });

            peer.on('error', err => {
                console.error('[MP-Sync] Peer error:', err);
                _joiningInFlight = false;
                _setConnBtnState(false);
                if (err.type === 'peer-unavailable') {
                    setStatus('Room code not found. Please check the code and try again.');

                } else if (err.type === 'network' || err.type === 'server-error') {
                    const hasPack = !!loadPackConfig();
                    const hasOR = isOpenRelayEnabled();
                    setStatus(hasPack
                        ? '⚠ Connection failed — check your Server Pack settings'
                        : hasOR
                            ? '⚠ Connection failed — OpenRelay may be busy, try again or use a private Pack'
                            : '⚠ Connection failed — enable Free Public TURN (Network tab) or add a Pack');
                } else
                    setStatus(`Failed to join room: ${err.type}`);
            });
        } catch (err) {
            _joiningInFlight = false;
            _setConnBtnState(false);
            console.error(err);
            setStatus('Failed to connect to PeerJS. Please try again.');
        }
    });

    // If user cancelled the confirm dialog, release the guard
    // (showJoinConfirmation is synchronous — if onConfirm wasn't called, we reset immediately)
    // We use a microtask so the async onConfirm has a chance to start first
    Promise.resolve().then(() => {
        if (_joiningInFlight && !peer) {
            // onConfirm was not entered (user pressed Cancel or peer not created yet)
            // Wait a tick to see if peer was created inside the callback
            setTimeout(() => {
                if (_joiningInFlight && !peer) {
                    _joiningInFlight = false;
                    _setConnBtnState(false);
                }
            }, 100);
        }
    });
}

// ============================================================
// PEER CONNECTION SETUP
// ============================================================

function setupHostClientConn(conn) {
    conn.on('open', async () => {

        const currentPlayerCount = Object.keys(players).length;
        if (currentPlayerCount >= maxPlayers) {
            conn.send({ type: 'error', message: `Room is full (${maxPlayers}/${maxPlayers} players). Please try another room.` });
            setTimeout(() => conn.close(), 1000);
            return;
        }

        clientConns[conn.peer] = conn;
        players[conn.peer] = { name: '', text: '', ready: false, description: '', preview: null, readyAt: null, role: 'player' };
        lastPongAt[conn.peer]  = Date.now(); // prevent false-positive zombie detection before first pong
        manualOrder.unshift(conn.peer);      // newest joiner goes to top; oldest (host) stays at bottom

        const botName = getCurrentBotName();
        const botAvatar = await captureBotAvatarBase64();

        conn.send({
            type: 'welcome',
            hostName: myName,
            botName,
            botAvatar,
            chatHistory: getRecentChatLog(),
            currentSeq: chatSeq,           // B: diff sync — client starts counting from here
            botThinking: waitingBot,
            // F3: send pending combined so late joiners see the merged message immediately
            combinedPending: waitingBot ? lastCombinedMessage : '',
            roomMode,
            maxPlayers,
            maxCharsPerMessage,
            chatEnabled: roomChatEnabled,
            roomChatHistory: chatHistory.slice(-30)
        });

        // Bug 1 fix: Send current preview state to the newly joined client (players only)
        if (roomMode === 'normal') {
            const ordered = getOrderedPeerIds();
            const previews = ordered
                .filter(id => players[id] && players[id].name && (players[id].role || 'player') === 'player')
                .map(id => ({ peerId: id, name: players[id].name || '?', text: players[id].preview ?? null }));
            if (previews.length > 0) {
                conn.send({ type: 'preview_update', previews });
            }
        }

        renderPlayerList();
    });

    conn.on('data', data => handleClientMessage(conn.peer, data));
    conn.on('close', () => handleClientDisconnect(conn.peer));
    conn.on('error', err => {
        console.error(`[MP-Sync] Conn error from ${conn.peer}:`, err);
        handleClientDisconnect(conn.peer);
    });
}

function setupClientConn(conn) {
    conn.on('open', () => {
        const descInput = document.getElementById('mp-desc-input');
        const rawDesc = (descInput && descInput.value.trim())
            ? descInput.value
            : (descInput ? descInput.placeholder : '');
        myDescription = rawDesc
            .replace(/\{\{user\}\}/gi, myName)
            .replace(/\r?\n+/g, '; ')
            .replace(/\s+/g, ' ')
            .trim();

        conn.send({ 
            type: 'hello', 
            name: myName, 
            description: myDescription
        });
        setStatus('Connected!');
        switchToRoom(false);
        integrateSTInput();
        startClientWatchdog();
        acquireWakeLock();      // A1
        saveSessionSnapshot();  // B1
    });

    conn.on('data', data => handleHostMessage(data));

    conn.on('close', () => {
        triggerReconnect();     // B2: attempt reconnect instead of immediate disconnect
    });

    conn.on('error', err => {
        console.error('[MP-Sync] Host conn error:', err);
        triggerReconnect();     // B2: attempt reconnect instead of immediate disconnect
    });
}

// ============================================================
// KICK PLAYER (Host only)
// ============================================================

function mpKickPlayer(peerId) {
    if (!isHost || !peerId) return;

    const playerName = players[peerId]?.name || peerId;
    const confirmed = window.confirm(`Kick ${playerName} from the room?`);
    if (!confirmed) return;

    if (clientConns[peerId] && clientConns[peerId].open) {
        clientConns[peerId].send({
            type: 'kicked',
            message: 'You have been kicked from the room by the host.'
        });
        setTimeout(() => { if (clientConns[peerId]) clientConns[peerId].close(); }, 500);
    }

    handleClientDisconnect(peerId);
}

function handleClientDisconnect(peerId) {
    if (clientConns[peerId]) delete clientConns[peerId];
    delete lastPongAt[peerId]; // clean up heartbeat tracking for this peer
    manualOrder = manualOrder.filter(id => id !== peerId); // remove from order
    let name = peerId;
    if (players[peerId]) {
        name = players[peerId].name || peerId;
        delete players[peerId];
    }
    if (roomMode === 'normal') broadcastPreviewUpdate();
    renderPlayerList();
    broadcastPlayerUpdate();
    setStatus(`${name} left the room`);
    checkAllReady();
}

// ============================================================
// DISCONNECT & RESET
// ============================================================

function onChatChanged() {
    invalidateBotAvatarCache();
    if (isHost || (hostConn && hostConn.open)) {
        alert('Changing the chat will disconnect the multiplayer session');
        mpDisconnect();
    }
}

function resetState() {
    isHost = false;
    myName = '';
    hostConn = null;
    clientConns = {};
    players = {};
    isReady = false;
    waitingBot = false;
    lastCombinedMessage = '';
    roomMode    = 'normal';
    isToggling  = false;
    previewMode = 'manual';
    manualOrder = [];
    myRole = 'player';
    lastPlayerList = [];
    maxCharsPerMessage = 0;
    if (botReplyTimeout) { clearTimeout(botReplyTimeout); botReplyTimeout = null; }
    stopHeartbeat();
    unbindHostDiffEvents();    // B: stop diff event listeners + flush pending
    chatSeq = 0;               // B: reset diff sequence counter
    clientMessageMap.clear();  // B: clear client message index map
    lastChatSeq = 0;           // B: reset client sequence
    // Room chat reset
    roomChatEnabled = false;
    chatHistory = [];
    chatUnread = 0;
    chatTabActive = false;
    lastChatAt = {};
    lastChatPeerId = null;
    lastChatTs = 0;
}

function mpDisconnect() {
    // Reset connect guards — defense in depth (covers error paths that might miss a reset)
    _hostingInFlight = false;
    _joiningInFlight = false;
    _setConnBtnState(false);

    cancelReconnect();   // stop any pending reconnect loop
    releaseWakeLock();   // A1: release screen wake lock

    if (peer) { peer.destroy(); peer = null; }
    resetState();
    clearChatPanel();
    mpSwitchTab('room');
    stopMasquerade();
    restoreSTInput();
    updatePreviews([]);

    // Reset accordion: open Play section, close others
    const secPlay = document.getElementById('mp-sec-play');
    const secNetwork = document.getElementById('mp-sec-network');
    const secSettings = document.getElementById('mp-sec-settings');
    if (secPlay) secPlay.open = true;
    if (secNetwork) secNetwork.open = false;
    if (secSettings) secSettings.open = false;

    // Show setup, hide room
    const setupEl = document.getElementById('mp-setup');
    const roomEl = document.getElementById('mp-room');
    if (setupEl) setupEl.style.display = 'block';
    if (roomEl) roomEl.style.display = 'none';

    const playersEl = document.getElementById('mp-players');
    if (playersEl) playersEl.innerHTML = '';

    const textarea = document.getElementById('send_textarea');
    if (textarea) textarea.disabled = false;

    setStatus('Left (F5 to Restore Chat)');
}

// ============================================================
// UI HELPERS
// ============================================================

function getMyName() {
    const input = document.getElementById('mp-name-input');
    let n = input ? input.value.trim() : '';
    if (!n && typeof name1 !== 'undefined' && name1) n = name1;
    return n || 'Player';
}

function switchToRoom(showCode) {
    // Accordion: open Play section
    const secPlay = document.getElementById('mp-sec-play');
    if (secPlay) secPlay.open = true;

    document.getElementById('mp-setup')?.style && (document.getElementById('mp-setup').style.display = 'none');
    document.getElementById('mp-room')?.style && (document.getElementById('mp-room').style.display = 'flex');
    const _tabbar = document.getElementById('mp-room-tabbar');
    if (_tabbar) _tabbar.style.display = roomChatEnabled ? '' : 'none';
    const _chatTabBtn = document.getElementById('mp-tabBtn-chat');
    if (_chatTabBtn) _chatTabBtn.style.display = roomChatEnabled ? '' : 'none';
    const codeBox = document.getElementById('mp-room-code-box');
    if (codeBox) codeBox.style.display = showCode ? 'flex' : 'none';
    const syncBtn = document.getElementById('mp-sync-btn');
    if (syncBtn) {
        syncBtn.style.display = 'block';
        syncBtn.className = showCode
            ? 'mp-btn mp-btn-warning'
            : 'mp-btn mp-btn-ghost';
        syncBtn.title = showCode
            ? 'Force re-sync all clients'
            : 'Request sync from host';
    }
}

// ============================================================
// IN-ROOM CHAT HELPERS
// ============================================================

function _mpChatId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Append one message to chat history + DOM. */
function mpChatAppend(entry) {
    chatHistory.push(entry);
    if (chatHistory.length > CHAT_MAX) chatHistory.shift();

    const listEl = document.getElementById('mp-chat-list');
    if (!listEl) return;

    const isSelf = entry.peerId === (peer ? peer.id : null);
    const grouped = (entry.peerId === lastChatPeerId) &&
                    (entry.ts - lastChatTs < CHAT_GROUP_MS);

    lastChatPeerId = entry.peerId;
    lastChatTs = entry.ts;

    const div = document.createElement('div');
    div.className = `mp-chat-msg ${isSelf ? 'mp-chat-self' : 'mp-chat-other'}${grouped ? ' mp-chat-grouped' : ''}`;

    const timeStr = new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `
        <div class="mp-chat-meta">
            <span class="mp-chat-name">${escapeHtml(entry.name)}</span>
            <span>${timeStr}</span>
        </div>
        <div class="mp-chat-bubble">${escapeHtml(entry.text)}</div>
    `;

    const empty = listEl.querySelector('.mp-chat-empty');
    if (empty) empty.remove();

    listEl.appendChild(div);

    if (isNearBottom(listEl, 60)) listEl.scrollTop = listEl.scrollHeight;

    if (!chatTabActive) {
        chatUnread++;
        const badge = document.getElementById('mp-chat-badge');
        if (badge) { badge.textContent = chatUnread > 9 ? '9+' : String(chatUnread); badge.style.display = ''; }
    }
}

/** Switch between room-info and chat tabs. */
function mpSwitchTab(tab) {
    const roomInfo = document.getElementById('mp-tab-room');
    const chatPane = document.getElementById('mp-tab-chat');
    const btnInfo  = document.getElementById('mp-tabBtn-room');
    const btnChat  = document.getElementById('mp-tabBtn-chat');
    if (!roomInfo || !chatPane) return;

    chatTabActive = tab === 'chat';

    roomInfo.style.display = tab === 'room' ? '' : 'none';
    chatPane.style.display = tab === 'chat' ? '' : 'none';

    if (btnInfo) btnInfo.classList.toggle('active', tab === 'room');
    if (btnChat) btnChat.classList.toggle('active', tab === 'chat');

    if (tab === 'chat') {
        chatUnread = 0;
        const badge = document.getElementById('mp-chat-badge');
        if (badge) badge.style.display = 'none';
        const listEl = document.getElementById('mp-chat-list');
        if (listEl) listEl.scrollTop = listEl.scrollHeight;
        document.getElementById('mp-chat-input')?.focus();
    }
}

/** Send chat message (called from UI). */
function mpChatSend() {
    const input = document.getElementById('mp-chat-input');
    if (!input) return;
    const text = input.value.trim();
    if (!text || text.length > 500) return;

    const now = Date.now();
    const myId = peer ? peer.id : 'local';
    if ((lastChatAt[myId] || 0) > now - 500) return;
    lastChatAt[myId] = now;

    input.value = '';

    const entry = { id: _mpChatId(), peerId: myId, name: myName, text, ts: now };

    if (isHost) {
        mpChatAppend(entry);
        broadcastToClients({ type: 'mp_chat_msg', entry });
    } else if (hostConn && hostConn.open) {
        // Client: do NOT show optimistically — wait for host to echo back to ALL clients
        hostConn.send({ type: 'mp_chat_send', text });
    }
}

/** Clear the chat panel DOM and reset state. */
function clearChatPanel() {
    chatHistory = [];
    chatUnread = 0;
    lastChatPeerId = null;
    lastChatTs = 0;
    const listEl = document.getElementById('mp-chat-list');
    if (listEl) listEl.innerHTML = '<div class="mp-chat-empty">No messages yet — say hi! 👋</div>';
    const badge = document.getElementById('mp-chat-badge');
    if (badge) badge.style.display = 'none';
}

function mpCopyCode() {
    const codeEl = document.getElementById('mp-room-code');
    const btn = document.getElementById('mp-copy-btn');
    if (!codeEl || !btn) return;
    navigator.clipboard.writeText(codeEl.textContent).then(() => {
        showToast('📋 Room code copied!', 'success');
    });
}

// ============================================================
// SERVER PACK — TURN/STUN configuration helpers (STMP1 + STMP2)
// ============================================================

const MP_PACK_RAW_KEY  = 'mp-server-pack-raw';
const MP_PACK_CFG_KEY  = 'mp-server-pack-cfg';
const MP_OPENRELAY_KEY = 'mp-openrelay';

// ── STMP1: plain base64url ────────────────────────────────────

function encodeServerPack({ url, username, password, forceRelay }) {
    const data = { u: url || '', n: username || '', p: password || '' };
    if (forceRelay) data.r = 1;
    const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(data))))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return 'STMP1:' + b64;
}

function decodeServerPackV1(packStr) {
    if (!packStr || !packStr.startsWith('STMP1:')) return null;
    try {
        const b64 = packStr.slice(6).replace(/-/g, '+').replace(/_/g, '/');
        const padding = '='.repeat((4 - b64.length % 4) % 4);
        const data = JSON.parse(decodeURIComponent(escape(atob(b64 + padding))));
        if (!data || !data.u) return null;
        return { url: data.u || '', username: data.n || '', password: data.p || '', forceRelay: !!data.r };
    } catch { return null; }
}

// ── STMP2: AES-GCM-256 + PBKDF2-SHA256 ──────────────────────

async function encodeServerPackV2({ url, username, password, forceRelay }, passphrase) {
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv   = crypto.getRandomValues(new Uint8Array(12));
    const keyMat = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
        keyMat, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const data = { u: url || '', n: username || '', p: password || '' };
    if (forceRelay) data.r = 1;
    const ct = new Uint8Array(await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data))));
    const out = new Uint8Array(16 + 12 + ct.length);
    out.set(salt, 0); out.set(iv, 16); out.set(ct, 28);
    const b64 = btoa(String.fromCharCode(...out))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return 'STMP2:' + b64;
}

async function decodeServerPackV2(packStr, passphrase) {
    if (!packStr || !packStr.startsWith('STMP2:')) throw new Error('Not STMP2');
    const b64 = packStr.slice(6).replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - b64.length % 4) % 4);
    const raw  = Uint8Array.from(atob(b64 + padding), c => c.charCodeAt(0));
    const salt = raw.slice(0, 16), iv = raw.slice(16, 28), ct = raw.slice(28);
    const keyMat = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' },
        keyMat, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    let plain;
    try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct); }
    catch { throw new Error('Wrong passphrase or corrupted pack'); }
    const data = JSON.parse(new TextDecoder().decode(plain));
    if (!data || !data.u) throw new Error('Invalid pack data');
    return { url: data.u || '', username: data.n || '', password: data.p || '', forceRelay: !!data.r };
}

// ── Storage helpers ───────────────────────────────────────────

function loadPackConfig() {
    try { const s = localStorage.getItem(MP_PACK_CFG_KEY); return s ? JSON.parse(s) : null; }
    catch { return null; }
}
function savePackConfig(cfg) { localStorage.setItem(MP_PACK_CFG_KEY, JSON.stringify(cfg)); }
function loadServerPack()    { return localStorage.getItem(MP_PACK_RAW_KEY) || ''; }
function saveServerPack(s)   { localStorage.setItem(MP_PACK_RAW_KEY, s); }
function clearServerPack()   {
    localStorage.removeItem(MP_PACK_RAW_KEY);
    localStorage.removeItem(MP_PACK_CFG_KEY);
}

// ── Open Relay helpers ────────────────────────────────────────

function isOpenRelayEnabled() { return localStorage.getItem(MP_OPENRELAY_KEY) === '1'; }
function setOpenRelayEnabled(v) {
    if (v) localStorage.setItem(MP_OPENRELAY_KEY, '1');
    else localStorage.removeItem(MP_OPENRELAY_KEY);
}

/**
 * Generate time-limited TURN credentials for openrelay.metered.ca
 * using the standard TURN REST API HMAC-SHA1 mechanism. TTL = 24h.
 */
async function generateOpenRelayCredentials() {
    const secret  = 'openrelayprojectsecret';
    const expiry  = Math.floor(Date.now() / 1000) + 24 * 3600;
    const username = String(expiry);
    const enc = new TextEncoder();
    const keyMat = await crypto.subtle.importKey(
        'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', keyMat, enc.encode(username));
    const credential = btoa(String.fromCharCode(...new Uint8Array(sig)));
    return { username, credential };
}

/** One-time migration from old 'mp-server-pack' key (v2.0.8 and earlier). */
function migrateLegacyPack() {
    if (localStorage.getItem(MP_PACK_CFG_KEY)) return;
    const old = localStorage.getItem('mp-server-pack');
    if (!old) return;
    const cfg = decodeServerPackV1(old);
    if (cfg) { savePackConfig(cfg); saveServerPack(old); }
    localStorage.removeItem('mp-server-pack');
}

// ── PeerJS config (async) — Pack > OpenRelay > STUN ──────────

async function buildPeerConfigAsync() {
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    let iceTransportPolicy;

    const pack = loadPackConfig();
    if (pack && pack.url) {
        const entry = { urls: pack.url };
        if (pack.username) entry.username = pack.username;
        if (pack.password) entry.credential = pack.password;
        iceServers.push(entry);
        if (pack.forceRelay) iceTransportPolicy = 'relay';
    } else if (isOpenRelayEnabled()) {
        try {
            const { username, credential } = await generateOpenRelayCredentials();
            iceServers.push(
                { urls: 'stun:openrelay.metered.ca:80' },
                { urls: 'turn:openrelay.metered.ca:80',   username, credential },
                { urls: 'turn:openrelay.metered.ca:443',  username, credential },
                { urls: 'turns:openrelay.metered.ca:443', username, credential }
            );
        } catch (err) {
            console.warn('[MP-Sync] Failed to generate OpenRelay credentials:', err);
        }
    }

    const config = { iceServers };
    if (iceTransportPolicy) config.iceTransportPolicy = iceTransportPolicy;
    return { config };
}

function refreshPackStatus() {
    const el = document.getElementById('mp-pack-status');
    if (!el) return;
    const pack = loadPackConfig();
    const shareBtn = document.getElementById('mp-pack-share-btn');
    const orBtn    = document.getElementById('mp-openrelay-btn');

    // Update the Network section summary badge
    const networkBadge = document.getElementById('mp-network-badge');

    if (pack && pack.url) {
        const display = pack.url.replace(/^turns?:\/?\/?/, '').split('?')[0];
        el.textContent = '🟢 ' + display;
        el.style.color = 'var(--mp-ok, #22d36c)';
        el.title = pack.url + (pack.forceRelay ? ' (force relay)' : '');
        if (shareBtn) shareBtn.style.display = '';
        if (orBtn) { orBtn.textContent = '🆓 Free Public TURN (OpenRelay)'; orBtn.style.opacity = '0.45'; }
        if (networkBadge) { networkBadge.textContent = '🟢'; networkBadge.title = display; }
    } else if (isOpenRelayEnabled()) {
        el.textContent = '🟡 openrelay.metered.ca';
        el.style.color = 'var(--mp-warn, #f0ad4e)';
        el.title = 'Free Public TURN via OpenRelay — 24h TTL';
        if (shareBtn) shareBtn.style.display = 'none';
        if (orBtn) { orBtn.textContent = '🔴 Disable Free Public TURN'; orBtn.style.opacity = '1'; }
        if (networkBadge) { networkBadge.textContent = '🟡'; networkBadge.title = 'OpenRelay active'; }
    } else {
        el.textContent = '⚪ None';
        el.style.color = '';
        el.title = 'No TURN server — direct P2P only';
        if (shareBtn) shareBtn.style.display = 'none';
        if (orBtn) { orBtn.textContent = '🆓 Free Public TURN (OpenRelay)'; orBtn.style.opacity = '1'; }
        if (networkBadge) { networkBadge.textContent = '⚪'; networkBadge.title = 'No TURN server'; }
    }
}

// ── Passphrase validation ─────────────────────────────────────

function validatePassphrase(pp, requireNonEmpty = false) {
    if (!pp && !requireNonEmpty) return { ok: true, msg: '' };
    if (!pp) return { ok: false, msg: 'Passphrase is required for STMP2' };
    if (pp.length < 8)  return { ok: false, msg: 'Passphrase must be at least 8 characters' };
    if (pp.length < 12) return { ok: true,  msg: '⚠ Passphrase < 12 chars — consider a longer one' };
    return { ok: true, msg: '' };
}

// ============================================================
// HEARTBEAT / KEEPALIVE
// ============================================================

function startHostHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
        const now = Date.now();
        // Send ping to every open client connection
        Object.entries(clientConns).forEach(([peerId, conn]) => {
            if (conn?.open) {
                try { conn.send({ type: 'ping', t: now }); } catch {}
            }
        });
        // Detect zombie clients that have not sent a pong within HEARTBEAT_TIMEOUT
        Object.keys(clientConns).forEach(peerId => {
            const last = lastPongAt[peerId] || 0;
            if (last && (now - last) > HEARTBEAT_TIMEOUT) {
                console.warn(`[MP-Sync] Zombie client ${peerId} — no pong for ${now - last}ms`);
                try { clientConns[peerId]?.close(); } catch {}
                handleClientDisconnect(peerId);
            }
        });
    }, HEARTBEAT_INTERVAL);
}

function startClientWatchdog() {
    stopHeartbeat();
    lastPingFromHostAt = Date.now(); // treat connect time as the first implicit ping
    clientWatchdog = setInterval(() => {
        if (!lastPingFromHostAt) return;
        const elapsed = Date.now() - lastPingFromHostAt;
        if (elapsed > HEARTBEAT_TIMEOUT) {
            console.warn(`[MP-Sync] No ping from host for ${elapsed}ms — connection assumed dead`);
            setStatus('⚠ Connection lost — host unreachable', 'err');
            stopHeartbeat();
            try { hostConn?.close(); } catch {}
        }
    }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (clientWatchdog) { clearInterval(clientWatchdog); clientWatchdog = null; }
    lastPongAt         = {};
    lastPingFromHostAt = 0;
}

// ============================================================
// WAKE LOCK (Phase 1 — A1)
// ============================================================

async function acquireWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', () => {
            wakeLockSentinel = null;
            // Re-acquire automatically if still in room (OS releases on tab hide)
            if (peer && (isHost || (hostConn && hostConn.open))) {
                setTimeout(acquireWakeLock, 1500);
            }
        });
    } catch (err) {
        // Not fatal — just means screen may sleep
        //console.warn('[MP-Sync] Wake Lock unavailable:', err.name);
    }
}

function releaseWakeLock() {
    if (wakeLockSentinel) {
        wakeLockSentinel.release().catch(() => {});
        wakeLockSentinel = null;
    }
}

// ============================================================
// VISIBILITY CHANGE HANDLER (Phase 1 — A2 / A4)
// ============================================================

function onVisibilityChange() {
    if (document.hidden) {
        hiddenSince = Date.now();
    } else {
        const wasHiddenFor = hiddenSince ? Date.now() - hiddenSince : 0;
        hiddenSince = 0;

        // A4: toast warning if hidden too long
        if (wasHiddenFor > HIDDEN_WARN_MS && (peer || isReconnecting)) {
            showToast(`📵 Tab hidden for ${Math.round(wasHiddenFor / 1000)}s — checking connection...`, 'warning');
        }

        // A1: re-acquire wake lock (may have been released by OS while hidden)
        if (peer && (isHost || (hostConn && hostConn.open))) {
            acquireWakeLock();
        }

        // A2: reset client watchdog — prevent false-positive "host unreachable" after tab unfreeze
        if (!isHost && lastPingFromHostAt) {
            lastPingFromHostAt = Date.now();
        }

        // A2: immediately send unsolicited pong to refresh host's zombie timer
        if (!isHost && hostConn?.open) {
            try { hostConn.send({ type: 'pong', t: Date.now() }); } catch {}
        }
    }
}

// ============================================================
// AUTO-RECONNECT (Phase 2 — B2 / B3 / B4)
// ============================================================

/**
 * Main reconnect loop — called from triggerReconnect()
 * Uses exponential backoff: 2s → 5s → 10s
 */
async function attemptReconnect() {
    const snap = loadSessionSnapshot();
    if (!snap || reconnectAttempts >= MAX_RECONNECT_TRIES) {
        console.warn('[MP-Sync] Reconnect exhausted — giving up');
        isReconnecting = false;
        reconnectAttempts = 0;
        clearSessionSnapshot();
        mpDisconnect();
        return;
    }

    isReconnecting = true;
    const delay = RECONNECT_DELAYS[reconnectAttempts] || 10000;
    reconnectAttempts++;

    setStatus(`🔄 Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_TRIES})...`, 'wait');
    showToast(`🔄 Reconnecting... attempt ${reconnectAttempts}/${MAX_RECONNECT_TRIES}`, 'warning');

    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        try {
            await loadPeerJS();
            const peerConfig = await buildPeerConfigAsync();

            // Clean up stale peer
            if (peer) { try { peer.destroy(); } catch {} peer = null; }

            if (snap.isHost) {
                // ── B4: Host — try to reclaim the same room code ────────
                peer = new window.Peer(snap.roomCode, peerConfig);

                peer.on('open', (id) => {
                    isReconnecting = false;
                    reconnectAttempts = 0;
                    isHost = true;
                    myName = snap.myName || myName;
                    roomMode = snap.roomMode || roomMode;
                    if (!players[id]) {
                        players[id] = { name: myName, text: '', ready: false, description: '', preview: null, readyAt: null, role: 'player' };
                        manualOrder = [id];
                    }
                    peer.on('connection', conn => setupHostClientConn(conn));
                    startHostHeartbeat();
                    bindHostDiffEvents();       // v3.0.8: rebind diff events after host reconnect
                    acquireWakeLock();
                    saveSessionSnapshot();
                    const codeEl = document.getElementById('mp-room-code');
                    if (codeEl) codeEl.textContent = id;
                    showToast('✅ Room restored! Waiting for players to rejoin.', 'success');
                    setStatus(`Room restored — waiting for players`);
                });

                peer.on('error', err => {
                    console.error('[MP-Sync] Host reconnect error:', err);
                    isReconnecting = false;
                    if (err.type === 'unavailable-id') {
                        showToast('❌ Room code already taken — could not restore', 'error');
                        clearSessionSnapshot();
                        mpDisconnect();
                    } else {
                        attemptReconnect();
                    }
                });

            } else {
                // ── Client reconnect ─────────────────────────────────────
                peer = new window.Peer(undefined, peerConfig);
                myName = snap.myName || myName;
                myDescription = snap.myDescription || myDescription;

                peer.on('open', () => {
                    hostConn = peer.connect(snap.roomCode);
                    setupClientConnReconnect(hostConn, snap);
                });

                peer.on('error', err => {
                    console.error('[MP-Sync] Client reconnect peer error:', err);
                    isReconnecting = false;
                    if (err.type === 'peer-unavailable') {
                        showToast('❌ Host room is no longer available', 'error');
                        clearSessionSnapshot();
                        mpDisconnect();
                    } else {
                        attemptReconnect();
                    }
                });
            }
        } catch (err) {
            console.error('[MP-Sync] Reconnect exception:', err);
            isReconnecting = false;
            attemptReconnect();
        }
    }, delay);
}

/**
 * Like setupClientConn but for reconnect — skips confirm dialog, uses snap credentials.
 */
function setupClientConnReconnect(conn, snap) {
    conn.on('open', () => {
        isReconnecting = false;
        reconnectAttempts = 0;

        conn.send({
            type: 'hello',
            name: snap.myName || myName,
            description: snap.myDescription || myDescription
        });

        switchToRoom(false);
        if (!mpInterceptActive) integrateSTInput();
        startClientWatchdog();
        acquireWakeLock();
        saveSessionSnapshot();

        // Request full chat + preview sync after short delay
        setTimeout(() => {
            if (conn.open) conn.send({ type: 'request_sync' });
        }, 600);

        setStatus('Reconnected! Syncing...');
        showToast('✅ Reconnected!', 'success');
    });

    conn.on('data', data => handleHostMessage(data));

    conn.on('close', () => {
        if (isReconnecting) return;
        triggerReconnect();
    });

    conn.on('error', err => {
        if (isReconnecting) return;
        console.error('[MP-Sync] Host conn error (after reconnect):', err);
        triggerReconnect();
    });
}

/**
 * Initiate reconnect flow — save snapshot first, then start backoff loop.
 */
function triggerReconnect() {
    if (isReconnecting) return;
    const snap = loadSessionSnapshot();
    if (!snap) {
        // No snapshot means first-time disconnect, not a resumable session
        showToast('⚠ Host disconnected', 'warning');
        renderMessageInMainChat('system', '', 'Host left the room. Game ended.');
        setTimeout(() => mpDisconnect(), 2000);
        return;
    }
    stopHeartbeat();
    setStatus('🔄 Connection lost — reconnecting...', 'wait');
    attemptReconnect();
}

/** Cancel any pending reconnect timers and clear state. */
function cancelReconnect() {
    isReconnecting = false;
    reconnectAttempts = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    clearSessionSnapshot();
}

// ============================================================
// PEERJS LOADER
// ============================================================

function loadPeerJS() {
    return new Promise((resolve, reject) => {
        if (window.Peer) return resolve();
        const script = document.createElement('script');
        script.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
        script.onload = () => resolve();
        script.onerror = () => {
            console.error('[MP-Sync] Failed to load PeerJS');
            setStatus('Failed to load PeerJS');
            alert('Failed to load PeerJS. Please check your internet connection.');
            reject(new Error('Failed to load PeerJS'));
        };
        document.head.appendChild(script);
    });
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================

function showToast(msg, type = 'info') {
    const container = document.getElementById('mp-toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `mp-toast mp-toast-${type}`;
    toast.textContent = msg;
    container.appendChild(toast);
    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('mp-toast-show')));
    setTimeout(() => {
        toast.classList.remove('mp-toast-show');
        setTimeout(() => toast.remove(), 320);
    }, 3000);
}

// ============================================================
// THEME MANAGEMENT
// ============================================================

function loadThemePreference() {
    const saved = localStorage.getItem('mp-theme');
    if (saved) panelTheme = saved;
    applyTheme();
}

function applyTheme() {
    const panel = document.getElementById('mp-panel');
    if (!panel) return;
    panel.classList.remove('mp-theme-dark', 'mp-theme-light');
    if (panelTheme === 'dark') panel.classList.add('mp-theme-dark');
    else if (panelTheme === 'light') panel.classList.add('mp-theme-light');
    document.querySelectorAll('#mp-panel .mp-theme-opt').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.theme === panelTheme);
    });
}

function setTheme(t) {
    panelTheme = t;
    localStorage.setItem('mp-theme', panelTheme);
    applyTheme();
}

// ============================================================
// 2D DRAG (X + Y) + localStorage persist
// ============================================================

function enable2DDrag(panel, handle) {
    let dragging  = false;
    let startX = 0, startY = 0;
    let startLeft = 0, startTop = 0;
    let moved = false;   // true once pointer exceeds 5 px threshold

    // Convert right-based CSS to left-based before first drag
    function initLeftTop() {
        if (!panel.style.left || panel.style.left === '') {
            const rect    = panel.getBoundingClientRect();
            panel.style.left  = rect.left + 'px';
            panel.style.right = 'auto';
        }
    }

    function clampL(l) { return Math.max(10, Math.min(window.innerWidth  - (panel.offsetWidth  || 50) - 10, l)); }
    function clampT(t) { return Math.max(10, Math.min(window.innerHeight - (panel.offsetHeight || 50) - 10, t)); }

    function persist() {
        localStorage.setItem('mp-panel-x', String(parseInt(panel.style.left) || 0));
        localStorage.setItem('mp-panel-y', String(parseInt(panel.style.top)  || 60));
    }

    // ── Mouse ──────────────────────────────────────────────
    function onMouseMove(e) {
        if (!dragging) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
        moved = true;
        panel.style.left = clampL(startLeft + dx) + 'px';
        panel.style.top  = clampT(startTop  + dy) + 'px';
    }

    function onMouseUp() {
        if (!dragging) return;
        dragging = false;
        panel.classList.remove('mp-dragging');
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup',   onMouseUp);
        if (moved) persist();
    }

    handle.addEventListener('mousedown', (e) => {
        if (e.target.closest('button, input, select, textarea, a')) return;
        e.preventDefault();
        initLeftTop();
        dragging  = true;
        moved     = false;
        startX    = e.clientX;
        startY    = e.clientY;
        startLeft = parseInt(panel.style.left) || 0;
        startTop  = parseInt(panel.style.top)  || 60;
        panel.classList.add('mp-dragging');
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup',   onMouseUp);
    });

    // ── Touch ──────────────────────────────────────────────
    function onTouchMove(e) {
        if (!dragging) return;
        const touch = e.touches[0];
        const dx = touch.clientX - startX, dy = touch.clientY - startY;
        if (!moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
        moved = true;
        e.preventDefault();
        panel.style.left = clampL(startLeft + dx) + 'px';
        panel.style.top  = clampT(startTop  + dy) + 'px';
    }

    function onTouchEnd() {
        if (!dragging) return;
        dragging = false;
        panel.classList.remove('mp-dragging');
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend',  onTouchEnd);
        if (moved) persist();
    }

    handle.addEventListener('touchstart', (e) => {
        if (e.target.closest('button, input, select, textarea, a')) return;
        initLeftTop();
        dragging  = true;
        moved     = false;
        const touch = e.touches[0];
        startX    = touch.clientX;
        startY    = touch.clientY;
        startLeft = parseInt(panel.style.left) || 0;
        startTop  = parseInt(panel.style.top)  || 60;
        panel.classList.add('mp-dragging');
        document.addEventListener('touchmove', onTouchMove, { passive: false });
        document.addEventListener('touchend',  onTouchEnd);
    }, { passive: true });
}

function clampPanelToViewport(panel) {
    if (!panel) return;
    const minPad = 10;
    const w = panel.offsetWidth  || 50;
    const h = panel.offsetHeight || 50;
    // top
    const curTop  = parseInt(panel.style.top)  || 60;
    const maxTop  = Math.max(minPad, window.innerHeight - h - minPad);
    const newTop  = Math.max(minPad, Math.min(maxTop, curTop));
    if (newTop !== curTop) { panel.style.top = newTop + 'px'; localStorage.setItem('mp-panel-y', String(newTop)); }
    // left (only clamp if left is set — don't override right-based positioning)
    if (panel.style.left && panel.style.left !== '') {
        const curLeft = parseInt(panel.style.left) || 0;
        const maxLeft = Math.max(minPad, window.innerWidth - w - minPad);
        const newLeft = Math.max(minPad, Math.min(maxLeft, curLeft));
        if (newLeft !== curLeft) { panel.style.left = newLeft + 'px'; localStorage.setItem('mp-panel-x', String(newLeft)); }
    }
}

function restorePanelPosition(panel) {
    const savedY = localStorage.getItem('mp-panel-y');
    const savedX = localStorage.getItem('mp-panel-x');
    if (savedY !== null) {
        const top = parseInt(savedY);
        if (!isNaN(top)) panel.style.top = top + 'px';
    }
    if (savedX !== null) {
        const left = parseInt(savedX);
        if (!isNaN(left)) { panel.style.left = left + 'px'; panel.style.right = 'auto'; }
    }
    // Clamp immediately in case the viewport shrank since last session
    clampPanelToViewport(panel);
}

// ============================================================
// MINIMIZE / RESTORE
// ============================================================

function toggleMinimize() {
    const panel = document.getElementById('mp-panel');
    if (!panel) return;
    const minimized = panel.classList.toggle('mp-minimized');
    localStorage.setItem('mp-minimized', minimized ? '1' : '0');
    const minBtn = document.getElementById('mp-minimize-btn');
    if (minBtn) minBtn.textContent = minimized ? '◰' : '−';
    // After toggling, re-clamp so the pill stays on screen
    setTimeout(() => clampPanelToViewport(panel), 50);
}

function restoreFromMinimize() {
    const panel = document.getElementById('mp-panel');
    if (!panel || !panel.classList.contains('mp-minimized')) return;
    toggleMinimize();
}

// ============================================================
// UI SETUP — Panel (v2.2.0 — Accordion + Draggable)
// ============================================================

function setupUI() {
    const panelHTML = `
        <div id="mp-panel" style="display: none;">

            <div class="mp-header mp-drag-handle">
                <span class="mp-drag-grip" title="Drag to reposition">⠿</span>
                <span class="mp-logo" id="mp-logo-btn" title="Expand">🎮</span>
                <span class="mp-title">ST Multiplayer</span>
                <span class="mp-mini-dot" id="mp-mini-dot"></span>
                <div class="mp-header-actions">
                    <button id="mp-minimize-btn" title="Minimize">−</button>
                </div>
            </div>

            <div id="mp-status-pill" class="mp-status-pill">
                <span class="mp-status-dot"></span>
                <span id="mp-status-bar">Not connected</span>
            </div>

            <!-- ── Section: Play ── -->
            <details id="mp-sec-play" class="mp-section" open>
                <summary class="mp-section-summary">🚀 Play</summary>
                <div class="mp-section-body">

                    <div id="mp-setup">
                        <input type="text" id="mp-name-input" class="mp-input" placeholder="Your name (auto from ST)">
                        
                        <button id="mp-host-btn" class="mp-btn mp-btn-primary">➕ Create Room</button>
                        <div class="mp-divider-text">— or join —</div>
                        <div class="mp-join-row">
                            <input type="text" id="mp-code-input" class="mp-input mp-code-field" placeholder="6-digit code">
                            <button id="mp-join-btn" class="mp-btn mp-btn-secondary">🚪 Join</button>
                        </div>
                        <details id="mp-advanced">
                            <summary>Advanced options</summary>
                            <label class="mp-field-label">Persona Description <span class="mp-label-note">(joining only)</span></label>
                            <textarea id="mp-desc-input" rows="2" class="mp-input" placeholder="Describe your character..."></textarea>
                            <div class="mp-row-2">
                                <div class="mp-field">
                                    <label class="mp-field-label">Mode</label>
                                    <select id="mp-room-mode" class="mp-input">
                                        <option value="normal">👁 Normal</option>
                                        <option value="hidden">🙈 Hidden</option>
                                    </select>
                                </div>
                                <div class="mp-field">
                                    <label class="mp-field-label">Max</label>
                                    <select id="mp-max-players" class="mp-input">
                                        <option value="2">2</option>
                                        <option value="3">3</option>
                                        <option value="4">4</option>
                                        <option value="5">5</option>
                                        <option value="6">6</option>
                                        <option value="8">8</option>
                                        <option value="10" selected>10</option>
                                    </select>
                                </div>
                            </div>
                            <div class="mp-field" style="margin-top:6px;">
                                <label class="mp-field-label">Max chars/message <span class="mp-label-note">(0 = unlimited)</span></label>
                                <input type="number" id="mp-max-chars" class="mp-input" min="0" max="10000" step="50" value="0" placeholder="0 (unlimited)">
                            </div>
                            <div class="mp-field" style="margin-top:6px;">
                                <label class="mp-field-label">ENABLE IN-ROOM CHAT</label>
                                <select id="mp-room-chat" class="mp-input">
                                    <option value="off">Off</option>
                                    <option value="on">On</option>
                                </select>
                            </div>
                        </details>
                    </div>

                    <div id="mp-room" style="display:none; flex-direction:column;">

                        <!-- Tab bar -->
                        <div class="mp-tabbar" id="mp-room-tabbar" style="display:none;">
                            <button id="mp-tabBtn-room" class="mp-tab-btn active" data-tab="room">👥 Room</button>
                            <button id="mp-tabBtn-chat" class="mp-tab-btn" data-tab="chat" style="display:none;">
                                💬 Chat
                                <span id="mp-chat-badge" class="mp-tab-badge" style="display:none;">0</span>
                            </button>
                        </div>

                        <!-- Tab: Room info -->
                        <div id="mp-tab-room">
                            <div id="mp-room-code-box">
                                <span class="mp-code-label">ROOM</span>
                                <span id="mp-room-code">------</span>
                                <button id="mp-copy-btn" class="mp-btn mp-btn-icon" title="Copy code">📋</button>
                            </div>
                            <div class="mp-ready-track">
                                <div class="mp-ready-progress">
                                    <div id="mp-ready-bar" class="mp-ready-bar-fill"></div>
                                </div>
                                <span id="mp-ready-label" class="mp-ready-label">0/0 ready</span>
                            </div>
                            <div id="mp-order-ctrl" class="mp-order-ctrl" style="display:none;">
                                <span class="mp-order-label">Order</span>
                                <button class="mp-order-opt mp-btn active" data-mode="manual">✋ Manual</button>
                                <button class="mp-order-opt mp-btn" data-mode="ready">📥 Ready</button>
                            </div>
                            <div id="mp-players"></div>
                            <div class="mp-room-actions">
                                <button id="mp-sync-btn" class="mp-btn mp-btn-ghost">🔄 Refresh</button>
                                <button id="mp-leave-btn" class="mp-btn mp-btn-danger">🚪 Leave</button>
                            </div>
                        </div>

                        <!-- Tab: Chat -->
                        <div id="mp-tab-chat" style="display:none;">
                            <div id="mp-chat-list" class="mp-chat-list">
                                <div class="mp-chat-empty">No messages yet — say hi! 👋</div>
                            </div>
                            <div class="mp-chat-input-row">
                                <input type="text" id="mp-chat-input" class="mp-input"
                                       placeholder="Type a message..." maxlength="500" autocomplete="off">
                                <button id="mp-chat-send-btn" class="mp-btn mp-btn-primary mp-chat-send-btn" title="Send">➤</button>
                            </div>
                        </div>

                    </div>

                </div>
            </details>

            <!-- ── Section: Settings (includes Network/TURN) ── -->
            <details id="mp-sec-settings" class="mp-section">
                <summary class="mp-section-summary">⚙️ Settings</summary>
                <div class="mp-section-body">

                    <!-- Network / TURN sub-section -->
                    <details id="mp-sec-network" class="mp-subsection">
                        <summary class="mp-subsection-summary">
                            🌐 Network / TURN (Can be skipped)
                            <span id="mp-network-badge" class="mp-sec-badge" title="No TURN server">⚪</span>
                        </summary>
                        <div class="mp-subsection-body">
                            <div class="mp-network-banner">
                                <span id="mp-pack-status">⚪ None</span>
                            </div>
                            <p class="mp-note" style="margin-bottom:4px;">Configure TURN relay for players behind strict NAT/firewalls.</p>
                            <button id="mp-openrelay-btn" class="mp-btn mp-btn-accent">🆓 Free Public TURN (OpenRelay)</button>
                            <p class="mp-note">openrelay.metered.ca | 24h auto-refresh</p>
                            <div class="mp-pack-divider">— or private pack —</div>
                            <details id="mp-pack-section">
                                <summary>🔐 Private Server Pack</summary>
                                <textarea id="mp-pack-input" rows="2" class="mp-input mp-mono" placeholder="Paste STMP1:... or STMP2:..."></textarea>
                                <div id="mp-pack-pp-row" style="display:none;">
                                    <input type="password" id="mp-pack-pp" class="mp-input" placeholder="Passphrase (STMP2)">
                                    <div id="mp-pack-pp-hint" class="mp-hint"></div>
                                </div>
                                <div class="mp-btn-row">
                                    <button id="mp-pack-save-btn" class="mp-btn mp-btn-primary">💾 Save</button>
                                    <button id="mp-pack-clear-btn" class="mp-btn mp-btn-ghost">🗑 Clear</button>
                                </div>
                                <button id="mp-pack-share-btn" style="display:none;" class="mp-btn mp-btn-secondary">📤 Share (re-encrypt)</button>
                                <details id="mp-pack-gen">
                                    <summary>Generate Pack (VPS server owners)</summary>
                                    <input type="text"     id="mp-gen-url"  class="mp-input" placeholder="turn:host:3478">
                                    <input type="text"     id="mp-gen-user" class="mp-input" placeholder="Username">
                                    <input type="password" id="mp-gen-pass" class="mp-input" placeholder="Password">
                                    <input type="password" id="mp-gen-pp"   class="mp-input" placeholder="Passphrase (blank = STMP1)">
                                    <div id="mp-gen-pp-hint" class="mp-hint"></div>
                                    <label class="mp-checkbox-label">
                                        <input type="checkbox" id="mp-gen-relay"> Force relay (debug)
                                    </label>
                                    <button id="mp-gen-create-btn" class="mp-btn mp-btn-secondary">📋 Generate &amp; Copy</button>
                                </details>
                            </details>
                        </div>
                    </details>

                    <!-- Enter key behavior -->
                    <div class="mp-setting-group">
                        <label class="mp-setting-label">⌨️ Enter key Behavior</label>
                        <select id="mp-enter-mode-sel" class="mp-input">
                            <option value="auto">🔍 Auto-detect (default)</option>
                            <option value="newline">↵ Always newline (mobile)</option>
                            <option value="ready">✅ Always Ready (desktop)</option>
                        </select>
                        <p class="mp-note" style="margin-top:3px;">Override if auto-detect is wrong for your device. Shift+Enter always inserts a newline.</p>
                    </div>

                    <!-- Theme -->
                    <div class="mp-setting-group">
                        <label class="mp-setting-label">Theme</label>
                        <div class="mp-theme-opts">
                            <button class="mp-btn mp-theme-opt" data-theme="auto">🎨 Auto</button>
                            <button class="mp-btn mp-theme-opt" data-theme="dark">🌙 Dark</button>
                            <button class="mp-btn mp-theme-opt" data-theme="light">☀️ Light</button>
                        </div>
                    </div>
                    <div class="mp-about">
                        <p class="mp-about-name">ST Multiplayer</p>
        <p class="mp-note">v3.4.0 · ${skvojannxlad()}</p>
                    </div>
                </div>
            </details>

        </div>
        <div id="mp-toast-container"></div>
    `;
    document.body.insertAdjacentHTML('beforeend', panelHTML);

    const toggleHtml = `
        <div id="mp-toggle-btn" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="listitem" title="Toggle Multiplayer Panel">
            <div class="fa-solid fa-users extensionsMenuExtensionButton"></div>
            <span>ST Multiplayer</span>
        </div>
    `;
    const extensionsMenu = document.getElementById('extensionsMenu');
    const topBar = document.getElementById('top-bar');
    if (extensionsMenu) extensionsMenu.insertAdjacentHTML('beforeend', toggleHtml);
    else if (topBar) topBar.insertAdjacentHTML('beforeend', toggleHtml);
    else document.body.insertAdjacentHTML('beforeend', `<div style="position:fixed;top:10px;right:100px;z-index:9999;">${toggleHtml}</div>`);

    // ── Setup drag + restore position ────────────────────────
    const panel = document.getElementById('mp-panel');
    const dragHandle = panel?.querySelector('.mp-drag-handle');
    if (panel && dragHandle) {
        restorePanelPosition(panel);
        enable2DDrag(panel, dragHandle);
        // Restore minimized state from previous session
        if (localStorage.getItem('mp-minimized') === '1') {
            panel.classList.add('mp-minimized');
            const minBtn = document.getElementById('mp-minimize-btn');
            if (minBtn) minBtn.textContent = '◰';
        }
    }
    // Clamp panel whenever the browser window is resized
    let _mpResizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(_mpResizeTimer);
        _mpResizeTimer = setTimeout(() => clampPanelToViewport(panel), 200);
    });

    // ── Toggle panel ──────────────────────────────────────────
    document.getElementById('mp-toggle-btn')?.addEventListener('click', () => {
        if (!panel) return;
        const isOpen = panel.style.display !== 'none' && panel.style.display !== '';
        panel.style.display = isOpen ? 'none' : 'flex';
        const nameInput = document.getElementById('mp-name-input');
        const descInput = document.getElementById('mp-desc-input');
        if (nameInput && !nameInput.value) nameInput.placeholder = getCurrentPersonaName() || 'Your name (auto from ST)';
        if (descInput && !descInput.value) descInput.placeholder = getCurrentPersonaDescription() || 'Describe your character...';
    });

    // ── Minimize / restore ────────────────────────────────────
    document.getElementById('mp-minimize-btn')?.addEventListener('click', toggleMinimize);
    document.getElementById('mp-logo-btn')?.addEventListener('click', restoreFromMinimize);

    // ── Quick Start — with 800ms tap-coalesce (iOS/Android ghost-tap protection) ──
    const _coalesceClick = (btn, handler) => {
        if (!btn) return;
        let lockUntil = 0;
        btn.addEventListener('click', (e) => {
            const now = Date.now();
            if (now < lockUntil) { e.preventDefault(); e.stopPropagation(); return; }
            lockUntil = now + 800;
            handler(e);
        });
    };
    _coalesceClick(document.getElementById('mp-host-btn'), mpHost);
    _coalesceClick(document.getElementById('mp-join-btn'), mpJoin);
    document.getElementById('mp-browse-btn')?.addEventListener('click', mpBrowseRooms);
    document.getElementById('mp-copy-btn')?.addEventListener('click', mpCopyCode);
    document.getElementById('mp-sync-btn')?.addEventListener('click', () => {
        if (isHost) {
            // Host: broadcast resync request to all connected clients
            const openConns = Object.values(clientConns).filter(c => c?.open);
            broadcastToClients({ type: 'request_resync' });
            showToast(`🔁 Resync signal sent to ${openConns.length} client${openConns.length !== 1 ? 's' : ''}`, 'success');
        } else if (hostConn && hostConn.open) {
            hostConn.send({ type: 'request_sync' });
            setStatus('Syncing...');
        }
    });
    document.getElementById('mp-leave-btn')?.addEventListener('click', mpDisconnect);

    // ── Room chat tab switching ───────────────────────────────
    document.getElementById('mp-tabBtn-room')?.addEventListener('click', () => mpSwitchTab('room'));
    document.getElementById('mp-tabBtn-chat')?.addEventListener('click', () => mpSwitchTab('chat'));

    // ── Chat send ─────────────────────────────────────────────
    document.getElementById('mp-chat-send-btn')?.addEventListener('click', mpChatSend);
    document.getElementById('mp-chat-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); mpChatSend(); }
    });

    // ── Order mode toggle (host only) ─────────────────────────
    document.getElementById('mp-order-ctrl')?.querySelectorAll('.mp-order-opt').forEach(btn => {
        btn.addEventListener('click', () => {
            previewMode = btn.dataset.mode;
            document.getElementById('mp-order-ctrl')?.querySelectorAll('.mp-order-opt').forEach(b => {
                b.classList.toggle('active', b.dataset.mode === previewMode);
            });
            renderPlayerList();
            if (roomMode === 'normal') broadcastPreviewUpdate();
            broadcastPlayerUpdate();
        });
    });

    // ── Settings: theme buttons ───────────────────────────────
    document.querySelectorAll('#mp-panel .mp-theme-opt').forEach(btn => {
        btn.addEventListener('click', () => setTheme(btn.dataset.theme));
    });

    // ── OpenRelay toggle ──────────────────────────────────────
    document.getElementById('mp-openrelay-btn')?.addEventListener('click', () => {
        const pack = loadPackConfig();
        if (pack && pack.url) {
            showToast('Clear the Private Pack first to use Free Public TURN', 'warning');
            return;
        }
        const enabling = !isOpenRelayEnabled();
        setOpenRelayEnabled(enabling);
        refreshPackStatus();
        showToast(enabling ? '🟡 OpenRelay TURN enabled' : '⚪ OpenRelay TURN disabled', enabling ? 'success' : 'info');
    });

    // ── Pack input: auto-show passphrase row ──────────────────
    document.getElementById('mp-pack-input')?.addEventListener('input', () => {
        const v = (document.getElementById('mp-pack-input')?.value || '').trim();
        const ppRow = document.getElementById('mp-pack-pp-row');
        if (ppRow) ppRow.style.display = v.startsWith('STMP2:') ? '' : 'none';
        const ppInput = document.getElementById('mp-pack-pp');
        if (ppInput && !v.startsWith('STMP2:')) ppInput.value = '';
        const hint = document.getElementById('mp-pack-pp-hint');
        if (hint) hint.textContent = '';
    });

    // Auto-strip whitespace/newlines when pasting a Server Pack string
    document.getElementById('mp-pack-input')?.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text');
        const cleaned = text.replace(/\s+/g, '').trim();
        const packInput = document.getElementById('mp-pack-input');
        if (packInput) {
            packInput.value = cleaned;
            packInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
    // Also trim on blur (handles middle-click paste and drag-drop)
    document.getElementById('mp-pack-input')?.addEventListener('blur', () => {
        const packInput = document.getElementById('mp-pack-input');
        if (!packInput) return;
        const cleaned = packInput.value.replace(/\s+/g, '').trim();
        if (cleaned !== packInput.value) {
            packInput.value = cleaned;
            packInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });

    document.getElementById('mp-pack-pp')?.addEventListener('input', () => {
        const pp = document.getElementById('mp-pack-pp')?.value || '';
        const hint = document.getElementById('mp-pack-pp-hint');
        if (!hint) return;
        const v = validatePassphrase(pp, true);
        hint.textContent = v.msg;
        hint.className = 'mp-hint ' + (v.ok ? 'mp-hint-warn' : 'mp-hint-error');
    });

    // ── Save Pack ──────────────────────────────────────────────
    document.getElementById('mp-pack-save-btn')?.addEventListener('click', async () => {
        const v = (document.getElementById('mp-pack-input')?.value || '').replace(/\s+/g, '').trim();
        if (!v) { showToast('Paste a Server Pack first', 'error'); return; }
        if (!v.startsWith('STMP1:') && !v.startsWith('STMP2:')) {
            showToast('Invalid Pack — must start with STMP1: or STMP2:', 'error'); return;
        }
        const btn = document.getElementById('mp-pack-save-btn');
        const origText = btn ? btn.textContent : '💾 Save';
        let cfg;
        if (v.startsWith('STMP1:')) {
            cfg = decodeServerPackV1(v);
            if (!cfg) { showToast('Invalid STMP1 pack', 'error'); return; }
        } else {
            const pp = (document.getElementById('mp-pack-pp')?.value || '');
            const vpp = validatePassphrase(pp, true);
            if (!vpp.ok) { showToast(vpp.msg, 'error'); return; }
            if (btn) btn.textContent = '⏳';
            try { cfg = await decodeServerPackV2(v, pp); }
            catch (e) {
                if (btn) btn.textContent = origText;
                showToast('❌ ' + e.message, 'error');
                return;
            }
        }
        saveServerPack(v);
        savePackConfig(cfg);
        setOpenRelayEnabled(false);
        refreshPackStatus();
        showToast('✅ Server Pack saved!', 'success');
        if (btn) { btn.textContent = '✅'; setTimeout(() => { if (btn) btn.textContent = origText; }, 1500); }
    });

    // ── Clear Pack ─────────────────────────────────────────────
    document.getElementById('mp-pack-clear-btn')?.addEventListener('click', () => {
        clearServerPack();
        const input = document.getElementById('mp-pack-input');
        if (input) input.value = '';
        const ppRow = document.getElementById('mp-pack-pp-row');
        if (ppRow) ppRow.style.display = 'none';
        refreshPackStatus();
        showToast('Pack cleared', 'info');
    });

    // ── Share (re-encrypt) ─────────────────────────────────────
    document.getElementById('mp-pack-share-btn')?.addEventListener('click', async () => {
        const cfg = loadPackConfig();
        if (!cfg || !cfg.url) { showToast('No Server Pack saved yet', 'error'); return; }
        const pp = window.prompt(
            'Enter a passphrase to encrypt the shared pack (STMP2).\n' +
            'Leave blank to share as plain STMP1 (password visible).\n\n' +
            'Minimum 8 characters for an encrypted pack.');
        if (pp === null) return;
        const btn = document.getElementById('mp-pack-share-btn');
        const origText = btn ? btn.textContent : '📤 Share (re-encrypt)';
        let pack;
        if (!pp) {
            pack = encodeServerPack(cfg);
        } else {
            const vpp = validatePassphrase(pp, true);
            if (!vpp.ok) { showToast(vpp.msg, 'error'); return; }
            if (vpp.msg && !window.confirm(vpp.msg + '\n\nContinue anyway?')) return;
            if (btn) btn.textContent = '⏳';
            pack = await encodeServerPackV2(cfg, pp);
        }
        navigator.clipboard.writeText(pack).then(() => {
            showToast('📋 Pack copied to clipboard!', 'success');
            if (btn) { btn.textContent = '✅ Copied!'; setTimeout(() => { if (btn) btn.textContent = origText; }, 2000); }
        }).catch(() => {
            alert('Share pack:\n\n' + pack + '\n\n(Copy manually)');
            if (btn) btn.textContent = origText;
        });
    });

    // ── Generate: passphrase hint ──────────────────────────────
    document.getElementById('mp-gen-pp')?.addEventListener('input', () => {
        const pp = document.getElementById('mp-gen-pp')?.value || '';
        const hint = document.getElementById('mp-gen-pp-hint');
        if (!hint) return;
        if (!pp) {
            hint.textContent = '(blank = STMP1 — password visible to anyone)';
            hint.className = 'mp-hint mp-hint-warn';
            return;
        }
        const v = validatePassphrase(pp, false);
        hint.textContent = v.msg;
        hint.className = 'mp-hint ' + (v.ok ? 'mp-hint-warn' : 'mp-hint-error');
    });

    // ── Generate Pack ──────────────────────────────────────────
    document.getElementById('mp-gen-create-btn')?.addEventListener('click', async () => {
        const url        = (document.getElementById('mp-gen-url')?.value || '').trim();
        const username   = (document.getElementById('mp-gen-user')?.value || '').trim();
        const password   = document.getElementById('mp-gen-pass')?.value || '';
        const pp         = document.getElementById('mp-gen-pp')?.value || '';
        const forceRelay = !!(document.getElementById('mp-gen-relay')?.checked);

        if (!url) { showToast('Please enter a TURN URL first', 'error'); return; }
        if (!url.startsWith('turn:') && !url.startsWith('turns:')) {
            showToast('TURN URL must start with "turn:" or "turns:"', 'error'); return;
        }
        if (pp) {
            const vpp = validatePassphrase(pp, false);
            if (!vpp.ok) { showToast(vpp.msg, 'error'); return; }
            if (vpp.msg && !window.confirm(vpp.msg + '\n\nContinue anyway?')) return;
        }

        const btn = document.getElementById('mp-gen-create-btn');
        const origText = btn ? btn.textContent : '📋 Generate & Copy';
        if (btn) btn.textContent = '⏳ Generating...';

        let pack;
        if (pp) {
            pack = await encodeServerPackV2({ url, username, password, forceRelay }, pp);
        } else {
            pack = encodeServerPack({ url, username, password, forceRelay });
        }

        const packInput = document.getElementById('mp-pack-input');
        if (packInput) {
            packInput.value = pack;
            const section = document.getElementById('mp-pack-section');
            if (section) section.open = true;
        }
        const ppRow = document.getElementById('mp-pack-pp-row');
        if (ppRow) ppRow.style.display = pack.startsWith('STMP2:') ? '' : 'none';

        navigator.clipboard.writeText(pack).then(() => {
            showToast('📋 Pack generated & copied!', 'success');
            if (btn) { btn.textContent = '✅ Copied!'; setTimeout(() => { if (btn) btn.textContent = origText; }, 2000); }
        }).catch(() => {
            alert('Generated:\n\n' + pack + '\n\n(Copy manually)');
            if (btn) btn.textContent = origText;
        });
    });

    // ── Enter key mode: init + handler ────────────────────────
    const enterModeSel = document.getElementById('mp-enter-mode-sel');
    if (enterModeSel) {
        const saved = localStorage.getItem('mp-enter-mode') || 'auto';
        enterModeSel.value = saved;
        enterModeSel.addEventListener('change', () => {
            localStorage.setItem('mp-enter-mode', enterModeSel.value);
            showToast(`⌨️ Enter key: ${enterModeSel.options[enterModeSel.selectedIndex].text}`, 'info');
        });
    }

    loadThemePreference();
    refreshPackStatus();
}

// ============================================================
// INIT
// ============================================================

async function init() {
    try {
        setupUI();
        migrateLegacyPack();

        if (eventSource) {
            if (eventSource.removeListener) {
                eventSource.removeListener(event_types.MESSAGE_RECEIVED, handleBotReply);
                eventSource.removeListener(event_types.CHAT_CHANGED, onChatChanged);
            }
            eventSource.on(event_types.MESSAGE_RECEIVED, handleBotReply);
            eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
            // Confirm that ST actually started generating after inject
            if (event_types.GENERATION_STARTED) {
                eventSource.on(event_types.GENERATION_STARTED, () => {
                    if (isHost && waitingBot) generationStartedConfirmed = true;
                });
            }
        } else {
            console.warn('[MP-Sync] eventSource not available');
        }

        // Graceful cleanup on tab close
        window.addEventListener('beforeunload', () => { /* P2P only — no server cleanup needed */ });

        // A2/A4: Visibility API — refresh heartbeat + warn on long background
        document.addEventListener('visibilitychange', onVisibilityChange);

        // ── Generation failure detection (host only) ─────────
        // Track whether MESSAGE_RECEIVED fired during the current round
        eventSource.on(event_types.MESSAGE_RECEIVED, () => {
            if (isHost && waitingBot) messageReceivedThisRound = true;
        });

        // GENERATION_ENDED: fires after every generation attempt (success or failure)
        if (event_types.GENERATION_ENDED) {
            eventSource.on(event_types.GENERATION_ENDED, () => {
                if (isHost && waitingBot && !messageReceivedThisRound) {
                    handleGenerationFailure('No message received');
                }
                // Reset flag for next round (handled inside resetRound too, belt+suspenders)
                messageReceivedThisRound = false;
            });
        }

        // GENERATION_STOPPED: fires when user hits Stop or generation errors out
        if (event_types.GENERATION_STOPPED) {
            eventSource.on(event_types.GENERATION_STOPPED, () => {
                if (isHost && waitingBot && !messageReceivedThisRound) {
                    handleGenerationFailure('Generation stopped');
                }
            });
        }

        console.log('[MP-Sync] Extension loaded v3.4.0');
    } catch (err) {
        console.error('[MP-Sync] Init error:', err);
    }
}

jQuery(async () => {
    await init();
});
