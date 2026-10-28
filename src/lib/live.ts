// Live updates shared by the server and the browser. Messages arrive on
// ModelRiver's session channel by themselves; Desk's own changes (a teammate
// taking over, handing back, archiving, the visitor leaving) go out as this
// signal, and every open widget or transcript for the conversation reloads it.
export const CONVERSATION_UPDATED = 'desk.conversation.updated'

// While live, a slow refresh is only a safety net; without a live connection
// (none yet, or it dropped) the views fall back to polling.
export const LIVE_SAFETY_REFRESH_MS = 60_000
