# Chat contract (engine.js <-> app.js <-> serve.py)

Goal: a real interactive chatbot. Instant feedback, streaming tokens from local qwen2.5:3b (Ollama),
multi-turn follow-ups, never a long silent wait, never invents products. Gemini is removed.

## 1. engine.js: `TechMartEngine.converse(message, products, state, opts)` (pure, synchronous, < 5 ms)

`opts = { stage: 1|2|3 (default 3), k: 5 }`, `state` = previous return's `state` or `null`.

Returns:
```js
{
  kind: 'greeting'|'thanks'|'help'|'smalltalk'|'off_topic'|'not_found'|'product_question'
        |'recommendation'|'list'|'compare'|'catalog_overview'|'clarify',
  needs_llm: boolean,        // false for greeting/thanks/help/smalltalk/off_topic/catalog_overview/clarify -> reply instantly
  answer: string,            // ALWAYS present: deterministic, catalog-grounded markdown (used directly when needs_llm=false,
                             // and as the instant fallback when the LLM is slow/unavailable)
  products: [ { id, name, category, price, specs, why: [..], badge: 'Best pick'|'Runner-up'|'' } ],  // 0-3 cards to show
  suggestions: [ string, string, string ],   // short follow-up chips relevant to this turn ("Anything cheaper?", "Compare top 2", ...)
  run: <existing run() result> | null,       // for the "How I found this" trace (null for non-retrieval kinds)
  llm: { system: string, user: string } | null,  // prompt for the LLM when needs_llm; includes a compact summary of the
                                                  // last 2 turns + ONLY the retrieved products (catalog-only rules)
  resolved_query: string,    // the query actually used for retrieval after follow-up resolution (shown in trace)
  must_include: string|null, // when `answer` leads with "Sorry, we don't carry …" (unknown product, incl. compares such as
                             // "macbook vs novabook"): that exact first sentence. llm.user also says "Start your reply with: <it>".
                             // app.js prepends it if the model's reply contains neither "don't carry" nor "do not carry".
  facts_numbers: [string],   // product_question only (else []): numbers stated in the answer's first numeric sentence,
                             // e.g. ["₹52,000", "8GB"]; optional for app.js to verify the model's reply
  // needs_llm is also false for deterministic "nothing cheaper / nothing matches" answers ("already the most affordable
  // match", relaxed-budget "Nothing in our catalog matches … exactly", "None of our … match", "That's everything we have")
  // even when product cards are shown: the small model tends to invent products there.
  state: { turn, last_query, last_plan, last_ids: [..], last_kind }   // feed back next turn
}
```

Must handle (examples, not exhaustive):
- greetings / thanks / "who are you" / "what can you do" / help -> friendly instant reply + suggestions
- off-topic ("weather?", "write a poem", "capital of France", refrigerators, cars) -> polite redirect, mention what TechMart sells
- unknown products ("iPhone 15", "PS5") -> "we don't carry X" + closest in-catalog alternatives
- product questions by name, partial name, typos ("novabook air", "zentra vision"), attribute questions ("battery of X?", "does X have ANC?")
- recommendations with budget/use-case (video editing, gaming, students, coding, travel, gym, office, kids, gifting)
- compare: "compare A and B", "A vs B", "compare the top two" (follow-up)
- lists/browse: "show me all tablets", "what monitors do you have", "cheapest phone", "most expensive laptop", "what do you sell"
- follow-ups using `state`: "anything cheaper?", "under 50k?", "what about with more RAM?", "and for gaming?", "tell me more about it/the first one",
  "compare them", "which is lighter?", "show more" -> reuse last category/use-case/ids and apply the change
- vague ("I need something good") -> clarify question with category chips as suggestions
- Hinglish/casual phrasing, lowercase, typos, emoji, very long text, empty/whitespace -> no crash
Existing `run()` and the 5 assignment queries must keep giving the same top picks.

## 2. serve.py
- `GET /api/health` -> `{"ok": bool, "provider": "ollama", "model": "qwen2.5:3b", "warm": bool}` — answers in < 1 s, never blocks.
- `POST /api/chat` body `{ "system": str, "messages": [{"role":"user"|"assistant","content":str}, ...] }`
  -> `Content-Type: application/x-ndjson`, streamed lines: `{"delta":"text"}` ... then `{"done":true,"model":"qwen2.5:3b","ms":1234}`
  or a single `{"error":"..."}` line. Flush every chunk. Ollama `stream:true`, `keep_alive:"30m"`, temperature 0.3, num_predict 350, num_ctx 4096.
- Model is warmed up in a background thread when the server starts (so first chat is fast). Requests are serialized (one generation at a time);
  if busy, queue (don't fail). Client disconnect stops generation.
- `POST /api/llm` kept for backward compatibility (non-streaming, Ollama only). All Gemini code and .env Gemini handling removed.

## 3. app.js (UI)
- Assistant tab becomes a chat: message thread (user right, assistant left), composer pinned at the bottom (Enter to send, Shift+Enter newline),
  Send turns into Stop while generating.
- On send: user bubble appears immediately; assistant bubble shows animated typing dots immediately.
  - `needs_llm=false` -> show `answer` after ~350 ms.
  - LLM available -> stream tokens into the bubble with a caret; product cards + suggestion chips appear under it when done.
  - LLM unavailable (health not ok) -> instant `answer`, small "rule-based answer" label. If no first token within 12 s or stream error ->
    replace dots with `answer` + a small note. Never wait 60 s.
- Each assistant message: source label ("qwen2.5:3b · local" / "rule-based"), product cards, suggestion chips, collapsible "How I found this"
  (the existing pipeline trace for that message: plan, funnel, retrieved table, tokens, prompt).
- Starter screen: welcome message + the 5 assignment queries as chips (with S1/S2/S3 tags) + a few fun ones.
- Stage switcher kept (assignment), Catalog tab kept, History tab now stores whole conversations (localStorage), "New chat" button.
- `?q=&stage=` still auto-sends. Light/dark, 375px mobile, existing design language (Urbanist, glass panels, no gradients).
