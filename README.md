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
- The processor routes by `(conversation.state, message.type)`. The IDLE/AWAITING_DOCUMENT +
  media branch now runs the real document intake flow (below); the remaining branches still send
  a placeholder reply ("Got it, processing...") with a `TODO(Task N)` pointing at the real logic
  (document chat in Task 7, onboarding copy in Task 8).

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

- Success → transition `-> ANALYZED` and notify the user (Task 6 replaces the placeholder reply
  with the real formatted summary).
- `403` (monthly analysis limit on the free plan) or `404`/`422` (document not found / text not
  extracted) → transition back to `IDLE` with a specific friendly message; not retried, since
  these are definitive outcomes for that document.
- Anything else (network blip, `5xx`) → rethrown so BullMQ retries per the queue's
  attempts/backoff config; if every retry is exhausted, `onFailed` resets the conversation to
  `IDLE` and notifies the user, so it never gets stuck silently in `PROCESSING`.

Any failure during the upload steps above is caught, logged with context, and reported to the
user as a generic friendly error.

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
- **Access tokens expire after 15 minutes.** Rather than tracking expiry and implementing
  refresh-token rotation, `ensureLinkedBackendUser()` calls this endpoint fresh every time a
  backend-authenticated call is about to be made, instead of caching the token on `WhatsappUser`.
  Simpler and more robust for an MVP, given linking itself is documented as cheap and idempotent.
- WhatsApp-linked users and email/password-registered users are deliberately **not** merged: they
  are separate `User` rows keyed by `phoneNumber` vs `email` respectively. lexai-backend's own
  README documents this as a known simplification, not an oversight.

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
