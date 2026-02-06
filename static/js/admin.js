const API_BASE = '/api/admin';

// DOM Ready
document.addEventListener('DOMContentLoaded', () => {
    console.log('Admin panel loaded');
    initModalEvents();
    checkAuthStatus();
});

// Initialize modal events
function initModalEvents() {
    const modal = document.getElementById('details-modal');

    // Close modal when clicking outside
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeModal();
        }
    });

    // Close modal with Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeModal();
        }
    });
}

// Check authentication status
async function checkAuthStatus() {
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
}

// Headers for API calls
function getHeaders() {
    const token = localStorage.getItem('admin_token');
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
    };
}

// Fetch with authentication
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
        console.warn("Session expired or unauthorized. Logging out...");
        logout();
        throw new Error("Unauthorized");
    }
    return response;
}

// Show section helper
function showSection(sectionId) {
    const sections = ['setup-section', 'login-section', 'change-password-section', 'dashboard-section'];

    sections.forEach(id => {
        const element = document.getElementById(id);
        if (element) {
            element.classList.add('hidden');
        }
    });

    const targetSection = document.getElementById(sectionId);
    if (targetSection) {
        targetSection.classList.remove('hidden');
    }
}

// Setup admin account
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

// Check admin authentication
async function checkAdminAuth() {
    const token = localStorage.getItem('admin_token');
    if (!token) {
        showSection('login-section');
        return;
    }

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
            logout();
        }
    } catch (e) {
        logout();
    }
}

// Login function
async function login() {
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    if (!username || !password) {
        alert("Please enter username and password");
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        if (response.ok) {
            const data = await response.json();
            localStorage.setItem('admin_token', data.access_token);
            checkAdminAuth();
        } else {
            const errorData = await response.json();
            alert(errorData.detail || 'Invalid credentials');
        }
    } catch (e) {
        console.error(e);
        alert('Login failed. Please check your connection.');
    }
}

// Logout function
function logout() {
    localStorage.removeItem('admin_token');
    showSection('login-section');
    closeModal();
}

// Change password
async function changePassword() {
    const oldPassword = document.getElementById('old-password').value;
    const newPassword = document.getElementById('new-password').value;
    const confirmPassword = document.getElementById('confirm-password').value;

    if (!oldPassword || !newPassword || !confirmPassword) {
        alert("Please fill in all fields");
        return;
    }

    if (newPassword !== confirmPassword) {
        alert("New passwords do not match!");
        return;
    }

    try {
        const response = await fetchWithAuth(`${API_BASE}/password`, {
            method: 'PUT',
            body: JSON.stringify({
                old_password: oldPassword,
                new_password: newPassword
            })
        });

        if (response.ok) {
            alert("Password changed successfully!");
            checkAdminAuth();
        } else {
            const data = await response.json();
            alert(data.detail || "Failed to change password");
        }
    } catch (e) {
        console.error(e);
        alert("Error changing password");
    }
}

// Load users table
async function loadUsers() {
    try {
        const response = await fetchWithAuth(`${API_BASE}/users`);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const users = await response.json();
        const tbody = document.getElementById('users-table-body');

        if (!tbody) {
            console.error('Users table body not found');
            return;
        }

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
                    <button onclick="viewUserDetails('${user.api_id}')" 
                        class="px-4 py-1.5 bg-brand/10 text-brand hover:bg-brand hover:text-white rounded-lg text-xs font-bold transition-all border border-brand/20">
                        View Details
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (error) {
        console.error("Failed to load users:", error);
        const tbody = document.getElementById('users-table-body');
        if (tbody) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="5" class="p-8 text-center text-red-400">
                        Error loading users: ${error.message}
                    </td>
                </tr>
            `;
        }
    }
}

// View user details - FIXED FUNCTION
async function viewUserDetails(apiId) {
    console.log('Viewing details for API ID:', apiId);

    const modal = document.getElementById('details-modal');
    const content = document.getElementById('modal-content-body');

    if (!modal || !content) {
        console.error('Modal elements not found');
        return;
    }

    // Show loading state
    content.innerHTML = `
        <div class="flex flex-col items-center justify-center py-12 space-y-4">
            <div class="animate-spin rounded-full h-10 w-10 border-t-2 border-b-2 border-brand"></div>
            <p class="text-indigo-300 italic">Loading user details...</p>
        </div>
    `;

    // Show modal
    modal.classList.add('active');
    document.body.style.overflow = 'hidden';

    try {
        // Try multiple API endpoints
        let userData = null;
        let error = null;

        // Try endpoint 1
        try {
            const response = await fetchWithAuth(`${API_BASE}/users/${apiId}`);
            if (response.ok) {
                userData = await response.json();
                console.log('Data from /users/:apiId:', userData);
            }
        } catch (e) {
            error = e;
        }

        // Try endpoint 2 if first failed
        if (!userData) {
            try {
                const response = await fetchWithAuth(`${API_BASE}/user/${apiId}`);
                if (response.ok) {
                    userData = await response.json();
                    console.log('Data from /user/:apiId:', userData);
                }
            } catch (e) {
                error = e;
            }
        }

        // Try endpoint 3 if still no data
        if (!userData) {
            try {
                const response = await fetchWithAuth(`${API_BASE}/users/${apiId}/details`);
                if (response.ok) {
                    userData = await response.json();
                    console.log('Data from /users/:apiId/details:', userData);
                }
            } catch (e) {
                error = e;
            }
        }

        // If still no data, use fallback
        if (!userData) {
            throw new Error('Could not fetch user data from any endpoint');
        }

        // Display the data
        displayUserDetails(userData, apiId);

    } catch (error) {
        console.error('Error fetching user details:', error);

        // Show fallback data
        content.innerHTML = `
            <div class="space-y-6">
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
                
                <div class="bg-yellow-500/10 border border-yellow-500/20 text-yellow-500 p-4 rounded-xl">
                    <div class="font-bold mb-2">⚠️ API Connection Issue</div>
                    <div class="text-sm opacity-70">Could not fetch full details. Check backend API endpoints.</div>
                    <div class="text-xs mt-2 opacity-50">Tried endpoints: 
                        ${API_BASE}/users/${apiId}, 
                        ${API_BASE}/user/${apiId}, 
                        ${API_BASE}/users/${apiId}/details
                    </div>
                </div>
                
                <div class="text-sm opacity-60 italic">
                    Error: ${error.message}
                </div>
            </div>
        `;
    }
}

// Display user details in modal
function displayUserDetails(data, apiId) {
    const content = document.getElementById('modal-content-body');

    // Extract data with fallbacks
    const apiHash = data.api_hash || data.hash || 'Not available';
    const firstName = data.first_name || data.name || 'Unknown';
    const username = data.username ? `@${data.username}` : 'Not set';
    const keywords = data.keywords || [];
    const isOnline = data.is_online || false;
    const status = isOnline ? 'Online' : 'Offline';
    const statusColor = isOnline ? 'text-green-500' : 'text-red-500';

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
                    <span class="text-xs font-bold uppercase tracking-wider opacity-60">Status</span>
                    <span class="${statusColor} font-semibold">${status}</span>
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

    // Add Keywords section if available
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
                                <b class="text-indigo-300">/${k.keyword || k.name || 'keyword'}</b>
                                <span class="text-xs opacity-50">Trigger</span>
                            </div>
                            <div class="text-sm opacity-70 leading-relaxed bg-black/10 p-2 rounded-lg">
                                ${k.reply || k.response || 'No reply set'}
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    } else if (data.has_keywords === false || data.keywords === null) {
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

// Close modal function
function closeModal() {
    const modal = document.getElementById('details-modal');
    if (modal) {
        modal.classList.remove('active');
        document.body.style.overflow = 'auto';
    }
}

// Show unsecured warning
function showUnsecuredWarning() {
    const header = document.querySelector('#dashboard-section header');
    if (!header) return;

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