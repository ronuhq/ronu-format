# Record receivers: how a player hands a completed session to a platform

A `.ronu` file plays anywhere, offline, with no account. That is the point of
the format. It also means that, by default, nothing a learner does in a player
goes anywhere. This document is the contract that lets a player send the
outcome of a session to a platform that keeps learning records (a "receiver"),
and, while connected, use services the platform offers such as an AI
conversation character.

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
may assume `<origin>/player-connect`.

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
