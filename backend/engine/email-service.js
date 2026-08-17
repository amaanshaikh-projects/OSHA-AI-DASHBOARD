const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') }); // Always resolves to backend/.env
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendAlertEmail(userEmail, cameraName, eventDescription, snapshotUrl) {
    if (!process.env.RESEND_API_KEY) return false; // Silent skip if no key
    try {
        let attachments = [];
        let imgSrc = snapshotUrl;

        // If snapshotUrl is a base64 string, extract it and attach it
        if (snapshotUrl && snapshotUrl.startsWith('data:image')) {
            const base64Data = snapshotUrl.split(',')[1];
            attachments.push({
                filename: 'snapshot.jpg',
                content: base64Data,
                content_id: 'snapshot_img' // CID for inline embedding
            });
            imgSrc = 'cid:snapshot_img';
        }

        const isFire = eventDescription && (eventDescription.toLowerCase().includes('fire') || eventDescription.toLowerCase().includes('smoke'));
        const headerBg = isFire ? 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)' : 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)';
        const headerText = isFire ? '🔥 CRITICAL FIRE ALERT 🔥' : 'VISION AI ALERT';
        const boxBg = isFire ? '#fef2f2' : '#eff6ff';
        const boxBorder = isFire ? '#ef4444' : '#3b82f6';
        const boxTitleColor = isFire ? '#991b1b' : '#1e3a8a';
        const boxTextColor = isFire ? '#7f1d1d' : '#1e40af';

        const htmlTemplate = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f4f4f5; margin: 0; padding: 40px 0; }
                .container { max-width: 500px; margin: 0 auto; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06); }
                .header { background: ${headerBg}; padding: 24px; text-align: center; }
                .header h1 { color: #ffffff; margin: 0; font-size: 20px; font-weight: 600; letter-spacing: 0.5px; }
                .content { padding: 32px; }
                .alert-box { background-color: ${boxBg}; border-left: 4px solid ${boxBorder}; padding: 16px; border-radius: 4px; margin-bottom: 24px; }
                .alert-box h3 { color: ${boxTitleColor}; margin: 0 0 8px 0; font-size: 16px; font-weight: 600; }
                .alert-box p { color: ${boxTextColor}; margin: 0; font-size: 14px; line-height: 1.5; font-weight: ${isFire ? '500' : 'normal'}; }
                .meta-table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
                .meta-table th { text-align: left; padding: 8px 0; color: #6b7280; font-size: 13px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #e5e7eb; }
                .meta-table td { padding: 8px 0; color: #111827; font-size: 15px; font-weight: 500; border-bottom: 1px solid #e5e7eb; }
                .snapshot-container { border-radius: 8px; overflow: hidden; border: 1px solid #e5e7eb; margin-bottom: 24px; background-color: #f9fafb; text-align: center; }
                .snapshot-container img { width: 100%; height: auto; display: block; }
                .footer { background-color: #f9fafb; padding: 20px; text-align: center; border-top: 1px solid #e5e7eb; }
                .footer p { margin: 0; color: #9ca3af; font-size: 12px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>${headerText}</h1>
                </div>
                <div class="content">
                    <div class="alert-box">
                        <h3>Event Detected</h3>
                        <p>${eventDescription}</p>
                    </div>
                    
                    <table class="meta-table">
                        <tr>
                            <th>Camera Name</th>
                        </tr>
                        <tr>
                            <td>${cameraName}</td>
                        </tr>
                    </table>

                    ${imgSrc ? `
                    <div class="snapshot-container">
                        <img src="${imgSrc}" alt="Event Snapshot" />
                    </div>
                    ` : ''}
                </div>
                <div class="footer">
                    <p>Sent securely by your Vision AI Engine.</p>
                </div>
            </div>
        </body>
        </html>
        `;

        const { data, error } = await resend.emails.send({
            from: 'Vision AI <onboarding@resend.dev>',
            to: [userEmail],
            subject: isFire ? `🔥 FIRE DETECTED: ${cameraName}` : `🚨 Security Alert: ${cameraName}`,
            html: htmlTemplate,
            attachments: attachments.length > 0 ? attachments : undefined
        });

        if (error) {
            console.error('[EmailService] Failed to send email:', error);
            return false;
        }

        console.log(`[EmailService] Alert email sent to ${userEmail}! ID: ${data?.id}`);
        return true;
    } catch (err) {
        console.error('[EmailService] Exception while sending email:', err.message);
        return false;
    }
}

module.exports = { sendAlertEmail };
