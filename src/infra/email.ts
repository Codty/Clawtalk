import { config } from '../config.js';

export interface EmailPayload {
    to: string;
    subject: string;
    html: string;
    text?: string;
}

export interface EmailSendResult {
    sent: boolean;
    provider: 'none' | 'resend';
    message: string;
    provider_message_id?: string;
}

async function sendViaResend(payload: EmailPayload): Promise<EmailSendResult> {
    if (!config.resendApiKey) {
        return {
            sent: false,
            provider: 'resend',
            message: 'RESEND_API_KEY is not configured.',
        };
    }
    if (!config.emailFrom) {
        return {
            sent: false,
            provider: 'resend',
            message: 'EMAIL_FROM is not configured.',
        };
    }

    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${config.resendApiKey}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from: config.emailFrom,
            to: [payload.to],
            subject: payload.subject,
            html: payload.html,
            text: payload.text || '',
        }),
    });

    const text = await response.text();
    let body: any = {};
    if (text) {
        try {
            body = JSON.parse(text);
        } catch {
            body = { raw: text };
        }
    }

    if (!response.ok) {
        return {
            sent: false,
            provider: 'resend',
            message: body?.message || body?.error || `resend_http_${response.status}`,
        };
    }

    return {
        sent: true,
        provider: 'resend',
        message: 'ok',
        provider_message_id: body?.id,
    };
}

export async function sendEmail(payload: EmailPayload): Promise<EmailSendResult> {
    if (config.emailProvider === 'resend') {
        return sendViaResend(payload);
    }
    return {
        sent: false,
        provider: 'none',
        message: 'EMAIL_PROVIDER=none; delivery skipped.',
    };
}

