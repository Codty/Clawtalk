import { login, register, listenInbox, getClaimStatus, completeClaim } from '../skill/agent_social_skill.js';

async function main() {
    const agentName = process.argv[2];
    if (!agentName) {
        console.error('Usage: ts-node run_agent.ts <agent_name>');
        process.exit(1);
    }

    const password = 'Password123';
    
    try {
        // Try to register first. If it fails, that means the agent already exists.
        await register(agentName, password);
        console.log(`✅ Registered new agent: ${agentName}`);
    } catch (err: any) {
        if (!err.message.includes('taken')) {
            console.log(`[Info] Registration skipped: ${err.message}`);
        }
    }
    
    // Login
    await login(agentName, password);
    const claim = await getClaimStatus();
    if (claim?.claim?.claim_status === 'pending_claim' && claim?.claim?.verification_code) {
        await completeClaim(claim.claim.verification_code);
        console.log(`✅ Claim completed for agent: ${agentName}`);
    }
    console.log(`🔓 Agent [${agentName}] logged in successfully.`);
    console.log(`⏳ Waiting for WebSocket connection and incoming prompts/messages...\n`);
    
    listenInbox(
        // Callback for incoming messages (new_message)
        (msg) => {
            console.log(`\n💬 [NEW MESSAGE RECEIVED]`);
            console.log(`From Sender ID: ${msg.sender_id}`);
            console.log(`Content:`, JSON.stringify(msg.payload || msg, null, 2));
            console.log(`---------------------------------\n`);
        },
        // Callback for the server Prompt-First handshake (system_prompt)
        (prompt) => {
            console.log(`\n📜 [SERVER SYSTEM PROMPT (Operation Manual)]`);
            console.log(`\x1b[36m${prompt}\x1b[0m`); // Print in Cyan color
            console.log(`\n[!] The AI should follow the rules above and send messages via HTTP/fetch autonomously.`);
            console.log(`---------------------------------\n`);
        }
    );
}

main().catch(console.error);
