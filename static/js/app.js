const API_BASE = '/api';

// --- Auth & Startup ---
document.addEventListener('DOMContentLoaded', () => {
    checkAuth();
});

function checkAuth() {
    const token = localStorage.getItem('user_token');
    if (token) {
        const profileStr = localStorage.getItem('user_profile');
        if (profileStr) {
            try {
                const profile = JSON.parse(profileStr);
                const name = profile.first_name || profile.name || 'User';
                const welcomeMsg = document.getElementById('welcome-msg');
                const userDisplay = document.getElementById('user-display');

                if (welcomeMsg) welcomeMsg.innerText = `Welcome, ${name}`;
                if (userDisplay) userDisplay.innerText = name;
            } catch (e) {
                console.error("Profile parse error:", e);
            }
        }
        showDashboard();
    } else {
        showLogin();
    }
}

function showLogin() {
    document.getElementById('login-container').classList.replace('hidden', 'flex');
    document.getElementById('dashboard').classList.add('hidden');
}

function toggleSidebar() {
    document.querySelector('.sidebar').classList.toggle('-translate-x-full');
}

function logout() {
    localStorage.removeItem('user_token');
    localStorage.removeItem('user_profile');
    window.location.reload();
}

function getHeaders() {
    const token = localStorage.getItem('user_token');
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
    };
}

async function fetchWithAuth(url, options = {}) {
    if (!options.headers) options.headers = getHeaders();
    else Object.assign(options.headers, getHeaders());

    const response = await fetch(url, options);
    if (response.status === 401) {
        console.warn("Session expired or unauthorized. Logging out...");
        logout();
        throw new Error("Unauthorized");
    }
    return response;
}

// --- Navigation ---
function navTo(section) {
    // 1. Sidebar Active State
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById(`nav-${section}`).classList.add('active');

    // 2. Show Section
    document.querySelectorAll('.content-section').forEach(el => el.classList.remove('active'));
    document.getElementById(`section-${section}`).classList.add('active');

    // 3. Load Data if needed
    if (section === 'settings') loadSettings();
    if (section === 'keywords') loadKeywords();
    if (section === 'chat') loadChats();
}

// --- Auth Handling ---
let isStep2 = false;

async function handleAuth() {
    const apiId = document.getElementById('api-id').value.trim();
    const apiHash = document.getElementById('api-hash').value.trim();
    const phone = document.getElementById('phone-number').value.trim();
    const err = document.getElementById('login-error');
    const btn = document.getElementById('btn-auth');

    // Smart Login Logic - Check session first
    if (document.getElementById('phone-group').classList.contains('hidden')) {
        // Step 1: Validate inputs
        if (!apiId || !apiHash) {
            err.innerText = "API ID & Hash Required";
            err.classList.remove('hidden');
            return;
        }

        btn.innerText = "Checking session...";
        btn.disabled = true;
        err.classList.add('hidden');

        try {
            // Step 2: Check if session exists
            const checkRes = await fetch(`${API_BASE}/auth/check-session`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_id: apiId, api_hash: apiHash })
            });
            const checkData = await checkRes.json();

            if (checkRes.ok && checkData.has_session) {
                // Session exists! Try to login directly
                btn.innerText = "Logging in...";

                const loginRes = await fetch(`${API_BASE}/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ api_id: apiId, api_hash: apiHash })
                });
                const loginData = await loginRes.json();

                if (loginRes.ok && loginData.access_token) {
                    // Success! Auto-login
                    finishLogin(loginData.access_token, loginData.user, apiId);
                    return;
                } else {
                    // Session exists but login failed, show phone field
                    document.getElementById('phone-group').classList.remove('hidden');
                    err.innerText = "Session expired. Please verify with phone number.";
                    err.classList.remove('hidden');
                }
            } else {
                // No session found, show phone field
                document.getElementById('phone-group').classList.remove('hidden');
                err.innerText = "No existing session. Please enter phone number to continue.";
                err.classList.remove('hidden');
            }
        } catch (e) {
            // Network error, show phone field as fallback
            document.getElementById('phone-group').classList.remove('hidden');
            err.innerText = "Connection error. Please enter phone number.";
            err.classList.remove('hidden');
        } finally {
            btn.innerText = "Continue";
            btn.disabled = false;
        }
    } else {
        // Request Code (phone field is now visible)
        if (!phone) {
            err.innerText = "Phone number required";
            err.classList.remove('hidden');
            return;
        }

        btn.innerText = "Sending Code...";
        btn.disabled = true;

        try {
            const res = await fetch(`${API_BASE}/auth/request-code`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_id: apiId, api_hash: apiHash, phone_number: phone })
            });

            const data = await res.json();

            if (res.ok) {
                // Success, go to step 2
                localStorage.setItem('temp_phone_hash', data.phone_code_hash);
                localStorage.setItem('temp_api_id', apiId);
                localStorage.setItem('temp_phone', phone);

                document.getElementById('step-1').classList.add('hidden');
                document.getElementById('step-2').classList.remove('hidden');
                err.classList.add('hidden');
            } else {
                err.innerText = data.message || "Failed to send code";
                err.classList.remove('hidden');
            }
        } catch (e) {
            err.innerText = "Network Error";
            err.classList.remove('hidden');
        } finally {
            btn.innerText = "Continue";
            btn.disabled = false;
        }
    }
}

async function verifyCode() {
    const code = document.getElementById('otp-code').value.trim();
    const btn = document.getElementById('btn-verify');
    const err = document.getElementById('login-error');

    if (!code) return;

    btn.disabled = true;
    btn.innerText = "Verifying...";

    try {
        const res = await fetch(`${API_BASE}/auth/verify-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_id: localStorage.getItem('temp_api_id'),
                phone_number: localStorage.getItem('temp_phone'),
                code: code,
                phone_code_hash: localStorage.getItem('temp_phone_hash')
            })
        });

        const data = await res.json();
        if (res.ok) {
            if (data.status === 'password_required') {
                // Two-Step Verification required
                document.getElementById('step-2').classList.add('hidden');
                document.getElementById('step-3').classList.remove('hidden');
                err.classList.add('hidden');
            } else {
                // Success, proceed to login
                await performLoginAfterVerify(localStorage.getItem('temp_api_id'), document.getElementById('api-hash').value);
            }
        } else {
            err.innerText = data.message || "Invalid Code";
            err.classList.remove('hidden');
            btn.disabled = false;
            btn.innerText = "Verify & Login";
        }
    } catch (e) {
        err.innerText = "Error verifying";
        err.classList.remove('hidden');
        btn.disabled = false;
        btn.innerText = "Verify & Login";
    }
}

async function verifyPassword() {
    const password = document.getElementById('two-step-password').value;
    const btn = document.getElementById('btn-verify-password');
    const err = document.getElementById('login-error');

    if (!password) {
        err.innerText = "Password required";
        err.classList.remove('hidden');
        return;
    }

    btn.disabled = true;
    btn.innerText = "Verifying...";

    try {
        const res = await fetch(`${API_BASE}/auth/verify-password`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                api_id: localStorage.getItem('temp_api_id'),
                password: password
            })
        });

        const data = await res.json();
        if (res.ok && data.status === 'success') {
            // Password verified successfully, create token and finish login
            const apiId = localStorage.getItem('temp_api_id');
            const apiHash = document.getElementById('api-hash').value;

            // Generate token by calling /api/login
            const loginRes = await fetch(`${API_BASE}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_id: apiId, api_hash: apiHash })
            });

            const loginData = await loginRes.json();
            if (loginRes.ok && loginData.access_token) {
                finishLogin(loginData.access_token, loginData.user, apiId);
            } else {
                // Login succeeded but token generation failed, just finish with user data
                const token = 'temp_token_' + Date.now();
                localStorage.setItem('user_token', token);
                localStorage.setItem('user_profile', JSON.stringify(data.user));
                checkAuth();
            }
        } else {
            err.innerText = data.message || "Incorrect password";
            err.classList.remove('hidden');
            btn.disabled = false;
            btn.innerText = "Verify Password";
        }
    } catch (e) {
        err.innerText = "Error verifying password";
        err.classList.remove('hidden');
        btn.disabled = false;
        btn.innerText = "Verify Password";
    }
}

async function performLoginAfterVerify(apiId, apiHash) {
    const res = await fetch(`${API_BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_id: apiId, api_hash: apiHash })
    });
    const data = await res.json();
    if (res.ok) {
        finishLogin(data.access_token, data.user, apiId);
    } else {
        alert("Verification success but login failed. Please try logging in again.");
        window.location.reload();
    }
}

function finishLogin(token, userObj, apiId) {
    if (!token || !userObj) {
        console.error("Invalid login data:", { token, userObj });
        return;
    }
    localStorage.setItem('user_token', token);
    localStorage.setItem('user_profile', JSON.stringify(userObj));
    localStorage.setItem('user_api_id', apiId);

    console.log("Login finished, switching to dashboard...");
    showDashboard();
}

function showDashboard() {
    document.getElementById('login-container').style.display = 'none';
    document.getElementById('dashboard').classList.remove('hidden');

    // Setup UI with profile
    const profileStr = localStorage.getItem('user_profile');
    if (profileStr) {
        const profile = JSON.parse(profileStr);
        const name = profile.first_name || profile.name || 'User';
        const welcomeMsg = document.getElementById('welcome-msg');
        const userDisplay = document.getElementById('user-display');

        if (welcomeMsg) welcomeMsg.innerText = `Welcome, ${name}`;
        if (userDisplay) userDisplay.innerText = name;
    }

    loadChats();
    connectWebSocket();
}

function backToStep1() {
    document.getElementById('step-2').classList.add('hidden');
    document.getElementById('step-1').classList.remove('hidden');
}

// --- WebSocket ---
let socket = null;

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

    socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'new_message') {
            handleNewMessage(msg);
        }
    };

    socket.onclose = () => {
        setTimeout(connectWebSocket, 3000); // Reconnect
    };
}

function handleNewMessage(msg) {
    // 1. If currently in this chat, append
    if (currentChatId && (currentChatId == msg.chat_id)) {
        appendMessage(msg);
        scrollToBottom();
    }
    // 2. Refresh Chat List (to show latest msg snippet)
    loadChats();
}

// --- Drawer & Modal ---
function toggleDrawer() {
    const drawer = document.querySelector('.drawer');
    const overlay = document.querySelector('.drawer-overlay');

    if (drawer.classList.contains('-translate-x-full')) {
        drawer.classList.remove('-translate-x-full');
        drawer.classList.add('translate-x-0');
        overlay.classList.remove('hidden');

        // Update Drawer Info
        const profileStr = localStorage.getItem('user_profile');
        if (profileStr) {
            const profile = JSON.parse(profileStr);
            const nameEl = document.getElementById('drawer-name');
            const avatarEl = document.getElementById('drawer-avatar');
            const phoneEl = document.getElementById('drawer-phone');

            if (nameEl) nameEl.innerText = profile.first_name || profile.name || 'User';
            if (avatarEl) avatarEl.innerText = (profile.first_name || profile.name || 'U').charAt(0);
            if (phoneEl) phoneEl.innerText = profile.phone || profile.username || '';
        }
    } else {
        drawer.classList.add('-translate-x-full');
        drawer.classList.remove('translate-x-0');
        overlay.classList.add('hidden');
    }
}

function openSection(sectionId) {
    toggleDrawer(); // Close drawer

    const modal = document.getElementById('modal-overlay');
    const body = document.getElementById('modal-body');
    modal.classList.remove('hidden');

    if (sectionId === 'settings') {
        body.innerHTML = `<h3 class="text-xl font-bold mb-6 flex items-center gap-2"><span>⚙️</span> Live Reply Settings</h3><div id="settings-content">Loading...</div>`;
        loadSettingsInsideModal();
    } else if (sectionId === 'keywords') {
        body.innerHTML = `<h3 class="text-xl font-bold mb-6 flex items-center gap-2"><span>🔑</span> Keyword Management</h3><div id="keywords-content">Loading...</div>`;
        loadKeywordsInsideModal();
    } else if (sectionId === 'scheduled') {
        body.innerHTML = `<h3 class="text-xl font-bold mb-6 flex items-center gap-2"><span>⏰</span> Scheduled Messages</h3><div id="scheduled-content">Loading...</div>`;
        loadScheduledInsideModal();
    } else if (sectionId === 'dashboard-stats') {
        body.innerHTML = `<h3 class="text-xl font-bold mb-6 flex items-center gap-2"><span>📊</span> Dashboard Stats</h3><div class="space-y-2"><p>Bot Status: <span class="text-green-400 font-bold">Running</span></p><p class="text-sm opacity-60 italic">Check terminal for detailed logs.</p></div>`;
    }
}

function closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
}

// Rewriting loadSettings/Keywords to work inside modal
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
                    <label class="block text-xs font-semibold uppercase tracking-wider text-indigo-200/60 ml-2">Cool-down Duration (Hours)</label>
                    <input type="number" id="m-wait" step="0.1" class="w-full bg-dark/50 border border-border rounded-2xl px-5 py-3.5 focus:outline-none focus:border-brand transition-all" value="${(data.wait_time / 3600).toFixed(1)}">
                </div>
                
                <button onclick="saveSettingsModal()" class="w-full bg-brand py-4 rounded-2xl font-bold shadow-lg hover:shadow-brand/20 transition-all">Save Changes</button>
            </div>
        `;
    } catch (e) { console.error(e); }
}

async function saveSettingsModal() {
    const active = document.getElementById('m-active').checked;
    const text = document.getElementById('m-text').value;
    const waitHours = parseFloat(document.getElementById('m-wait').value);
    const wait = Math.floor(waitHours * 3600);

    await fetchWithAuth(`${API_BASE}/settings`, {
        method: 'POST',
        body: JSON.stringify({ active, auto_reply_text: text, wait_time: wait })
    });
    closeModal();
}

async function loadKeywordsInsideModal() {
    const content = document.getElementById('keywords-content');
    content.innerHTML = `
        <div class="space-y-4 mb-8">
            <div class="flex flex-col md:flex-row gap-3">
                <input id="m-k-key" class="flex-1 bg-dark/50 border border-border rounded-xl px-5 py-3.5 focus:outline-none focus:border-brand transition-all" placeholder="Keyword...">
                <input id="m-k-reply" class="flex-1 bg-dark/50 border border-border rounded-xl px-5 py-3.5 focus:outline-none focus:border-brand transition-all" placeholder="Bot reply...">
            </div>
            <button onclick="addKeywordModal()" class="w-full bg-brand py-3.5 rounded-xl font-bold transition-all shadow-lg active:scale-95">Add New Keyword</button>
        </div>
        <div id="m-k-list" class="space-y-2 max-h-[400px] overflow-y-auto custom-scrollbar pr-2">Loading...</div>
     `;

    const res = await fetchWithAuth(`${API_BASE}/keywords`);
    const data = await res.json();
    const list = document.getElementById('m-k-list');
    list.innerHTML = '';
    data.forEach(k => {
        const div = document.createElement('div');
        div.className = 'group flex justify-between items-center bg-white/5 p-4 rounded-2xl border border-white/5 hover:border-brand/40 transition-all';
        div.innerHTML = `
            <div onclick="editKeywordModal('${k.keyword}', '${k.reply}')" class="flex-1 cursor-pointer">
                <b class="text-brand block mb-1">/${k.keyword}</b>
                <div class="text-[0.9rem] opacity-70">${k.reply}</div>
            </div>
            <button onclick="deleteKeywordModal('${k.keyword}')" class="w-8 h-8 flex items-center justify-center rounded-full bg-red-500/10 text-red-500 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-500 hover:text-white ml-3">×</button>
        `;
        list.appendChild(div);
    });
}

async function addKeywordModal() {
    const keyEl = document.getElementById('m-k-key');
    const replyEl = document.getElementById('m-k-reply');
    const keyword = keyEl.value.trim();
    const reply = replyEl.value.trim();

    if (!keyword || !reply) {
        alert("Both fields are required");
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
            loadKeywordsInsideModal(); // Refresh list
        } else {
            const data = await res.json();
            alert(data.message || "Failed to add keyword");
        }
    } catch (e) {
        console.error(e);
        alert("Error adding keyword");
    }
}

async function deleteKeywordModal(keyword) {
    if (!confirm(`Are you sure you want to delete "${keyword}"?`)) return;

    try {
        const res = await fetchWithAuth(`${API_BASE}/keywords?keyword=${encodeURIComponent(keyword)}`, {
            method: 'DELETE'
        });

        if (res.ok) {
            loadKeywordsInsideModal(); // Refresh list
        } else {
            const data = await res.json();
            alert(data.message || "Failed to delete keyword");
        }
    } catch (e) {
        console.error(e);
        alert("Error deleting keyword");
    }
}

function editKeywordModal(keyword, reply) {
    document.getElementById('m-k-key').value = keyword;
    document.getElementById('m-k-reply').value = reply;
}

// --- Scheduled Messages ---
async function loadScheduledInsideModal() {
    const content = document.getElementById('scheduled-content');
    content.innerHTML = `
        <div class="space-y-6">
            <div class="space-y-2">
                <label class="block text-xs font-semibold uppercase tracking-wider text-indigo-200/60 ml-2"><i>⏰</i> Delivery Time</label>
                <p class="text-[0.7rem] opacity-50 ml-2 mb-2">Select when you want the message to be sent daily.</p>
                <input type="time" id="m-s-time" class="w-full bg-dark/50 border border-border rounded-xl px-5 py-3.5 focus:outline-none focus:border-brand transition-all dark:[color-scheme:dark]">
            </div>
            
            <div class="space-y-2">
                <div class="flex items-center justify-between mb-1">
                    <label class="block text-xs font-semibold uppercase tracking-wider text-indigo-200/60 ml-2"><i>👥</i> Select Target Chats</label>
                    <div class="flex items-center gap-2 cursor-pointer group" onclick="selectAllChats()">
                        <span class="text-[0.65rem] font-bold uppercase tracking-widest text-brand group-hover:opacity-80 transition-opacity">Select All</span>
                        <input type="checkbox" id="select-all-toggle" class="w-4 h-4 rounded border-white/20 bg-dark/50 text-brand focus:ring-brand focus:ring-offset-0 pointer-events-none">
                    </div>
                </div>
                <div id="m-s-chat-list" class="max-h-40 overflow-y-auto custom-scrollbar bg-dark/30 rounded-xl border border-white/5 p-2 flex flex-col gap-1">
                    <div class="p-4 text-center text-sm opacity-50 italic">Fetching chats...</div>
                </div>
            </div>

            <div class="space-y-2">
                <label class="block text-xs font-semibold uppercase tracking-wider text-indigo-200/60 ml-2"><i>🔗</i> Custom Usernames/IDs <span class="bg-surface px-1.5 py-0.5 rounded text-[0.6rem] font-bold">(Optional)</span></label>
                <input type="text" id="m-s-usernames" class="w-full bg-dark/50 border border-border rounded-xl px-5 py-3.5 focus:outline-none focus:border-brand transition-all" placeholder="e.g. @username, 12345678">
            </div>

            <div class="space-y-2">
                <label class="block text-xs font-semibold uppercase tracking-wider text-indigo-200/60 ml-2"><i>✉️</i> Daily Message Content</label>
                <textarea id="m-s-message" class="w-full bg-dark/50 border border-border rounded-xl px-5 py-4 focus:outline-none focus:border-brand transition-all resize-none h-24" placeholder="Write your message here..."></textarea>
            </div>
            
            <button onclick="saveScheduledModal()" class="w-full bg-brand py-4 rounded-xl font-bold shadow-lg transition-all active:scale-95">Add Scheduled Message</button>
            
            <div class="h-px bg-white/5 my-4"></div>
            
            <div class="space-y-4">
                <h4 class="text-sm font-bold uppercase tracking-widest opacity-40 ml-1">Active Schedules</h4>
                <div id="m-s-list" class="grid grid-cols-1 gap-3">Loading...</div>
            </div>
        </div>
    `;

    // Load actual schedules
    loadScheduledList();

    // Load chats for selection
    try {
        const res = await fetchWithAuth(`${API_BASE}/chats`);
        const chats = await res.json();
        const chatList = document.getElementById('m-s-chat-list');
        chatList.innerHTML = '';

        if (chats.length === 0) {
            chatList.innerHTML = '<div class="p-8 text-center text-sm opacity-40">No chats found.</div>';
        }

        chats.forEach(async chat => {
            const label = document.createElement('label');
            label.className = 'flex items-center gap-3 p-2 bg-white/5 rounded-xl cursor-pointer hover:bg-brand/5 transition-all border border-transparent hover:border-brand/10 group';
            label.innerHTML = `
                <input type="checkbox" name="m-s-chat" value="${chat.id}" class="w-5 h-5 rounded border-white/20 bg-dark/50 text-brand focus:ring-brand focus:ring-offset-0 ml-1">
                <div class="w-8 h-8 rounded-full bg-brand/20 flex items-center justify-center text-xs font-bold text-brand shadow-inner s-avatar" id="s-avatar-${chat.id}">${chat.name.charAt(0)}</div>
                <span class="text-[0.9rem] font-medium truncate flex-1">${chat.name}</span>
            `;
            chatList.appendChild(label);

            // Fetch photo for selection list
            try {
                const pres = await fetchWithAuth(`${API_BASE}/photos/${chat.id}`);
                const pdata = await pres.json();
                if (pdata.url) {
                    const avatarDiv = document.getElementById(`s-avatar-${chat.id}`);
                    if (avatarDiv) {
                        avatarDiv.innerHTML = `<img src="${pdata.url}" class="w-full h-full object-cover" style="border-radius: 50%">`;
                    }
                }
            } catch (e) { }
        });
    } catch (e) {
        document.getElementById('m-s-chat-list').innerText = "Failed to load chats";
    }
}

function selectAllChats() {
    const toggle = document.getElementById('select-all-toggle');
    const checkboxes = document.querySelectorAll('input[name="m-s-chat"]');
    const newState = !toggle.checked;

    toggle.checked = newState;
    checkboxes.forEach(cb => {
        cb.checked = newState;
    });
}

async function loadScheduledList() {
    const res = await fetchWithAuth(`${API_BASE}/scheduled-messages`);
    const data = await res.json();
    const list = document.getElementById('m-s-list');
    if (!list) return;

    list.innerHTML = '';

    if (data.length === 0) {
        list.innerHTML = '<div class="p-8 text-center text-sm opacity-40 border border-dashed border-white/10 rounded-2xl">No scheduled messages yet.</div>';
        return;
    }

    data.forEach(s => {
        const div = document.createElement('div');
        div.className = 'bg-white/5 p-4 rounded-2xl border border-white/5 flex flex-col gap-3';

        const targetCount = s.chat_ids.length + s.usernames.length;

        div.innerHTML = `
            <div class="flex justify-between items-center">
                <div class="flex items-center gap-2 text-brand font-bold text-lg">
                    <span>⏰</span>
                    <span>${s.time}</span>
                </div>
                <button class="w-8 h-8 flex items-center justify-center rounded-full bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white transition-all" onclick="deleteScheduledModal('${s.id}')">×</button>
            </div>
            <div class="space-y-2">
                <div class="text-[0.6rem] font-bold uppercase tracking-widest text-indigo-100/40">Targets: ${targetCount} recipients</div>
                <div class="text-sm bg-dark/40 p-3 rounded-xl italic opacity-80 leading-relaxed">${s.message}</div>
            </div>
        `;
        list.appendChild(div);
    });
}

async function saveScheduledModal() {
    const time = document.getElementById('m-s-time').value;
    const message = document.getElementById('m-s-message').value.trim();
    const usernamesStr = document.getElementById('m-s-usernames').value.trim();

    const chatCheckboxes = document.querySelectorAll('input[name="m-s-chat"]:checked');
    const chat_ids = Array.from(chatCheckboxes).map(cb => parseInt(cb.value));

    const usernames = usernamesStr ? usernamesStr.split(',').map(u => u.trim()).filter(u => u) : [];

    if (!time || !message || (chat_ids.length === 0 && usernames.length === 0)) {
        alert("Please specify time, message, and at least one chat/username.");
        return;
    }

    try {
        const res = await fetchWithAuth(`${API_BASE}/scheduled-messages`, {
            method: 'POST',
            body: JSON.stringify({
                time,
                message,
                chat_ids,
                usernames,
                active: true
            })
        });

        if (res.ok) {
            loadScheduledInsideModal(); // Reset/Reload
        } else {
            const data = await res.json();
            alert(data.message || "Failed to save schedule");
        }
    } catch (e) {
        console.error(e);
        alert("Error saving schedule");
    }
}

async function deleteScheduledModal(id) {
    if (!confirm("Are you sure you want to delete this schedule?")) return;

    try {
        const res = await fetchWithAuth(`${API_BASE}/scheduled-messages/${id}`, {
            method: 'DELETE'
        });

        if (res.ok) {
            loadScheduledList();
        } else {
            const data = await res.json();
            alert(data.message || "Failed to delete schedule");
        }
    } catch (e) {
        console.error(e);
        alert("Error deleting schedule");
    }
}

// --- Chat & Mobile View ---

async function toggleSystemActive() {
    const toggle = document.getElementById('system-active-toggle');
    const container = document.getElementById('status-container');
    const statusText = container.querySelector('.status-text');
    const isActive = toggle.checked;

    // Update UI immediately for better feel
    if (isActive) {
        container.querySelector('#status-indicator').className = 'w-2.5 h-2.5 rounded-full bg-green-400 shadow-[0_0_8px_#4ade80]';
        statusText.innerText = 'Online';
    } else {
        container.querySelector('#status-indicator').className = 'w-2.5 h-2.5 rounded-full bg-red-400 shadow-[0_0_8px_#f87171]';
        statusText.innerText = 'Offline';
    }

    // Sync with server
    try {
        const res = await fetchWithAuth(`${API_BASE}/settings`);
        const settings = await res.json();
        settings.active = isActive;

        await fetchWithAuth(`${API_BASE}/settings`, {
            method: 'POST',
            body: JSON.stringify(settings)
        });
        console.log("System status updated:", isActive ? "Online" : "Offline");
    } catch (e) {
        console.error("Failed to sync system status:", e);
    }
}

async function loadInitialSystemState() {
    try {
        const res = await fetchWithAuth(`${API_BASE}/settings`);
        const data = await res.json();
        const toggle = document.getElementById('system-active-toggle');
        const container = document.getElementById('status-container');
        const statusText = (container) ? container.querySelector('.status-text') : null;

        if (toggle) {
            toggle.checked = data.active;
            const indicator = container ? container.querySelector('#status-indicator') : null;
            if (data.active) {
                if (indicator) indicator.className = 'w-2.5 h-2.5 rounded-full bg-green-400 shadow-[0_0_8px_#4ade80]';
                if (statusText) statusText.innerText = 'Online';
            } else {
                if (indicator) indicator.className = 'w-2.5 h-2.5 rounded-full bg-red-400 shadow-[0_0_8px_#f87171]';
                if (statusText) statusText.innerText = 'Offline';
            }
        }
    } catch (e) { }
}

function showDashboard() {
    const loginContainer = document.getElementById('login-container');
    const dashboard = document.getElementById('dashboard');

    if (loginContainer) {
        loginContainer.classList.add('hidden');
        loginContainer.classList.remove('flex');
    }
    if (dashboard) dashboard.classList.remove('hidden');

    // Setup UI with profile
    const profileStr = localStorage.getItem('user_profile');
    if (profileStr) {
        const profile = JSON.parse(profileStr);
        const name = profile.first_name || profile.name || 'User';
        const welcomeMsg = document.getElementById('welcome-msg');
        const userDisplay = document.getElementById('user-display');
        const drawerName = document.getElementById('drawer-name');
        const drawerAvatar = document.getElementById('drawer-avatar');
        const drawerPhone = document.getElementById('drawer-phone');

        if (welcomeMsg) welcomeMsg.innerText = `Welcome, ${name}`;
        if (userDisplay) userDisplay.innerText = name;
        if (drawerName) drawerName.innerText = name;
        if (drawerAvatar) drawerAvatar.innerText = name.charAt(0);
        if (drawerPhone) drawerPhone.innerText = profile.phone || profile.username || '';
    }

    // Load initial toggle state
    loadInitialSystemState();

    loadChats();
    connectWebSocket();
}


async function loadChats() {
    const container = document.getElementById('chats-container');
    try {
        const res = await fetchWithAuth(`${API_BASE}/chats`);
        const chats = await res.json();

        // Sort chats by date (newest first)
        chats.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

        container.innerHTML = '';

        chats.forEach(async chat => {
            const el = document.createElement('div');
            el.className = 'flex items-center gap-4 p-4 cursor-pointer hover:bg-white/5 active:bg-white/10 transition-all border-b border-white-[0.02] group';

            // Photo
            let photoHtml = `<div class="w-12 h-12 rounded-full bg-brand/20 flex items-center justify-center text-lg font-bold text-brand shadow-inner chat-avatar">${chat.name.charAt(0)}</div>`;

            el.innerHTML = `
                ${photoHtml}
                <div class="flex-1 min-w-0">
                    <div class="flex justify-between items-baseline mb-1">
                        <span class="font-semibold truncate text-[0.95rem] group-hover:text-brand transition-colors">${chat.name}</span>
                        <span class="text-[0.7rem] opacity-40 shrink-0 font-medium">${chat.date ? new Date(chat.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
                    </div>
                    <div class="text-[0.8rem] opacity-50 truncate leading-relaxed">${chat.message}</div>
                </div>
            `;
            el.onclick = () => openChat(chat.id, chat.name);
            container.appendChild(el);

            // Fetch photo
            try {
                const pres = await fetchWithAuth(`${API_BASE}/photos/${chat.id}`);
                const pdata = await pres.json();
                if (pdata.url) {
                    const img = document.createElement('img');
                    img.src = pdata.url;
                    img.className = 'w-12 h-12 rounded-full object-cover shadow-md border border-white/10 chat-avatar';
                    img.style.borderRadius = '50%';
                    el.querySelector('.chat-avatar').replaceWith(img);
                }
            } catch (e) { }
        });
    } catch (e) { }
}

async function openChat(chatId, chatName) {
    currentChatId = chatId;
    document.getElementById('chat-header-name').innerText = chatName;
    document.getElementById('chat-header-img').classList.add('hidden'); // Reset

    // Mobile Transition
    if (window.innerWidth <= 768) {
        document.getElementById('chat-view-panel').classList.add('active');
    }

    loadMessages(chatId);

    // Fetch Header Photo
    try {
        const res = await fetchWithAuth(`${API_BASE}/photos/${chatId}`);
        const data = await res.json();
        if (data.url) {
            const img = document.getElementById('chat-header-img');
            img.src = data.url;
            img.classList.remove('hidden');
        }
    } catch (e) { }
}

function closeChat() {
    currentChatId = null;
    document.getElementById('chat-view-panel').classList.remove('active');
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
            container.innerHTML = '<div class="flex items-center justify-center h-full opacity-20 text-sm">No messages yet.</div>';
            return;
        }

        // Sort messages by date (chronological) to be absolutely sure
        messages.sort((a, b) => new Date(a.date) - new Date(b.date));

        messages.forEach(msg => appendMessage(msg));
        scrollToBottom();
    } catch (e) {
        console.error("Load Messages Error:", e);
        container.innerHTML = '<div class="text-center p-4 text-red-400 opacity-60">Failed to load messages</div>';
    }
}

function appendMessage(msg) {
    const container = document.getElementById('messages-container');
    const isOutgoing = msg.outgoing;
    const div = document.createElement('div');
    div.className = `flex gap-1 w-full message-anim ${isOutgoing ? 'justify-end' : 'justify-start'}`;

    const time = msg.date ? new Date(msg.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

    let avatarHtml = '';
    if (!isOutgoing) {
        // Check if message already exists to avoid duplicates
        if (document.getElementById(`msg-${msg.id}`)) return;

        const initial = msg.sender_name ? msg.sender_name.charAt(0) : '?';
        avatarHtml = `<div class="w-8 h-8 rounded-full bg-brand/20 flex items-center justify-center text-xs font-bold shrink-0 border border-white/10 overflow-hidden" style="border-radius: 50%" id="avatar-${msg.id}">${initial}</div>`;
        if (currentChatId) updateMsgAvatar(msg.id, currentChatId);
    }

    div.id = `msg-${msg.id}`;

    const isFormattedReceipt = msg.text.includes('---') || msg.text.includes('|') || msg.text.includes('=') || msg.text.includes('Price List');
    const bubbleClasses = isOutgoing
        ? 'bg-brand text-white rounded-[16px] rounded-tr-[4px] shadow-sm'
        : 'bg-[#212d3b] border border-white/5 rounded-[16px] rounded-tl-[4px] shadow-sm';

    let mediaHtml = '';
    if (msg.media) {
        const cId = msg.chat_id || currentChatId;
        const mediaUrl = `${API_BASE}/media/${cId}/${msg.id}`;

        if (msg.media.type === 'photo') {
            // If it's a local optimistic send, we might not have a URL yet, or we could show a local preview?
            // For now, if URL fails (404), image might be broken until refresh.
            // But for real messages, it works.
            mediaHtml = `<div class="mb-1 rounded-lg overflow-hidden border border-white/10 cursor-pointer hover:opacity-90 transition-opacity" onclick="window.open('${mediaUrl}', '_blank')">
                            <img src="${mediaUrl}" class="max-w-full h-auto object-cover" loading="lazy" alt="Photo">
                          </div>`;
        } else if (msg.media.type === 'document') {
            mediaHtml = `<div class="mb-1 p-2 bg-white/5 rounded-xl border border-white/10 flex items-center gap-3 hover:bg-white/10 transition-colors cursor-pointer" onclick="window.open('${mediaUrl}', '_blank')">
                            <div class="w-8 h-8 rounded-lg bg-brand/20 flex items-center justify-center text-lg">📄</div>
                            <div class="overflow-hidden flex-1 min-w-0">
                                <div class="text-xs font-medium text-indigo-100 truncate">${msg.media.filename || 'Document'}</div>
                                <div class="text-[0.6rem] opacity-50 uppercase tracking-wider">${msg.media.mime_type || 'FILE'}</div>
                            </div>
                          </div>`;
        }
    }

    div.innerHTML = `
        ${!isOutgoing ? avatarHtml : ''}
        <div class="max-w-[85%] md:max-w-[75%] flex flex-col ${isOutgoing ? 'items-end' : 'items-start'}">
            <div class="${bubbleClasses} px-2.5 py-1 text-[0.85rem] leading-snug whitespace-pre-wrap break-words w-fit ${isFormattedReceipt ? 'font-mono text-[0.78rem] tracking-tight' : 'font-sans'}">
                ${mediaHtml}
                ${msg.text ? `<div>${msg.text}</div>` : ''}
            </div>
            <span class="text-[0.65rem] opacity-30 mt-1 font-medium uppercase tracking-tighter mx-1">${time}</span>
        </div>
    `;
    container.appendChild(div);
}

async function updateMsgAvatar(msgId, peerId) {
    try {
        const res = await fetchWithAuth(`${API_BASE}/photos/${peerId}`);
        const data = await res.json();
        if (data.url) {
            const el = document.getElementById(`avatar-${msgId}`);
            if (el) el.innerHTML = `<img src="${data.url}" class="w-full h-full object-cover" style="border-radius: 50%">`;
        }
    } catch (e) { }
}

function scrollToBottom() {
    const container = document.getElementById('messages-container');
    container.scrollTop = container.scrollHeight;
}

// --- File Handling ---
let selectedFile = null;

function handleFileSelect(event) {
    const file = event.target.files[0];
    if (file) {
        selectedFile = file;
        const previewObj = document.getElementById('file-preview-container');
        if (previewObj) previewObj.classList.remove('hidden');

        const nameObj = document.getElementById('file-preview-name');
        if (nameObj) nameObj.innerText = file.name;
    }
}

function clearFile() {
    selectedFile = null;
    const input = document.getElementById('chat-file-input');
    if (input) input.value = '';

    const previewObj = document.getElementById('file-preview-container');
    if (previewObj) previewObj.classList.add('hidden');
}

async function sendChatMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();

    // Allow sending if text OR file is present
    if ((!text && !selectedFile) || !currentChatId) return;

    input.value = ''; // Clear input

    try {
        if (selectedFile) {
            const formData = new FormData();
            formData.append('chat_id', currentChatId);
            formData.append('message', text);
            formData.append('file', selectedFile);

            // Optimistic Append (approximate)
            appendMessage({
                id: Date.now(),
                text: text,
                outgoing: true,
                date: new Date().toISOString(),
                media: {
                    type: selectedFile.type.startsWith('image/') ? 'photo' : 'document',
                    filename: selectedFile.name
                }
            });
            clearFile();

            await fetchWithAuth(`${API_BASE}/chats/send-media`, {
                method: 'POST',
                body: formData
            });

        } else {
            // Standard Text Send
            await fetchWithAuth(`${API_BASE}/chats/send`, {
                method: 'POST',
                body: JSON.stringify({ chat_id: currentChatId, message: text })
            });

            appendMessage({
                id: Date.now(),
                text: text,
                outgoing: true,
                date: new Date().toISOString()
            });
        }

        scrollToBottom();

    } catch (e) {
        console.error("Send Error:", e);
    }
}

// ... (rest of standard functions: logout, getHeaders, Auth steps) ...
