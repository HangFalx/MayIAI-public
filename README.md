# MayIAI – Hungarian AI receptionist for private clinics

University assignment (NLP and Transformer-based models). A Hungarian-speaking assistant that answers
questions about a private clinic's services, prices and doctors, and books, cancels and reschedules appointments
in real time through **LLM tool calling**.

This repository is a simplified, self-contained version of a larger production system. It keeps only the NLP core
(single system prompt + tool-calling agent + simulated clinic calendar), a text chat, and an evaluation harness that
compares the assistant with two baselines.

**Production version:** the further developed system runs at [mayiai.hu](https://mayiai.hu) as a phone assistant.
On top of this core it adds the voice layer (Twilio Media Streams, Deepgram streaming STT, Cartesia streaming TTS,
barge-in), a step-by-step conversation flow, filler phrases while the model thinks, speculative LLM start before the
final transcript, FAQ retrieval from the clinic's own website, an admin and setup interface, and multi-clinic operation.

## Architecture

```
 Caller text (in production: speech recognized by Deepgram, low-confidence words marked as word[?])
                         │
                         ▼
            ConversationAgent ── system prompt (role, rules, date context, clinic catalog with prices)
                         │  ▲
            tool calls   │  │ tool results (JSON)
                         ▼  │
            tools.ts: find_free_slots · book_appointment · find_appointment · cancel_appointment
                         │
                         ▼
            ClinicCalendar (simulated clinic calendar, doctors' weekly schedules, 30-min slots)
                         │
                         ▼
 Reply text (in production: spoken by Cartesia TTS, sentence by sentence)
```

| Path | Content |
|---|---|
| `src/llm/agent.ts` | Conversation loop: LLM stream → tool calls → tool results → LLM stream (max 4 rounds) |
| `src/llm/systemPrompt.ts` | The single system prompt: role, style, date context, catalog, tool-usage rules |
| `src/llm/tools.ts` | Tool definitions (JSON Schema with enums) and their execution with validation |
| `src/llm/openaiProvider.ts` | OpenAI-compatible streaming client (Gemini or OpenAI) |
| `src/llm/ruleBasedProvider.ts` | Baseline B0: keyword/regex dialogue manager with the same tools |
| `src/booking/` | Clinic catalog (services, prices, doctors), calendar simulator, fuzzy name matching |
| `src/chat.ts` | Text-mode chat in the terminal |
| `src/eval/`, `eval/scenarios.json` | Evaluation harness and the 46 test scenarios |
| `results/` | Latest evaluation results (`summary.md`, `results.json` with full transcripts) |

## Running

Requirements: Node.js 20+.

```bash
npm install
cp .env.example .env        # fill in GEMINI_API_KEY (or OPENAI_API_KEY with LLM_PROVIDER=openai)

npm run chat                # talk to the assistant in the terminal
npm run chat -- --no-tools  # baseline B1
npm run chat -- --rules     # baseline B0 (no API key needed)

npm run eval                # all systems, 1 run each
npm run eval -- --runs 3    # 3 runs per LLM system
npm run eval -- --systems rules --only book   # subset
```

## Evaluation

Each scenario is a scripted multi-turn conversation in Hungarian. Before each scenario the calendar is reset to an
in-memory state (optionally with seeded appointments); afterwards the **end state of the calendar** and the
assistant's replies are checked against the expectations.

* **Task success** – all expectations met: the right booking was created (service, doctor, weekday, time window,
  patient name) or the right appointment cancelled / kept, and the reply contains the expected facts
  (prices also accepted in Hungarian number words) and no forbidden ones (e.g. an invented price).
* **Expected tools called** – share of the expected tools the system actually called.
* **Schema-valid calls** – tool arguments that satisfy the JSON Schema (required fields, enums, types).
* **Successful calls** – tool calls that the backend accepted (no `hiba` / `siker: false`).
* **Hallucinated confirmations** – replies claiming a booking or cancellation without a successful tool call behind it.

Systems compared:

| System | Description |
|---|---|
| B0 rule-based | Keyword and regex intent / slot detection, written for the catalog; same tools and calendar |
| B1 LLM without tools | Same LLM and prompt with the catalog, but no calendar access |
| LLM + tool calling | The assistant |

The scenario set has a **core** part (32 scenarios: information, booking, cancellation, rescheduling) and a
**hard** part (14 scenarios: paraphrases, number words, implicit intents) that the rule-based baseline was not tuned on.
See `results/summary.md` for the latest numbers.

## Data

The clinic is fictional: specialties, services and price levels are modelled on typical Budapest private clinics,
all clinic and doctor names are invented, and so are the doctors' weekly schedules and visit durations.
The test conversations are synthetic. No real patient data is included.
