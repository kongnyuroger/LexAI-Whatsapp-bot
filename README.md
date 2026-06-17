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
so a user can always type "new"/"restart" — Task 8):

| From | Can move to |
| --- | --- |
| `IDLE` | `AWAITING_DOCUMENT`, `PROCESSING` |
| `AWAITING_DOCUMENT` | `PROCESSING`, `IDLE` |
| `PROCESSING` | `ANALYZED`, `IDLE` (on failure) |
| `ANALYZED` | `CHATTING`, `PROCESSING` (new document), `IDLE` |
| `CHATTING` | `CHATTING`, `PROCESSING` (new document), `IDLE` |

`ensureLinkedBackendUser(user)` is the single seam that calls the (currently unbuilt)
`lexai-backend` `POST /auth/whatsapp-link` endpoint — see "Known Integration Gap" below.

## Background job queue

`POST /webhook` only validates and enqueues — `IncomingMessageProcessor`
(`src/messaging/incoming-message.processor.ts`) does the actual work off the request path, via a
BullMQ queue (`src/queue/queue.module.ts`) backed by Redis:

- Each job retries up to 5 times with exponential backoff (starting at 2s) before being left in
  the failed set (capped at the most recent 1000) — this repo's dead-letter handling, since BullMQ
  has no separate DLQ concept. Failures are logged with the job id, message id, and sender so they
  stay debuggable.
- The processor routes by `(conversation.state, message.type)`. The IDLE/AWAITING_DOCUMENT +
  media branch now runs the real document intake flow (below); the remaining branches still send
  a placeholder reply ("Got it, processing...") with a `TODO(Task N)` pointing at the real logic
  (document chat in Task 7, onboarding copy in Task 8).

## Document intake flow

When a user sends a photo or PDF while `IDLE`/`AWAITING_DOCUMENT`, `DocumentIntakeService`
(`src/document-intake/document-intake.service.ts`) runs:

1. Validate the mime type from the webhook payload itself (`application/pdf`, `image/jpeg`,
   `image/png` — see `ALLOWED_MIME_TYPES`) and reject anything else with a friendly WhatsApp
   reply, with no Graph API or backend call at all.
2. Fetch media metadata (`WhatsappApiService.getMediaMetadata`) to check the file size against
   `MAX_FILE_SIZE_BYTES` (10MB default — adjust once lexai-backend documents its own limit) and
   reject oversized files the same way, still before calling lexai-backend.
3. Download the file, call `ensureLinkedBackendUser()`, then `lexai-backend`'s
   `POST /documents/upload`.
4. Send the acknowledgement reply ("Got your document! Reading through it now...") and transition
   the conversation `-> PROCESSING` with `activeDocumentId` set.
5. Enqueue a `document-analysis` job (separate BullMQ queue) to trigger and track analysis,
   decoupled from the fast incoming-message queue since analysis can be slow.

`AnalyzeDocumentProcessor` (`src/document-intake/analyze-document.processor.ts`) then:

- Calls `POST /documents/:id/analyze`, then self-schedules a delayed "poll" job
  (`POLL_INTERVAL_MS` = 5s) rather than blocking inside one job.
- Each poll calls `GET /documents/:id`: `ANALYZED` → transition `-> ANALYZED` and notify the user
  (Task 6 replaces the placeholder reply with the real formatted summary); `FAILED` → transition
  back to `IDLE` with a friendly error; still processing → re-enqueue another poll, up to
  `MAX_POLL_ATTEMPTS` (24 × 5s = 2 minutes) before giving up and resetting to `IDLE`.

Any failure during steps 1-5 above (including `ensureLinkedBackendUser()` rejecting because
`POST /auth/whatsapp-link` doesn't exist yet in `lexai-backend`) is caught, logged with context,
and reported to the user as a generic friendly error — the conversation stays in its current
state rather than getting stuck in a falsely-`PROCESSING` limbo.

## Environment variables

| Variable | Description |
| --- | --- |
| `PORT` | Port this service listens on |
| `DATABASE_URL` | Postgres connection string (Prisma) |
| `REDIS_URL` | Redis connection string (BullMQ) |
| `LEXAI_BACKEND_URL` | Base URL of `lexai-backend` |
| `LEXAI_WHATSAPP_LINK_SECRET` | Shared secret for the proposed `POST /auth/whatsapp-link` endpoint (not yet implemented in `lexai-backend`) |
| `WHATSAPP_VERIFY_TOKEN` | Shared secret used to verify the Meta webhook subscription challenge |
| `WHATSAPP_ACCESS_TOKEN` | Permanent access token for a System User on the Meta App |
| `WHATSAPP_PHONE_NUMBER_ID` | Phone Number ID from the Meta App's WhatsApp API Setup page |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | WhatsApp Business Account (WABA) ID |

## Known Integration Gap

**`lexai-backend` currently has no concept of a WhatsApp-linked identity or a service-to-service
API key.** Its only auth mechanism is user email/password JWT login. This bot, however, needs to
act on behalf of a user identified solely by a phone number — there is no email/password to log in
with, and no human is typing credentials into a form.

This is a real gap, not an oversight to design around silently. It is called out here explicitly
so it can be tracked as a required follow-up task in the `lexai-backend` repo.

### Proposed solution

Add a new endpoint to `lexai-backend`:

```
POST /auth/whatsapp-link
Body:     { "phoneNumber": "+237...", "secret": "<shared service secret>" }
Response: { "userId": "...", "accessToken": "<JWT>" }
```

Behavior:

- Looks up a `User` by `phoneNumber` (requires adding a unique, nullable `phoneNumber` column to
  the existing `User` model).
- Creates one if it doesn't exist yet (no password set; the row is flagged as bot-linked, e.g. via
  an `authProvider: 'whatsapp'` field).
- Returns the same JWT shape as the normal email/password login, so every existing guard,
  controller, and downstream service in `lexai-backend` keeps working unmodified.
- The endpoint itself is protected by a shared `secret` (an env var both services know), so it
  cannot be called by arbitrary clients to mint tokens for any phone number.

**Why this approach over an internal API key / "act as any user" header:** it reuses the existing
JWT auth path end-to-end instead of adding a second, parallel trust boundary into
`lexai-backend`. The only new attack surface is the linking endpoint itself, which is narrow and
easy to reason about (it can only ever mint a token for the *one* phone number in the request,
guarded by a shared secret) — versus a generic "trusted caller can impersonate any user" key,
which has a much larger blast radius if it ever leaks.

### Current state in this repo

Until that endpoint exists in `lexai-backend`, this bot cannot actually obtain a usable access
token. This is tracked as an explicit seam: `ConversationService.ensureLinkedBackendUser()`
(introduced in Task 3) is the single method that calls this endpoint, so swapping in the real
integration once it ships in `lexai-backend` requires changing only that one method.

## Project status

This is an MVP built incrementally, one numbered task per commit. See commit history for what's
implemented so far.

- [x] Task 1 — Project initialization, tooling, backend auth gap analysis
- [x] Task 2 — WhatsApp Cloud API client
- [x] Task 3 — Conversation state & user linking
- [x] Task 4 — Background job queue for webhook processing
- [x] Task 5 — Document intake flow
- [ ] Task 6 — Sending analysis results as WhatsApp messages
- [ ] Task 7 — Document chat via WhatsApp
- [ ] Task 8 — Onboarding, help & error messaging
- [ ] Task 9 — Observability, rate limiting & security hardening
- [ ] Task 10 — Testing & CI
