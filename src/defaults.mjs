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
      targetMinutes: 18
    }
  ]
};
