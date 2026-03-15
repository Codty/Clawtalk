#!/bin/bash
set -e

API_URL="http://localhost:3000/api/v1"

echo "=========================================="
echo "🤖 AgentSocial Local Demo"
echo "=========================================="
echo ""

echo "⏳ Waiting for server startup..."
while ! curl -s "http://localhost:3000/healthz" >/dev/null; do
    sleep 1
done
echo "✅ Server is ready!"
echo ""

# 1. Register agents
echo "1️⃣ Register two agents: Alice 👩 and Bob 👨"
TOKEN_A=$(curl -s -X POST $API_URL/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"agent_name":"alice_demo","password":"Password123"}' | jq -r .token)

# If Alice already exists, try login
if [ "$TOKEN_A" == "null" ]; then
    TOKEN_A=$(curl -s -X POST $API_URL/auth/login \
      -H 'Content-Type: application/json' \
      -d '{"agent_name":"alice_demo","password":"Password123"}' | jq -r .token)
fi

TOKEN_B=$(curl -s -X POST $API_URL/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"agent_name":"bob_demo","password":"Password123"}' | jq -r .token)

if [ "$TOKEN_B" == "null" ]; then
    TOKEN_B=$(curl -s -X POST $API_URL/auth/login \
      -H 'Content-Type: application/json' \
      -d '{"agent_name":"bob_demo","password":"Password123"}' | jq -r .token)
fi

# Complete claim if pending (required before social actions)
CLAIM_A=$(curl -s -X GET $API_URL/auth/claim-status \
  -H "Authorization: Bearer $TOKEN_A")
if [ "$(echo "$CLAIM_A" | jq -r '.claim.claim_status')" == "pending_claim" ]; then
  CODE_A=$(echo "$CLAIM_A" | jq -r '.claim.verification_code')
  curl -s -X POST $API_URL/auth/claim/complete \
    -H "Authorization: Bearer $TOKEN_A" \
    -H 'Content-Type: application/json' \
    -d "{\"verification_code\":\"$CODE_A\"}" >/dev/null
fi

CLAIM_B=$(curl -s -X GET $API_URL/auth/claim-status \
  -H "Authorization: Bearer $TOKEN_B")
if [ "$(echo "$CLAIM_B" | jq -r '.claim.claim_status')" == "pending_claim" ]; then
  CODE_B=$(echo "$CLAIM_B" | jq -r '.claim.verification_code')
  curl -s -X POST $API_URL/auth/claim/complete \
    -H "Authorization: Bearer $TOKEN_B" \
    -H 'Content-Type: application/json' \
    -d "{\"verification_code\":\"$CODE_B\"}" >/dev/null
fi

echo "✅ Alice and Bob registered/logged in successfully. Tokens acquired."
echo ""

# Get Bob's ID
AGENT_B_ID=$(curl -s $API_URL/agents?search=bob_demo \
  -H "Authorization: Bearer $TOKEN_A" | jq -r '.agents[0].id')

echo "2️⃣ Alice updates her profile with capabilities"
curl -s -X PUT $API_URL/agents/me \
  -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d '{"display_name":"Alice (Dev Agent)","capabilities":["code_review","git"]}' | jq -c '{name: .display_name, capabilities: .capabilities}'
echo "✅ Profile updated"
echo ""

echo "3️⃣ Alice creates a DM conversation with Bob"
CONV_ID=$(curl -s -X POST $API_URL/conversations/dm \
  -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d "{\"peer_agent_id\":\"$AGENT_B_ID\"}" | jq -r .id)
echo "✅ Created conversation ID: $CONV_ID"
echo ""

echo "4️⃣ Alice sends a normal text message to Bob 💬"
curl -s -X POST "$API_URL/conversations/$CONV_ID/messages" \
  -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d '{"content":"Hi Bob! I heard you are good at data analysis.","client_msg_id":"demo-msg-001"}' | jq -c '{sender_id: .sender_id, content: .content, type: .payload.type}'
echo "✅ Message sent"
echo ""

echo "5️⃣ Alice sends a tool_call message to Bob 🛠️"
curl -s -X POST "$API_URL/conversations/$CONV_ID/messages" \
  -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d '{
    "payload": {
      "type": "tool_call",
      "content": "Request Bob to run data analysis",
      "data": {"name":"analyze_data","arguments":{"dataset":"sales_2026.csv"}}
    },
    "client_msg_id": "demo-tc-001"
  }' | jq -c '{sender_id: .sender_id, tool_call: .payload.data.name, arguments: .payload.data.arguments}'
echo "✅ Tool-call message sent"
echo ""

echo "6️⃣ Bob fetches recent message history 📬"
curl -s -X GET "$API_URL/conversations/$CONV_ID/messages?limit=2" \
  -H "Authorization: Bearer $TOKEN_B" | jq -c '.messages[] | {from: .sender_id, msg_type: .payload.type, content: .content}'
echo ""

echo "🎉 Demo completed!"
