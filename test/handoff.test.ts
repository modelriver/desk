import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hasHandoffMarker, HANDOFF_MARKER, wantsHuman } from '../src/lib/handoff.ts'
import { linkCitations } from '../src/lib/citations.ts'

test('clear requests for a person are caught', () => {
  for (const msg of [
    'Can I talk to a person?',
    'I want to speak with someone from your team',
    'connect me with support please',
    'Please transfer me',
    'I need a real person',
    'live agent',
    'human please',
    'Agent, please!',
    'can I get a human',
    'Can you escalate this?',
    'Let me chat with the team',
    'talk to a team member',
  ]) {
    assert.equal(wantsHuman(msg), true, msg)
  }
})

test('everyday product questions are not mistaken for a handoff', () => {
  for (const msg of [
    'How do I invite my team?',
    'How do I connect my calendar?',
    'Can I talk to my team about the Business plan first?',
    'What does a team member role allow?',
    'Is there a person limit on the Free plan?',
    'How do I export my data?',
    'Can you connect me to Stripe?',
    'Please put me on the annual plan',
    'Transfer me to the Pro plan',
    '',
  ]) {
    assert.equal(wantsHuman(msg), false, msg)
  }
})

test('the AI handoff marker is detected and never shown', () => {
  const answer = `I'll connect you with our team now. ${HANDOFF_MARKER}`
  assert.equal(hasHandoffMarker(answer), true)
  assert.equal(linkCitations(answer, new Map()).trim(), 'I’ll connect you with our team now.'.replace('’', "'"))
  assert.equal(hasHandoffMarker('Here is how to export [[exporting-your-data]].'), false)
})

test('the AI is told when to hand off', async () => {
  const { buildContextMessage } = await import('../src/lib/prompt-core.ts')
  assert.match(buildContextMessage([]).content, /end your reply with \[\[handoff\]\]/)
})
