# Record receivers: how a player hands a completed session to a platform

A `.ronu` file plays anywhere, offline, with no account. That is the point of
the format. It also means that, by default, nothing a learner does in a player
goes anywhere. This document is the contract that lets a player send the
outcome of a session to a platform that keeps learning records (a "receiver"),
and, while connected, use services the platform offers such as an AI
conversation character. Section 7 adds the second way to connect: a package
that carries a customer key and acts for an LMS's learner by itself.

RonuNest is the first receiver. The contract is written so that any platform
can be one, and any player can talk to one.

Status: trunk, unversioned, like the rest of the format. Message and body
shapes carry a `version: 0` field so a change can be detected.

## 1. Discovery

A receiver publishes `/.well-known/ronu-receiver.json` on its web origin, with
CORS open to any origin:

```json
{
  "ronuReceiver": 0,
  "name": "RonuNest",
  "connect": "https://ronunest.com/player-connect"
}
```

A player that is given a receiver origin (for RonuNest, the default) fetches
this document to find the connect page. If the document is missing, the player
may assume `<origin>/player-connect`. The document also carries the receiver's
coordinates (section 7), so a player that connects by key needs nothing but
the origin.

## 2. Connecting

Connecting means the learner signs in to the receiver, in the receiver's own
pages, and consents to the player acting for them. The player never sees a
password and never embeds a sign-in form of its own.

1. The player opens the connect page in a popup:
   `<connect>?origin=<the player's origin, URL-encoded>&name=<player name>`.
2. The receiver's page asks the learner to sign in if they are not, checks
   that `origin` is one it allows (see section 6), and shows a consent screen
   naming the player origin and what it will be able to do.
3. On consent the page posts one message to `window.opener`, with
   `targetOrigin` set to the `origin` parameter, then closes:

```json
{
  "type": "ronu-receiver-connect",
  "version": 0,
  "receiver": {
    "name": "RonuNest",
    "origin": "https://ronunest.com",
    "supabaseUrl": "https://<project>.supabase.co",
    "anonKey": "<public anon key>",
    "records": "https://<project>.supabase.co/functions/v1/record-completion",
    "conversation": "https://<project>.supabase.co/functions/v1/ai-conversation"
  },
  "session": {
    "access_token": "<jwt>",
    "refresh_token": "<token>",
    "expires_at": 1757500000,
    "token_type": "bearer"
  },
  "user": { "id": "<uuid>", "email": "learner@example.com", "name": "Learner" }
}
```

4. The player accepts the message only if `event.origin` equals the receiver
   origin it opened, and only while it is waiting for one. It stores the
   receiver block, the session and the user locally.

**Fallback without a popup.** If the page has no `window.opener` (popup
blocked, or the learner opened the page in a tab), it shows the same JSON as a
"connection code" (base64url of the JSON) with a copy button. A player offers a
"paste a connection code" input that accepts it.

**Session refresh.** Access tokens expire (about an hour). Before a call, if
`expires_at` is within 60 seconds, the player refreshes:
`POST <supabaseUrl>/auth/v1/token?grant_type=refresh_token` with header
`apikey: <anonKey>` and body `{"refresh_token": "<token>"}`; the response is a
new session in the same shape. If the refresh fails, the player is
disconnected and must reconnect.

**Disconnect.** `POST <supabaseUrl>/auth/v1/logout` with `Authorization:
Bearer <access_token>` and `apikey`, then forget everything stored.

## 3. Sending a session record

When a session ends, the player may send it once. The call is the receiver's
`records` endpoint, which for RonuNest is the same function the online player
uses, so an offline completion is recorded, graded, certified and counted
exactly like an online one.

```
POST <records>
Authorization: Bearer <access_token>
apikey: <anonKey>
Content-Type: application/json
```

```json
{
  "moduleId": "<manifest.module.id>",
  "responses": { "<nodeId>": { "answer": <what the learner answered>, "score": 0-100 } },
  "path": [ { "nodeId": "<nodeId>", "enteredAt": "<ISO time>" } ],
  "variableState": { "<variableId>": <value> }
}
```

- `moduleId` is `manifest.module.id`: the id the file was exported from. The
  receiver must know that module; a file from another platform, or a module
  deleted since, cannot be recorded (404).
- `responses` carries only nodes that were answered; `score` only where the
  player computed a 0 to 100 grade (matching, procedure, dragToTarget, an
  assessed conversation). The receiver recomputes pass or fail from the
  module's stored completion rule; the player's own verdict is not sent and
  would not be trusted.
- `path` is the ordered list of nodes entered.
- `variableState` is keyed by variable **id**, values as they stand at the end.

Responses:

| Status | Meaning | Player behaviour |
|---|---|---|
| 200 | recorded; body includes `passed`, `score`, and `certificate` `{verification_code, issued_at, expires_at}` when one was issued | mark the session as sent, show the result, link the certificate at `<origin>/certificates/<verification_code>` |
| 401 | session invalid or expired | refresh, then reconnect |
| 403 | the learner has no access to this module on the receiver | say so; nothing to retry |
| 404 | the receiver does not have this module | say so |
| 413 | record too large | drop bulky answer payloads and retry once |

A record is sent at most once per session; the player keeps a "sent" flag with
the receiver's response. Sending the same session twice creates two attempts
on the receiver.

The xAPI-shaped statements a player builds locally (see the reference player's
`session.js`) are a superset of this body and remain the right thing to give
to a Learning Record Store; this contract is deliberately the smaller,
platform-native shape.

## 4. Services while connected: the AI conversation

A `conversation` node needs a model. A connected player may run it through the
receiver's `conversation` endpoint, which for RonuNest is the same function the
online player uses; the creator who owns the module pays for the turns, exactly
as online.

```
POST <conversation>     (same headers as section 3)
{
  "version": 0,
  "moduleId": "<manifest.module.id>",
  "persona": "<config.persona>",
  "objective": "<config.objective>",
  "moodStates": [ { "label": "...", "cue": "..." } ],
  "messages": [ { "role": "character" | "learner", "content": "..." } ],
  "finalize": false
}
```

- With `finalize: false`, the last message must be the learner's; the response
  is `{ "reply": "...", "mood": "...", "degraded": false, "usage": { "used", "limit" } }`.
  `degraded: true` means the creator's allowance is spent and the reply is
  scripted; the player should end the conversation and finalize.
- With `finalize: true` and the full transcript, the response is the
  assessment: `{ "score": 0-100, "summary": "...", "criteria"?: [...] }` when
  the node has `criteria` (a rubric), plus `model` and `promptVersion`.
  The player writes `score` to the node's `scoreVariableId` with a `set`
  action and records the node's answer with that score, so the record sent in
  section 3 carries it.
- Errors come back as `{ "error": "..." }` with 4xx or 5xx; the player shows
  the message and offers the fallback card.

Not connected, or the call fails: the player shows the spec's fallback card
for the node and continues, as a minimal player does.

## 5. What a receiver must and must not do

- Must recompute pass or fail from its own copy of the module's rule. A
  player's verdict is a preview, never the record.
- Must apply the same access rules as online play: a learner who could not
  open the module online cannot record it offline either.
- Must not require the player to embed any secret. The anon key is public by
  design; the learner's session is the only credential.
- Should record the provenance (`source`) of the record as coming from a
  player, so analytics can tell offline play from online play.

## 6. Security notes

- The connect page hands the player a real session for the learner. A
  receiver therefore decides which player origins it will connect to. RonuNest
  allows its own reference player origin and local development origins, and
  reads extra origins from configuration. This is deliberate for now: the
  intended follow-up is a scoped player token (a credential that can only
  submit records and run conversations, revocable from the learner's account
  page) so that any third-party player can connect without receiving a full
  session. Players should be written against this document so that swap is
  invisible to them.
- The player must validate `event.origin` on the connect message and ignore
  anything else.
- Stored sessions are as sensitive as being signed in. Disconnect clears them.
  A player on a shared device should offer disconnect prominently.
- All calls are HTTPS. A receiver on plain HTTP is only acceptable on
  localhost during development.

## 7. Customer keys: machine launch

Sections 2 to 4 assume a learner who can sign in to the receiver in a popup.
Inside an LMS there is often no such learner: the LMS knows who they are, the
receiver does not, and a popup is the wrong shape for a course window. This
section lets a package act for the LMS's learner by itself, with a credential
issued to the customer rather than to the learner.

### 7.1 Discovery carries the coordinates

`/.well-known/ronu-receiver.json` (section 1) also names the endpoints a
connected player calls, so a player given only an origin needs nothing else:

```json
{
  "ronuReceiver": 0,
  "name": "RonuNest",
  "connect": "/player-connect",
  "supabaseUrl": "https://<project>.supabase.co",
  "anonKey": "<public anon key>",
  "records": "https://<project>.supabase.co/functions/v1/record-completion",
  "conversation": "https://<project>.supabase.co/functions/v1/ai-conversation",
  "session": "https://<project>.supabase.co/functions/v1/creator-api"
}
```

`connect` and the endpoint URLs may be relative to the origin. A receiver
that publishes only `connect` supports the popup handshake alone; a player
asked for a machine launch against it reports that and plays offline.

### 7.2 The package file

A package may carry `ronu-package.json` at its root, beside the launcher:

```json
{
  "version": 0,
  "receiver": "https://ronunest.com",
  "key": "<creator API key>",
  "moduleId": "<manifest.module.id>",
  "name": "ronu player"
}
```

A package with a key is a **connected package**; one without the file, or
with the file but no key, is **self-contained** and behaves as sections 1 to
6 describe (the learner may still connect through the popup). `receiver` is
an origin; `moduleId` is the id the file was exported from, the same value
the record in section 3 carries; `name` is what the receiver will show as the
player.

### 7.3 The exchange

At launch, when the file is present and a key is set, the player fetches
discovery from `receiver`, then posts to `session`:

```
POST <session>
x-api-key: <key>
Content-Type: application/json
```

```json
{
  "action": "player_session",
  "version": 0,
  "learner": {
    "externalId": "<cmi.core.student_id>",
    "name": "<cmi.core.student_name>",
    "email": "<optional>"
  },
  "moduleId": "<manifest.module.id>",
  "player": { "name": "ronu player", "origin": "<location.origin>" }
}
```

`learner.externalId` is the LMS's own identifier for the learner
(`cmi.core.student_id` in SCORM 1.2); `name` and `email` are sent when the
LMS gives them. A launch with no learner id at all (an LMS that leaves the
field blank, or a package opened outside an LMS) sends
`anonymous-<random>`, and the player says so; such a learner is new on every
launch. `player.origin` is where the package is being served from, so a
receiver can see which LMS a key is used at.

The receiver finds or creates a tenant learner for (customer, `externalId`),
grants that learner the module, and mints a session for them:

```json
{
  "success": true,
  "version": 0,
  "session": {
    "access_token": "<jwt>",
    "refresh_token": "<token>",
    "expires_at": 1757500000,
    "token_type": "bearer"
  },
  "user": { "id": "<uuid>", "email": "", "name": "<learner name>" },
  "learner": { "created": true }
}
```

The `session` block is exactly what the popup handshake delivers in section
2, so it drops into the same store: refresh through GoTrue works the same
(section 2), records go to `records` (section 3) and conversations to
`conversation` (section 4), with the receiver block assembled from
discovery. `learner.created` says whether this launch made the tenant
learner or found one from an earlier launch.

Errors come back as:

```json
{ "success": false, "error": "<words for the learner>", "errorCode": "unauthorized" }
```

with status 401, 403 or 404, or as a 200 whose `success` is false; a player
treats both the same and branches on `errorCode`:

| `errorCode` | Meaning |
|---|---|
| `unauthorized` | the key is unknown or revoked |
| `tier_required` | the account that issued the key needs a plan that includes connected packages |
| `invalid_learner` | the request named no usable learner |
| `module_not_found` | the receiver does not have this module |
| `module_not_owned` | the module does not belong to the account that issued the key |

On any failure the player shows one line ("Could not connect to RonuNest:
<error>. Playing offline.") and continues as a self-contained package:
conversations show their fallback card, and the end screen offers the popup
connect as before. The LMS report never waits on the receiver.

### 7.4 What the player does while connected by key

- It shows the learner as connected ("connected as <name>") with no popup
  and no account step. There is no Disconnect: the session belongs to the
  launch, is kept in memory only, and goes when the course window closes.
  The player must not write a machine session to durable storage (the next
  launch on the same browser may be another learner) and must not call
  `logout` on unload; a receiver expires the session on its own.
- When the end screen renders, the player sends the record once (section 3)
  without being asked, after the LMS report has gone out, and shows the
  result with the certificate link. The LMS report and the receiver record
  are independent: one failing never blocks the other.
- Play again after that is a practice run for both: the LMS keeps the first
  outcome of the launch, and a second send is a manual action that creates a
  second attempt.

### 7.5 Security notes for keys

- A key in a package can mint sessions for that customer's tenant learners
  only, for modules the customer's account owns; it cannot reach any other
  account's learners, modules or records. It is a customer credential, not a
  learner one, and not a platform one.
- Keys are per customer, issued in RonuNest's settings (nest settings, Portal
  API keys), revocable there at any time. Issue one key per LMS customer and
  put that key in the packages built for them: revoking it cuts off every
  package that carries it and nothing else. A revoked key fails with
  `unauthorized` and the package keeps working offline.
- A package is a zip the customer's LMS administrators can open, so the key
  is visible to them. That is the intended trust boundary: the key belongs
  to that customer. Do not reuse one customer's key in another customer's
  package.
- The receiver should record the provenance of records and conversations
  minted through a key (the key, the player origin) as it does for the popup
  path (section 5), so a customer's usage can be attributed and a leaked key
  spotted.
