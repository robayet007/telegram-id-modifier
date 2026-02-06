const API_BASE = '/api/admin';

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
        const setupRes = await fetch(`${API_BASE}/setup-check`);
        const setupData = await setupRes.json();
        if (setupData.setup_required) {
            return response;
        }
        console.warn("Session expired. Logging out...");
        logout();
        throw new Error("Unauthorized");
    }
    return response;
}

document.addEventListener('DOMContentLoaded', async () => {
    try {
        const res = await fetch(`${API_BASE}/setup-check`);
        const data = await res.json();

        if (data.setup_required) {
            // Aggressively bypass login - go straight to dashboard
            showSection('dashboard-section');
            showUnsecuredWarning();
            loadUsers();
        } else {
            checkAdminAuth();
        }
    } catch (e) {
        console.error("Setup check failed", e);
        checkAdminAuth();
    }
});

function showUnsecuredWarning() {
    const header = document.querySelector('#dashboard-section header');
    if (!document.getElementById('unsecured-banner')) {
        const banner = document.createElement('div');
        banner.id = 'unsecured-banner';
        banner.className = 'bg-yellow-500/10 border border-yellow-500/20 text-yellow-500 px-4 py-3 rounded-xl mb-6 flex items-center justify-between';
        banner.innerHTML = `
            <div class="flex items-center gap-3">
                <span class="text-xl">⚠️</span>
                <div>
                    <div class="font-bold">Dashboard Unsecured</div>
                    <div class="text-xs opacity-70">Anyone can access this page. Set a password to secure it.</div>
                </div>
            </div>
            <button onclick="showSection('setup-section')" class="px-4 py-2 bg-yellow-500 text-black rounded-lg font-bold text-sm hover:brightness-110 transition-all">Secure Dashboard</button>
        `;
        header.insertAdjacentElement('afterend', banner);
    }
}

async function setupAdmin() {
    const username = document.getElementById('setup-username').value;
    const password = document.getElementById('setup-password').value;
    const confirm = document.getElementById('setup-confirm-password').value;

    if (!username || !password) {
        alert("Please fill in all fields");
        return;
    }

    if (password !== confirm) {
        alert("Passwords do not match");
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/setup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        if (res.ok) {
            alert("Admin account created! Please login.");
            showSection('login-section');
        } else {
            const data = await res.json();
            alert(data.detail || "Setup failed");
        }
    } catch (e) {
        console.error(e);
        alert("Error creating admin");
    }
}

async function checkAdminAuth() {
    try {
        const response = await fetchWithAuth(`${API_BASE}/check-status`);

        if (response.ok) {
            const data = await response.json();
            if (data.must_change) {
                showSection('change-password-section');
            } else {
                showSection('dashboard-section');
                loadUsers();
            }
        } else {
            showSection('login-section');
        }
    } catch (e) {
        showSection('login-section');
    }
}

function showSection(id) {
    // Hide all sections
    ['setup-section', 'login-section', 'change-password-section', 'dashboard-section'].forEach(sid => {
        const el = document.getElementById(sid);
        if (el) el.classList.add('hidden');
    });

    // Show target section
    const target = document.getElementById(id);
    if (target) target.classList.remove('hidden');

    // Close modal if open
    closeModal();
}

async function login() {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    try {
        const response = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        if (response.ok) {
            checkAdminAuth();
        } else {
            alert('Invalid credentials');
        }
    } catch (e) {
        console.error(e);
        alert('Login failed');
    }
}

async function logout() {
    await fetch(`${API_BASE}/logout`, { method: 'POST' });
    showSection('login-section');
}

async function changePassword() {
    const oldPassword = document.getElementById('old-password').value;
    const newPassword = document.getElementById('new-password').value;
    const confirmPassword = document.getElementById('confirm-password').value;

    if (newPassword !== confirmPassword) {
        alert("New passwords do not match!");
        return;
    }

    try {
        const response = await fetchWithAuth(`${API_BASE}/password`, {
            method: 'PUT',
            body: JSON.stringify({ old_password: oldPassword, new_password: newPassword })
        });

        if (response.ok) {
            alert("Password changed successfully!");
            checkAdminAuth();
        } else {
            const data = await response.json();
            alert(data.detail || "Failed to change password");
        }
    } catch (e) {
        alert("Error changing password");
    }
}

async function loadUsers() {
    try {
        const response = await fetchWithAuth(`${API_BASE}/users`);
        const users = await response.json();

        const tbody = document.getElementById('users-table-body');
        tbody.innerHTML = '';

        if (users.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" class="p-8 text-center text-indigo-200/40">
                        No users found
                    </td>
                </tr>
            `;
            return;
        }

        users.forEach(user => {
            const tr = document.createElement('tr');
            tr.className = 'hover:bg-white/5 transition-colors';

            const isOnline = user.is_online || false;
            const indicatorColor = isOnline ? 'bg-green-400 shadow-[0_0_8px_#4ade80]' : 'bg-red-400 shadow-[0_0_8px_#f87171]';
            const statusText = isOnline ? 'Online' : 'Offline';

            const displayName = user.first_name
                ? `<span class="font-semibold">${user.first_name}</span> ${user.username ? '<span class="opacity-40 text-xs ml-1">@' + user.username + '</span>' : ''}`
                : 'Unknown';

            const lastLogin = user.last_login
                ? new Date(user.last_login).toLocaleString()
                : 'Never';

            tr.innerHTML = `
                <td class="p-4 font-mono text-indigo-300/80 text-xs">${user.api_id || 'N/A'}</td>
                <td class="p-4">${displayName}</td>
                <td class="p-4">
                    <div class="flex items-center gap-2">
                        <span class="w-2 h-2 rounded-full ${indicatorColor}"></span>
                        <span class="text-xs font-bold uppercase tracking-wider ${isOnline ? 'text-green-400' : 'text-red-400'}">${statusText}</span>
                    </div>
                </td>
                <td class="p-4 text-xs opacity-60">${lastLogin}</td>
                <td class="p-4">
                    <button onclick="showUserDetails('${user.api_id}')" 
                        class="px-4 py-1.5 bg-brand/10 text-brand hover:bg-brand hover:text-white rounded-lg text-xs font-bold transition-all border border-brand/20">
                        View Details
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (e) {
        console.error("Failed to load users", e);
        const tbody = document.getElementById('users-table-body');
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" class="p-8 text-center text-red-400">
                        Error loading users: ${e.message}
                    </td>
                </tr>
            `;
        }
    }
}

// --- User Details Modal ---
async function showUserDetails(apiId) {
    console.log('Showing details for API ID:', apiId);

    const modal = document.getElementById('details-modal');
    const content = document.getElementById('modal-content-body');

    // Show loading state
    content.innerHTML = `
        <div class="flex flex-col items-center justify-center py-12 space-y-4">
            <div class="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-brand"></div>
            <p class="text-indigo-300 italic">Loading user details...</p>
        </div>
    `;

    // Show modal
    modal.classList.remove('hidden');
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';

    try {
        // Fetch user details
        const response = await fetchWithAuth(`${API_BASE}/users/${apiId}/details`);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        const userData = await response.json();
        console.log('User data received:', userData);

        // Format the data for display
        displayUserDetails(userData, apiId);

    } catch (error) {
        console.error('Error loading user details:', error);

        // Show error state
        content.innerHTML = `
            <div class="space-y-6">
                <div class="bg-red-500/10 border border-red-500/20 text-red-500 p-4 rounded-xl">
                    <div class="font-bold mb-2">⚠️ Failed to Load Details</div>
                    <div class="text-sm opacity-70">${error.message}</div>
                </div>
                
                <div class="bg-white/5 p-4 rounded-2xl border border-white/5 space-y-3">
                    <div class="flex justify-between items-center">
                        <span class="text-xs font-bold uppercase tracking-wider opacity-60">API ID</span>
                        <span class="font-mono text-indigo-300">${apiId}</span>
                    </div>
                    <div class="border-t border-white/5"></div>
                    <div class="flex justify-between items-center">
                        <span class="text-xs font-bold uppercase tracking-wider opacity-60">Status</span>
                        <span class="text-green-500 font-semibold">Active</span>
                    </div>
                </div>
            </div>
        `;
    }
}

function displayUserDetails(data, apiId) {
    const content = document.getElementById('modal-content-body');

    // Extract data with fallbacks
    const apiHash = data.api_hash || 'Not available';
    const firstName = data.first_name || 'Unknown';
    const username = data.username ? `@${data.username}` : 'Not set';
    const keywords = data.keywords || [];
    const lastLogin = data.last_login ? new Date(data.last_login).toLocaleString() : 'Never';

    let modalHTML = `
        <div class="space-y-6">
            <!-- User Info Card -->
            <div class="bg-white/5 p-4 rounded-2xl border border-white/5 space-y-3">
                <div class="flex justify-between items-center">
                    <span class="text-xs font-bold uppercase tracking-wider opacity-60">API ID</span>
                    <span class="font-mono text-indigo-300">${apiId}</span>
                </div>
                <div class="border-t border-white/5"></div>
                <div class="flex justify-between items-center">
                    <span class="text-xs font-bold uppercase tracking-wider opacity-60">Name</span>
                    <span class="text-white font-medium">${firstName}</span>
                </div>
                <div class="border-t border-white/5"></div>
                <div class="flex justify-between items-center">
                    <span class="text-xs font-bold uppercase tracking-wider opacity-60">Username</span>
                    <span class="text-white">${username}</span>
                </div>
                <div class="border-t border-white/5"></div>
                <div class="flex justify-between items-center">
                    <span class="text-xs font-bold uppercase tracking-wider opacity-60">Last Login</span>
                    <span class="text-indigo-300">${lastLogin}</span>
                </div>
            </div>
            
            <!-- API Hash -->
            <div class="bg-surface/50 p-4 rounded-2xl border border-border">
                <div class="text-xs font-bold uppercase tracking-wider opacity-60 mb-2">API Hash</div>
                <div class="font-mono text-sm break-all bg-black/20 p-3 rounded-lg border border-white/5">
                    ${apiHash}
                </div>
            </div>
    `;

    // Add Keywords section
    if (keywords.length > 0) {
        modalHTML += `
            <div>
                <h4 class="text-lg font-bold mb-3 text-brand flex items-center gap-2">
                    <span>🔑</span> Keywords (${keywords.length})
                </h4>
                <div class="space-y-3 max-h-[300px] overflow-y-auto custom-scrollbar pr-3">
                    ${keywords.map(k => `
                        <div class="bg-white/5 p-4 rounded-2xl border border-white/5 hover:bg-white/10 transition-all">
                            <div class="flex items-center justify-between mb-2">
                                <b class="text-indigo-300">/${k.keyword || 'keyword'}</b>
                                <span class="text-xs opacity-50">Trigger</span>
                            </div>
                            <div class="text-sm opacity-70 leading-relaxed bg-black/10 p-2 rounded-lg">
                                ${k.reply || 'No reply set'}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    } else {
        modalHTML += `
            <div class="text-center py-8 space-y-4 bg-white/5 rounded-2xl border border-white/5">
                <div class="text-4xl opacity-30">📭</div>
                <p class="opacity-60 italic">No keywords configured for this user</p>
            </div>
        `;
    }

    modalHTML += `</div>`;
    content.innerHTML = modalHTML;
}

function closeModal() {
    const modal = document.getElementById('details-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('active');
        document.body.style.overflow = 'auto';
    }
}

// Add modal close events
document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('details-modal');
    if (modal) {
        // Close when clicking outside
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal();
            }
        });

        // Close with Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeModal();
            }
        });
    }
});