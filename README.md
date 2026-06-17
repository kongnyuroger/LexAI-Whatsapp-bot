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

Note: `PrismaModule` connects to Postgres on app startup, so a reachable `DATABASE_URL` is required
even to run the e2e test suite (`npm run test:e2e`) — `docker-compose up -d` + `npm run
prisma:migrate` (or `prisma:deploy` against an already-migrated database) first.

## WhatsApp webhook

This bot exposes `GET/POST /webhook` for the Meta WhatsApp Cloud API (Graph API `v25.0`, confirmed
current as of June 2026):

- `GET /webhook` — handles Meta's one-time webhook verification handshake. Meta sends
  `hub.mode`, `hub.verify_token`, and `hub.challenge` as query params; this endpoint echoes back
  `hub.challenge` with `200 OK` if `hub.verify_token` matches `WHATSAPP_VERIFY_TOKEN`, otherwise
  responds `403`.
- `POST /webhook` — receives real-time message notifications. The payload shape is validated
  against the documented Cloud API webhook structure (`object` / `entry[].changes[].value`).
  Meta requires a fast acknowledgement or it will retry and eventually disable the webhook, so
  for now this handler only validates and logs the parsed message (sender, type, content/media
  id) — background job processing is added in Task 4.

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
- [ ] Task 4 — Background job queue for webhook processing
- [ ] Task 5 — Document intake flow
- [ ] Task 6 — Sending analysis results as WhatsApp messages
- [ ] Task 7 — Document chat via WhatsApp
- [ ] Task 8 — Onboarding, help & error messaging
- [ ] Task 9 — Observability, rate limiting & security hardening
- [ ] Task 10 — Testing & CI
