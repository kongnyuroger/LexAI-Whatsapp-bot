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
- **ORM:** Prisma
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
npm run start:dev
```

Health check: `GET http://localhost:3000/health` → `{ "status": "ok", "timestamp": "..." }`

## Environment variables

| Variable | Description |
| --- | --- |
| `PORT` | Port this service listens on |
| `DATABASE_URL` | Postgres connection string (Prisma) |
| `REDIS_URL` | Redis connection string (BullMQ) |
| `LEXAI_BACKEND_URL` | Base URL of `lexai-backend` |
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
- [ ] Task 2 — WhatsApp Cloud API client
- [ ] Task 3 — Conversation state & user linking
- [ ] Task 4 — Background job queue for webhook processing
- [ ] Task 5 — Document intake flow
- [ ] Task 6 — Sending analysis results as WhatsApp messages
- [ ] Task 7 — Document chat via WhatsApp
- [ ] Task 8 — Onboarding, help & error messaging
- [ ] Task 9 — Observability, rate limiting & security hardening
- [ ] Task 10 — Testing & CI
