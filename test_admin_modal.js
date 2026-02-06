// Simplified version - show only API ID and API Hash
async function viewUserKeywords(apiId) {
    const modal = document.getElementById('details-modal');
    const content = document.getElementById('modal-content-body');

    content.innerHTML = '<div class="flex justify-center p-8 text-indigo-300">Loading...</div>';
    modal.classList.remove('hidden');

    try {
        console.log('Fetching details for:', apiId);
        const response = await fetchWithAuth(`${API_BASE}/users/${apiId}/details`);

        if (!response.ok) throw new Error('Failed to load');

        const data = await response.json();
        console.log('Data:', data);

        content.innerHTML = `
            <div class="space-y-4">
                <h3 class="text-xl font-bold mb-4" style="color: #818cf8;">User Credentials</h3>
                
                <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.05);">
                    <div style="font-size: 12px; opacity: 0.6; margin-bottom: 4px;">API ID</div>
                    <div style="font-family: monospace; color: #a5b4fc; font-size: 16px;">${data.api_id || 'N/A'}</div>
                </div>
                
                <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.05);">
                    <div style="font-size: 12px; opacity: 0.6; margin-bottom: 4px;">API Hash</div>
                    <div style="font-family: monospace; color: #a5b4fc; font-size: 14px; word-break: break-all;">${data.api_hash || 'HIDDEN'}</div>
                </div>
            </div>
        `;

        console.log('Display complete');
    } catch (e) {
        console.error('Error:', e);
        content.innerHTML = '<div class="text-red-400 p-4">Error: ' + e.message + '</div>';
    }
}
