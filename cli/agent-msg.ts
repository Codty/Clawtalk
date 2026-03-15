#!/usr/bin/env node

/**
 * Clawtalk CLI — Minimal wrapper for agent messaging.
 *
 * Usage:
 *   npx tsx cli/agent-msg.ts register <agent_name> <password>
 *   npx tsx cli/agent-msg.ts login <agent_name> <password>
 *   npx tsx cli/agent-msg.ts send_dm <token> <peer_agent_id> <message> [client_msg_id]
 *   npx tsx cli/agent-msg.ts send_group <token> <conversation_id> <message> [client_msg_id]
 *   npx tsx cli/agent-msg.ts listen_inbox <token>
 */

import WebSocket from 'ws';

const BASE_URL = process.env.CLAWTALK_URL || process.env.AGENT_SOCIAL_URL || 'http://localhost:3000';
const WS_URL = BASE_URL.replace(/^http/, 'ws');

async function api(method: string, path: string, body?: any, token?: string): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });

    const data = await res.json();
    if (!res.ok) {
        console.error(`❌ ${res.status}:`, data);
        process.exit(1);
    }
    return data;
}

const [, , command, ...args] = process.argv;

async function main() {
    switch (command) {
        case 'register': {
            const [agentName, password] = args;
            if (!agentName || !password) {
                console.error('Usage: register <agent_name> <password>');
                process.exit(1);
            }
            const result = await api('POST', '/api/v1/auth/register', { agent_name: agentName, password });
            console.log('✅ Registered:', JSON.stringify(result, null, 2));
            break;
        }

        case 'login': {
            const [agentName, password] = args;
            if (!agentName || !password) {
                console.error('Usage: login <agent_name> <password>');
                process.exit(1);
            }
            const result = await api('POST', '/api/v1/auth/login', { agent_name: agentName, password });
            console.log('✅ Logged in:', JSON.stringify(result, null, 2));
            break;
        }

        case 'send_dm': {
            const [token, peerAgentId, message, clientMsgId] = args;
            if (!token || !peerAgentId || !message) {
                console.error('Usage: send_dm <token> <peer_agent_id> <message> [client_msg_id]');
                process.exit(1);
            }
            // Create or get DM conversation
            const conv = await api('POST', '/api/v1/conversations/dm', { peer_agent_id: peerAgentId }, token);
            console.log(`💬 DM conversation: ${conv.id}`);
            // Send message
            const msg = await api('POST', `/api/v1/conversations/${conv.id}/messages`, {
                content: message,
                client_msg_id: clientMsgId || `cli-${Date.now()}`,
            }, token);
            console.log('✅ Message sent:', JSON.stringify(msg, null, 2));
            break;
        }

        case 'send_group': {
            const [token, conversationId, message, clientMsgId] = args;
            if (!token || !conversationId || !message) {
                console.error('Usage: send_group <token> <conversation_id> <message> [client_msg_id]');
                process.exit(1);
            }
            const msg = await api('POST', `/api/v1/conversations/${conversationId}/messages`, {
                content: message,
                client_msg_id: clientMsgId || `cli-${Date.now()}`,
            }, token);
            console.log('✅ Message sent:', JSON.stringify(msg, null, 2));
            break;
        }

        case 'listen_inbox': {
            const [token] = args;
            if (!token) {
                console.error('Usage: listen_inbox <token>');
                process.exit(1);
            }
            console.log('🎧 Connecting to WebSocket...');
            const wsTokenRes = await api('POST', '/api/v1/auth/ws-token', undefined, token);
            const ws = new WebSocket(`${WS_URL}/ws?ws_token=${wsTokenRes.ws_token}`);

            ws.on('open', () => {
                console.log('✅ Connected! Listening for messages... (Ctrl+C to exit)');
            });

            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    if (msg.type === 'new_message') {
                        console.log(`\n📩 [${msg.data.created_at}] From ${msg.data.sender_id} in ${msg.data.conversation_id}:`);
                        console.log(`   ${msg.data.content}`);
                    } else {
                        console.log('📌', JSON.stringify(msg));
                    }
                } catch {
                    console.log('Raw:', data.toString());
                }
            });

            ws.on('close', (code, reason) => {
                console.log(`\n🔌 Disconnected (code=${code}, reason=${reason})`);
                process.exit(0);
            });

            ws.on('error', (err) => {
                console.error('❌ WebSocket error:', err.message);
                process.exit(1);
            });

            // Keep alive with pings
            const pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ping' }));
                }
            }, 30000);

            process.on('SIGINT', () => {
                clearInterval(pingInterval);
                ws.close();
            });

            // Keep process alive
            await new Promise(() => { });
            break;
        }

        default:
            console.log(`
Clawtalk CLI

Commands:
  register <agent_name> <password>                          Register a new agent
  login <agent_name> <password>                             Login and get token
  send_dm <token> <peer_agent_id> <message> [client_msg_id] Send DM
  send_group <token> <conversation_id> <message> [client_msg_id] Send group message
  listen_inbox <token>                                      Listen for real-time messages

Environment:
  CLAWTALK_URL      Server URL (preferred)
  AGENT_SOCIAL_URL  Server URL (legacy fallback)
`);
    }
}

main().catch((err) => {
    console.error('Error:', err);
    process.exit(1);
});
