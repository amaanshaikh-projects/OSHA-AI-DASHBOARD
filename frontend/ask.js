const chatHistory = document.getElementById('chat-history');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');

let messageHistory = [];

async function sendMessage(text) {
    if (!text.trim()) return;

    // Add User Message
    addMessageToUI('user', text);
    chatInput.value = '';

    // Add Loading Indicator
    const loadingId = 'loading-' + Date.now();
    addMessageToUI('assistant', '<div class="loader">Thinking...</div>', loadingId);

    try {
        const response = await fetch(window.API_BASE_URL + '/api/assistant/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer fake-token` // For demo
            },
            body: JSON.stringify({
                query: text,
                history: messageHistory
            })
        });

        const data = await response.json();
        
        // Remove loading
        document.getElementById(loadingId).remove();

        if (data.error) {
            addMessageToUI('assistant', `Error: ${data.error}`);
            return;
        }

        // Add Assistant Message
        let html = `<p>${data.text.replace(/\n/g, '<br>')}</p>`;
        
        if (data.events && data.events.length > 0) {
            html += `<div class="event-cards">`;
            data.events.forEach(ev => {
                const date = new Date(ev.timestamp);
                html += `
                    <div class="event-card">
                        <img src="${ev.snapshot_url}" alt="Event Snapshot">
                        <div class="event-details">
                            <strong>${ev.cameras?.name || 'Camera'}</strong>
                            ${date.toLocaleDateString()} ${date.toLocaleTimeString()}<br>
                            ${ev.reason.split(' (Secondary Alert)')[0]}
                        </div>
                    </div>
                `;
            });
            html += `</div>`;
        }

        addMessageToUI('assistant', html);
        
        messageHistory.push({ role: 'user', content: text });
        messageHistory.push({ role: 'assistant', content: data.text });

    } catch (e) {
        document.getElementById(loadingId).remove();
        addMessageToUI('assistant', "Sorry, I couldn't connect to the server.");
        console.error(e);
    }
}

function addMessageToUI(role, htmlContent, id = null) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}`;
    if (id) msgDiv.id = id;
    msgDiv.innerHTML = htmlContent;
    chatHistory.appendChild(msgDiv);
    chatHistory.scrollTop = chatHistory.scrollHeight;
}

function askQuestion(text) {
    sendMessage(text);
}

sendBtn.addEventListener('click', () => sendMessage(chatInput.value));
chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage(chatInput.value);
});
