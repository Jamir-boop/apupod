import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { createAppContext, routeRequest } from "./legacy-app.js";

export {
  ELEVENLABS_MODELS,
  MIMO_VOICES,
  TTS_MODELS,
  clipCacheKey,
  parseTranscript,
  transcriptSpeakerRule,
  transcriptToMarkdown,
  validateOutline,
  validateProfileData,
  validateTranscriptJson,
  writeAudioAsWav,
} from "./legacy-app.js";

export { DEFAULT_DATA } from "./defaults.js";

export interface BuildAppOptions {
  rootDir?: string;
  fetchImpl?: typeof fetch;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: false,
    bodyLimit: 5 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    "*",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  const context = await createAppContext(options);
  app.decorate("context", context);

  app.all("/*", async (request, reply) => {
    const raw = request.raw as typeof request.raw & { fastifyBodyBuffer?: unknown };
    if (request.body != null) raw.fastifyBodyBuffer = request.body;
    reply.hijack();
    try {
      await routeRequest(raw, reply.raw, context);
    } catch (error) {
      if (reply.raw.headersSent) {
        reply.raw.end();
        return;
      }
      const statusCode = typeof error === "object" && error && "statusCode" in error
        ? Number((error as { statusCode?: unknown }).statusCode) || 500
        : 500;
      const message = error instanceof Error ? error.message : String(error);
      const body = Buffer.from(JSON.stringify({ error: message }));
      reply.raw.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      reply.raw.end(body);
    }
  });

  await app.ready();
  return app;
}

export async function createPodcastServer(options: BuildAppOptions = {}) {
  const app = await buildApp(options);
  return app.server;
}
