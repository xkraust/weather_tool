// server.js
import "dotenv/config";
import express from "express";
import { Anthropic } from "@anthropic-ai/sdk";

const app = express();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());

// --- Tool implementation ---

async function geocode(location) {
  const cityName = location.split(",")[0].trim();
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.results?.length) throw new Error(`Lokace nenalezena: ${location}`);
  const { latitude, longitude, name, country } = data.results[0];
  return { latitude, longitude, name, country };
}

async function fetchWeather(latitude, longitude) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`;
  const res = await fetch(url);
  const data = await res.json();
  return data.current_weather;
}

async function get_weather(location) {
  const { latitude, longitude, name, country } = await geocode(location);
  const weather = await fetchWeather(latitude, longitude);
  return {
    location: `${name}, ${country}`,
    temperature_celsius: weather.temperature,
    wind_speed_kmh: weather.windspeed,
    is_day: weather.is_day === 1
  };
}

const tools = [
  {
    name: "get_weather",
    description: "Zjisti aktuální počasí pro zadanou lokaci.",
    input_schema: {
      type: "object",
      properties: {
        location: { type: "string", description: "Město a země, např. Praha, CZ" }
      },
      required: ["location"]
    }
  }
];

async function runTool(name, input) {
  if (name === "get_weather") return await get_weather(input.location);
  throw new Error(`Unknown tool: ${name}`);
}

// --- Chat endpoint ---

app.post("/chat", async (req, res) => {
  const { message, history } = req.body;
  const messages = [...(history || []), { role: "user", content: message }];

  try {
    let response = await anthropic.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 1024,
      tools,
      messages
    });

    const toolCalls = [];

    while (response.stop_reason === "tool_use") {
      const toolUseBlock = response.content.find(b => b.type === "tool_use");
      const toolResult = await runTool(toolUseBlock.name, toolUseBlock.input);

      toolCalls.push({ tool: toolUseBlock.name, input: toolUseBlock.input, result: toolResult });

      messages.push({ role: "assistant", content: response.content });
      messages.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseBlock.id, content: JSON.stringify(toolResult) }]
      });

      response = await anthropic.messages.create({
        model: "claude-opus-4-6",
        max_tokens: 1024,
        tools,
        messages
      });
    }

    const assistantText = response.content.find(b => b.type === "text")?.text ?? "";
    messages.push({ role: "assistant", content: assistantText });

    res.json({ reply: assistantText, history: messages, toolCalls });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Serve the frontend ---

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Rosnička</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: system-ui, sans-serif;
      background: #f0f4f8;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
    }

    #app {
      background: white;
      border-radius: 16px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.1);
      width: 480px;
      max-width: 95vw;
      display: flex;
      flex-direction: column;
      height: 620px;
    }

    header {
      padding: 20px;
      border-bottom: 1px solid #e5e7eb;
      font-weight: 600;
      font-size: 1.1rem;
      color: #1e293b;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    #messages {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .message {
      max-width: 80%;
      padding: 10px 14px;
      border-radius: 12px;
      font-size: 0.92rem;
      line-height: 1.5;
    }

    .message.user {
      align-self: flex-end;
      background: #3b82f6;
      color: white;
      border-bottom-right-radius: 4px;
    }

    .message.assistant {
      align-self: flex-start;
      background: #f1f5f9;
      color: #1e293b;
      border-bottom-left-radius: 4px;
    }

    .tool-badge {
      font-size: 0.75rem;
      color: #64748b;
      align-self: flex-start;
      background: #e2e8f0;
      padding: 3px 8px;
      border-radius: 6px;
    }

    #input-area {
      padding: 16px;
      border-top: 1px solid #e5e7eb;
      display: flex;
      gap: 8px;
    }

    #input {
      flex: 1;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 0.92rem;
      outline: none;
      transition: border-color 0.2s;
    }

    #input:focus { border-color: #3b82f6; }

    #send {
      background: #3b82f6;
      color: white;
      border: none;
      border-radius: 8px;
      padding: 10px 18px;
      font-size: 0.92rem;
      cursor: pointer;
      transition: background 0.2s;
    }

    #send:hover { background: #2563eb; }
    #send:disabled { background: #93c5fd; cursor: not-allowed; }

    .typing {
      align-self: flex-start;
      color: #94a3b8;
      font-size: 0.85rem;
      font-style: italic;
    }
  </style>
</head>
<body>
  <div id="app">
    <header>🌤️ Rosnička</header>
    <div id="messages">
      <div class="message assistant">Ahoj! Zeptej se mě na počasí kdekoli na světě.</div>
    </div>
    <div id="input-area">
      <input id="input" type="text" placeholder="např. Jaké je počasí v Praze?" />
      <button id="send">Odeslat</button>
    </div>
  </div>

  <script>
    let history = [];
    const messagesEl = document.getElementById("messages");
    const inputEl = document.getElementById("input");
    const sendBtn = document.getElementById("send");

    function addMessage(role, text) {
      const div = document.createElement("div");
      div.className = "message " + role;
      div.textContent = text;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }

    function addToolBadge(toolName, location) {
      const div = document.createElement("div");
      div.className = "tool-badge";
      div.textContent = "🔧 Zavolal jsem nástroj " + toolName + " pro " + location;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    async function sendMessage() {
      const text = inputEl.value.trim();
      if (!text) return;

      inputEl.value = "";
      sendBtn.disabled = true;
      addMessage("user", text);

      const typingEl = document.createElement("div");
      typingEl.className = "typing";
      typingEl.textContent = "Claude přemýšlí...";
      messagesEl.appendChild(typingEl);
      messagesEl.scrollTop = messagesEl.scrollHeight;

      try {
        const res = await fetch("/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text, history })
        });

        const data = await res.json();
        typingEl.remove();

        if (data.error) {
          addMessage("assistant", "Error: " + data.error);
        } else {
          if (data.toolCalls?.length) {
            data.toolCalls.forEach(tc => addToolBadge(tc.tool, tc.input.location));
          }
          addMessage("assistant", data.reply);
          history = data.history;
        }
      } catch (err) {
        typingEl.remove();
        addMessage("assistant", "Network error: " + err.message);
      }

      sendBtn.disabled = false;
      inputEl.focus();
    }

    sendBtn.addEventListener("click", sendMessage);
    inputEl.addEventListener("keydown", e => { if (e.key === "Enter") sendMessage(); });
  </script>
</body>
</html>`);
});

app.listen(3000, () => console.log("Running at http://localhost:3000"));