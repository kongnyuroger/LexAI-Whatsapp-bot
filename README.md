# lexai-whatsapp-bot

WhatsApp bridge/orchestrator for **LexAI**, an AI-powered personal legal assistant.

This service is the most accessible entry point into LexAI for everyday users in Cameroon, many of
whom are far more comfortable with WhatsApp than with installing a new app or visiting a website.
A user sends a photo or PDF of a contract to a WhatsApp number, and the bot:

1. Downloads the media from WhatsApp.
2. Forwards it to `lexai-backend` for upload, text extraction, and analysis.
3. Sends back a plain-language summary and risk flags as a sequence of WhatsApp messages.
4. Lets the user continue the conversation by texting questions, which get forwarded to the
   backend's document chat endpoint and answered in the same WhatsApp thread.

This repo's only responsibility is to **bridge WhatsApp and `lexai-backend`** — all document
processing and AI analysis logic stays in `lexai-backend`. This bot does not reimplement OCR, risk
detection, or document analysis.

## Tech stack

- **Runtime/Framework:** Node.js (LTS) + NestJS + TypeScript
- **WhatsApp integration:** Official Meta WhatsApp Cloud API (Graph API), via direct HTTPS calls
  with axios
- **Database:** PostgreSQL — tracks only WhatsApp session/conversation state, not documents or
  analysis (that lives in `lexai-backend`)
- **ORM:** Prisma 6.x (deliberately not 7.x: the new major introduced a `prisma.config.ts`
  rewrite, mandatory driver adapters, and an ESM-by-default client that needs extra workarounds
  under NestJS's CJS build — not worth the risk for this MVP)
- **Queue:** BullMQ + Redis, so webhook handlers can acknowledge Meta within a few seconds while
  real work happens in the background
- **Validation:** class-validator / class-transformer
- **Testing:** Jest (unit) + Supertest (e2e)
- **Containerization:** Docker + docker-compose for Postgres + Redis

## Getting started

```bash
npm install
cp .env.example .env   # fill in real values, see table below
docker-compose up -d   # starts Postgres + Redis
npm run prisma:migrate # applies the Prisma schema to Postgres
npm run start:dev
```

Health check: `GET http://localhost:3000/health` → `{ "status": "ok", "timestamp": "..." }`

Note: `PrismaModule` connects to Postgres and `QueueModule` connects to Redis on app startup, so
both `DATABASE_URL` and `REDIS_URL` must be reachable even to run the e2e test suite (`npm run
test:e2e`) — `docker-compose up -d` + `npm run prisma:migrate` (or `prisma:deploy` against an
already-migrated database) first.

## WhatsApp webhook

This bot exposes `GET/POST /webhook` for the Meta WhatsApp Cloud API (Graph API `v25.0`, confirmed
current as of June 2026):

- `GET /webhook` — handles Meta's one-time webhook verification handshake. Meta sends
  `hub.mode`, `hub.verify_token`, and `hub.challenge` as query params; this endpoint echoes back
  `hub.challenge` with `200 OK` if `hub.verify_token` matches `WHATSAPP_VERIFY_TOKEN`, otherwise
  responds `403`.
- `POST /webhook` — receives real-time message notifications. The payload shape is validated
  against the documented Cloud API webhook structure (`object` / `entry[].changes[].value`), then
  each message is enqueued as an `IncomingMessageJob` (BullMQ) and the handler returns `200`
  immediately — Meta requires a fast acknowledgement or it will retry and eventually disable the
  webhook.

`WhatsappApiService` (`src/whatsapp/whatsapp-api.service.ts`) wraps the three Graph API calls this
bot needs:

- `getMediaUrl(mediaId)` — resolves a webhook media id to a short-lived (5 minute) download URL.
- `downloadMedia(mediaUrl)` — downloads the actual file bytes as a `Buffer`.
- `sendTextMessage(to, body)` — sends a free-form text message. Only deliverable within
  WhatsApp's 24-hour customer service window (i.e. within 24h of the user's last inbound
  message).
- `sendTemplateMessage(to, templateName, languageCode, components?)` — sends a pre-approved
  template message, for first contact or to re-engage outside the 24-hour window. Templates must
  already exist and be approved in the Meta Business Manager.

## Conversation state

`ConversationService` (`src/conversation/conversation.service.ts`) tracks one `WhatsappUser` and
one `Conversation` per phone number (Prisma models in `prisma/schema.prisma`):

- **WhatsappUser** — `phoneNumber` (unique), and the linked `lexai-backend` identity once
  `ensureLinkedBackendUser()` succeeds (`lexaiUserId`, `lexaiAccessToken`).
- **Conversation** — `state` (`IDLE` / `AWAITING_DOCUMENT` / `PROCESSING` / `ANALYZED` /
  `CHATTING`) and `activeDocumentId`.

Allowed state transitions (enforced by `transitionState()`; `IDLE` is reachable from every state
so a user can always type "new"/"restart" to reset — see "Onboarding, help & restart" below):

| From | Can move to |
| --- | --- |
| `IDLE` | `AWAITING_DOCUMENT`, `PROCESSING` |
| `AWAITING_DOCUMENT` | `PROCESSING`, `IDLE` |
| `PROCESSING` | `ANALYZED`, `IDLE` (on failure) |
| `ANALYZED` | `CHATTING`, `PROCESSING` (new document), `IDLE` |
| `CHATTING` | `CHATTING`, `PROCESSING` (new document), `IDLE` |

`ensureLinkedBackendUser(user)` is the single seam that calls `lexai-backend`'s
`POST /auth/whatsapp-link` endpoint — see "Backend Integration: Service-to-Service Auth" below.

## Background job queue

`POST /webhook` only validates and enqueues — `IncomingMessageProcessor`
(`src/messaging/incoming-message.processor.ts`) does the actual work off the request path, via a
BullMQ queue (`src/queue/queue.module.ts`) backed by Redis:

- Each job retries up to 5 times with exponential backoff (starting at 2s) before being left in
  the failed set (capped at the most recent 1000) — this repo's dead-letter handling, since BullMQ
  has no separate DLQ concept. Failures are logged with the job id, message id, and sender so they
  stay debuggable.
- Before routing by state, every text message is checked for a "help" or "restart" command (see
  "Onboarding, help & restart" below) — these work from (almost) any state, not just one branch
  of the switch.
- The processor then routes by `(conversation.state, message.type)`. IDLE/AWAITING_DOCUMENT +
  media runs document intake (below); ANALYZED/CHATTING + text runs document chat (below);
  ANALYZED/CHATTING + media starts a new analysis (sending a new file is treated as "analyze this
  instead", not a confirmation prompt — both states already allow transitioning to `PROCESSING`).
  IDLE/AWAITING_DOCUMENT + text sends onboarding copy; PROCESSING + anything sends a status reply.

## Document intake flow

When a user sends a photo or PDF while `IDLE`/`AWAITING_DOCUMENT`, `DocumentIntakeService`
(`src/document-intake/document-intake.service.ts`) runs:

1. Validate the mime type from the webhook payload itself (`application/pdf`, `image/jpeg`,
   `image/png`, `.docx` — see `ALLOWED_MIME_TYPES`, confirmed against lexai-backend's own upload
   validator) and reject anything else with a friendly WhatsApp reply, with no Graph API or
   backend call at all.
2. Fetch media metadata (`WhatsappApiService.getMediaMetadata`) to check the file size against
   `MAX_FILE_SIZE_BYTES` (10MB — confirmed against lexai-backend's `MAX_FILE_BYTES`, not a guess)
   and reject oversized files the same way, still before calling lexai-backend.
3. Download the file, call `ensureLinkedBackendUser()`, then `lexai-backend`'s
   `POST /documents/upload`. That endpoint extracts text **synchronously** and can return a
   `201` with `status: "FAILED"` (extraction failed) even though the HTTP call itself succeeded —
   checked explicitly, since it's not surfaced as an HTTP error.
4. Send the acknowledgement reply ("Got your document! Reading through it now...") and transition
   the conversation `-> PROCESSING` with `activeDocumentId` set.
5. Enqueue an `analyze-document` job (separate BullMQ queue) to run analysis, decoupled from the
   fast incoming-message queue since the AI call can be slow.

`AnalyzeDocumentProcessor` (`src/document-intake/analyze-document.processor.ts`) then calls
`POST /documents/:id/analyze` — confirmed **synchronous** on lexai-backend's side (it runs the AI
analysis inline and returns the full result or a definitive error in one call; there is no
"processing" status to poll for, unlike what an earlier version of this flow assumed):

- Success → transition `-> ANALYZED` and send the formatted summary + risk flags (see "Analysis
  result formatting" below).
- `403` (monthly analysis limit on the free plan) or `404`/`422` (document not found / text not
  extracted) → transition back to `IDLE` with a specific friendly message; not retried, since
  these are definitive outcomes for that document.
- Anything else (network blip, `5xx`) → rethrown so BullMQ retries per the queue's
  attempts/backoff config; if every retry is exhausted, `onFailed` resets the conversation to
  `IDLE` and notifies the user, so it never gets stuck silently in `PROCESSING`.

Any failure during the upload steps above is caught, logged with context, and reported to the
user as a generic friendly error.

## Analysis result formatting

WhatsApp has no rich UI for structured data, so `AnalysisFormatterService`
(`src/analysis-formatter/analysis-formatter.service.ts`) converts a `lexai-backend` analysis
result into a sequence of plain-text messages, sent in order once analysis succeeds:

1. **Summary** — purpose, parties, key dates, money involved, and key responsibilities.
2. **Risk flags** — grouped by severity, using emoji as the WhatsApp equivalent of the web app's
   colored risk `Badge` component (no colored UI exists here): 🔴 High, 🟠 Medium, 🟢 Low. A
   document with zero risk flags gets a reassuring "no major risks" message instead.
3. **Closing** — a nudge that the user can now ask questions, plus the standard "this is
   information, not legal advice" disclaimer.

Each message is split if it would exceed `SAFE_MESSAGE_LENGTH` (1500 characters — a practical,
readable chunk size well under the Cloud API's hard `4096` character limit for free-form session
messages, confirmed June 2026) via `splitWhatsappMessage()`
(`src/common/whatsapp-text.util.ts`), splitting on line boundaries first and falling back to
word-wrapping for any single line that alone exceeds the limit (e.g. an unusually long risk
explanation). Document chat replies (below) reuse this same shared utility.

## Document chat flow

Once a conversation is `ANALYZED` or `CHATTING`, a text message is forwarded to
`DocumentChatService` (`src/document-chat/document-chat.service.ts`):

1. If the incoming message has no text body (e.g. a sticker), ask the user to send their question
   as text — no backend call.
2. Defensively check `conversation.activeDocumentId` is set (it always should be, by this point in
   the state machine) before calling the backend at all.
3. Call `ensureLinkedBackendUser()`, then `lexai-backend`'s `POST /documents/:id/chat` with
   `{ message }`. Confirmed **synchronous** on lexai-backend's side (`lexAI-server/src/chat`): it
   runs RAG-grounded Q&A inline and returns `{ message: { role: 'assistant', content, ... } }` or
   throws `404`/`422` in one call — same shape as analyze, but with no usage-limit guard.
4. On success: transition `-> CHATTING` (a no-op transition if already `CHATTING`) and send the
   assistant's answer, split via `splitWhatsappMessage()` if it's long.
5. `404`/`422` → transition back to `IDLE` with a friendly message (the document this conversation
   was pointing at is no longer usable); anything else is rethrown so BullMQ retries per the
   incoming-message queue's attempts/backoff config.

## Onboarding, help & restart

`OnboardingService` (`src/onboarding/onboarding.service.ts`) is a pure text/parsing helper — no
I/O of its own, same split as `AnalysisFormatterService` — covering three things:

- **Onboarding** — the first (or any) plain-text message while `IDLE` gets a welcome message
  explaining what to send, and the conversation moves to `AWAITING_DOCUMENT`. A further plain-text
  message there gets a shorter reminder instead of repeating the full welcome, since the user has
  already seen it. (There's no separate "is this a brand-new user" check — the same welcome copy
  works fine for a returning user back at `IDLE`, so no extra field was added just to suppress it.)
- **Help** — typing `help`, `menu`, or `?` (exact match, case-insensitive, not a substring match —
  so "can you help me understand clause 4?" isn't misread as a command) replies with a static list
  of capabilities and supported formats, from **any** conversation state, without changing it.
- **Restart** — typing `restart`, `new`, `reset`, `cancel`, or `start over` resets the conversation
  to `IDLE` (clearing `activeDocumentId`) and confirms, from any state **except** `PROCESSING`.
  It's deliberately not honored mid-`PROCESSING`: a `document-analysis` job is already in flight
  for that conversation, and resetting the state out from under it would make
  `AnalyzeDocumentProcessor`'s own `-> ANALYZED` transition fail once the job completes (`IDLE` to
  `ANALYZED` isn't an allowed transition). The `PROCESSING` branch's existing "still working" reply
  is sent instead, explaining why nothing changed.

Both commands are checked once, before the `(state, message.type)` switch in
`IncomingMessageProcessor`, rather than being duplicated into every branch.

**Note on "error messaging":** user-facing error copy for document intake, analysis, and chat
failures was already built in Tasks 5-7 (friendly WhatsApp replies, not raw error text). What's
not yet in this repo is a global HTTP exception filter for the webhook controller itself (the
backend has one — `AllExceptionsFilter`); that's deferred to Task 9 alongside the rest of
security/observability hardening rather than bundled in here.

## Environment variables

| Variable | Description |
| --- | --- |
| `PORT` | Port this service listens on |
| `DATABASE_URL` | Postgres connection string (Prisma) |
| `REDIS_URL` | Redis connection string (BullMQ) |
| `LEXAI_BACKEND_URL` | Base URL of `lexai-backend` |
| `LEXAI_SERVICE_API_KEY` | Shared secret sent as the `X-Service-Key` header to `lexai-backend`'s `POST /auth/whatsapp-link`. Must match lexai-backend's own `SERVICE_API_KEY` env var |
| `WHATSAPP_VERIFY_TOKEN` | Shared secret used to verify the Meta webhook subscription challenge |
| `WHATSAPP_ACCESS_TOKEN` | Permanent access token for a System User on the Meta App |
| `WHATSAPP_PHONE_NUMBER_ID` | Phone Number ID from the Meta App's WhatsApp API Setup page |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | WhatsApp Business Account (WABA) ID |

## Backend Integration: Service-to-Service Auth

Task 1's initial gap analysis (written before this bot had a running `lexai-backend` to check
against) proposed a `POST /auth/whatsapp-link` endpoint, guessing at a body-based shared secret.
Once `lexai-backend` was actually running locally, inspecting it directly
(`lexAI-server/src/auth/`) showed the endpoint **already exists** — independently built with a
similar goal but a different mechanism. This section documents the real, verified contract.

### The real contract

```
POST /auth/whatsapp-link
Header:   X-Service-Key: <SERVICE_API_KEY>
Body:     { "phoneNumber": "+237...", "displayName"?: "..." }
Response: { "accessToken": "<JWT, 15min>", "refreshToken": "<JWT, 7d>", "user": { "id": "...", ... } }
```

- Guarded by `ServiceAuthGuard`: a single static shared secret (`SERVICE_API_KEY` on
  `lexai-backend`, sent here as `LEXAI_SERVICE_API_KEY`) compared in constant time. This proves
  *which service* is calling, not which end-user — endpoints behind it (like this one) take an
  explicit `phoneNumber` for who they're acting on behalf of.
- Idempotent: repeated calls for the same `phoneNumber` find-or-create the same `User` row and
  issue a fresh token pair — never a duplicate user.
- WhatsApp-linked users and email/password-registered users are deliberately **not** merged: they
  are separate `User` rows keyed by `phoneNumber` vs `email` respectively. lexai-backend's own
  README documents this as a known simplification, not an oversight.

### Token caching and refresh

`lexai-backend`'s own README spells out the exact flow it expects this bot to follow (its
"Service-to-Service / WhatsApp Integration" -> "Full flow" section): link once, cache both
tokens, reuse the access token while valid, and use `POST /auth/refresh` — not a fresh link —
once it expires. An earlier version of `ensureLinkedBackendUser()` in this repo didn't do this
(it called `whatsapp-link` fresh on every request and discarded the refresh token entirely);
that's corrected now to match:

- `WhatsappUser` caches `lexaiAccessToken`, `lexaiRefreshToken`, and `lexaiAccessTokenExpiresAt`.
- If the cached access token is still valid (with a 30s safety margin), it's reused with **no**
  HTTP call at all.
- If it's expired but a refresh token is cached, `POST /auth/refresh` (`{ refreshToken }` ->
  `{ accessToken }`, confirmed against `lexai-backend/src/auth/auth.service.ts` — the refresh
  token itself is reused as-is, not rotated) gets a new access token without re-linking.
- Falls back to `POST /auth/whatsapp-link` only if there's no refresh token yet, or the refresh
  token itself is rejected (its own 7-day lifetime expired) — re-linking is documented as
  idempotent, so this is always a safe recovery path.
- `AnalyzeDocumentProcessor` calls `ensureLinkedBackendUser()` too (not just the upload path in
  `DocumentIntakeService`), since the access token cached at upload time can expire while the
  analyze job sits queued.

### Other contract details confirmed the same way (by reading lexai-backend directly)

- `POST /documents/upload` accepts PDF, DOCX, and JPEG/PNG, max 10MB — extracts text
  **synchronously** as part of the same request. A `201` response can still carry
  `status: "FAILED"` if extraction failed; that's not surfaced as an HTTP error.
- `POST /documents/:id/analyze` is also **synchronous**: it runs the AI analysis inline and
  returns `{ summary: { purpose, mainParties[], importantDates[], moneyInvolved[],
  responsibilities[] }, riskFlags: [{ severity: 'HIGH'|'MEDIUM'|'LOW', clauseText, explanation }] }`
  directly, or throws `403` (free-plan monthly limit), `404`, or `422` (text not extracted yet).
  There is no "processing" status to poll for on the analysis itself — see "Document intake flow"
  above for how this bot's earlier (poll-based) design was corrected once this was confirmed.
- `POST /documents/:id/chat` (and `GET /documents/:id/chat` for history, not currently called by
  this bot) is synchronous too: `{ message }` in, `{ message: { role: 'assistant', content,
  ... } }` out, or `404`/`422`. No usage-limit guard applies to chat, unlike analyze.

## Project status

This is an MVP built incrementally, one numbered task per commit. See commit history for what's
implemented so far.

- [x] Task 1 — Project initialization, tooling, backend auth gap analysis
- [x] Task 2 — WhatsApp Cloud API client
- [x] Task 3 — Conversation state & user linking
- [x] Task 4 — Background job queue for webhook processing
- [x] Task 5 — Document intake flow
- [x] Task 6 — Sending analysis results as WhatsApp messages
- [x] Task 7 — Document chat via WhatsApp
- [x] Task 8 — Onboarding, help & error messaging
- [ ] Task 9 — Observability, rate limiting & security hardening
- [ ] Task 10 — Testing & CI
