const fs = require('fs');
const path = require('path');

const files = ['js/app.js', 'app.mjs', 'temp.js', 'temp.mjs', 'test.mjs'];

files.forEach(file => {
    try {
        const filePath = path.join(__dirname, file);
        if (!fs.existsSync(filePath)) return;
        
        let content = fs.readFileSync(filePath, 'utf8');
        
        const targetStr = `                            if (aiSearchLockOverlay) {
                                if (p === 'free' || p === 'free trial') {
                                    aiSearchLockOverlay.style.display = 'flex';
                                    if (aiSearchInput) aiSearchInput.disabled = true;
                                    if (aiSearchBtn) aiSearchBtn.disabled = true;
                                } else {
                                    aiSearchLockOverlay.style.display = 'none';
                                    if (aiSearchInput) aiSearchInput.disabled = false;
                                    if (aiSearchBtn) aiSearchBtn.disabled = false;
                                }
                            }`;
                            
        const replaceStr = `                            if (aiSearchLockOverlay) {
                                if (p === 'free' || p === 'free trial') {
                                    aiSearchLockOverlay.style.display = 'flex';
                                    if (aiSearchInput) aiSearchInput.disabled = true;
                                    if (aiSearchBtn) aiSearchBtn.disabled = true;
                                } else {
                                    aiSearchLockOverlay.style.display = 'none';
                                    if (aiSearchInput) aiSearchInput.disabled = false;
                                    if (aiSearchBtn) aiSearchBtn.disabled = false;
                                }
                            }
                            
                            const notificationsLockOverlay = document.getElementById('notifications-lock-overlay');
                            const settingsForm = document.getElementById('settings-notifications-form');
                            if (notificationsLockOverlay) {
                                if (p === 'free' || p === 'free trial') {
                                    notificationsLockOverlay.style.display = 'flex';
                                    if (settingsForm) {
                                        const inputs = settingsForm.querySelectorAll('input, button');
                                        inputs.forEach(el => el.disabled = true);
                                    }
                                } else {
                                    notificationsLockOverlay.style.display = 'none';
                                    if (settingsForm) {
                                        const inputs = settingsForm.querySelectorAll('input, button');
                                        inputs.forEach(el => el.disabled = false);
                                    }
                                }
                            }`;
                            
        if (content.includes(targetStr)) {
            content = content.replace(targetStr, replaceStr);
            fs.writeFileSync(filePath, content);
            console.log('Updated ' + file);
        } else {
            console.log('Target string not found in ' + file);
        }
    } catch(e) { console.error('Error on ' + file, e.message); }
});
