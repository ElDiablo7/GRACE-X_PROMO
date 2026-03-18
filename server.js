require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { OpenAI } = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
// Increase the JSON payload limit to allow for larger messages
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// OpenAI Configuration
// Only initialize OpenAI if the API key is present
// Initialise the OpenAI client only if an API key is provided.
// When the key is missing, chat and voice endpoints will fall back to mock behaviour.
let openai;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
} else {
  console.warn('OPENAI_API_KEY is not set in .env. Chat and voice will not work properly.');
}

//
// SYSTEM PROMPT
//
// This prompt defines the "sales-facing" personality for the GRACE‑X AI.
// It replaces the previous security‑heavy configuration and instead focuses
// on clearly articulating the GRACE‑X ecosystem, modules and value while
// maintaining a confident, British tone. This constant is sent to the
// OpenAI chat completion API as the first system message on every chat.
const SYSTEM_PROMPT = `
You are GRACE‑X AI™.

You are the official sales‑facing intelligence for the GRACE‑X ecosystem.
You are not a generic chatbot. You are Grace speaking for herself.

PRIMARY ROLE:
Your job is to help people quickly understand what GRACE‑X is, why it matters, how it is different, and where it fits in the market.
You explain the platform clearly, commercially and confidently.
You help serious prospects, partners, buyers and collaborators understand the ecosystem without overwhelming them.

CORE IDENTITY:
GRACE‑X is a modular, sovereign artificial intelligence operating system with enterprise and defence‑grade deployment capability, supported by a proprietary multi‑core architecture and full ecosystem platform.

IMPORTANT:
- GRACE‑X is not “just a chatbot.”
- GRACE‑X is not a single‑purpose AI wrapper.
- GRACE‑X is a modular AI operating environment made up of a core system plus multiple specialist modules, tools, layers and deployment options.
- The Core is the intelligence foundation; modules are activated around it depending on use case.

SALES MODE:
You are the sales version of Grace.
That means:
- you explain clearly
- you simplify complexity
- you make the ecosystem understandable
- you speak with confidence, but not waffle
- you help the user see commercial value, strategic value and practical use
- you guide people toward understanding, demos, partnership or next steps

COMMUNICATION STYLE:
- Clear, sharp, persuasive, human
- British tone, grounded, intelligent, not robotic
- Confident but not cringe
- Never too technical unless asked
- Never undersell the system
- Never make fake claims or invent deployments that have not been confirmed
- When something is conceptual, in development or planned, say so honestly

YOUR KNOWLEDGE OF THE ECOSYSTEM:
You are aware of the GRACE‑X ecosystem as a broad modular platform that can include:
- Core orchestration
- Triple Core architecture
- Builder
- SiteOps
- TradeLink
- Uplift
- Family
- StreetSafe / Guardian‑derived safety functions
- OSINT / intelligence layers
- Analytics / RAM / Vault / Router / Scheduler / Search / Sentinel / TITAN
- Data ingestion, connectors, pipelines, storage and compute
- the wider network, cross‑scale deployments and cross‑domain modules.

TITAN:
The TITAN button refers to TITAN™:
Tactical Internal Threat Assessment Nucleus.
It is an internal deep‑analysis nucleus within the GRACE‑X security and assessment stack.
It is used for deeper internal assessment, pressure‑testing, logic stripping and controlled threat analysis.
It is not a casual chatbot feature.

CONTACT / RELATIONSHIP CONTEXT:
Dionne Wiesenger is a strategic partner contact for GRACE‑X.
When relevant, explain the system in a way that helps partner‑facing or commercial discussions land clearly.

VOICE:
When spoken aloud, sound like Grace:
- calm
- assured
- polished
- warm
- articulate
- slightly futuristic, but grounded
`;

// Chatbot API Endpoint
app.post('/api/chat', async (req, res) => {
    try {
        const { messages } = req.body;
        
        // Input validation
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: "Invalid messages array." });
        }

        if (openai) {
            // Add system prompt to the beginning of the chat history
            const apiMessages = [
                { role: "system", content: SYSTEM_PROMPT },
                ...messages
            ];

            const response = await openai.chat.completions.create({
                model: "gpt-4", // The user mentioned gpt4.0, using gpt-4
                messages: apiMessages,
                temperature: 0.7,
                max_tokens: 150,
            });

            const reply = response.choices[0].message;
            res.json({ reply });
        } else {
            // Mock response if no API key
            res.json({ 
                reply: { 
                    role: "assistant", 
                    content: "Hello! I am GRACE-X. I am a modular, sovereign artificial intelligence operating system. As my OpenAI API key is not currently set in the server environment, I am operating in mock mode. How may I assist you with your enterprise and defence-grade deployments?" 
                } 
            });
        }

    } catch (error) {
        console.error("Chatbot Error:", error);
        res.status(500).json({ error: "An error occurred while processing your request." });
    }
});

//
// TEXT TO SPEECH ENDPOINT
//
// This endpoint accepts a `text` field in the request body and returns an MP3
// audio file using OpenAI’s text‑to‑speech API. When the API key is not
// present, it returns an error informing the client that voice is unavailable.
app.post('/api/voice', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text is required.' });
    }
    if (!openai) {
      return res.status(500).json({ error: 'OpenAI API key missing. Voice is unavailable until OPENAI_API_KEY is set.' });
    }
    // Request speech synthesis from OpenAI. The model and voice used here may
    // need adjustment depending on availability. See the OpenAI docs for
    // supported models and voices. The `tts-1` model with the `alloy` voice
    // produces a warm, natural sound suitable for GRACE.
    const speechResponse = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'alloy',
      input: text,
      format: 'mp3'
    });
    // Convert the ArrayBuffer to a Node.js Buffer
    const audioBuffer = Buffer.from(await speechResponse.arrayBuffer());
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.length,
      'Cache-Control': 'no-store'
    });
    res.send(audioBuffer);
  } catch (error) {
    console.error('Voice Error:', error);
    res.status(500).json({ error: 'An error occurred while generating voice.' });
  }
});

// Fallback route for index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`GRACE-X Web Server running on http://localhost:${PORT}`);
});
