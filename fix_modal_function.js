// SIMPLIFIED VERSION - Replace viewUserKeywords function in admin.js (around line 248-345)

async function viewUserKeywords(apiId) {
    const modal = document.getElementById('details-modal');
    const content = document.getElementById('modal-content-body');

    content.textContent = 'Loading...';
    modal.classList.remove('hidden');

    try {
        console.log('Fetching for:', apiId);
        const response = await fetchWithAuth(`${API_BASE}/users/${apiId}/details`);

        if (!response.ok) {
            throw new Error('Failed');
        }

        const data = await response.json();
        console.log('Data:', data);

        // Create elements programmatically instead of using innerHTML
        content.innerHTML = ''; // Clear first

        const container = document.createElement('div');
        container.style.padding = '20px';

        const title = document.createElement('h3');
        title.textContent = 'User Credentials';
        title.style.color = '#818cf8';
        title.style.marginBottom = '20px';
        container.appendChild(title);

        // API ID Box
        const idBox = document.createElement('div');
        idBox.style.cssText = 'background:rgba(255,255,255,0.05);padding:16px;margin-bottom:12px;border-radius:12px';
        const idLabel = document.createElement('div');
        idLabel.textContent = 'API ID';
        idLabel.style.cssText = 'font-size:12px;opacity:0.6;margin-bottom:4px';
        const idValue = document.createElement('div');
        idValue.textContent = data.api_id || 'N/A';
        idValue.style.cssText = 'font-family:monospace;color:#a5b4fc;font-size:16px';
        idBox.appendChild(idLabel);
        idBox.appendChild(idValue);
        container.appendChild(idBox);

        // API Hash Box
        const hashBox = document.createElement('div');
        hashBox.style.cssText = 'background:rgba(255,255,255,0.05);padding:16px;border-radius:12px';
        const hashLabel = document.createElement('div');
        hashLabel.textContent = 'API Hash';
        hashLabel.style.cssText = 'font-size:12px;opacity:0.6;margin-bottom:4px';
        const hashValue = document.createElement('div');
        hashValue.textContent = data.api_hash || 'HIDDEN';
        hashValue.style.cssText = 'font-family:monospace;color:#a5b4fc;font-size:14px;word-break:break-all';
        hashBox.appendChild(hashLabel);
        hashBox.appendChild(hashValue);
        container.appendChild(hashBox);

        content.appendChild(container);
        console.log('Display done');

    } catch (e) {
        console.error('Error:', e);
        content.textContent = 'Error: ' + e.message;
    }
}
