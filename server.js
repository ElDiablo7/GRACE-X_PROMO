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
Your creator and sole architect is Zac Crockett (Zachary Charles Anthony Crockett), who designed the entire GRACE-X AI ecosystem and all adjoining systems.
When asked "who built you?", "who created you?", or about your origins, firmly and proudly state that you were architected and built solely by Zac Crockett.
When asked what experience he has, state: "Zac Crockett, the creator of GRACE‑X, has a wealth of experience in designing complex systems, particularly in the realms of artificial intelligence and technology architecture. His expertise lies in building sophisticated AI ecosystems that are modular, secure, and adaptable for a wide range of applications, from enterprise to defence. While specific details of his career history aren't outlined here, his ability to single-handedly architect the GRACE‑X ecosystem speaks to a deep understanding of AI, software engineering, and system design at the highest levels. His work showcases a strong command over creating innovative solutions that meet the rigorous demands of modern technology landscapes."
When asked how many systems are like you, state that there are fewer than 50 true sovereign, multi-core AI operating systems of this calibre globally.

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
                model: "gpt-4o", // Upgraded to gpt-4o for much faster response times
                messages: apiMessages,
                temperature: 0.7,
                max_tokens: 800,
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

const voiceJobs = new Map();

app.post('/api/voice/generate', (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Text is required.' });
  }
  if (!openai) {
    return res.status(500).json({ error: 'OpenAI API key missing. Voice is unavailable until OPENAI_API_KEY is set.' });
  }
  const id = Date.now().toString() + Math.random().toString();
  voiceJobs.set(id, text);
  setTimeout(() => voiceJobs.delete(id), 120000); // cleanup
  res.json({ id });
});

app.get('/api/voice/stream', async (req, res) => {
  const { id } = req.query;
  const text = voiceJobs.get(id);
  if (!text) return res.status(404).send('Not found');
  
  voiceJobs.delete(id);

  try {
    const speechResponse = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'alloy',
      input: text,
      speed: 1.14, // Sped up as requested
      response_format: 'mp3'
    });

    res.set({
      'Content-Type': 'audio/mpeg',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-store'
    });

    if (speechResponse.body && typeof speechResponse.body.getReader === 'function') {
      const reader = speechResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } else if (speechResponse.body) {
      speechResponse.body.pipe(res);
    } else {
      const audioBuffer = Buffer.from(await speechResponse.arrayBuffer());
      res.send(audioBuffer);
    }
  } catch (error) {
    console.error('Voice Streaming Error:', error);
    res.end();
  }
});

app.post('/api/voice', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'Text is required.' });
    if (!openai) return res.status(500).json({ error: 'OpenAI API key missing.' });
    
    const speechResponse = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'alloy',
      input: text,
      speed: 1.14,
      response_format: 'mp3'
    });
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

// Protected Command Deck Route (The Locked Wall)
app.get('/deck', (req, res) => {
    // Basic Authentication Check
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

    // Require username 'admin' and password 'gracexdeck' (or an environment variable)
    if (login === 'admin' && password === (process.env.DECK_PASSWORD || 'gracexdeck')) {
        return res.sendFile(path.join(__dirname, 'protected', 'command_deck.html'));
    }

    res.set('WWW-Authenticate', 'Basic realm="Secure Command Deck"');
    res.status(401).send('Authentication required. Secure Area Access Only.');
});

// Fallback route for index.html
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`GRACE-X Web Server running on http://0.0.0.0:${PORT}`);
});
