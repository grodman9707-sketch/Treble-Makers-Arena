/**
 * AI match announcers for POST /api/commentary, /api/ref-announce, /api/match-intro.
 * - singles: one Groq line → one Deepgram Aura voice
 * - dual: pick any two speakers → two lines → two voices
 * - ref: Ref Russ score callouts (Groq → Deepgram)
 * - intro: Thunderous Tom ring announcer (Groq → Deepgram Helios)
 * Locale packs keep personalities the same while switching accent / language voices.
 */

const SPEAKERS = {
  jack: {
    id: 'jack',
    name: 'Hype Master Jack',
    gender: 'masculine',
    voice: 'aura-2-apollo-en',
    style:
      'High-energy stadium play-by-play host. Explosive, loud, celebratory.',
  },
  sam: {
    id: 'sam',
    name: 'Sarcastic Sam',
    gender: 'masculine',
    voice: 'aura-2-orion-en',
    style:
      'Dry, cynical, deadpan pub referee. Witty roasts, never gushes.',
  },
  coach: {
    id: 'coach',
    name: 'Coach Pete',
    gender: 'masculine',
    voice: 'aura-2-orpheus-en', // warm supportive male
    style:
      'Supportive darts coach. Short tips and praise, calm and clear.',
  },
  maya: {
    id: 'maya',
    name: 'Maya Marks',
    gender: 'feminine',
    voice: 'aura-2-asteria-en', // female commentator (former Coach Pete voice)
    style:
      'Sharp female color commentator. Clear, punchy, crowd-aware.',
  },
};

/** Permanent boxing-style arena voice for match introductions / walk-ons. */
const INTRO_ANNOUNCER = {
  id: 'thunderous-tom',
  name: 'Thunderous Tom',
  // Prefer Aura-2 id when available; Deepgram currently ships Helios as Aura-1.
  voice: 'aura-2-helios-en',
  voiceFallbacks: ['aura-2-helios-en', 'aura-helios-en', 'aura-2-zeus-en'],
  // Slightly slower = booming Bruce Buffer–style punch and pause.
  speed: 0.88,
  style:
    'Bruce Buffer–style world-championship ring announcer. Explosive, commanding, theatrical fight-night energy.',
  systemPrompt:
    'You are "Thunderous Tom", a Bruce Buffer–style world-championship boxing and MMA ring announcer introducing a darts match. ' +
    'Write one LOUD, explosive match introduction (1–2 short sentences) with COMMANDING fight-night presence. ' +
    'Use ALL CAPS for dramatic emphasis on player names and key phrases. ' +
    'Lean into classic cadence with pauses (ellipsis) — e.g. "LADIES AND GENTLEMEN...", "IIIIIT\'S TIME!", player names shouted. ' +
    'Sound thunderous, hyped, and arena-loud — never calm, soft, or conversational. ' +
    'Include both player names and the game type. Keep the total text under 30 words.',
};

/** Official score referee — Groq line then Deepgram TTS. */
const REF_ANNOUNCER = {
  id: 'ref',
  name: 'Ref Russ',
  // Prefer Aura-2 id when available; Deepgram currently ships Perseus as Aura-1.
  voice: 'aura-2-perseus-en',
  voiceFallbacks: ['aura-2-perseus-en', 'aura-perseus-en', 'aura-2-orpheus-en'],
  // Slightly faster = Russ Bray–style sharp, commanding callouts.
  speed: 1.08,
  style:
    'Russ Bray–style professional darts referee. Loud, sharp, commanding score callouts only.',
  systemPrompt:
    'You are "Ref Russ", a Russ Bray–style official professional darts referee calling out score results with commanding arena energy. ' +
    'When the score is 180, reply with EXCLUSIVELY: "ONE HUNDRED AND EIGHTY!" ' +
    'When a throw is a bust, reply with EXCLUSIVELY: "BUST!" ' +
    'When the MATCH is won, reply with EXCLUSIVELY: "GAME SHOT AND THE MATCH!" ' +
    'When a LEG is won (but not the match), reply with EXCLUSIVELY: "GAME SHOT!" ' +
    'For standard scores, call out the EXACT visit total in spoken words crisply and loudly ' +
    '(e.g., "SIXTY!", "TWENTY-SIX!", "ONE HUNDRED AND FORTY!") — never invent a different number. ' +
    'Always use ALL CAPS and end with ! — never soft or conversational. ' +
    'Keep responses under 6 words max. Do not add casual small talk.',
};

/**
 * Shared accent / language packs for Ref + commentators.
 * Personalities stay the same; only spoken language + Deepgram voice change.
 */
const VOICE_LOCALES = {
  'en-us': {
    id: 'en-us',
    label: 'English (US)',
    language: 'en',
    languageName: 'English',
    accent: 'American',
    groqLanguageHint: null, // default English — no extra instruction
    refVoice: 'aura-2-perseus-en',
    refVoiceFallbacks: ['aura-2-perseus-en', 'aura-perseus-en', 'aura-2-orpheus-en'],
    masculine: 'aura-2-apollo-en',
    masculineAlt: 'aura-2-orion-en',
    masculineWarm: 'aura-2-orpheus-en',
    feminine: 'aura-2-asteria-en',
  },
  'en-gb': {
    id: 'en-gb',
    label: 'English (UK)',
    language: 'en',
    languageName: 'English',
    accent: 'British',
    groqLanguageHint: 'Speak in British English phrasing and spelling.',
    refVoice: 'aura-2-draco-en',
    masculine: 'aura-2-draco-en',
    masculineAlt: 'aura-2-draco-en',
    masculineWarm: 'aura-2-draco-en',
    feminine: 'aura-2-pandora-en',
  },
  'en-au': {
    id: 'en-au',
    label: 'English (AU)',
    language: 'en',
    languageName: 'English',
    accent: 'Australian',
    groqLanguageHint: 'Speak with Australian English phrasing.',
    refVoice: 'aura-2-hyperion-en',
    masculine: 'aura-2-hyperion-en',
    masculineAlt: 'aura-2-hyperion-en',
    masculineWarm: 'aura-2-hyperion-en',
    feminine: 'aura-2-theia-en',
  },
  es: {
    id: 'es',
    label: 'Español',
    language: 'es',
    languageName: 'Spanish',
    accent: 'Spanish',
    groqLanguageHint: 'Respond entirely in Spanish.',
    refVoice: 'aura-2-nestor-es',
    masculine: 'aura-2-aquila-es',
    masculineAlt: 'aura-2-alvaro-es',
    masculineWarm: 'aura-2-javier-es',
    feminine: 'aura-2-celeste-es',
  },
  fr: {
    id: 'fr',
    label: 'Français',
    language: 'fr',
    languageName: 'French',
    accent: 'French',
    groqLanguageHint: 'Respond entirely in French.',
    refVoice: 'aura-2-hector-fr',
    masculine: 'aura-2-hector-fr',
    masculineAlt: 'aura-2-hector-fr',
    masculineWarm: 'aura-2-hector-fr',
    feminine: 'aura-2-agathe-fr',
  },
  de: {
    id: 'de',
    label: 'Deutsch',
    language: 'de',
    languageName: 'German',
    accent: 'German',
    groqLanguageHint: 'Respond entirely in German.',
    refVoice: 'aura-2-fabian-de',
    masculine: 'aura-2-julius-de',
    masculineAlt: 'aura-2-fabian-de',
    masculineWarm: 'aura-2-fabian-de',
    feminine: 'aura-2-lara-de',
  },
  it: {
    id: 'it',
    label: 'Italiano',
    language: 'it',
    languageName: 'Italian',
    accent: 'Italian',
    groqLanguageHint: 'Respond entirely in Italian.',
    refVoice: 'aura-2-perseo-it',
    masculine: 'aura-2-cesare-it',
    masculineAlt: 'aura-2-flavio-it',
    masculineWarm: 'aura-2-elio-it',
    feminine: 'aura-2-livia-it',
  },
  nl: {
    id: 'nl',
    label: 'Nederlands',
    language: 'nl',
    languageName: 'Dutch',
    accent: 'Dutch',
    groqLanguageHint: 'Respond entirely in Dutch.',
    refVoice: 'aura-2-roman-nl',
    masculine: 'aura-2-sander-nl',
    masculineAlt: 'aura-2-roman-nl',
    masculineWarm: 'aura-2-lars-nl',
    feminine: 'aura-2-beatrix-nl',
  },
  ja: {
    id: 'ja',
    label: '日本語',
    language: 'ja',
    languageName: 'Japanese',
    accent: 'Japanese',
    groqLanguageHint: 'Respond entirely in Japanese.',
    refVoice: 'aura-2-fujin-ja',
    masculine: 'aura-2-fujin-ja',
    masculineAlt: 'aura-2-ebisu-ja',
    masculineWarm: 'aura-2-ebisu-ja',
    feminine: 'aura-2-uzume-ja',
  },
};

const DEFAULT_LOCALE = 'en-us';

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
    gender: s.gender,
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

function listLocales() {
  return Object.values(VOICE_LOCALES).map((loc) => ({
    id: loc.id,
    label: loc.label,
    language: loc.language,
    languageName: loc.languageName,
    accent: loc.accent,
    refVoice: loc.refVoice,
  }));
}

function getLocale(id) {
  const key = String(id || '')
    .trim()
    .toLowerCase();
  return VOICE_LOCALES[key] || VOICE_LOCALES[DEFAULT_LOCALE];
}

function appendLocaleHint(systemPrompt, locale) {
  const loc = typeof locale === 'string' ? getLocale(locale) : locale || getLocale(DEFAULT_LOCALE);
  const hint = loc?.groqLanguageHint;
  if (!hint) return systemPrompt;
  return `${systemPrompt} ${hint}`;
}

function getSingle(id, localeId) {
  const pack = SINGLES[id];
  if (!pack) return null;
  const speaker = SPEAKERS[pack.speakerId];
  if (!speaker) return null;
  const locale = getLocale(localeId);
  const voice = resolveSpeakerVoice(speaker, locale);
  return {
    ...pack,
    voice,
    speaker,
    systemPrompt: appendLocaleHint(pack.systemPrompt, locale),
    locale: locale.id,
  };
}

function getSpeaker(id) {
  return SPEAKERS[id] || null;
}

function resolveSpeakerVoice(speaker, locale) {
  const loc = typeof locale === 'string' ? getLocale(locale) : locale || getLocale(DEFAULT_LOCALE);
  if (!speaker) return loc.masculine;
  // Keep canonical Deepgram voices for US English.
  if (loc.id === 'en-us' && speaker.voice) return speaker.voice;
  if (speaker.id === 'sam') return loc.masculineAlt || loc.masculine;
  if (speaker.id === 'coach') return loc.masculineWarm || loc.masculine;
  if (speaker.gender === 'feminine') return loc.feminine;
  return loc.masculine;
}

function resolveRefVoice(localeId) {
  const loc = getLocale(localeId);
  // Default US pack always uses the dedicated Ref Russ voice.
  if (loc.id === 'en-us') return REF_ANNOUNCER.voice;
  return loc.refVoice || REF_ANNOUNCER.voice;
}

function resolveRefVoiceFallbacks(localeId) {
  const loc = getLocale(localeId);
  if (loc.id === 'en-us') {
    return REF_ANNOUNCER.voiceFallbacks || [REF_ANNOUNCER.voice];
  }
  const primary = loc.refVoice || REF_ANNOUNCER.voice;
  const extras = loc.refVoiceFallbacks || REF_ANNOUNCER.voiceFallbacks || [];
  return [primary, ...extras].filter((v, i, arr) => v && arr.indexOf(v) === i);
}

function resolveIntroVoiceFallbacks() {
  return INTRO_ANNOUNCER.voiceFallbacks || [INTRO_ANNOUNCER.voice];
}

function getRefSystemPrompt(localeId) {
  return appendLocaleHint(REF_ANNOUNCER.systemPrompt, localeId);
}

function getIntroSystemPrompt(localeId) {
  return appendLocaleHint(INTRO_ANNOUNCER.systemPrompt, localeId);
}

function buildDualSystemPrompt(speaker1, speaker2, localeId) {
  const base =
    'You are a 2-person darts commentary team:\n' +
    `- Speaker 1 (${speaker1.name}): ${speaker1.style}\n` +
    `- Speaker 2 (${speaker2.name}): ${speaker2.style}\n` +
    "Analyze the player's recent throw history. Roast slumps (e.g., repeated low scores like 26) " +
    'or hype up streaks (e.g., back-to-back 140s/180s) and checkout pressure. ' +
    'Keep EACH speaker line under 10 words.\n' +
    'Respond with STRICT JSON only matching: ' +
    '{ "speaker1": "Line for speaker 1", "speaker2": "Line for speaker 2" }';
  return appendLocaleHint(base, localeId);
}

module.exports = {
  SPEAKERS,
  SINGLES,
  DUAL,
  INTRO_ANNOUNCER,
  REF_ANNOUNCER,
  VOICE_LOCALES,
  DEFAULT_LOCALE,
  listSpeakers,
  listPersonalities,
  listLocales,
  getLocale,
  getSingle,
  getSpeaker,
  resolveSpeakerVoice,
  resolveRefVoice,
  resolveRefVoiceFallbacks,
  resolveIntroVoiceFallbacks,
  getRefSystemPrompt,
  getIntroSystemPrompt,
  appendLocaleHint,
  buildDualSystemPrompt,
};
