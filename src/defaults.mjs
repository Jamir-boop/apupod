const speakerRules = `Episode format:
1. Open with a short hook or question about the topic.
2. Alex introduces the main idea.
3. Alex explains the key points in plain language.
4. Sam asks questions, adds examples, and reacts.
5. Both connect the topic to everyday life.
6. Close with 3 practical takeaways.

Rules:
- Keep a friendly, conversational tone.
- Stay on the topic.
- Do not read long passages from the source.
- Use paraphrase, analysis, and commentary.
- Alternate voices naturally.
- Alex leads. Sam reacts and deepens.`;

export const DEFAULT_DATA = {
  speakerProfiles: [
    {
      id: "speaker-example-hosts",
      name: "Example hosts",
      description: "Example host profile with two conversational hosts. Edit it or replace it with your own hosts.",
      voiceModel: "mimo-v2.5-tts",
      instructions: speakerRules,
      speakers: [
        {
          name: "Alex",
          backstory: "Alex is the main host. Alex prepares the topic, brings clear notes and examples, and keeps the episode on track.",
          personality: "Warm, curious, and clear. Alex explains ideas simply and asks good questions.",
          voiceId: "Chloe",
          style: "Warm, clear, conversational podcast voice with natural transitions.",
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
          name: "Sam",
          backstory: "Sam is the cohost. Sam reacts to the topic, adds everyday examples, and asks the questions a listener would ask.",
          personality: "Friendly, expressive, and honest, with light humor. Sam reacts without taking over the conversation.",
          voiceId: "Milo",
          style: "Friendly, expressive conversational voice with natural pauses.",
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
      id: "episode-example-format",
      name: "Example format",
      description: "Example Episode Format: one conversational episode per topic. Edit it or replace it with your own format.",
      speakerProfileId: "speaker-example-hosts",
      numSegments: 3,
      language: "en-US",
      targetMinutes: 10
    }
  ]
};
