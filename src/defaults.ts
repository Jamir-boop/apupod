const speakerRules = `Episode format:
1. Open with a gossip-style hook or strong question about the chapter.
2. Valeria presents the chapter's central theme.
3. Valeria summarizes the main ideas without reading long passages verbatim.
4. Diego reacts from a male perspective with humor, emotion, or a brief personal story.
5. Both connect the theme to parenting, family, couples, or childhood.
6. Close with 3 practical takeaways from the chapter.

Rules:
- Maintain intelligent gossip-panel style throughout.
- Do not turn the episode into a flat summary.
- Do not lose focus on the book.
- Do not read full chapters or long literal passages.
- Use paraphrase, analysis, and commentary.
- Alternate voices naturally.
- Valeria leads. Diego reacts and deepens.`;

const defaultBriefing = `Create a podcast episode for ONE chapter of the book The Book You Wish Your Parents Had Read. The episode must sound like an intelligent gossip panel between two people who read the chapter and are commenting on it naturally.

Voice dynamics:
- Valeria is the main host. She leads the episode, presents the chapter, summarizes central ideas, connects concepts, and keeps focus on the book.
- Diego is the male cohost. He reacts, asks questions, jokes, gets emotional when the topic hits him, and shares a male perspective without dominating the conversation.

Mandatory 5-segment structure:

Segment 1 — Hook entry
Open with a strong question, controversial statement, or gossip-style comment related to the chapter's theme. Briefly introduce what the chapter is about and why it matters.

Segment 2 — What the chapter says
Valeria explains the chapter's main ideas in clear language. Do not read long literal passages. Use paraphrase, summary, and commentary. Diego may react briefly, but Valeria maintains control.

Segment 3 — Gossip panel and debate
Both comment on the ideas as if sitting at an analysis table with confidence. Include natural phrases, light disagreements, everyday examples, uncomfortable questions, and observations about family, parenting, childhood, couples, or emotional communication.

Segment 4 — Personal stories and perspective
Diego shares a brief story or reflection from a male perspective. He may use dry humor or get emotional, but without exaggerating. Valeria connects that story to the chapter and deepens without turning it into therapy or drifting from the book.

Segment 5 — What we learned
Close with a clear reflection. Include 3 practical takeaways from the chapter:
1. Something we can observe in our family history.
2. Something we can change in how we communicate.
3. Something we can apply with children, parents, partners, or ourselves.

Style rules:
- Maintain conversational, agile, and emotionally intelligent podcast tone.
- Style: elegant gossip, not flat academic summary.
- Do not lose focus on the chapter.
- Do not invent quotes from the book.
- Do not read full chapters or long literal passages.
- Use paraphrase and analysis.
- Alternate voices naturally.
- Valeria must lead.
- Diego must provide contrast, humor, and emotion.
- Ending should feel reflective, not preachy.`;

const episodeOneInstructions = `This episode corresponds to the book's first theme: how our emotional past returns when we parent, even when we think we have moved past it.

Episode objective:
Explore how childhood experiences, unresolved wounds, fear, shame, insecurity, or family memories can be activated when a child does something that makes us uncomfortable. The focus must be on the chapter's central idea: many parental reactions say more about the adult's history than about the child's behavior.

Initial hook:
Open with an intelligent gossip tone. Something like: "What if when you scold your child, you are actually talking to your twenty-year-old self?" Do not use that exact phrase if it does not fit; generate a natural entry.

Points that must be covered:
1. Parents often react from their own childhood.
2. A child can activate the adult's memories, insecurities, or wounds.
3. Before correcting the child, the adult must look at which own emotion was activated.
4. It is not about blaming previous parents, but about breaking automatic repetition.
5. Repair begins when the adult recognizes: "this was not only about the child, it was also about me."

Suggested stories:
- Diego can tell a brief story about men who say "I was raised this way and turned out fine," but then discover they do not know how to apologize or express sadness.
- Valeria can mention an everyday example: a child asks for help, the adult gets irritated, but the irritation comes from having been ridiculed or ignored when they were small.

Mandatory closing:
End with "What we learned today" and three takeaways: observe when the reaction is bigger than the situation, ask ourselves which part of our history was activated, and respond to the child from the present.`;

const episodeTitles = [
  "Ep. 01 — El pasado vuelve a criar contigo",
  "Ep. 02 — Romper no es final: reparar vínculo",
  "Ep. 03 — Reparar pasado para no repetirlo",
  "Ep. 04 — Cómo nos hablamos por dentro",
  "Ep. 05 — Trampa de juzgar buen padre / mal padre",
  "Ep. 06 — No es estructura familiar, es trato",
  "Ep. 07 — Cuando padres no están juntos",
  "Ep. 08 — Cómo hacer dolor soportable",
  "Ep. 09 — Cuando padres siguen juntos",
  "Ep. 10 — Cómo discutir sin destruir",
  "Ep. 11 — Crear buena voluntad en casa",
  "Ep. 12 — Aprender a contener emociones",
  "Ep. 13 — Validar sentimientos sin perder límites",
  "Ep. 14 — Peligro de negar emociones",
  "Ep. 15 — Ruptura, reparación y emociones",
  "Ep. 16 — Sentir con niño, no solo manejarlo",
  "Ep. 17 — Monstruos debajo cama",
  "Ep. 18 — Aceptar cada estado de ánimo",
  "Ep. 19 — Exigencia de ser feliz",
  "Ep. 20 — Distraer para evitar sentir",
  "Ep. 21 — Embarazo y vínculo",
  "Ep. 22 — Magia simpática",
  "Ep. 23 — Tribu parental",
  "Ep. 24 — Bebé y tú",
  "Ep. 25 — Plan de parto",
  "Ep. 26 — Procesar experiencia de parto",
  "Ep. 27 — Primer contacto",
  "Ep. 28 — Vínculo inicial",
  "Ep. 29 — Para criar, necesitamos ser cuidados",
  "Ep. 30 — Teoría del apego",
  "Ep. 31 — Llanto coercitivo",
  "Ep. 32 — Hormonas diferentes, tú diferente",
  "Ep. 33 — Soledad parental",
  "Ep. 34 — Depresión posparto",
  "Ep. 35 — Vínculo",
  "Ep. 36 — Ida y vuelta en comunicación",
  "Ep. 37 — Cómo empieza diálogo",
  "Ep. 38 — Turnarse",
  "Ep. 39 — Cuando diálogo cuesta",
  "Ep. 40 — Observación comprometida",
  "Ep. 41 — Adicción al teléfono",
  "Ep. 42 — Capacidad innata de dialogar",
  "Ep. 43 — Bebés y niños también son personas",
  "Ep. 44 — Cómo entrenamos niños para ser molestos",
  "Ep. 45 — Por qué niño se vuelve pegajoso",
  "Ep. 46 — Dar sentido al cuidado infantil",
  "Ep. 47 — Estado de ánimo base del niño",
  "Ep. 48 — Sueño",
  "Ep. 49 — Guiar sueño sin forzar",
  "Ep. 50 — Ayudar, no rescatar",
  "Ep. 51 — Juego",
  "Ep. 52 — Modelos de conducta",
  "Ep. 53 — Juego de ganar y perder",
  "Ep. 54 — Trabajar con presente, no fantasía futura",
  "Ep. 55 — Cualidades para portarse bien",
  "Ep. 56 — Conducta incómoda como mensaje",
  "Ep. 57 — Invertir tiempo antes, no castigar después",
  "Ep. 58 — Poner sentimientos en palabras",
  "Ep. 59 — Cuando explicaciones no ayudan",
  "Ep. 60 — Qué tan estricto debe ser un padre",
  "Ep. 61 — Berrinches",
  "Ep. 62 — Quejas",
  "Ep. 63 — Mentiras parentales",
  "Ep. 64 — Mentiras infantiles",
  "Ep. 65 — Límites: definirte tú, no etiquetar niño",
  "Ep. 66 — Límites con niños mayores y adolescentes",
  "Ep. 67 — Adolescentes y jóvenes adultos",
  "Ep. 68 — Cuando todos somos adultos"
];

export const DEFAULT_DATA = {
  speakerProfiles: [
    {
      id: "speaker-chisme-crianza",
      name: "Chisme de Crianza — Capítulo por Capítulo",
      description: "Podcast with an intelligent gossip-panel style covering each chapter of The Book You Wish Your Parents Had Read. Two hosts discuss the book with conversational energy, personal stories, and emotional perspective, without losing focus on the chapter's central ideas.",
      voiceModel: "mimo-v2.5-tts",
      instructions: speakerRules,
      speakers: [
        {
          name: "Valeria",
          backstory: "Valeria is the main host. She read the full chapter before the episode and arrives with clear notes, concrete examples, and prepared questions. She has emotional sensitivity and keeps the episode anchored to the book.",
          personality: "Natural, warm, agile delivery with an elegant gossip-panel tone. Curious, observant, direct, and emotionally intelligent. She does not sermonize or read long passages verbatim.",
          voiceId: "Chloe",
          style: "Warm, intelligent, agile female voice. Conversational podcast sound, clean diction, contained emotion, and natural transitions. Do not sound like a commercial announcer.",
          chatterboxExaggeration: 0.7,
          chatterboxCfgWeight: 0.3,
          chatterboxTemperature: 0.7,
          mimoTemperature: null,
          mimoTopP: null,
          mimoInstructionPreset: "",
          mimoInstructionText: "",
          elevenlabsStability: 0.5,
          elevenlabsSimilarityBoost: 0.75,
          elevenlabsStyle: 0,
          elevenlabsUseSpeakerBoost: true,
          elevenlabsSpeed: 1,
          elevenlabsSeed: null,
          elevenlabsTextNormalization: "auto",
          ttsModelOverride: ""
        },
        {
          name: "Diego",
          backstory: "Diego is the male cohost. He reacts from a male perspective on parents, children, partners, and men who did not always learn to talk about emotions. He shares brief stories and honest observations.",
          personality: "Conversational, expressive, honest delivery with dry humor. He reacts, interrupts with moderate naturalness, and admits when a topic hits him emotionally without dominating the conversation.",
          voiceId: "Milo",
          style: "Medium-to-deep male voice, warm and expressive. Use dry humor, natural pauses, and honest emotion. Do not sound like a commercial announcer or exaggerate.",
          chatterboxExaggeration: 0.7,
          chatterboxCfgWeight: 0.3,
          chatterboxTemperature: 0.7,
          mimoTemperature: null,
          mimoTopP: null,
          mimoInstructionPreset: "",
          mimoInstructionText: "",
          elevenlabsStability: 0.5,
          elevenlabsSimilarityBoost: 0.75,
          elevenlabsStyle: 0,
          elevenlabsUseSpeakerBoost: true,
          elevenlabsSpeed: 1,
          elevenlabsSeed: null,
          elevenlabsTextNormalization: "auto",
          ttsModelOverride: ""
        }
      ]
    }
  ],
  episodeProfiles: [
    {
      id: "episode-chisme-crianza",
      name: "Chisme de Crianza — Episodio por Capítulo",
      description: "Reusable profile for generating one episode per chapter. Valeria leads the reading and analysis; Diego comments with humor, emotion, and personal stories. The episode stays focused on the book and closes with a clear reflection.",
      speakerProfileId: "speaker-chisme-crianza",
      numSegments: 5,
      outlineModel: "mimo-v2.5-pro",
      transcriptModel: "mimo-v2.5-pro",
      language: "es-419",
      targetMinutes: 18,
      defaultBriefing
    }
  ],
  episodeSeeds: episodeTitles.map((name, index) => ({
    name,
    additionalInstructions: index === 0 ? episodeOneInstructions : ""
  }))
};
