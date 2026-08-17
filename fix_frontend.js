const fs = require('fs');
const path = require('path');

const walk = (dir) => {
    fs.readdirSync(dir).forEach(file => {
        const p = path.join(dir, file);
        if (fs.statSync(p).isDirectory()) {
            walk(p);
        } else if (p.endsWith('.js') || p.endsWith('.mjs')) {
            let content = fs.readFileSync(p, 'utf8');
            let updated = false;
            
            // Regex to remove the 'type:' line
            const regex = /type:\s*activeTab\s*===\s*'tab-webcam'\s*\?\s*'webcam'\s*:\s*'rtsp',?/g;
            if (regex.test(content)) {
                console.log('Fixed', p);
                content = content.replace(regex, '');
                updated = true;
            }
            
            if (updated) {
                fs.writeFileSync(p, content);
            }
        }
    });
};

walk('./frontend');
