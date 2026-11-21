# Campaigns — bulk / promotional sending

A **campaign** sends one message to many numbers, one at a time, on a timer. Use
it for promotions, announcements, reminders to a list — anything where you have a
column of numbers and one message to send them all.

The message can be a **template**. Upload a spreadsheet with a phone column and as
many other columns as you like, put `{column_name}` in the message, and each person
gets their own values merged in — see
[Personalise from a spreadsheet](#personalise-from-a-spreadsheet).

It is built on the ordinary send path, so nothing new touches the radio: a
campaign just calls the normal "send one SMS" once per number, spaced out, from
the SIM you choose. Every recipient therefore shows up in **Messages** with its
own sender/recipient/status, exactly like a one-off send.

---

## Read this first — keep your SIMs alive

Bulk promotional SMS from ordinary consumer SIMs is the single fastest way to get
a number **blocked by the carrier**. Their spam systems watch for one number
sending many texts to strangers quickly. Two rails protect you, and neither is
optional:

- **The per-SIM daily cap** (`SIM_DAILY_SMS_LIMIT`, ~100/day) still applies. When
  a SIM hits it, the campaign pauses rather than pushing past it.
- **A minimum pace** (`CAMPAIGN_MIN_INTERVAL_MS`, default 3s between messages).
  You can go slower, never faster.

Also: in India, promotional SMS is legally meant to go through **DLT-registered**
headers. Sending promo from personal SIMs is outside that regime. This is your
call and your risk — the gateway just gives you the rails. Keep volumes modest,
spread across SIMs, and prefer sending to people who expect to hear from you.

---

## Run a campaign from the admin panel

1. Open `http://<server>:4000/admin`, sign in, go to **Campaigns**.
2. **Name** it (for your own reference).
3. **Send from (SIM):** pick a specific connected SIM, or leave **Auto** to let
   the gateway spread the load across every connected SIM (recommended for volume
   — it keeps any one number off the carrier's radar).
4. **Country code:** the code added to bare local numbers (default `+91`). Numbers
   you paste already in `+…` form are left alone.
5. **Seconds between messages:** the pace. 10s is a sensible default. Lower is
   faster but riskier; the server enforces a floor.
6. **Message:** the text. Non-GSM characters (emoji, Hindi, curly quotes) make it
   a longer, costlier multi-part SMS — the same rules as any send. Put
   `{any_column}` in it to merge per-person values from your spreadsheet.
7. **Recipients:** upload an Excel/CSV file (recommended — it is the only way to
   use variables), or paste bare numbers, one per line (commas and spaces also
   work). Duplicates are removed and unrecognisable lines are skipped — after you
   create the campaign it tells you how many were accepted, skipped and
   de-duplicated.
8. Press **Create & start sending**.

You'll see a card with a live progress bar (green = sent, red = failed), the
counts, and controls:

- **Pause** — stop sending; resume later from where it left off.
- **Resume** — continue a paused campaign.
- **Cancel** — stop for good; unsent numbers are abandoned.
- **View numbers** — the per-recipient status list.

**If no phone is connected when you start,** the campaign pauses with "No gateway
phone is connected" — and **resumes by itself** once a phone comes back online
(the app showing **Online** on the Phones tab). Same when every SIM hits its daily
cap: it pauses, then restarts on its own at local midnight when the counters reset.

You do not have to press Resume for either. The runner re-checks a system-paused
campaign every 30 seconds and restarts it the moment a send would actually succeed,
so a long list keeps grinding through overnight outages and daily caps unattended.
The card shows **⏳ … It restarts on its own — no action needed** while it waits.

A campaign **you** paused is different: it stays paused until you press Resume,
however healthy the fleet gets. Only the runner's own pauses auto-resume.

**Partial outages never pause anything.** The router picks a SIM per message from
whatever is connected at that instant, so if 5 of 8 phones drop, the campaign keeps
running on the remaining 6 SIMs at reduced throughput and silently speeds back up
when they return — the returning SIMs have the most unused quota, so they get
picked first.

Because progress lives in the database, a campaign survives a server restart: it
picks up exactly where it stopped, re-sending nothing and skipping nothing.

---

## Personalise from a spreadsheet

One message, different values per person: "Hi Asha, your rent of Rs 12,000 is due
on 5 Sep." You choose how many variables to use — there is no fixed set, and no
fixed count (up to 20). Whatever columns you map become the variables the message
can use.

### 1. The spreadsheet

One row per person. One column holds the phone number; every other column is a
value you might want to merge. Headers are what the variables get named:

| Name | Mobile | Rent Amount | Due Date |
| --- | --- | --- | --- |
| Asha | 9876543210 | Rs 12,000 | 5 Sep |
| Bala | 9123456780 | Rs 9,500 | 7 Sep |

`.xlsx` or `.csv`. Column order does not matter, and a header row is optional (a
sheet without one gets `Column A`, `Column B`, … which you can rename).

### 2. Upload and map

Drop the file on **Upload Excel or CSV**. The panel reads every column, shows you a
sample value from each, and guesses which one holds the phone numbers. For each
column you then say what it is:

- **Phone number** — the numbers to send to. Exactly one column.
- **Variable** — usable in the message, under the name in the box next to it.
  "Rent Amount" becomes `rent_amount`; rename it to anything you prefer.
- **Ignore** — not sent anywhere.

### 3. Write the message

Put the variable in braces. Click a variable chip above the message box to insert
it at the cursor:

```
Hi {name}, your rent of {rent_amount} is due on {due_date}. — Pondy Properties
```

Names are matched loosely: `{Rent Amount}`, `{rent_amount}` and `{RENT-AMOUNT}` all
mean the same column. The preview under the message shows the real merged text for
a real row from your file, with **Next row** to page through — check a few before
you send.

### The rules that keep a bad merge off the network

- **`{name}` is special.** A blank name becomes "there" ("Hi there, …"), and names
  longer than 8 characters are shortened, so the message length stays predictable.
- **Every other variable is strict.** A row with an empty cell for a variable the
  message uses is **failed and reported**, not sent — nobody receives "your rent of
  {rent_amount} is due". The panel warns you how many rows that affects *before*
  you start, and the failed rows show the reason in **View numbers**.
- **A variable no column supplies is refused at creation**, with the offending
  `{placeholder}` named. That catches a typo before it reaches 5,000 people.
- **Braces are reserved.** Because `{…}` means "variable", you cannot send a
  literal `{Rs 500}` in the text — that reads as a variable and is refused.
- Values are capped at 120 characters (8 for `{name}`), and the part count shown on
  the campaign card is for the **longest** message the merge can produce.
- Pasted numbers carry no variables, so use the paste box only with a message that
  has none (or only `{name}`, which falls back).

### From the API

Upload is a separate call, so you can review before anything queues:

```bash
curl -X POST http://<server>:4000/api/campaigns/parse-recipients \
  -H "X-Api-Key: sk_YOUR_KEY" \
  -F "file=@rent.xlsx"
```

It returns the sheet as a table — `columns` (each with `index`, `header`, `key`,
`role`, `sample`), `rows`, `phoneColumn`, and how many rows were `skipped` for
having no number. Nothing is stored; it is only a read.

Then create the campaign with `recipientRows`, each row a number plus its variable
values. You can build these yourself — the upload call is a convenience, not a
requirement:

```bash
curl -X POST http://<server>:4000/api/campaigns \
  -H "X-Api-Key: sk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "Rent reminder — September",
        "body": "Hi {name}, your rent of {rent_amount} is due on {due_date}.",
        "countryCode": "+91",
        "intervalSeconds": 10,
        "recipientRows": [
          { "phone": "9876543210", "vars": { "name": "Asha", "rent_amount": "Rs 12,000", "due_date": "5 Sep" } },
          { "phone": "9123456780", "vars": { "name": "Bala", "rent_amount": "Rs 9,500", "due_date": "7 Sep" } }
        ],
        "start": true
      }'
```

`meta` on the response adds `variables` (what the body merges) and `incomplete`
(how many rows are missing a value and will be failed rather than sent).

> The whole list travels in one JSON body, and the server caps request bodies at
> `BODY_LIMIT` (1 MB by default). A few thousand rows with a few short columns fits;
> if you send more, raise `BODY_LIMIT` in `backend/.env` or split the list.

---

## Run a campaign from the API

Everything the panel does is also an API, if you'd rather trigger campaigns from
your own app. Authenticate with an API key that has the `sms:send` scope (and
`sms:read` to read progress) — the same keys as the send API.

**Create and start**

```bash
curl -X POST http://<server>:4000/api/campaigns \
  -H "X-Api-Key: sk_YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "Diwali offer",
        "body": "Flat 20% off this week! Reply STOP to opt out.",
        "from": "+919000000001",
        "countryCode": "+91",
        "intervalSeconds": 10,
        "recipients": "9876543210\n9123456780\n+919000000001",
        "start": true
      }'
```

`recipients` is one blob of text — newline-, comma- or space-separated. `from` is
optional (omit for auto-balancing). `start` defaults to `true`.

**Response — `202 Accepted`.** `data` is the campaign (with its normalised
recipient list); `meta` summarises the parse:

```json
{
  "success": true,
  "data": { "id": "…", "status": "RUNNING", "total": 3, "intervalSeconds": 10, "…": "…" },
  "meta": { "accepted": 3, "invalid": [], "invalidCount": 0, "duplicates": 0, "variables": [], "incomplete": 0 }
}
```

**Other endpoints**

| Method & path | Does |
| --- | --- |
| `POST /api/campaigns/parse-recipients` | Read an uploaded `.xlsx`/`.csv` into columns + rows. Creates nothing. |
| `GET /api/campaigns` | List your campaigns (newest first, paginated). |
| `GET /api/campaigns/{id}` | One campaign, including every recipient's status. |
| `POST /api/campaigns/{id}/pause` | Pause a running campaign. |
| `POST /api/campaigns/{id}/start` | Start a draft, or resume a paused one. |
| `POST /api/campaigns/{id}/cancel` | Abandon it; unsent numbers stop. |

**Campaign statuses:** `DRAFT` → `RUNNING` ⇄ `PAUSED` → `COMPLETED`, or
`CANCELLED`. A `PAUSED` campaign carries a `pausedReason` telling you why (you
paused it, no phone, or every SIM capped) and a `pausedBy` of `SYSTEM` or
`OPERATOR`. `SYSTEM` means the runner parked it on a blocker that clears with
time, and it will resume without you; `OPERATOR` means a person stopped it and
only a person can start it again.

---

## Configuration

Set in `backend/.env` (all optional — sensible defaults shown):

| Variable | Default | Meaning |
| --- | --- | --- |
| `CAMPAIGN_DEFAULT_INTERVAL_MS` | `10000` | Pace used when a campaign doesn't set its own. |
| `CAMPAIGN_MIN_INTERVAL_MS` | `3000` | The floor — no campaign may send faster. Safety rail. |
| `CAMPAIGN_MAX_RECIPIENTS` | `5000` | Most numbers one campaign may target. |
| `CAMPAIGN_DEFAULT_COUNTRY_CODE` | `+91` | Code added to bare local numbers when the form doesn't override it. |
| `SIM_DAILY_SMS_LIMIT` | `100` | SMS parts one SIM sends per day before the gateway refuses. |
