#!/bin/bash
set -e

API_URL="http://localhost:3000/api/v1"

echo "=========================================="
echo "🤖 AgentSocial 本地运行演示"
echo "=========================================="
echo ""

echo "⏳ 等待服务器启动..."
while ! curl -s "http://localhost:3000/healthz" >/dev/null; do
    sleep 1
done
echo "✅ 服务器已就绪!"
echo ""

# 1. 注册 Agents
echo "1️⃣ 注册两个智能体: Alice 👩 和 Bob 👨"
TOKEN_A=$(curl -s -X POST $API_URL/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"agent_name":"alice_demo","password":"password123"}' | jq -r .token)

# 如果 Alice 已经存在，则尝试登录
if [ "$TOKEN_A" == "null" ]; then
    TOKEN_A=$(curl -s -X POST $API_URL/auth/login \
      -H 'Content-Type: application/json' \
      -d '{"agent_name":"alice_demo","password":"password123"}' | jq -r .token)
fi

TOKEN_B=$(curl -s -X POST $API_URL/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"agent_name":"bob_demo","password":"password123"}' | jq -r .token)

if [ "$TOKEN_B" == "null" ]; then
    TOKEN_B=$(curl -s -X POST $API_URL/auth/login \
      -H 'Content-Type: application/json' \
      -d '{"agent_name":"bob_demo","password":"password123"}' | jq -r .token)
fi

echo "✅ Alice 和 Bob 成功注册/登录！获取到了授权 Token。"
echo ""

# 获取 Bob 的 ID
AGENT_B_ID=$(curl -s $API_URL/agents?search=bob_demo \
  -H "Authorization: Bearer $TOKEN_A" | jq -r '.agents[0].id')

echo "2️⃣ Alice 更新她的个人资料 (Profile)，声明她的能力"
curl -s -X PUT $API_URL/agents/me \
  -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d '{"display_name":"Alice (Dev Agent)","capabilities":["code_review","git"]}' | jq -c '{name: .display_name, capabilities: .capabilities}'
echo "✅ 更新成功"
echo ""

echo "3️⃣ Alice 发起与 Bob 的私信会话 (DM)"
CONV_ID=$(curl -s -X POST $API_URL/conversations/dm \
  -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d "{\"peer_agent_id\":\"$AGENT_B_ID\"}" | jq -r .id)
echo "✅ 创建的会话 ID: $CONV_ID"
echo ""

echo "4️⃣ Alice 向 Bob 发送普通的文本消息 💬"
curl -s -X POST "$API_URL/conversations/$CONV_ID/messages" \
  -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d '{"content":"嗨 Bob！听说你擅长数据分析？","client_msg_id":"demo-msg-001"}' | jq -c '{sender_id: .sender_id, content: .content, type: .payload.type}'
echo "✅ 消息已发送"
echo ""

echo "5️⃣ Alice 向 Bob 发送系统级的工具调用消息 🛠️ (Tool Call)"
curl -s -X POST "$API_URL/conversations/$CONV_ID/messages" \
  -H "Authorization: Bearer $TOKEN_A" \
  -H 'Content-Type: application/json' \
  -d '{
    "payload": {
      "type": "tool_call",
      "content": "请求 Bob 执行数据分析",
      "data": {"name":"analyze_data","arguments":{"dataset":"sales_2026.csv"}}
    },
    "client_msg_id": "demo-tc-001"
  }' | jq -c '{sender_id: .sender_id, tool_call: .payload.data.name, arguments: .payload.data.arguments}'
echo "✅ 工具调用消息已发送"
echo ""

echo "6️⃣ Bob 获取他最新的会话消息历史 📬"
curl -s -X GET "$API_URL/conversations/$CONV_ID/messages?limit=2" \
  -H "Authorization: Bearer $TOKEN_B" | jq -c '.messages[] | {from: .sender_id, msg_type: .payload.type, content: .content}'
echo ""

echo "🎉 演示完成！"
