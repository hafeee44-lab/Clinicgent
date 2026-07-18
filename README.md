# Dental Clinic WhatsApp Automation Agent

Automates the repetitive front-desk work of a small dental clinic over WhatsApp: booking, reminders, rescheduling/cancellation, FAQs, post-procedure check-ins, 6-month recalls, no-show follow-ups and review requests — with strict medical-safety guardrails and instant human escalation for anything urgent.

## 1. Architecture overview

```
Patient WhatsApp ──▶ Meta Cloud API / Twilio ──▶ POST /webhook/{meta|twilio}
                                                        │
                                                  src/pipeline.js
                                                        │
       ┌──────────── staff command? (#takeover/#release/#done) ── handled, done
       │
       ├─ save message → human-mode gate (staff took over? → bot silent)
       │
       ├─ deterministic EMERGENCY pre-filter (EN/Urdu/Roman Urdu regex)
       │     └─ match → flag + instant WhatsApp alert to dentist/front desk
       │
       └─ agent loop (Claude tool-calling) ──▶ tools ──▶ SQLite
              check_availability · book/reschedule/cancel/confirm_appointment
              find_my_appointments · get_faq_answer · flag_emergency
              request_human_handoff · log_followup_response
                                                        │
                                    reply ──▶ WhatsApp provider ──▶ patient

node-cron scheduler (src/scheduler/scheduler.js)
  every 5 min : 24h + 2h reminders, unanswered-reminder flags, no-show detection
  daily 10:00 : post-procedure check-ins, review requests
  daily 11:00 : 6-month recall messages

Express admin API (token-protected): flags, appointments, complete visit, bot/human mode
config/clinic.json : everything staff-editable (FAQ, prices, hours, templates, contacts)
SQLite (node:sqlite, built into Node — no native deps) : patients, appointments, conversations, messages, flags
```

Everything runs in one Node process. Data stays in a local SQLite file; the only external calls are the WhatsApp provider and the Claude API.

## 2. Data model

`patients` — id, phone (unique, E.164), name, language, last_checkup_at (drives recall), recall_sent_at, notes.

`appointments` — id, patient_id, start_ts/end_ts (local ISO), reason (patient's words), procedure_type (set by staff at completion, drives follow-ups), status (`booked → confirmed → completed` | `cancelled` | `no_show`), plus idempotency stamps: reminder_24h_sent_at, reminder_2h_sent_at, reminder_flagged_at, followup_sent_at, noshow_msg_sent_at, review_req_sent_at.

`conversations` — one per phone; `mode` = `bot` or `human` (human = staff took over, bot stays silent).

`messages` — full chat history per conversation (in/out), also the agent's memory.

`flags` — actionable items for staff: `emergency`, `followup_concern`, `no_reminder_response`, `handoff`, `no_show`; status open/resolved.

The `*_sent_at` stamps make every scheduler job idempotent — restarts or overlapping runs never double-message a patient.

## 3. Agent tools (Claude tool-calling)

Defined in `src/agent/tools.js` with full JSON schemas. The model can only act through these:

`check_availability(from_date?, days?, time_of_day?)` — open slots from clinic hours minus active bookings; if the requested window is full, returns nearest alternatives so the agent never answers a flat "no slots".
`book_appointment(patient_name, slot_start, reason)` — books for the current phone number; rejects taken slots and >2 upcoming appointments (duplicate-booking guard).
`find_my_appointments()` — the patient's active bookings (for reschedule/cancel/confirm flows).
`reschedule_appointment(appointment_id, new_slot_start)` — moves booking, frees old slot, resets reminders.
`cancel_appointment(appointment_id)` / `confirm_appointment(appointment_id)`.
`get_faq_answer(topic)` — approved answers/pricing from clinic.json only; unknown topic returns "no approved answer" so nothing is invented.
`flag_emergency(summary)` — flag + immediate WhatsApp alert to emergency contacts + staff.
`request_human_handoff(reason)` — flips the thread to human mode (bot goes silent), alerts staff.
`log_followup_response(status, notes)` — logs post-procedure replies; `concern` alerts staff instantly.

Safety is layered: system-prompt rules (no diagnosis/treatment/medication advice ever, prices only as "starting from" ranges), plus a deterministic regex emergency pre-filter (`src/agent/emergency.js`) that alerts staff even if the model misjudges, plus tool-side guardrail instructions in every sensitive tool result.

## 4. Setup

Requires Node.js >= 22.13 (uses built-in `node:sqlite` — no compilers, no native modules).

```bash
npm install
cp .env.example .env      # fill in ANTHROPIC_API_KEY; leave WA_PROVIDER=mock for now
npm test                  # 38 deterministic tests, no API key needed
npm run seed              # fake clinic data
npm run scheduler:once    # watch reminders/follow-ups/recalls print to console
npm run simulate          # chat with the agent as a patient (needs ANTHROPIC_API_KEY)
npm start                 # webhook server + cron scheduler
```

`npm run simulate -- +923001234567` simulates from a staff number (from clinic.json), so you can also test staff commands.

### Choosing the LLM (free option for testing)

The agent's brain is switchable via `LLM_PROVIDER` in `.env`. `anthropic` (default) uses the Claude API — recommended for production because of quality on the safety-critical judgment calls and its no-training-on-API-data default. `gemini` uses Google's free tier — get a key at [aistudio.google.com](https://aistudio.google.com) (no card required), set `LLM_PROVIDER=gemini` and `GEMINI_API_KEY=...` (model defaults to `gemini-3.5-flash`). `groq` works the same with `GROQ_API_KEY`. `openai_compat` points at any OpenAI-compatible endpoint via `LLM_BASE_URL`.

Free-tier caveats: rate limits (Gemini free ≈ 15 requests/min — fine for one clinic), and free tiers may use your data for training — fine with the fake seed data, but do not run real patient conversations on a free tier. The deterministic emergency filter and all guardrail prompts apply regardless of provider, but smaller models are weaker at judgment calls — retest the guardrails in the simulator when switching.

### Connecting real WhatsApp

Meta Cloud API (recommended, free tier is generous): create a Meta Business app → WhatsApp → get a phone number ID + permanent token → set `WA_PROVIDER=meta`, `META_WA_TOKEN`, `META_WA_PHONE_NUMBER_ID`, `META_WA_VERIFY_TOKEN` → in the Meta dashboard set the webhook URL to `https://your-domain/webhook/meta` with your verify token and subscribe to `messages`.

Twilio: set `WA_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WA_FROM=whatsapp:+1...` and point the Twilio WhatsApp webhook at `https://your-domain/webhook/twilio`.

Note: outside a 24-hour customer-service window, WhatsApp requires pre-approved template messages for business-initiated sends (reminders, recalls). Register your reminder/recall templates with Meta/Twilio and they will map 1:1 onto the templates in `clinic.json`.

### Deploying on a small VPS

```bash
# Ubuntu 22.04+, as a non-root user
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
git clone <your-repo> && cd dental-clinic-agent && npm install
cp .env.example .env && nano .env
sudo npm i -g pm2
pm2 start src/index.js --name clinic-agent && pm2 save && pm2 startup
# HTTPS (required by both WhatsApp providers): put Caddy or nginx+certbot in front
sudo apt install -y caddy
# /etc/caddy/Caddyfile:  clinic.yourdomain.com { reverse_proxy localhost:3000 }
```

Back up `data/clinic.db` nightly (`sqlite3 data/clinic.db ".backup backup-$(date +%F).db"` in cron). For local development without a public URL, use `ngrok http 3000` and point the webhook at the ngrok URL.

## 5. Clinic-facing configuration

Everything staff may need to change lives in `config/clinic.json`: clinic name/address/phone, opening hours, slot length, dentists, FAQ answers, pricing ranges, care instructions, all patient-facing message templates, staff and emergency WhatsApp numbers, recall interval. The file hot-reloads — edits apply without restarting. No code knowledge needed; just keep the quotes.

## 6. Daily staff workflow

From their own WhatsApp (numbers listed in `staff_whatsapp_numbers`):

`#takeover +9230xxxxxxxxx` — bot goes silent on that patient's thread (staff replies personally). The bot also does this itself via `request_human_handoff`.
`#release +9230xxxxxxxxx` — bot resumes.
`#done <appointment_id> [procedure]` — mark a visit completed, e.g. `#done 42 extraction`. This is what triggers next-day check-ins, the recall clock (for cleanings/checkups), and review requests.

Staff receive WhatsApp alerts for: emergencies, post-procedure concerns, handoffs, unanswered 24h reminders, and bot errors. Open items are also listed at `GET /admin/flags` (header `X-Admin-Token`).

## 7. Edge cases handled

Urdu / Roman Urdu / mixed messages: system prompt mirrors the patient's language; the emergency filter matches English, Urdu script and Roman Urdu keywords. Phone formats: `0300...`, `92300...`, `whatsapp:+92300...` all normalize to E.164. Race on a slot: booking re-checks atomically; if taken, the agent re-offers. Duplicate bookings: same slot blocked, max 2 upcoming per patient (agent offers rescheduling instead). Ambiguous reschedules: agent lists the patient's appointments and asks which. Reminder replies "1"/"2" handled via confirm/reschedule flows; no reply within 3h of the 24h reminder → front-desk flag (never silent). Rescheduled appointments get fresh reminders. Review requests wait a day after a post-procedure check-in and are skipped entirely if the patient has an open concern flag. Recalls skip patients who already have an upcoming booking and won't repeat within 60 days. Agent/API failure mid-conversation: patient gets a graceful message and staff are alerted — no dead air. Non-text messages (voice notes, images) are ignored by the bot rather than mis-answered (staff see them on the clinic phone). Tool-loop runaway is capped and fails over to human handoff.

## 8. Assumptions made (flagging per the brief)

Single clinic, single shared calendar (1–3 dentists working one chair-schedule; per-dentist calendars are a small schema addition if needed). 30-minute uniform slots. Timezone Asia/Karachi. Visit completion is confirmed by staff (`#done`) because only staff know the visit actually happened and what procedure was done — this is the one deliberate human touchpoint the automation depends on. Claude model default `claude-sonnet-4-5` (good quality/cost for this volume; change via `CLAUDE_MODEL`). Node's built-in SQLite instead of better-sqlite3 to avoid native build issues on cheap VPSes. WhatsApp text only in v1.

## 9. Privacy & security

Patient data lives only in the local SQLite file — restrict with filesystem permissions (`chmod 600 data/clinic.db`) and OS user isolation; nothing is sent anywhere except the WhatsApp provider (message delivery) and the Claude API (conversation text needed to respond). No third-party analytics or storage. Admin endpoints require a token; webhooks validate Meta's verify token. Set `DRY_RUN=1` to test in production config without messaging real patients.
