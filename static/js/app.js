const API_BASE = '/api';

// Global variables
let currentChatId = null;
let selectedFile = null;
let socket = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let userProfile = null;
let loginTempData = {};

// --- Auth & Startup ---
document.addEventListener('DOMContentLoaded', () => {
    console.log('App initialized');
    setupEventListeners();
    checkAuth();
});

function setupEventListeners() {
    // Enter key support for inputs
    document.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            const loginContainer = document.getElementById('login-container');
            if (loginContainer && !loginContainer.classList.contains('hidden')) {
                handleAuth();
            } else if (document.getElementById('chat-input') === document.activeElement) {
                sendChatMessage();
            }
        }
    });

    // Modal close on outside click
    const modalOverlay = document.getElementById('modal-overlay');
    if (modalOverlay) {
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) {
                closeModal();
            }
        });
    }
}

async function checkAuth() {
    try {
        const response = await fetch(`${API_BASE}/auth/profile`);
        if (response.ok) {
            userProfile = await response.json();
            updateUIWithProfile(userProfile);
            showDashboard();
        } else {
            showLogin();
        }
    } catch (e) {
        console.error("Error checking auth:", e);
        showLogin();
    }
}

function updateUIWithProfile(profile) {
    const name = profile.first_name || profile.name || 'User';

    // Update welcome message
    const welcomeMsg = document.getElementById('welcome-msg');
    if (welcomeMsg) welcomeMsg.innerText = `Welcome, ${name}`;

    // Update user display
    const userDisplay = document.getElementById('user-display');
    if (userDisplay) userDisplay.innerText = name;

    // Update drawer info
    const drawerName = document.getElementById('drawer-name');
    const drawerAvatar = document.getElementById('drawer-avatar');
    const drawerPhone = document.getElementById('drawer-phone');

    if (drawerName) drawerName.innerText = name;
    if (drawerAvatar) drawerAvatar.innerText = name.charAt(0).toUpperCase();
    if (drawerPhone) drawerPhone.innerText = profile.phone || profile.username || '';
}

function showLogin() {
    const loginContainer = document.getElementById('login-container');
    const dashboard = document.getElementById('dashboard');

    if (loginContainer) {
        loginContainer.style.display = 'flex';
        loginContainer.classList.remove('hidden');
    }
    if (dashboard) {
        dashboard.classList.add('hidden');
    }
}

function showDashboard() {
    const loginContainer = document.getElementById('login-container');
    const dashboard = document.getElementById('dashboard');

    if (loginContainer) {
        loginContainer.style.display = 'none';
        loginContainer.classList.add('hidden');
    }
    if (dashboard) {
        dashboard.classList.remove('hidden');
    }

    // Update UI with profile if we have it
    if (userProfile) {
        updateUIWithProfile(userProfile);
    }

    // Load initial data
    loadInitialSystemState();
    loadChats();
    connectWebSocket();
}

function toggleSidebar() {
    document.querySelector('.sidebar').classList.toggle('-translate-x-full');
}

async function logout() {
    // Call server logout
    await fetch(`${API_BASE}/logout`, { method: 'POST' });

    userProfile = null;
    loginTempData = {};

    // Close WebSocket
    if (socket) {
        socket.close();
        socket = null;
    }

    // Reload page
    window.location.reload();
}

function getHeaders() {
    return {
        'Content-Type': 'application/json'
    };
}

async function fetchWithAuth(url, options = {}) {
    if (!options.headers) options.headers = getHeaders();
    else Object.assign(options.headers, getHeaders());

    const response = await fetch(url, options);
    if (response.status === 401) {
        console.warn("Session expired. Logging out...");
        logout();
        throw new Error("Unauthorized");
    }
    return response;
}

// --- Navigation ---
function navTo(section) {
    // Update active nav item
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const navElement = document.getElementById(`nav-${section}`);
    if (navElement) navElement.classList.add('active');

    // Show section
    document.querySelectorAll('.content-section').forEach(el => el.classList.remove('active'));
    const sectionElement = document.getElementById(`section-${section}`);
    if (sectionElement) sectionElement.classList.add('active');

    // Load data if needed
    if (section === 'settings') loadSettings();
    if (section === 'keywords') loadKeywords();
    if (section === 'chat') loadChats();
}

// --- Auth Handling ---
async function handleAuth() {
    const apiId = document.getElementById('api-id').value.trim();
    const apiHash = document.getElementById('api-hash').value.trim();
    const phoneInput = document.getElementById('phone-number');
    const phone = phoneInput ? phoneInput.value.trim() : '';
    const err = document.getElementById('login-error');
    const btn = document.getElementById('btn-auth');

    // Step 1: API ID and Hash
    const phoneGroup = document.getElementById('phone-group');
    if (phoneGroup && phoneGroup.classList.contains('hidden')) {
        if (!apiId || !apiHash) {
            showError("API ID & Hash Required");
            return;
        }

        btn.innerText = "Checking session...";
        btn.disabled = true;
        hideError();

        try {
            // Check existing session
            const checkRes = await fetch(`${API_BASE}/auth/check-session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_id: apiId, api_hash: apiHash })
            });

            const checkData = await checkRes.json();

            if (checkRes.ok && checkData.has_session) {
                // Session exists - try direct login
                btn.innerText = "Logging in...";

                const loginRes = await fetch(`${API_BASE}/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ api_id: apiId, api_hash: apiHash })
                });

                const loginData = await loginRes.json();

                if (loginRes.ok && loginData.status === 'success') {
                    userProfile = loginData.user;
                    finishLogin();
                    return;
                }
            }

            // No session or login failed - show phone field
            if (phoneGroup) {
                phoneGroup.classList.remove('hidden');
                showError("Please enter your phone number to continue");
            }

        } catch (e) {
            console.error("Auth error:", e);
            showError("Connection error. Please try again.");
        } finally {
            btn.innerText = "Continue";
            btn.disabled = false;
        }
    } else {
        // Step 2: Request code with phone
        if (!phone) {
            showError("Phone number required");
            return;
        }

        btn.innerText = "Sending Code...";
        btn.disabled = true;

        try {
            const res = await fetch(`${API_BASE}/auth/request-code`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api_id: apiId,
                    api_hash: apiHash,
                    phone_number: phone
                })
            });

            const data = await res.json();

            if (res.ok) {
                // Store temp data and go to code verification
                loginTempData = {
                    phone_code_hash: data.phone_code_hash,
                    api_id: apiId,
                    phone: phone,
                    api_hash: apiHash
                };

                document.getElementById('step-1').classList.add('hidden');
                document.getElementById('step-2').classList.remove('hidden');
                hideError();
            } else {
                showError(data.message || "Failed to send code");
            }
        } catch (e) {
            showError("Network Error");
        } finally {
            btn.innerText = "Continue";
            btn.disabled = false;
        }
    }
}

async function verifyCode() {
    const code = document.getElementById('otp-code').value.trim();
    const btn = document.getElementById('btn-verify');

    if (!code) {
        showError("Please enter the code");
        return;
    }

    btn.disabled = true;
    btn.innerText = "Verifying...";

    try {
        const res = await fetch(`${API_BASE}/auth/verify-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_id: loginTempData.api_id,
                phone_number: loginTempData.phone,
                code: code,
                phone_code_hash: loginTempData.phone_code_hash
            })
        });

        const data = await res.json();
        if (res.ok) {
            if (data.status === 'password_required') {
                // Two-step verification required
                document.getElementById('step-2').classList.add('hidden');
                document.getElementById('step-3').classList.remove('hidden');
                hideError();
            } else {
                // Login successful
                await performLoginAfterVerify();
            }
        } else {
            showError(data.message || "Invalid code");
            btn.disabled = false;
            btn.innerText = "Verify & Login";
        }
    } catch (e) {
        showError("Error verifying code");
        btn.disabled = false;
        btn.innerText = "Verify & Login";
    }
}

async function verifyPassword() {
    const password = document.getElementById('two-step-password').value;
    const btn = document.getElementById('btn-verify-password');

    if (!password) {
        showError("Password required");
        return;
    }

    btn.disabled = true;
    btn.innerText = "Verifying...";

    try {
        const res = await fetch(`${API_BASE}/auth/verify-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_id: loginTempData.api_id,
                password: password
            })
        });

        const data = await res.json();
        if (res.ok && data.status === 'success') {
            await performLoginAfterVerify();
        } else {
            showError(data.message || "Incorrect password");
            btn.disabled = false;
            btn.innerText = "Verify Password";
        }
    } catch (e) {
        showError("Error verifying password");
        btn.disabled = false;
        btn.innerText = "Verify Password";
    }
}

async function performLoginAfterVerify() {
    const apiId = loginTempData.api_id;
    const apiHash = loginTempData.api_hash || document.getElementById('api-hash').value;

    try {
        const res = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_id: apiId, api_hash: apiHash })
        });

        const data = await res.json();
        if (res.ok) {
            userProfile = data.user;
            finishLogin();
        } else {
            showError("Login failed after verification");
        }
    } catch (e) {
        showError("Error completing login");
    }
}

function finishLogin() {
    // Clean up temp data
    loginTempData = {};

    console.log("Login successful, showing dashboard...");
    showDashboard();
}

function showError(message) {
    const err = document.getElementById('login-error');
    if (err) {
        err.innerText = message;
        err.classList.remove('hidden');
    }
}

function hideError() {
    const err = document.getElementById('login-error');
    if (err) {
        err.classList.add('hidden');
    }
}

function backToStep1() {
    document.getElementById('step-2').classList.add('hidden');
    document.getElementById('step-3').classList.add('hidden');
    document.getElementById('step-1').classList.remove('hidden');
    hideError();
}

// --- WebSocket ---
function connectWebSocket() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        console.log("✅ WebSocket connected");
        reconnectAttempts = 0;
    };

    socket.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleWebSocketMessage(msg);
        } catch (e) {
            console.error("WebSocket message parse error:", e);
        }
    };

    socket.onclose = () => {
        console.log("WebSocket disconnected");

        if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempts++;
            const delay = Math.min(3000, reconnectAttempts * 1000);
            console.log(`Reconnecting in ${delay}ms...`);
            setTimeout(connectWebSocket, delay);
        }
    };

    socket.onerror = (error) => {
        console.error("WebSocket error:", error);
    };
}

function handleWebSocketMessage(msg) {
    switch (msg.type) {
        case 'new_message':
            handleNewMessage(msg);
            break;
        case 'message_sent':
            console.log("✅ Message sent successfully");
            break;
        default:
            console.log("Unknown message type:", msg.type);
    }
}

function handleNewMessage(msg) {
    // 1. If currently in this chat, append the message
    if (currentChatId && (currentChatId == msg.chat_id)) {
        appendMessage({
            id: Date.now(),
            text: msg.text,
            outgoing: false,
            date: msg.date,
            sender_name: msg.chat_name
        });
        scrollToBottom();
    }

    // 2. Refresh chat list to show latest message
    loadChats();
}

// --- System Status ---
async function toggleSystemActive() {
    const toggle = document.getElementById('system-active-toggle');
    const isActive = toggle.checked;

    // Update UI immediately for better UX
    updateSystemStatusUI(isActive);

    // Update on server
    try {
        const settings = await fetchWithAuth(`${API_BASE}/settings`);
        const currentSettings = await settings.json();
        currentSettings.active = isActive;

        await fetchWithAuth(`${API_BASE}/settings`, {
            method: 'POST',
            body: JSON.stringify(currentSettings)
        });

        console.log(`✅ System ${isActive ? 'activated' : 'deactivated'}`);
    } catch (e) {
        console.error("Failed to update system status:", e);
        // Revert UI on error
        toggle.checked = !isActive;
        updateSystemStatusUI(!isActive);
    }
}

function updateSystemStatusUI(isActive) {
    const container = document.getElementById('status-container');
    if (!container) return;

    const indicator = container.querySelector('#status-indicator');
    const statusText = container.querySelector('.status-text');

    if (isActive) {
        indicator.className = 'w-2.5 h-2.5 rounded-full bg-green-400 shadow-[0_0_8px_#4ade80]';
        if (statusText) statusText.innerText = 'Online';
    } else {
        indicator.className = 'w-2.5 h-2.5 rounded-full bg-red-400 shadow-[0_0_8px_#f87171]';
        if (statusText) statusText.innerText = 'Offline';
    }
}

async function loadInitialSystemState() {
    try {
        const res = await fetchWithAuth(`${API_BASE}/settings`);
        const data = await res.json();
        const toggle = document.getElementById('system-active-toggle');

        if (toggle) {
            toggle.checked = data.active;
            updateSystemStatusUI(data.active);
        }
    } catch (e) {
        console.error("Failed to load system state:", e);
    }
}

// --- Drawer & Modal ---
function toggleDrawer() {
    const drawer = document.querySelector('.drawer');
    const overlay = document.querySelector('.drawer-overlay');

    if (drawer.classList.contains('-translate-x-full')) {
        // Open drawer
        drawer.classList.remove('-translate-x-full');
        drawer.classList.add('translate-x-0');
        if (overlay) overlay.classList.remove('hidden');

        // Update drawer info
        if (userProfile) {
            const nameEl = document.getElementById('drawer-name');
            const avatarEl = document.getElementById('drawer-avatar');
            const phoneEl = document.getElementById('drawer-phone');

            if (nameEl) nameEl.innerText = userProfile.first_name || userProfile.name || 'User';
            if (avatarEl) avatarEl.innerText = (userProfile.first_name || userProfile.name || 'U').charAt(0);
            if (phoneEl) phoneEl.innerText = userProfile.phone || userProfile.username || '';
        }
    } else {
        // Close drawer
        drawer.classList.add('-translate-x-full');
        drawer.classList.remove('translate-x-0');
        if (overlay) overlay.classList.add('hidden');
    }
}

function openSection(sectionId) {
    toggleDrawer(); // Close drawer first

    const modal = document.getElementById('modal-overlay');
    const body = document.getElementById('modal-body');

    if (!modal || !body) return;

    modal.classList.remove('hidden');

    switch (sectionId) {
        case 'settings':
            body.innerHTML = `<h3 class="text-xl font-bold mb-6 flex items-center gap-2"><span>⚙️</span> Live Reply Settings</h3><div id="settings-content">Loading...</div>`;
            loadSettingsInsideModal();
            break;
        case 'keywords':
            body.innerHTML = `<h3 class="text-xl font-bold mb-6 flex items-center gap-2"><span>🔑</span> Keyword Management</h3><div id="keywords-content">Loading...</div>`;
            loadKeywordsInsideModal();
            break;
        case 'scheduled':
            body.innerHTML = `<h3 class="text-xl font-bold mb-6 flex items-center gap-2"><span>⏰</span> Scheduled Messages</h3><div id="scheduled-content">Loading...</div>`;
            loadScheduledInsideModal();
            break;
        default:
            body.innerHTML = `<h3 class="text-xl font-bold mb-6">${sectionId}</h3><div>Content not available</div>`;
    }
}

function closeModal() {
    const modal = document.getElementById('modal-overlay');
    if (modal) {
        modal.classList.add('hidden');
    }
}

// --- Settings Modal ---
async function loadSettingsInsideModal() {
    try {
        const res = await fetchWithAuth(`${API_BASE}/settings`);
        const data = await res.json();

        const content = document.getElementById('settings-content');
        content.innerHTML = `
            <div class="space-y-6">
                <div class="flex items-center justify-between p-4 bg-white/5 rounded-2xl border border-white/5">
                    <span class="font-medium">Auto-Reply Active</span>
                    <label class="relative inline-flex items-center cursor-pointer">
                        <input type="checkbox" id="m-active" class="sr-only peer" ${data.active ? 'checked' : ''}>
                        <div class="w-11 h-6 bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-green-500"></div>
                    </label>
                </div>
                
                <div class="space-y-2 text-left">
                    <label class="block text-xs font-semibold uppercase tracking-wider text-indigo-200/60 ml-2">Custom Reply Text</label>
                    <textarea id="m-text" class="w-full bg-dark/50 border border-border rounded-2xl px-5 py-4 focus:outline-none focus:border-brand transition-all custom-scrollbar h-32 resize-none" placeholder="Hello! How can I help?">${data.auto_reply_text}</textarea>
                </div>
                
                <div class="space-y-2 text-left">
                    <label class="block text-xs font-semibold uppercase tracking-wider text-indigo-200/60 ml-2">Cool-down Duration</label>
                    <div class="flex gap-3">
                        <div class="flex-1">
                            <input type="number" id="m-wait-h" min="0" class="w-full bg-dark/50 border border-border rounded-xl px-4 py-3 focus:outline-none focus:border-brand transition-all" value="${Math.floor(data.wait_time / 3600)}" placeholder="HH">
                            <span class="text-[10px] opacity-40 ml-1">Hours</span>
                        </div>
                        <div class="flex-1">
                            <input type="number" id="m-wait-m" min="0" max="59" class="w-full bg-dark/50 border border-border rounded-xl px-4 py-3 focus:outline-none focus:border-brand transition-all" value="${Math.floor((data.wait_time % 3600) / 60)}" placeholder="MM">
                            <span class="text-[10px] opacity-40 ml-1">Minutes</span>
                        </div>
                    </div>
                </div>
                
                <button onclick="saveSettingsModal()" class="w-full bg-brand py-4 rounded-2xl font-bold shadow-lg hover:shadow-brand/20 transition-all">Save Changes</button>
            </div>
        `;
    } catch (e) {
        console.error("Load settings error:", e);
        document.getElementById('settings-content').innerHTML = `<div class="text-red-400 p-4">Error loading settings</div>`;
    }
}

async function saveSettingsModal() {
    const active = document.getElementById('m-active').checked;
    const text = document.getElementById('m-text').value;

    const h = parseInt(document.getElementById('m-wait-h').value) || 0;
    const m = parseInt(document.getElementById('m-wait-m').value) || 0;
    const waitSeconds = (h * 3600) + (m * 60);

    try {
        await fetchWithAuth(`${API_BASE}/settings`, {
            method: 'POST',
            body: JSON.stringify({
                active,
                auto_reply_text: text,
                wait_time: waitSeconds
            })
        });
        closeModal();
        showToast("✅ Settings saved successfully");
    } catch (e) {
        console.error("Save settings error:", e);
        showToast("❌ Error saving settings", "error");
    }
}

// --- Keywords Modal ---
async function loadKeywordsInsideModal() {
    const content = document.getElementById('keywords-content');
    content.innerHTML = `
        <div class="space-y-4 mb-8">
            <div class="flex flex-col gap-3">
                <input id="m-k-key" class="w-full bg-dark/50 border border-border rounded-xl px-5 py-3.5 focus:outline-none focus:border-brand transition-all" placeholder="Keyword (e.g., hello)">
                <textarea id="m-k-reply" class="w-full bg-dark/50 border border-border rounded-xl px-5 py-3.5 focus:outline-none focus:border-brand transition-all custom-scrollbar h-32 resize-none" placeholder="Bot reply with line breaks..."></textarea>
            </div>
            <button onclick="addKeywordModal()" class="w-full bg-brand py-3.5 rounded-xl font-bold transition-all shadow-lg active:scale-95">Add New Keyword</button>
        </div>
        <div id="m-k-list" class="space-y-3 max-h-[400px] overflow-y-auto custom-scrollbar pr-2">Loading...</div>
     `;

    try {
        const res = await fetchWithAuth(`${API_BASE}/keywords`);
        const data = await res.json();
        const list = document.getElementById('m-k-list');

        if (data.length === 0) {
            list.innerHTML = '<div class="text-center py-8 text-indigo-200/40">No keywords added yet</div>';
            return;
        }

        list.innerHTML = '';
        data.forEach(k => {
            const div = document.createElement('div');
            div.className = 'group flex justify-between items-start bg-white/5 p-4 rounded-2xl border border-white/5 hover:border-brand/40 transition-all';
            div.innerHTML = `
                <div onclick="editKeywordModal(\`${k.keyword}\`, \`${k.reply.replace(/`/g, '\\`').replace(/\n/g, '\\n')}\`)" class="flex-1 cursor-pointer">
                    <b class="text-brand block mb-1">/${k.keyword}</b>
                    <div class="text-[0.85rem] opacity-70 whitespace-pre-wrap leading-relaxed">${k.reply}</div>
                </div>
                <button onclick="deleteKeywordModal('${k.keyword}')" class="w-8 h-8 flex items-center justify-center rounded-full bg-red-500/10 text-red-500 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500 hover:text-white ml-3 mt-1">×</button>
            `;
            list.appendChild(div);
        });
    } catch (e) {
        console.error("Load keywords error:", e);
        document.getElementById('m-k-list').innerHTML = '<div class="text-red-400 p-4">Error loading keywords</div>';
    }
}

async function addKeywordModal() {
    const keyEl = document.getElementById('m-k-key');
    const replyEl = document.getElementById('m-k-reply');
    const keyword = keyEl.value.trim();
    const reply = replyEl.value.trim();

    if (!keyword || !reply) {
        showToast("❌ Both fields are required", "error");
        return;
    }

    try {
        const res = await fetchWithAuth(`${API_BASE}/keywords`, {
            method: 'POST',
            body: JSON.stringify({ keyword, reply })
        });

        if (res.ok) {
            keyEl.value = '';
            replyEl.value = '';
            loadKeywordsInsideModal();
            showToast("✅ Keyword added successfully");
        } else {
            const data = await res.json();
            showToast(`❌ ${data.message || "Failed to add keyword"}`, "error");
        }
    } catch (e) {
        console.error(e);
        showToast("❌ Error adding keyword", "error");
    }
}

async function deleteKeywordModal(keyword) {
    if (!confirm(`Are you sure you want to delete "${keyword}"?`)) return;

    try {
        const res = await fetchWithAuth(`${API_BASE}/keywords?keyword=${encodeURIComponent(keyword)}`, {
            method: 'DELETE'
        });

        if (res.ok) {
            loadKeywordsInsideModal();
            showToast("✅ Keyword deleted");
        } else {
            const data = await res.json();
            showToast(`❌ ${data.message || "Failed to delete keyword"}`, "error");
        }
    } catch (e) {
        console.error(e);
        showToast("❌ Error deleting keyword", "error");
    }
}

function editKeywordModal(keyword, reply) {
    document.getElementById('m-k-key').value = keyword;
    document.getElementById('m-k-reply').value = reply;
}

// --- Chat Functions ---
async function loadChats() {
    const container = document.getElementById('chats-container');
    if (!container) return;

    try {
        const res = await fetchWithAuth(`${API_BASE}/chats`);
        const chats = await res.json();

        // Sort by date (newest first)
        chats.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
        container.innerHTML = '';

        if (chats.length === 0) {
            container.innerHTML = '<div class="text-center py-8 text-indigo-200/40">No chats found</div>';
            return;
        }

        for (const chat of chats) {
            const el = document.createElement('div');
            el.className = 'flex items-center gap-4 p-4 cursor-pointer hover:bg-white/5 active:bg-white/10 transition-all border-b border-white/[0.02] group';

            // Photo placeholder
            let photoHtml = `<div class="w-12 h-12 rounded-full bg-brand/20 flex items-center justify-center text-lg font-bold text-brand shadow-inner chat-avatar">${chat.name.charAt(0)}</div>`;

            el.innerHTML = `
                ${photoHtml}
                <div class="flex-1 min-w-0">
                    <div class="flex justify-between items-baseline mb-1">
                        <span class="font-semibold truncate text-[0.95rem] group-hover:text-brand transition-colors">${chat.name}</span>
                        <span class="text-[0.7rem] opacity-40 shrink-0 font-medium">${chat.date ? formatTime(chat.date) : ''}</span>
                    </div>
                    <div class="text-[0.8rem] opacity-50 truncate leading-relaxed">${chat.message || ''}</div>
                </div>
            `;

            el.onclick = () => openChat(chat.id, chat.name);
            container.appendChild(el);

            // Load profile photo
            loadChatPhoto(chat.id, el);
        }
    } catch (e) {
        console.error("Load chats error:", e);
        container.innerHTML = '<div class="text-center py-8 text-red-400">Error loading chats</div>';
    }
}

function formatTime(dateString) {
    try {
        const date = new Date(dateString);
        const now = new Date();
        const diff = now - date;

        if (diff < 24 * 60 * 60 * 1000) {
            // Today
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } else if (diff < 7 * 24 * 60 * 60 * 1000) {
            // This week
            return date.toLocaleDateString([], { weekday: 'short' });
        } else {
            // Older
            return date.toLocaleDateString();
        }
    } catch (e) {
        return '';
    }
}

async function loadChatPhoto(chatId, chatElement) {
    try {
        const res = await fetchWithAuth(`${API_BASE}/photos/${chatId}`);
        const data = await res.json();

        if (data.url) {
            const avatarDiv = chatElement.querySelector('.chat-avatar');
            if (avatarDiv) {
                avatarDiv.innerHTML = `<img src="${data.url}" class="w-full h-full rounded-full object-cover border border-white/10" onerror="this.onerror=null; this.parentElement.innerHTML='${chatElement.querySelector('.font-semibold').innerText.charAt(0)}'">`;
            }
        }
    } catch (e) {
        // Silent fail - use default avatar
    }
}

async function openChat(chatId, chatName) {
    currentChatId = chatId;

    // Update header
    const headerName = document.getElementById('chat-header-name');
    if (headerName) headerName.innerText = chatName;

    const headerImg = document.getElementById('chat-header-img');
    if (headerImg) headerImg.classList.add('hidden');

    // Mobile view
    if (window.innerWidth <= 768) {
        const chatPanel = document.getElementById('chat-view-panel');
        if (chatPanel) chatPanel.classList.add('active');
    }

    // Load messages
    await loadMessages(chatId);

    // Load header photo
    try {
        const res = await fetchWithAuth(`${API_BASE}/photos/${chatId}`);
        const data = await res.json();
        if (data.url && headerImg) {
            headerImg.src = data.url;
            headerImg.classList.remove('hidden');
        }
    } catch (e) {
        console.error("Load chat photo error:", e);
    }
}

function closeChat() {
    currentChatId = null;
    const chatPanel = document.getElementById('chat-view-panel');
    if (chatPanel) chatPanel.classList.remove('active');
}

async function loadMessages(chatId) {
    const container = document.getElementById('messages-container');
    if (!container) return;

    container.innerHTML = '<div class="flex items-center justify-center h-full opacity-40 animate-pulse italic">Loading messages...</div>';

    try {
        const res = await fetchWithAuth(`${API_BASE}/chats/${chatId}/messages`);
        const messages = await res.json();
        container.innerHTML = '';

        if (messages.length === 0) {
            container.innerHTML = '<div class="flex items-center justify-center h-full opacity-20 text-sm">No messages yet. Start the conversation!</div>';
            return;
        }

        // Messages come in reverse order (oldest first), we need to show newest at bottom
        messages.forEach(msg => appendMessage(msg));
        scrollToBottom();
    } catch (e) {
        console.error("Load messages error:", e);
        container.innerHTML = '<div class="text-center p-4 text-red-400 opacity-60">Failed to load messages</div>';
    }
}

function appendMessage(msg) {
    const container = document.getElementById('messages-container');
    const isOutgoing = msg.outgoing;

    // Avoid duplicates
    if (document.getElementById(`msg-${msg.id}`)) return;

    const div = document.createElement('div');
    div.className = `flex gap-2 w-full message-anim items-end ${isOutgoing ? 'justify-end' : 'justify-start'}`;
    div.id = `msg-${msg.id}`;

    const time = msg.date ? formatTime(msg.date) : '';

    let avatarHtml = '';
    if (!isOutgoing) {
        const initial = msg.sender_name ? msg.sender_name.charAt(0) : '?';
        avatarHtml = `<div class="w-8 h-8 rounded-full bg-brand/20 flex items-center justify-center text-xs font-bold shrink-0 border border-white/10 mb-0.5" id="avatar-${msg.id}">${initial}</div>`;
    }

    const bubbleClass = isOutgoing ? 'message-bubble-outgoing' : 'message-bubble-incoming';

    // Fix: Added `text-xs` to make time smaller and used `.trim()` on text content
    div.innerHTML = `
        ${!isOutgoing ? avatarHtml : ''}
        <div class="flex flex-col ${isOutgoing ? 'items-end ml-auto' : 'items-start'} max-w-[85%] md:max-w-[70%]">
            <div class="${bubbleClass} shadow-sm w-fit ${isOutgoing ? 'outgoing' : 'incoming'} px-3 py-1.5 flex flex-col">
                <span class="msg-text block w-full text-[15px] self-start whitespace-pre-wrap break-words text-white">
                    ${(msg.text || '').trim()}
                </span>
                <span class="msg-time text-[10px] shrink-0 font-medium">${time}</span>
            </div>
        </div>
    `;
    container.appendChild(div);
}

function scrollToBottom() {
    const container = document.getElementById('messages-container');
    if (container) {
        container.scrollTop = container.scrollHeight;
    }
}

// --- Message Sending ---
function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) {
        selectedFile = file;
        const preview = document.getElementById('file-preview-container');
        const name = document.getElementById('file-preview-name');

        if (preview) preview.classList.remove('hidden');
        if (name) name.innerText = file.name;
    }
}

function clearFile() {
    selectedFile = null;
    const input = document.getElementById('chat-file-input');
    if (input) input.value = '';

    const preview = document.getElementById('file-preview-container');
    if (preview) preview.classList.add('hidden');
}

async function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();

    if ((!text && !selectedFile) || !currentChatId) {
        return;
    }

    // Clear input
    input.value = '';

    try {
        if (selectedFile) {
            // Send with file
            const formData = new FormData();
            formData.append('chat_id', currentChatId);
            formData.append('message', text);
            formData.append('file', selectedFile);

            // Optimistic UI update
            appendMessage({
                id: Date.now(),
                text: text || `[File: ${selectedFile.name}]`,
                outgoing: true,
                date: new Date().toISOString()
            });

            clearFile();

            await fetchWithAuth(`${API_BASE}/chats/send-media`, {
                method: 'POST',
                body: formData
            });

        } else {
            // Send text only
            appendMessage({
                id: Date.now(),
                text: text,
                outgoing: true,
                date: new Date().toISOString()
            });

            await fetchWithAuth(`${API_BASE}/chats/send`, {
                method: 'POST',
                body: JSON.stringify({ chat_id: currentChatId, message: text })
            });
        }

        scrollToBottom();

    } catch (e) {
        console.error("Send message error:", e);
        showToast("❌ Failed to send message", "error");
    }
}

// --- Toast Notifications ---
function showToast(message, type = "success") {
    // Remove existing toast
    const existingToast = document.getElementById('global-toast');
    if (existingToast) existingToast.remove();

    // Create toast
    const toast = document.createElement('div');
    toast.id = 'global-toast';
    toast.className = `fixed top-4 right-4 z-[9999] px-4 py-3 rounded-lg shadow-lg transform transition-all duration-300 ${type === 'error' ? 'bg-red-500 text-white' : 'bg-green-500 text-white'
        }`;
    toast.innerText = message;

    document.body.appendChild(toast);

    // Animate in
    setTimeout(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateY(0)';
    }, 10);

    // Remove after 3 seconds
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-20px)';
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    }, 3000);
}

// --- Utility Functions ---
async function loadSettings() {
    try {
        const res = await fetchWithAuth(`${API_BASE}/settings`);
        const data = await res.json();
        // Update settings UI if needed
        console.log("Settings loaded:", data);
    } catch (e) {
        console.error("Load settings error:", e);
    }
}

async function loadKeywords() {
    try {
        const res = await fetchWithAuth(`${API_BASE}/keywords`);
        const data = await res.json();
        // Update keywords UI if needed
        console.log("Keywords loaded:", data.length);
    } catch (e) {
        console.error("Load keywords error:", e);
    }
}

// --- Scheduled Messages Modal (Basic) ---
async function loadScheduledInsideModal() {
    const content = document.getElementById('scheduled-content');
    content.innerHTML = `
        <div class="space-y-6">
            <!-- Form to Add New Schedule -->
            <div class="bg-white/5 border border-white/10 p-6 rounded-2xl space-y-4">
                <h4 class="text-sm font-bold uppercase tracking-widest text-brand mb-2">Create New Schedule</h4>
                
                <div class="space-y-2">
                    <label class="block text-xs font-semibold uppercase tracking-wider text-indigo-200/60 ml-2">Select Recipients</label>
                    <div id="m-s-chats-container" class="max-h-48 overflow-y-auto bg-dark/50 border border-border rounded-2xl p-3 custom-scrollbar">
                        <div class="flex items-center gap-2 mb-3 pb-2 border-b border-white/5">
                            <input type="checkbox" id="m-s-select-all" class="w-4 h-4 rounded border-white/10 bg-white/5 text-brand focus:ring-brand" onchange="toggleSelectAllChats(this.checked)">
                            <label for="m-s-select-all" class="text-sm font-bold cursor-pointer">Select All Chats</label>
                        </div>
                        <div id="m-s-chats-list" class="space-y-2">Loading chats...</div>
                    </div>
                </div>

                <div class="space-y-2">
                    <label class="block text-xs font-semibold uppercase tracking-wider text-indigo-200/60 ml-2">Message</label>
                    <textarea id="m-s-message" class="w-full bg-dark/50 border border-border rounded-2xl px-5 py-4 focus:outline-none focus:border-brand transition-all custom-scrollbar h-24 resize-none" placeholder="Enter message to send..."></textarea>
                </div>

                <div class="flex gap-4">
                    <div class="flex-1 space-y-2">
                        <label class="block text-xs font-semibold uppercase tracking-wider text-indigo-200/60 ml-2">Time (Every Day)</label>
                        <input type="time" id="m-s-time" class="w-full bg-dark/50 border border-border rounded-2xl px-5 py-3 focus:outline-none focus:border-brand transition-all" value="12:00">
                    </div>
                </div>

                <button onclick="addScheduledMessageModal()" id="m-s-add-btn" class="w-full bg-brand py-4 rounded-full font-bold shadow-lg hover:shadow-brand/20 transition-all flex items-center justify-center gap-2">
                    <span>➕</span> Create Schedule
                </button>
            </div>
            
            <div class="space-y-4">
                <h4 class="text-sm font-bold uppercase tracking-widest opacity-40 ml-1">Active Schedules</h4>
                <div id="m-s-list" class="space-y-3">Loading...</div>
            </div>
        </div>
    `;

    // Load Chats for Selection
    loadChatsForSchedule();

    // Load actual schedules
    try {
        const res = await fetchWithAuth(`${API_BASE}/scheduled-messages`);
        const data = await res.json();
        const list = document.getElementById('m-s-list');

        if (data.length === 0) {
            list.innerHTML = '<div class="p-8 text-center text-sm opacity-40 border border-dashed border-white/10 rounded-2xl">No scheduled messages yet.</div>';
            return;
        }

        list.innerHTML = '';
        data.forEach(s => {
            const div = document.createElement('div');
            div.className = 'bg-white/5 p-4 rounded-2xl border border-white/5 flex flex-col gap-3';

            const targetCount = (s.chat_ids?.length || 0) + (s.usernames?.length || 0);

            div.innerHTML = `
                <div class="flex justify-between items-center">
                    <div class="flex items-center gap-2 text-brand font-bold text-lg">
                        <span>⏰</span>
                        <span>${s.time || '00:00'}</span>
                    </div>
                    <button class="w-8 h-8 flex items-center justify-center rounded-full bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white transition-all" onclick="deleteScheduledModal('${s.id}')">×</button>
                </div>
                <div class="space-y-2">
                    <div class="text-[0.6rem] font-bold uppercase tracking-widest text-indigo-100/40">Targets: ${targetCount} recipients</div>
                    <div class="text-sm bg-dark/40 p-3 rounded-xl italic opacity-80 leading-relaxed">${s.message || 'No message'}</div>
                </div>
            `;
            list.appendChild(div);
        });
    } catch (e) {
        console.error("Load scheduled messages error:", e);
        document.getElementById('m-s-list').innerHTML = '<div class="text-red-400">Error loading schedules</div>';
    }
}

async function deleteScheduledModal(id) {
    if (!confirm("Are you sure you want to delete this schedule?")) return;

    try {
        const res = await fetchWithAuth(`${API_BASE}/scheduled-messages/${id}`, {
            method: 'DELETE'
        });

        if (res.ok) {
            loadScheduledInsideModal();
            showToast("✅ Schedule deleted");
        } else {
            const data = await res.json();
            showToast(`❌ ${data.message || "Failed to delete schedule"}`, "error");
        }
    } catch (e) {
        console.error(e);
        showToast("❌ Error deleting schedule", "error");
    }
}

async function loadChatsForSchedule() {
    const list = document.getElementById('m-s-chats-list');
    try {
        const res = await fetchWithAuth(`${API_BASE}/chats`);
        const chats = await res.json();
        list.innerHTML = '';

        if (chats.length === 0) {
            list.innerHTML = '<div class="text-xs opacity-40">No chats found.</div>';
            return;
        }

        chats.forEach(chat => {
            const div = document.createElement('div');
            div.className = 'flex items-center gap-3 p-2 hover:bg-white/5 rounded-xl transition-all cursor-pointer';
            div.onclick = (e) => {
                if (e.target.tagName !== 'INPUT') {
                    const cb = div.querySelector('input');
                    cb.checked = !cb.checked;
                }
            };

            div.innerHTML = `
                <input type="checkbox" name="m-s-chat-item" value="${chat.id}" class="w-4 h-4 rounded border-white/10 bg-white/5 text-brand focus:ring-brand">
                <div class="flex-1 min-w-0">
                    <div class="text-sm font-medium truncate">${chat.name}</div>
                    <div class="text-[0.7rem] opacity-40">${chat.id}</div>
                </div>
            `;
            list.appendChild(div);
        });
    } catch (e) {
        console.error(e);
        list.innerHTML = '<div class="text-red-400">Error loading chats</div>';
    }
}

function toggleSelectAllChats(checked) {
    const checkboxes = document.querySelectorAll('input[name="m-s-chat-item"]');
    checkboxes.forEach(cb => cb.checked = checked);
}

async function addScheduledMessageModal() {
    const msgEl = document.getElementById('m-s-message');
    const timeEl = document.getElementById('m-s-time');
    const message = msgEl.value.trim();
    const time = timeEl.value;

    const selectedChats = Array.from(document.querySelectorAll('input[name="m-s-chat-item"]:checked'))
        .map(cb => parseInt(cb.value));

    if (selectedChats.length === 0) {
        showToast("❌ Please select at least one recipient", "error");
        return;
    }

    if (!message) {
        showToast("❌ Message cannot be empty", "error");
        return;
    }

    const btn = document.getElementById('m-s-add-btn');
    btn.disabled = true;
    btn.innerHTML = `<span>⏳</span> Creating...`;

    try {
        const res = await fetchWithAuth(`${API_BASE}/scheduled-messages`, {
            method: 'POST',
            body: JSON.stringify({
                chat_ids: selectedChats,
                message: message,
                time: time,
                active: true
            })
        });

        if (res.ok) {
            msgEl.value = '';
            loadScheduledInsideModal();
            showToast("✅ Schedule created successfully");
        } else {
            const data = await res.json();
            showToast(`❌ ${data.message || "Failed to create schedule"}`, "error");
        }
    } catch (e) {
        console.error(e);
        showToast("❌ Error creating schedule", "error");
    } finally {
        btn.disabled = false;
        btn.innerHTML = `<span>➕</span> Create Schedule`;
    }
}

// --- Media Handling ---
async function downloadMedia(chatId, messageId) {
    try {
        const url = `${API_BASE}/media/${chatId}/${messageId}`;
        window.open(url, '_blank');
    } catch (e) {
        console.error("Download media error:", e);
        showToast("❌ Failed to download media", "error");
    }
}

// --- Initialize on load ---
window.onload = function () {
    console.log("Telegram Bot Manager loaded");

    // Add CSS for animations
    const style = document.createElement('style');
    style.textContent = `
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .message-anim {
            animation: fadeIn 0.3s ease-out;
        }
        #global-toast {
            opacity: 0;
            transform: translateY(-20px);
        }
    `;
    document.head.appendChild(style);
};

// Make functions globally available
window.handleAuth = handleAuth;
window.verifyCode = verifyCode;
window.verifyPassword = verifyPassword;
window.backToStep1 = backToStep1;
window.toggleDrawer = toggleDrawer;
window.openSection = openSection;
window.closeModal = closeModal;
window.toggleSystemActive = toggleSystemActive;
window.openChat = openChat;
window.closeChat = closeChat;
window.sendChatMessage = sendChatMessage;
window.handleFileSelect = handleFileSelect;
window.clearFile = clearFile;
window.logout = logout;
window.navTo = navTo;
window.saveSettingsModal = saveSettingsModal;
window.loadKeywordsInsideModal = loadKeywordsInsideModal;
window.addKeywordModal = addKeywordModal;
window.deleteKeywordModal = deleteKeywordModal;
window.editKeywordModal = editKeywordModal;
window.loadScheduledInsideModal = loadScheduledInsideModal;
window.deleteScheduledModal = deleteScheduledModal;
window.addScheduledMessageModal = addScheduledMessageModal;
window.toggleSelectAllChats = toggleSelectAllChats;

// --- Help Modal ---
function toggleHelpModal(show) {
    const helpModal = document.getElementById('help-modal-overlay');
    if (helpModal) {
        if (show) helpModal.classList.remove('hidden');
        else helpModal.classList.add('hidden');
    }
}
window.toggleHelpModal = toggleHelpModal;