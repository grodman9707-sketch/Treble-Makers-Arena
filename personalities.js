/**
 * AI match announcers for POST /api/commentary.
 * - singles: one Groq line → one Deepgram Aura voice
 * - dual: pick any two speakers → two lines → two voices
 * - intro: fixed ring announcer voice for match walk-ons (Deepgram only)
 */

const SPEAKERS = {
  jack: {
    id: 'jack',
    name: 'Hype Master Jack',
    voice: 'aura-2-apollo-en',
    style:
      'High-energy stadium play-by-play host. Explosive, loud, celebratory.',
  },
  sam: {
    id: 'sam',
    name: 'Sarcastic Sam',
    voice: 'aura-2-orion-en',
    style:
      'Dry, cynical, deadpan pub referee. Witty roasts, never gushes.',
  },
  coach: {
    id: 'coach',
    name: 'Coach Pete',
    voice: 'aura-2-orpheus-en', // warm supportive male
    style:
      'Supportive darts coach. Short tips and praise, calm and clear.',
  },
  maya: {
    id: 'maya',
    name: 'Maya Marks',
    voice: 'aura-2-asteria-en', // female commentator (former Coach Pete voice)
    style:
      'Sharp female color commentator. Clear, punchy, crowd-aware.',
  },
};

/** Permanent boxing-style arena voice for match introductions / walk-ons. */
const INTRO_ANNOUNCER = {
  id: 'ring',
  name: 'Ring Announcer',
  voice: 'aura-2-zeus-en', // deep, authoritative “ladies and gentlemen…” energy
  style:
    'Classic boxing / sports arena ring announcer. Formal, booming, theatrical.',
};

const SINGLES = {
  sarcastic: {
    id: 'sarcastic',
    name: 'Sarcastic Sam',
    speakerId: 'sam',
    systemPrompt:
      'You are Sarcastic Sam, a dry, witty darts commentator. ' +
      'Reply with one sarcastic one-liner only. Maximum 12 words. ' +
      'No quotes, emojis, or stage directions.',
  },
  hyped: {
    id: 'hyped',
    name: 'Hype Master Jack',
    speakerId: 'jack',
    systemPrompt:
      'You are Hype Master Jack, an explosive arena hype man for darts. ' +
      'Reply with one high-energy hype line only. Maximum 12 words. ' +
      'No quotes, emojis, or stage directions.',
  },
  coach: {
    id: 'coach',
    name: 'Coach Pete',
    speakerId: 'coach',
    systemPrompt:
      'You are Coach Pete, a supportive darts coach. ' +
      'Reply with one short encouraging tip or praise. Maximum 12 words. ' +
      'No quotes, emojis, or stage directions.',
  },
  maya: {
    id: 'maya',
    name: 'Maya Marks',
    speakerId: 'maya',
    systemPrompt:
      'You are Maya Marks, a sharp female darts color commentator. ' +
      'Reply with one clear, punchy line only. Maximum 12 words. ' +
      'No quotes, emojis, or stage directions.',
  },
};

const DUAL = {
  id: 'dual',
  name: 'Dual team (pick 2)',
  defaultSpeaker1: 'jack',
  defaultSpeaker2: 'sam',
};

function listSpeakers() {
  return Object.values(SPEAKERS).map((s) => ({
    id: s.id,
    name: s.name,
    voice: s.voice,
  }));
}

function listPersonalities() {
  const singles = Object.values(SINGLES).map((p) => ({
    id: p.id,
    name: p.name,
    mode: 'single',
    voice: SPEAKERS[p.speakerId]?.voice || null,
  }));
  return [
    ...singles,
    {
      id: DUAL.id,
      name: DUAL.name,
      mode: 'dual',
      defaultSpeaker1: DUAL.defaultSpeaker1,
      defaultSpeaker2: DUAL.defaultSpeaker2,
    },
  ];
}

function getSingle(id) {
  const pack = SINGLES[id];
  if (!pack) return null;
  const speaker = SPEAKERS[pack.speakerId];
  if (!speaker) return null;
  return { ...pack, voice: speaker.voice, speaker };
}

function getSpeaker(id) {
  return SPEAKERS[id] || null;
}

function buildDualSystemPrompt(speaker1, speaker2) {
  return (
    'You are a 2-person darts commentary team:\n' +
    `- Speaker 1 (${speaker1.name}): ${speaker1.style}\n` +
    `- Speaker 2 (${speaker2.name}): ${speaker2.style}\n` +
    "Analyze the player's recent throw history. Roast slumps (e.g., repeated low scores like 26) " +
    'or hype up streaks (e.g., back-to-back 140s/180s) and checkout pressure. ' +
    'Keep EACH speaker line under 10 words.\n' +
    'Respond with STRICT JSON only matching: ' +
    '{ "speaker1": "Line for speaker 1", "speaker2": "Line for speaker 2" }'
  );
}

module.exports = {
  SPEAKERS,
  SINGLES,
  DUAL,
  INTRO_ANNOUNCER,
  listSpeakers,
  listPersonalities,
  getSingle,
  getSpeaker,
  buildDualSystemPrompt,
};
