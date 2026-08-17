const axios = require('axios');
const { RESEND_API_KEY, isResendConfigured } = require('../config.js');

/**
 * Dispatch an email alert using Resend API.
 * 
 * @param {string} toEmail - The recipient's email address
 * @param {object} cam - Camera object
 * @param {string} reason - The detection reason
 * @param {string} snapshotUrl - The base64 snapshot string
 */
const sendAlertEmail = async (toEmail, cam, reason, snapshotUrl) => {
    if (!isResendConfigured()) {
        console.log(`[EmailService] Simulated email to ${toEmail} for camera "${cam.name}". (RESEND_API_KEY not configured)`);
        return true;
    }

    try {
        const emailHtml = `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
                <div style="background-color: #09090b; padding: 20px; text-align: center; color: white;">
                    <h2 style="margin: 0; font-size: 24px;">🚨 OSHA AI Security Alert</h2>
                </div>
                <div style="padding: 20px; background-color: #ffffff;">
                    <h3 style="margin-top: 0; color: #ef4444;">Detection on ${cam.name}</h3>
                    <p><strong>Location:</strong> ${cam.location}</p>
                    <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
                    <p><strong>AI Matched:</strong> ${reason}</p>
                    
                    <div style="margin-top: 20px; border-radius: 8px; overflow: hidden; background: #000;">
                        <img src="${snapshotUrl}" alt="Alert Snapshot" style="width: 100%; height: auto; display: block;" />
                    </div>
                    
                    <div style="text-align: center; margin-top: 30px;">
                        <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/#alerts" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">View in Dashboard</a>
                    </div>
                </div>
                <div style="background-color: #f9fafb; padding: 15px; text-align: center; font-size: 12px; color: #6b7280;">
                    <p>You received this because email notifications are enabled in your OSHA AI settings.</p>
                </div>
            </div>
        `;

        const response = await axios.post('https://api.resend.com/emails', {
            from: 'OSHA AI Alerts <onboarding@resend.dev>',
            to: toEmail,
            subject: `🚨 Alert: Detection on ${cam.name}`,
            html: emailHtml
        }, {
            headers: {
                'Authorization': `Bearer ${RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        console.log(`[EmailService] Email dispatched successfully to ${toEmail} (ID: ${response.data.id})`);
        return true;
    } catch (error) {
        console.error(`[EmailService] Failed to send email to ${toEmail}:`, error.response ? error.response.data : error.message);
        return false;
    }
};

const sendOfflineEmail = async (toEmail, camName, downtimeMinutes) => {
    if (!isResendConfigured()) {
        console.log(`[EmailService] Simulated OFFLINE email to ${toEmail} for camera "${camName}". (RESEND_API_KEY not configured)`);
        return true;
    }

    try {
        const emailHtml = `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
                <div style="background-color: #f59e0b; padding: 20px; text-align: center; color: white;">
                    <h2 style="margin: 0; font-size: 24px;">⚠️ OSHA AI Warning: Camera Offline</h2>
                </div>
                <div style="padding: 20px; background-color: #ffffff;">
                    <h3 style="margin-top: 0; color: #b45309;">Connection Lost on ${camName}</h3>
                    <p><strong>Time Detected:</strong> ${new Date().toLocaleString()}</p>
                    <p>We have lost the video signal from your camera for over <strong>${downtimeMinutes} minutes</strong>.</p>
                    <p>Your site is currently <strong>unmonitored</strong>. Please check the camera's power and network connection.</p>
                    
                    <div style="text-align: center; margin-top: 30px;">
                        <a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}/#cameras" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Check Status in Dashboard</a>
                    </div>
                </div>
                <div style="background-color: #f9fafb; padding: 15px; text-align: center; font-size: 12px; color: #6b7280;">
                    <p>You received this because email notifications are enabled in your OSHA AI settings.</p>
                </div>
            </div>
        `;

        const response = await axios.post('https://api.resend.com/emails', {
            from: 'OSHA AI Alerts <onboarding@resend.dev>',
            to: toEmail,
            subject: `⚠️ Warning: Camera Offline (${camName})`,
            html: emailHtml
        }, {
            headers: {
                'Authorization': `Bearer ${RESEND_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        console.log(`[EmailService] Offline email dispatched successfully to ${toEmail} (ID: ${response.data.id})`);
        return true;
    } catch (error) {
        console.error(`[EmailService] Failed to send offline email to ${toEmail}:`, error.response ? error.response.data : error.message);
        return false;
    }
};

module.exports = {
    sendAlertEmail,
    sendOfflineEmail
};
