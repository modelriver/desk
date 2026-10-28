# Desk

**Open-source AI support that hands off to your team. Your help articles become a help center and AI answers, and the AI never touches your database. Built on [ModelRiver](https://modelriver.com).**

A small, self-hostable support app:

- **Chat widget.** Visitors ask questions and AI answers stream in token by token over websockets. Answers link to the help-center articles they draw on.
- **Help center.** Public Markdown articles rendered as pages.
- **Integrations.** Optional, read-only connectors for **Shopify**, **Stripe**, **Cal.com** and your own API (**Custom HTTP**). Once a visitor proves their email, the AI can answer "where's my order?", "when does my plan renew?" or "when is my appointment?" from their own records. See [Integrations](#integrations).
- **Team dashboard.** Sign in, read every conversation, take over from the AI and reply as a human, manage users (admin/agent) and upload data files. Admins also get a **Settings** page showing whether the AI is connected, how much of the AI budget is used, who hasn't set up two-factor, whether the proxy settings look right, and where each setting comes from.

It is a reference app for ModelRiver, not a full CRM. ModelRiver does the heavy lifting (model gateway, retries and fallbacks, streaming, conversation sessions), so this repo stays small.

## Quick start

You need Node.js 26.12.1+ and a ModelRiver API key.

```bash
git clone https://github.com/modelriver/desk.git
cd desk
nvm use            # reads .nvmrc (26.12.1)
npm ci
cp .env.example .env   # then set MODELRIVER_API_KEY
npm run create-admin
```

Before the first run, in the ModelRiver console, import [`examples/support_assistant.workflow.json`](examples/support_assistant.workflow.json) with **Import workflows**, and make sure it's published Live. It is a chat workflow named `support_assistant` with **Sessions** on and the prompt from [`examples/workflow-system-prompt.md`](examples/workflow-system-prompt.md). It answers with Anthropic `claude-haiku-5-5` and falls back to OpenAI `gpt-6-luna`, so the assistant keeps answering if one provider is down. Change either model to one your project has a key for. To use a different name, set `MODELRIVER_WORKFLOW`.

Then start it:

```bash
npm run dev
```

Open http://localhost:3000 for the help center and chat widget, and http://localhost:3000/dashboard for the team side. The public pages don't link to the dashboard, so share that address with your team. Your first sign-in walks you through setting up two-factor authentication with an authenticator app.

The sample data in [`examples/data`](examples/data) works out of the box. Point `DATA_DIR` at your own folder when you're ready.

Production:

```bash
npm ci && npm run build && NODE_ENV=production npm start
```

The build always runs in production mode, whatever `NODE_ENV` says: cookies are `Secure`, and the visitor cookie is `SameSite=None; Partitioned`. Serve it over HTTPS, or open it on `localhost`, which browsers treat as secure.

## Data folder

`DATA_DIR` has two subfolders:

| Folder | File types | Shown in help center | Used by the AI | Cited with a link |
| --- | --- | --- | --- | --- |
| `public/` | `.md` | Yes | Yes | Yes |
| `private/` | `.md`, `.txt` | Never | Yes | Never |

- **Folders are sections.** A folder in `public/` is a help-center section and a folder inside it a subsection (two levels at most). Folder names are the URL: `public/billing/invoices/refunds.md` is `/help/billing/invoices/refunds`, and `/help/billing` is the Billing section's own page. Each folder can hold a small `.desk.json` with its display title and the order of what's in it; the Data page writes it for you:

  ```json
  { "title": "Billing", "order": ["plans.md", "invoices", "refunds.md"] }
  ```

  Items not listed come after the listed ones, folders first, then by name.
- **Articles** are Markdown with optional front matter:

  ```markdown
  ---
  title: Billing and plans
  description: What each plan includes and how to cancel.
  ---
  ```

  Add `status: draft` to keep an article (or a Markdown note) as a **draft**: it stays out of the help center, its search, the sitemap and everything sent to the AI until it's published. `draft: true` works too. Plain-text (`.txt`) notes have no front matter, so they can't be drafts.

  Without a `title`, the first `# Heading` is used, then the file name. A file's name is its id: it must be unique across `public/` (the Data page checks), it's what the AI cites, and it keeps old links working. If an article moves to another folder, or a folder is renamed, its old URL redirects (301) to the new one, and so does a plain `/help/<file-name>`. Files at the top level of `public/` can still use the older `category:` and `order:` front matter.
- **Private files** are internal notes, playbooks and known issues. The AI may use them to shape an answer, but it is told never to quote, cite or mention them, and the app never links to them. Help-center URLs resolve only through the public article index, so a private file can't be reached by URL.
- **Dashboard → Data** (admins) shows both folders as trees:
  - **Write** articles and notes in the editor, which shows them as they'll look on the help center. Markdown shortcuts format as you type (`## ` for a heading, `- ` for a list, `> ` for a quote, `**bold**`). Selecting text shows a formatting bar (⌘K adds a link), and the + beside an empty line adds headings, lists, code, dividers, tables and images (linked by URL, not uploaded). Switch to **Markdown** to edit the source. An article the visual editor can't show exactly, such as one with task lists, opens as Markdown, so nothing is changed by opening it.
  - **Drafts and publishing.** **Save draft** saves without publishing; **Publish** puts the article on the help center and in the AI's answers (for a private note, the AI's answers only). **Unpublish** moves a published article back to draft, with any changes in the editor saved too. Publish and Unpublish ask you to confirm first, since they change what visitors and the AI see. ⌘S saves without changing which it is: a new article becomes a draft, and for a published article it asks before publishing your changes. Drafts show a **Draft** badge, and each Markdown file's menu has **Publish** or **Unpublish**, so you can change it without opening it. A draft keeps its address reserved, and moving it keeps it a draft.
  - **Unsaved changes** are kept in the browser, and offered back when you open the article again. If someone else saved the article meanwhile, you choose whose version to keep.
  - **Arrange** to reorder things or move them between folders, by dragging or from each item's menu. Nothing changes on the help center until you press **Save changes**; Undo (⌘Z) steps back one move and Cancel drops them all. Outside Arrange, nothing can be dragged by accident.
  - **Upload** files with the buttons, or drop them from your computer onto a folder (max 1 MB each; names are normalised to `lowercase-with-dashes.md`). Create, rename and delete folders from the same page.

- **Git:** keep your real data folder out of the public repo. `data/` is already in `.gitignore`.

## The help center

- **Search.** `/help` has a search box over published public articles only; a private note or a draft can never appear in results. Results show the matching section and a short extract with the words highlighted, and link straight to that section. The query is in the URL (`/help?q=export`), so results can be shared. No match offers to ask the assistant instead.
- **Sections.** Articles are grouped by folder, in the order set on the Data page (see [Data folder](#data-folder)). Each section and subsection has its own page, such as `/help/billing`.
- **Reading.** Every heading has a link (`/help/billing/billing-and-plans#invoices`). Articles with three or more sections get an "On this page" list: a sidebar that follows your reading on wide screens, a collapsible list on phones. Each article shows its section, when it was last updated, and up to three related articles: the rest of its section first, then similar ones.
- **Feedback.** Each article ends with "Was this article helpful?". One vote per browser per article, which can be changed; votes are tied to a random browser id, not a person.
- **Insights** (dashboard, for the whole team) shows what to write next:
  - **Questions the help center couldn't answer** from the last 30 days, most asked first, grouped when they only differ in wording order. A question counts when nothing in the articles or notes matched it, when the AI said it wasn't sure (it ends such replies with a hidden `[[unsure]]` marker), or when the AI failed. Mark one handled once you've written the article. Questions are kept locally for 90 days, then deleted by the hourly cleanup.
  - **Article ratings**, least helpful first.
- **Search engines.** `/sitemap.xml` lists the home page, the help center and every published article with its last-modified date; `/robots.txt` points to it and keeps the dashboard, sign-in and chat out. Article pages carry a description, Open Graph tags and, when `APP_URL` is set, a canonical URL. Search results, the dashboard, sign-in and `/widget` are marked `noindex`.

## How it works

```
Browser ──(server functions)──▶ This app ──(API key)──▶ ModelRiver ──▶ LLM provider
   ▲                                │                       │
   └────── websocket: streamed tokens ──────────────────────┘
```

1. A visitor asks a question. The server does a quick keyword (BM25) search over the data folder and picks the best excerpts.
2. It calls ModelRiver's `POST /v1/ai/async` with `stream: true`, the visitor's ModelRiver `session_id`, and two messages: a system message with the excerpts and citation rules, then the visitor's question.
3. ModelRiver returns a one-time websocket token. The browser joins with [`@modelriver/client`](https://www.npmjs.com/package/@modelriver/client) and renders `stream_delta` events as they arrive.
4. ModelRiver keeps the conversation history in the session. Only the visitor's question and the answer go into session memory, not the excerpts.
5. When a team member takes over, their replies and the visitor's next messages go to the session through `POST /v1/sessions/:id/messages`, and the AI stays quiet until someone hands back.
6. Everything is live. The open widget and the open dashboard transcript each follow the conversation over ModelRiver's session channel (`POST /v1/sessions/:id/subscribe`, then `subscribeToSession` from `@modelriver/client`). New messages arrive as they're stored, and Desk's own changes (a teammate taking over, handing back, archiving, the visitor leaving) go out as a signal (`POST /v1/sessions/:id/signals`), so a reply shows up within a second instead of on the next poll. Each view reloads the conversation when it (re)connects, keeps a once-a-minute safety refresh, and polls as before if it can't connect.

### Talking to a person

Visitors can ask for a person at any point, and the chat switches from the AI to the team:

- **How it's spotted.** Clear requests ("can I talk to a person?", "connect me with support", "human please") are caught on the server before the AI is called (`src/lib/handoff.ts`). For anything phrased differently, or a "yes" to the AI's offer to connect them, the AI is told to end its reply with a hidden `[[handoff]]` marker, and the widget hands off when it sees it. Visitors can also choose **Talk to a person** in the chat's **⋯** menu.
- **What the visitor sees.** A "Connecting you with our team" card above the message box, with how long they've been waiting and a **Go back to the AI assistant** button. They can keep typing; their messages go to the team, not the AI. Once someone replies, the card goes away and the chat stays with the team: only a team member can hand it back to the AI (**Hand back to AI** in the dashboard).
- **What the team sees.** Waiting conversations are pinned to the top of **Conversations**, longest wait first, with a **Wants a person** (or **AI couldn't answer**) badge, and the sidebar shows how many people are waiting on every dashboard page. The first reply from a team member clears the flag. So does the visitor going back to the AI before anyone has replied, a team member choosing **Hand back to AI**, or the visitor ending the chat.

The request shows up in the dashboard straight away. [Email notifications](#email-notifications) can tell the team too; Slack and webhook notifications are on the [roadmap](#roadmap).

**When the AI can't answer**, the chat goes to the team instead of showing an error. That covers ModelRiver refusing the request, the model failing or timing out mid-answer, a lost connection, and the site-wide AI budget being used up. The visitor sees "Our assistant couldn't answer that one, so we've passed your question to the team", and the dashboard marks the conversation **AI couldn't answer**. The question is in the session for the team to read: ModelRiver records the failed turn, and when the request never reached the model, the app adds the question itself. The one exception is a visitor's very first message: with no session yet, there's nowhere to put it for the team, so they're asked to try again.

**One person per conversation.** **Take over**, or a reply, makes you the one handling the conversation. Your name shows on its row in **Conversations** and on the transcript, as **You** for yourself. Colleagues see who has it, and their reply box is replaced by **Take over from Sam**, so two people never answer the same visitor. **Hand back to AI**, or the visitor going back to the AI, frees the conversation. Removing a team member frees theirs too.

### Email notifications

Each team member chooses their own emails under **Account settings** (in the menu with their name):

- **Someone wants a person**, on by default: a visitor asked for the team, or the AI couldn't answer and passed the chat on. Sent once per wait, not for each message.
- **Every new conversation**, off by default: once when a conversation starts, with the visitor's first question.

To keep inboxes calm, updates that arrive within about 15 seconds come as one email, and each person gets at most 20 an hour. Emails include the visitor's message (up to 280 characters), so it passes through your email provider.

Turn email on with environment variables. Every provider is a plain HTTPS call (no SDK), behind one small interface in [`src/server/email.server.ts`](src/server/email.server.ts), so adding another means writing one function:

| `EMAIL_PROVIDER` | Also set |
| --- | --- |
| `resend` | `RESEND_API_KEY` |
| `postmark` | `POSTMARK_SERVER_TOKEN` |
| `ses` | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (and `AWS_SESSION_TOKEN` for temporary credentials). Requests are signed with AWS Signature Version 4 in [`src/server/aws-sigv4.server.ts`](src/server/aws-sigv4.server.ts) |
| `log` | Nothing: emails are printed to the server log, for development |

All of them need `EMAIL_FROM` (a sender on a domain your provider has verified), and `APP_URL` (the address people use to open this app) so emails can link to the conversation. Admins can check the setup and **Send a test email** under **Settings**.

### Archiving

The **×** at the end of each row in **Conversations** closes the conversation and moves it to **Archived**. The transcript page has an **Archive** button that does the same.

- **The visitor's side.** If the visitor still has the chat open, it ends for them and they see "Our team closed this conversation", with a button to start a new one. The dashboard asks first before closing a conversation that's still open.
- **Undo and restore.** Choose **Undo** right after archiving, or **Restore** in **Archived**. Either one puts it back in the list, still ended, since the visitor's chat can't be reopened.
- **Deleted after a day.** Archived conversations are deleted for good `ARCHIVE_RETENTION_HOURS` after they were archived (default 24). That removes the ModelRiver session with its whole history (`DELETE /v1/sessions/:id`) and the local record. `npm start` runs this cleanup every hour. In development, or from cron, run `npm run cleanup-archived`. Set `ARCHIVE_RETENTION_HOURS=0` to keep archived conversations until someone restores them.
- **What can be archived.** Anything in the list can be archived, including sessions started through the API. The dashboard only opens, archives or deletes sessions of your `MODELRIVER_WORKFLOW`, even if your API key can reach other workflows in the project.

## Integrations

Connectors let the assistant answer from a visitor's **own** records: orders, subscriptions and invoices, bookings. They're read-only, off by default, and only used after the visitor has proved their email address. Admins set them up under **Dashboard → Integrations**.

| Connector | What the assistant can see | Key to create |
| --- | --- | --- |
| **Shopify** | The visitor's last 5 orders: number, date, payment and fulfillment status, total, items, shipping status and tracking links, and the order status page | A custom app's Admin API access token with **only** `read_orders` (add `read_all_orders` to see orders older than 60 days) |
| **Stripe** | Subscriptions (plan, price, renewal or end date, trial end) and the last 3 invoices with their hosted links | A **restricted key** (`rk_…`) with **Read** on Customers, Subscriptions, Invoices and Products, and nothing else |
| **Cal.com** | Upcoming bookings (title, time, status) with reschedule and cancel links | An API key (cal.com or self-hosted) |
| **Custom HTTP** | Up to 20 facts your own API returns | Your endpoint URL and a signing secret you choose |

Addresses, phone numbers, card details and other customers' data are never read into the conversation: each connector keeps a fixed, short list of fields and drops everything else. The assistant can't change anything. Refunds, cancellations and changes are answered with a link from the data (an invoice, a reschedule page) or by offering the team.

### What you need first

1. **A way for visitors to prove their email**, at least one of:
   - **Email codes.** Set up [email](#email-notifications). The chat shows a **Verify your email** card when a question needs the visitor's account, and sends a 6-digit code.
   - **Identity tokens.** For visitors already signed in on your site. Set `DESK_IDENTITY_SECRET` (`openssl rand -base64 32`) and pass a signed token to the widget (below).
2. **`DESK_SECRET_KEY`**, to save keys on the Integrations page: 32 random bytes, base64 (`openssl rand -base64 32`). Keys are encrypted with it (AES-256-GCM) in SQLite. Keep it with your other server secrets: if it changes, saved keys must be entered again. Without it, set keys in the environment instead (each field shows its variable, e.g. `STRIPE_RESTRICTED_KEY`). A value in the environment always wins over the dashboard.

### How a lookup happens

1. A visitor asks something that matches a connector's topic ("where is my **order**", "my **invoice**", "**reschedule**"). Follow-up questions in the same chat keep using that connector.
2. If they haven't verified, nothing is looked up. The assistant says it can check once they verify, and the widget offers the card. After they verify, the question is asked again.
3. If they have, Desk calls each relevant connector (4 seconds each, in parallel), using **only the verified email**, and adds what it found to that turn's instructions as clearly labelled data. The widget shows "Checking your account…" meanwhile. A connector that fails or times out is reported to the assistant as unavailable, so it says so instead of guessing.
4. Each lookup is recorded under **Recent lookups** (masked email, result, timing, never the data) and shown to your team on the conversation. Records are kept 30 days. Saving or turning a connector on or off is recorded under **Changes**.

The assistant never calls the connectors itself and never sees their keys; Desk's server decides what to look up. No extra AI request is made for a lookup.

### Read-only, enforced

- **Shopify.** **Test connection** refuses a token that has any `write_*` scope.
- **Stripe.** Only restricted keys are accepted; a full secret key (`sk_…`) is refused when saved and again on every call.
- **Cal.com.** Cal.com keys can't be limited to reading, so Desk only ever sends `GET` requests with it.
- **Custom HTTP.** Desk sends one signed `POST`; your API decides what to share.

### Shopify

1. In Shopify admin, go to **Settings → Apps and sales channels → Develop apps** and create an app.
2. Under **Admin API scopes**, choose only `read_orders` (and `read_all_orders` if you need older orders). Install it and copy the **Admin API access token** (`shpat_…`).
3. In **Integrations → Shopify**, enter your `your-store.myshopify.com` domain and the token, then choose **Test connection** and turn it on.

Orders are matched by the email on the order. A question naming an order (`#1001`, "order 1001") looks up that order, and it's only used if it belongs to the verified email.

### Stripe

1. In the Stripe Dashboard, go to **Developers → API keys → Create restricted key**.
2. Set **Customers**, **Subscriptions**, **Invoices** and **Products** to **Read**, and leave everything else at **None**.
3. Paste the `rk_live_…` key (or `rk_test_…` to try it) in **Integrations → Stripe** and test it.

Customers are matched by email exactly. Give your prices a nickname, or allow Products, so the assistant can name the plan.

### Cal.com

Create an API key under **Settings → Developer → API keys** and paste it in **Integrations → Cal.com**. For a self-hosted Cal.com, also set its API address and booking site, so reschedule and cancel links point at it.

### Custom HTTP

For anything else: licences, seats, account status, your own order system. Desk sends your endpoint one `POST` per lookup:

```http
POST /desk/lookup
Content-Type: application/json
X-Desk-Timestamp: 1793534400
X-Desk-Signature: sha256=5f1c…

{"type":"lookup","email":"sam@example.com","conversation_id":"…","question":"how many seats do I have?","sent_at":"2026-10-28T12:00:00.000Z"}
```

`question` is left out if you turn off **Send the visitor's question too**. **Test connection** sends `{"type":"test"}`. Answer with up to 20 facts (labels up to 80 characters, values up to 300, `url` optional and https only), or say nothing was found:

```json
{ "facts": [{ "label": "Plan", "value": "Team, 12 seats" }, { "label": "Renews", "value": "2027-01-31", "url": "https://example.com/billing" }] }
{ "found": false }
```

**Always verify the signature** before answering, and reject old timestamps:

```js
import { createHmac, timingSafeEqual } from 'node:crypto'

function verifyDesk(req, rawBody, secret) {
  const timestamp = req.headers['x-desk-timestamp']
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`)
  const given = Buffer.from(String(req.headers['x-desk-signature'] ?? ''))
  return given.length === expected.length && timingSafeEqual(given, expected)
}
```

The endpoint must be https and reachable on the internet. Desk refuses private and reserved addresses (localhost, 10.x, 192.168.x, cloud metadata at 169.254.169.254…), checked on the address the name resolves to when connecting, and never follows redirects. For an API on your own network, set `DESK_ALLOW_PRIVATE_CONNECTOR_URLS=true`. That applies only to Custom HTTP and a self-hosted Cal.com. Answers over 64 KB, or slower than 4 seconds, count as unavailable.

### Identity tokens (signed-in visitors)

If visitors are signed in on your site, your server can vouch for their email, so they skip the code. Sign a token and add it to the widget's URL:

```html
<iframe src="https://support.example.com/widget?identity=TOKEN" style="width:400px;height:600px;border:0"></iframe>
```

The token is `base64url(JSON {"email", "exp"})` + `.` + `base64url(HMAC-SHA256(DESK_IDENTITY_SECRET, first part))`. `exp` is a Unix time at most one hour away, and the payload must hold exactly those two fields.

```js
// Node
import { createHmac } from 'node:crypto'
const payload = Buffer.from(JSON.stringify({ email: user.email, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')
const token = `${payload}.${createHmac('sha256', process.env.DESK_IDENTITY_SECRET).update(payload).digest('base64url')}`
```

```python
# Python
import base64, hashlib, hmac, json, os, time
b64 = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode()
payload = b64(json.dumps({"email": user.email, "exp": int(time.time()) + 600}).encode())
token = payload + "." + b64(hmac.new(os.environ["DESK_IDENTITY_SECRET"].encode(), payload.encode(), hashlib.sha256).digest())
```

```php
// PHP
$b64 = fn($s) => rtrim(strtr(base64_encode($s), '+/', '-_'), '=');
$payload = $b64(json_encode(['email' => $user->email, 'exp' => time() + 600]));
$token = $payload . '.' . $b64(hash_hmac('sha256', $payload, getenv('DESK_IDENTITY_SECRET'), true));
```

Only sign tokens for emails your site has verified. The widget takes the token out of its address bar as soon as it loads, so it isn't kept in history or sent on as a referrer.

### Verification rules

- **Codes.** 6 digits, valid 10 minutes, stored hashed and tied to the conversation that asked for them. Five wrong codes lock verification for 15 minutes.
- **Sending limits.** 3 codes per 10 minutes per chat, 10 per IP and 200 an hour site-wide, so the form can't be used to flood someone's inbox.
- **How long it lasts.** Once verified, follow-up questions in the same chat use it without asking again. It lapses after `VERIFIED_HOURS` (default 24), or after 2 hours without a message from the visitor, whichever comes first. Keeping the chat open doesn't count as activity, so a chat left open on a shared computer stops showing someone's orders. After that the assistant says the verification has expired and the widget asks them to verify again. Signed-in visitors are verified again from a fresh identity token when the page reloads. `VERIFIED_HOURS=0` removes the 24-hour limit, but not the 2-hour one.
- **Forgotten on close.** The verified email is also forgotten as soon as the conversation ends or is archived, and a new chat always starts unverified.

## What you'd need to build without ModelRiver

| Without ModelRiver | With ModelRiver |
| --- | --- |
| Provider SDKs, model switching and fallbacks | A workflow name |
| Retries, timeouts, rate limits | Built in |
| A websocket server, auth tokens, reconnects | `ws_token` + `@modelriver/client` |
| A job queue so slow model calls don't block requests | `POST /v1/ai/async` |
| Webhook delivery with signatures and retries | Built in (optional here) |
| Conversation storage, memory and summarisation | Sessions |
| Pushing new messages to visitors and agents (pub/sub, socket auth, reconnects) | Session channels: `subscribe` + `subscribeToSession` |
| Keeping the AI away from your database | It only sees what you send it |

**With ModelRiver: one API key.**

## Data and privacy

- **Unanswered questions.** The one exception to the point below: questions the help center couldn't answer are kept in SQLite (up to 300 characters each, for 90 days) so the team can see what to write. They're linked to their conversation, not to a person.
- **Where conversations live.** Conversations are stored in **ModelRiver sessions**, not in this app. The SQLite database holds the team's accounts, sign-in sessions and recovery codes, an admin audit log, article metadata and feedback, usage snapshots, encrypted connector keys, and per-conversation details: the session mapping, the visitor's name and verified email, unanswered questions (above) and connector lookup logs. Message text stays in ModelRiver, apart from those unanswered questions.
- **The AI never accesses your database or your connected services.** It sees only what the server puts in each request: the visitor's question, a few data-folder excerpts and, with [Integrations](#integrations), a short summary of the verified visitor's own records.
- **Account data passes through ModelRiver too.** What a connector found is part of that turn's request, so it's in ModelRiver's request logs (if request-body logging is on) for your project's retention period. Like the excerpts, it isn't kept in session memory: only the question and the answer are. Leave out fields you don't want sent with each connector's options.
- **Verified emails.** A visitor's proved email is stored on their conversation in SQLite until it lapses (see [Verification rules](#verification-rules)), or the conversation ends or is archived. Lookup records keep only a masked version (`s***@example.com`) for 30 days.
- **Excerpts pass through ModelRiver.** Private-file excerpts sent as context go through ModelRiver to your model provider. They are kept in ModelRiver's request logs if request-body logging is on for your project, which is the default. They are never shown publicly or cited.
- **Deletion.** Archived conversations are deleted from ModelRiver after `ARCHIVE_RETENTION_HOURS` (see [Archiving](#archiving)). You can also delete any session with `DELETE /v1/sessions/:id`.
- **Export.** Use the sessions API: `GET /v1/sessions?workflow=support_assistant` lists sessions and `GET /v1/sessions/:id` returns the full message history.
- **Visitor names.** Visitors give a name before their first message. It is stored with the conversation in SQLite, shown to your team, and sent to the model (labelled as the visitor's own text) so answers can address them. Nothing else about the visitor is collected.

### Cookies

The app uses only functional cookies; there's no tracking or analytics.

| Cookie | Set by | Holds | Lifetime |
| --- | --- | --- | --- |
| `desk_visitor` | Server, `HttpOnly` | The visitor's conversation ID and a random token (stored hashed) | `VISITOR_COOKIE_DAYS` (default 30), extended each time they send a message |
| `desk_device` | Server, `HttpOnly` | A random ID for this browser, used only to pace new chats after one is ended | 1 year |
| `desk_widget_open` | Widget | Whether the chat was open, so a refresh reopens it | 1 day, removed when the chat is closed |
| `desk_pending` | Widget | The answer being streamed (channel ID, question, start time), so a refresh can resume it | 5 minutes, removed when the answer finishes |
| `desk_session` | Server, `HttpOnly` | A team member's sign-in, created only after the two-factor step | 14 days |
| `desk_2fa` | Server, `HttpOnly` | A sign-in that passed the password step and is waiting for its code | 10 minutes, removed once finished |

- **After a refresh.** The widget reopens if it was open, reloads the conversation, and rejoins an answer that was still streaming. If the answer already finished, it shows it from the session history.
- **Clearing cookies.** This or switching browsers starts a new conversation. The old one stays in the dashboard.
- **Ending a conversation.** Visitors can choose **End conversation** in the chat's **⋯** menu. The conversation stays in the dashboard, marked **Ended**, with replies turned off. Starting another chat soon after is paced, as described under [Abuse protection](#abuse-protection).
- **Embedded widget.** In production the visitor cookies are `SameSite=None; Secure; Partitioned`, so the embedded `/widget` keeps its conversation inside an iframe on another site. The cookie is partitioned per embedding site, and cross-site requests are still rejected.

## Customize the look

Colours, fonts, corner radius, the brand name and logo live in [`support.config.json`](support.config.json). Edit it and restart the app. To keep your settings outside the repo (for example next to your data), point `SUPPORT_CONFIG` at another file. Anything you leave out uses the defaults in [`src/lib/site-config.ts`](src/lib/site-config.ts).

```json
{
  "brand": { "name": "Acme Support", "logo": "./brand/logo.svg", "logoDark": "./brand/logo-dark.svg" },
  "theme": {
    "radius": "0.5rem",
    "light": { "primary": "#6d28d9", "primaryHover": "#5b21b6", "ring": "#6d28d9", "accent": "#f3effd" },
    "dark": { "primary": "#a78bfa", "primaryForeground": "#1e1036" }
  },
  "fonts": {
    "sans": "Inter, ui-sans-serif, system-ui, sans-serif",
    "serif": "Charter, Georgia, serif",
    "stylesheets": ["https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap"]
  }
}
```

| Setting | What it changes |
| --- | --- |
| `brand.name` | Header, chat panel, sign-in page and page titles |
| `brand.logo`, `brand.logoDark` | An SVG shown beside the name in the header, chat panel and dashboard, and on the sign-in page. See [Logo](#logo) |
| `theme.light`, `theme.dark` | Colours for each scheme; the app follows the visitor's system setting. Tokens: `background`, `foreground`, `card`, `muted`, `mutedForeground`, `border`, `input`, `primary`, `primaryHover`, `primaryForeground`, `accent`, `accentForeground`, `destructive`, `success`, `ring`. Hex, `rgb()`, `hsl()` or `oklch()` |
| `theme.radius` | Corner rounding, e.g. `0.5rem`, `8px`, `0` |
| `fonts.sans` | Interface text (navigation, buttons, dashboard) |
| `fonts.serif` | Reading text: headlines, articles and chat answers |
| `fonts.mono` | File names and IDs |

### Logo

Set `brand.logo` to an SVG file to replace the default mark. Add `brand.logoDark` for a version that reads well on dark backgrounds; without it, the same file is used in both schemes.

- **Paths are relative to the config file** and must stay inside its folder. With `SUPPORT_CONFIG=/var/lib/desk/support.config.json`, `"./brand/logo.svg"` means `/var/lib/desk/brand/logo.svg`.
- **SVG only, up to 100 KB.** The file is read once at startup and sent inline, so it costs no extra request. A missing, oversized or non-SVG file stops startup with a clear message.
- **Sizing.** It's shown 24–36 px tall, depending on where it appears, with its width following its aspect ratio (at most 160 px). Give it a tight `viewBox` without padding.
- **Safe to use any SVG.** It's displayed as an image, so scripts or external references inside the file never run.

### Fonts from a CDN

By default the app uses fonts already on the visitor's device, so it makes no third-party requests. To use a web font:

1. Add the font's CSS URL to `fonts.stylesheets`. You can list up to 5 `https://` URLs from Google Fonts, Bunny Fonts, Adobe Fonts or your own CDN.
2. Name the family in `fonts.sans`, `fonts.serif` or `fonts.mono`, followed by fallbacks.
3. If the font files are served from a different host than the stylesheet, add that host to `fonts.fontOrigins`. Google Fonts (`fonts.gstatic.com`) is added automatically.

The app adds these hosts to its Content-Security-Policy for you. Values are validated when the app starts. An invalid colour, font name or URL stops startup with a message listing every problem, so a typo can't silently break the page or inject CSS.

## Dependencies

Kept deliberately small. Everything else uses Node.js built-ins: `node:sqlite`, `fetch`, `crypto.randomUUID`, `crypto.scrypt`, native `FormData`, `--env-file`, and `node --test`.

| Package | Why |
| --- | --- |
| `@tanstack/react-start`, `@tanstack/react-router` | The framework: SSR, routing and server functions |
| `react`, `react-dom` | UI |
| `@modelriver/client` | Official ModelRiver websocket client: streamed answers, and live conversation updates for the widget and the dashboard (brings in `phoenix`, the Phoenix Channels client) |
| `markdown-it` | Renders articles and answers. Raw HTML is disabled and unsafe link schemes are blocked, so no separate sanitizer is needed |
| `@tiptap/react`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/extensions`, `@tiptap/extension-table`, `@tiptap/extension-image`, `@tiptap/markdown` | The article editor: formatting as you type, reading and writing Markdown so the files stay plain Markdown. Loaded only on the editor page (about 180 KB gzipped); visitors never download it |
| `uqr` | Draws the QR code shown when someone sets up two-factor authentication. No dependencies of its own; runs only on the server, so nothing extra ships to the browser |
| `vite`, `@vitejs/plugin-react` (dev) | Build tool used by TanStack Start |
| `tailwindcss`, `@tailwindcss/vite` (dev) | Styling. Utility classes compiled at build time; nothing ships to the browser except the generated CSS. UI components (buttons, inputs, badges) are written in this repo instead of pulling in a component library |
| `typescript`, `@types/*` (dev) | Type checking |

## Security

- **TanStack versions.** `@tanstack/*` packages are pinned to exact versions. `@tanstack/react-start` is ≥ 1.168.60 and resolves `@tanstack/start-server-core` ≥ 1.169.39, which fix [CVE-2026-102989](https://tanstack.com/blog/tanstack-start-security-update-cve-2026-102989) (reflected XSS in server-function responses). `npm run check-versions` checks the resolved versions in `package-lock.json`, and CI runs it.
- **Lockfile and audit.** The lockfile is committed. Install with `npm ci`, never `npm install` in CI or deploy, and run `npm audit` before each release. `.npmrc` sets `save-exact` and `engine-strict`.
- **Updates.** Don't install `latest` blindly: check a package's release date and maintainers before upgrading (`npm view <pkg> time maintainers`).
- **Secrets.** No secrets live in the repo; the API key and paths come from the environment.
- **Connector keys.** Keys entered on the Integrations page are encrypted with `DESK_SECRET_KEY` (AES-256-GCM, bound to their connector and field), are never sent back to the browser (it only learns that a key is set and its last four characters), and are scrubbed from error messages. Only admins can see the page or call its functions.
- **Outbound requests.** Connectors use https only, never follow redirects, cap response size and time, and refuse private, loopback and cloud-metadata addresses at connect time (see [Custom HTTP](#custom-http)).
- **Rendering.** Markdown is rendered with HTML disabled. AI answers and team replies also never render images: a visitor could steer the AI into adding one that makes a team member's browser call another server.
- **Request protection.** Server-function POSTs are checked against cross-site requests. The production server sends a CSP, `nosniff` and a referrer policy on every response, errors included. `/widget` can only be framed by the sites in `WIDGET_FRAME_ANCESTORS` (by default, none but your own).
- **CI.** GitHub Actions are pinned to exact commits.
- **Accounts.** Passwords are hashed with scrypt, and session tokens are stored only as SHA-256 hashes.
- **Two-factor sign-in, required for every team account.** See below.

### Two-factor authentication

Every team member signs in with their password and a 6-digit code from an authenticator app (Google Authenticator, 1Password, Authy or any TOTP app). It uses the standard TOTP algorithm (RFC 6238), built on Node's own crypto. The only addition is `uqr`, a tiny dependency-free package that draws the setup QR code.

- **First sign-in.** After the password, the dashboard shows a QR code to scan with the authenticator app, with a setup key and a phone link as fallbacks. Once the app's first code is confirmed, 10 one-time recovery codes are shown, once, to save. This also applies to accounts that existed before two-factor was added: their next sign-in starts with setup, and sessions created without it are no longer accepted.
- **Every sign-in after that.** The password, then a code. Codes are compared in constant time and each works once. A half-finished sign-in expires after 10 minutes. Five wrong codes cancel it, so the password has to be entered again, and there are per-account and per-IP limits on top. After 30 wrong codes in total the account is locked, across restarts, until an admin chooses **Reset two-factor** for it (or you run `npm run create-admin`). A locked account suggests someone knows its password, so change it too.
- **Changing a password.** Your own needs your current password, and changing it signs you out everywhere else. An admin setting someone else's password signs them out everywhere.
- **Lost phone.** Use a recovery code, each of which works once. Or ask an admin to choose **Reset two-factor** in the person's **⋯** menu under **Users**. That signs them out everywhere, and they set it up again at their next sign-in.
- **Every admin locked out.** On the server, run `npm run create-admin` with an admin's email. It sets a new password and resets that account's two-factor.
- **Turning it off.** Set `DISABLE_TWO_FACTOR=true` to sign in with a password only. That's handy for local development, or for a dashboard that's only reachable behind your own VPN or SSO. Don't use it where the sign-in page is public. It applies to every account, including ones that already set up an authenticator, and the server logs a warning at startup. Setting it back to `false` brings the code step back, and every password-only sign-in made while it was off stops working, so everyone signs in with a code again.
- **Storage.** Authenticator secrets are stored in SQLite so codes can be checked, while recovery codes are stored only as hashes. Protect the database file like the rest of your server data.
- **SQL.** Every SQLite query uses bound parameters, and the AI never touches the database.
- **Not yet encrypted.** `DESK_SECRET_KEY` doesn't encrypt authenticator secrets yet; that's on the [roadmap](#roadmap).

## Abuse protection

The chat widget is public and every answer costs model tokens, so the app limits how much any visitor, and all visitors together, can use.

### Built-in limits

| What | Limit |
| --- | --- |
| New conversations | 20 per hour per IP, 1,000 per hour site-wide |
| Messages | 20 per 10 min per conversation, 60 per 10 min per IP |
| AI answers, site-wide | `GLOBAL_MESSAGES_PER_MINUTE` (default 60) and `GLOBAL_MESSAGES_PER_DAY` (default 2,000) |
| Conversation reloads (live updates, or polling when not live) | 30 per minute per conversation, 120 per minute per IP; each session is cached for 2 s, so a burst costs at most one ModelRiver call |
| Live-update tokens | 20 per 10 min per conversation, 60 per 10 min per IP (each reconnection asks for one) |
| Stream reconnects | 10 per minute per conversation |
| New chat after **End conversation** | First one right away; then, within the hour, 60 s after the last end, then 2 min, 4 min, … up to 15 min. Tracked per browser (`desk_device`) and per IP, where the IP allows 3 free restarts so people sharing an office IP aren't slowed down. Only a conversation that really ended counts, so nobody can run up the wait for others on their IP |
| Dashboard sign-in | 10 per 15 min per IP + account, 30 per 15 min per account (any IP), 50 per 15 min per IP (any account) |
| Account lookups ([Integrations](#integrations)) | 10 per 10 min per conversation, 30 per 10 min per IP, 120 per minute per connector site-wide; results are cached for 2 minutes per conversation |
| Email codes | 3 per 10 min per conversation, 10 per 10 min per IP, 200 per hour site-wide; 30 code checks per 10 min per IP, and 5 wrong codes lock verification for 15 min |

- **Request checks.** Requests over 2 MB are refused. The production server times out slow or idle connections (headers 15 s, request 30 s, idle 60 s).
- **Visitor caps.** The site-wide caps apply only to AI answers. A visitor can still message a team member who has taken over.
- **One process.** Limits live in memory, reset on restart and aren't shared between processes. Run one instance, or move `src/server/rate-limit.server.ts` to a shared store.
- **Login lock-out.** The per-account sign-in limit means someone who knows an admin's email can briefly lock them out. That's the usual trade-off for stopping credential stuffing.

### Tell the app the real client IP

Per-IP limits only work if the app sees the visitor's IP rather than your proxy's. The app never trusts the first `X-Forwarded-For` entry, because clients can set it themselves.

| Setup | Setting |
| --- | --- |
| Nothing in front (dev) | Defaults. Under `npm run dev` every visitor shares one bucket |
| nginx or Caddy | `TRUST_PROXY_HOPS=1`: use the address your proxy appended, the right-most entry |
| Cloudflare, then nginx | `CLIENT_IP_HEADER=cf-connecting-ip`, and firewall the server so only Cloudflare can reach it. Otherwise anyone can send that header |

Setting more hops than you really have lets clients choose their own IP again.

### Cap spend in ModelRiver too

The app's caps count messages. ModelRiver caps money, so set both:

- **Workflow budget.** On the `support_assistant` workflow, set a spend cap per model. When every model in the chain is over its cap, ModelRiver returns `workflow_budget_exceeded` and makes no provider call.
- **Project limit.** Set a project spending limit as the backstop.

See [Spending limits](https://modelriver.com/docs/observability/spending-limits). Visitors then see "The assistant is unavailable right now" instead of you getting an unexpected bill.

### Put Cloudflare (or similar) in front

No app can absorb a network-level DDoS by itself. In production:

- **Proxy through Cloudflare.** Its DDoS protection and Bot Fight Mode stop floods before they reach your server. Keep the origin's firewall open only to Cloudflare's IP ranges.
- **Add a WAF rate-limit rule.** Cover `POST /_serverFn/*`, for example 30 requests per 10 seconds per IP, so abusive clients are blocked at the edge.
- **Add nginx limits.** For example `limit_req_zone $binary_remote_addr zone=support:10m rate=10r/s;` with `limit_req zone=support burst=40 nodelay;`, plus `limit_conn` and `client_max_body_size 2m;`.

### Optional: Cloudflare Turnstile

Not built in yet (see the [roadmap](#roadmap)). If bots start opening many conversations from rotating IPs:

1. Add the [Turnstile](https://developers.cloudflare.com/turnstile/) widget to the chat before the first message is sent.
2. Send its token with `startConversation`.
3. Verify it server-side with Turnstile's `siteverify` endpoint before creating the conversation.

Later messages are already tied to the conversation's visitor token and limits.

### Private data and prompt injection

Excerpts from `private/` are sent to the model, and only its instructions stop it from quoting them. A determined user can sometimes talk a model out of its instructions. Treat `private/` as "fine if a customer saw it by accident". Never put secrets, credentials or other customers' data there.

Account data from connectors is safer by design: it's only ever the verified visitor's own records, so talking the model round can't reveal anyone else's. Text from those services (a product name, a fact from your API) could contain instructions, so it's passed as JSON inside a tagged block labelled as data, can't close that block, and has Desk's `[[...]]` markers removed.

## Deploying (systemd)

On a fresh Ubuntu server, one script does it all: Node.js, the `desk` user, the systemd service, nginx and a Let's Encrypt certificate. Run it again to update.

```bash
sudo ./deploy/setup-server.sh --source . --domain support.acme.com --email you@acme.com
```

With Docker instead, `docker-compose.yml` runs the published image (`ghcr.io/modelriver/desk`) behind Caddy, which handles HTTPS. No clone needed; the server only needs Docker:

```bash
curl -fsSLO https://raw.githubusercontent.com/modelriver/desk/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/modelriver/desk/main/deploy/docker/env.example -o .env    # then fill it in
docker compose up -d
```

See [`deploy/README.md`](deploy/README.md) for the options and what goes where. By hand, in short:

1. Put the app in `/opt/desk` and your data in `/var/lib/desk/data/{public,private}`.
2. Create `/etc/desk/env` with `MODELRIVER_API_KEY`, `DATA_DIR`, `DATABASE_PATH`, `NODE_ENV=production` and `TRUST_PROXY_HOPS=1` (see [Abuse protection](#abuse-protection)).
3. Install [`deploy/desk.service`](deploy/desk.service), then run `systemctl enable --now desk`.
4. Put nginx or Caddy in front for TLS.

Private data and environment files live on the server, or in a small private repo containing only data, env and the service file. Never put them in this repo.

## Embedding the widget elsewhere

`/widget` is a full-page chat that can be embedded with an iframe. Set `WIDGET_FRAME_ANCESTORS` to the sites allowed to embed it, space-separated. Until you do, only the app's own pages can frame it.

```html
<iframe src="https://support.example.com/widget" style="width:400px;height:600px;border:0"></iframe>
```

For visitors signed in on your site, add `?identity=` with a signed token so connector lookups work without an email code (see [Identity tokens](#identity-tokens-signed-in-visitors)).

## Out of scope

Intentionally not built: ticket assignment, reports and analytics, product tours, granular permissions.

## Roadmap

Planned, roughly in priority order:

- Notify the team in Slack or through a webhook when a visitor asks for a person.
- Use CSP nonces instead of `'unsafe-inline'`.
- Optional Cloudflare Turnstile check before a new conversation (see [Abuse protection](#abuse-protection)).
- A shared rate-limit store for running several instances.
- Optionally use ModelRiver webhooks for activity notifications.
- Add a script-tag embed.
- Connector actions that change things (refunds, cancellations, rebooking), behind limits, visitor confirmation and team approval. Connectors are read-only for now.
- More connectors: WooCommerce, Calendly, Lemon Squeezy and Paddle.
- Encrypt authenticator secrets with `DESK_SECRET_KEY`.

## License

[MIT](LICENSE). Third-party notices are in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).
