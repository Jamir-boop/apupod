import { createPodcastServer } from "./app.mjs";

const host = "127.0.0.1";
// Created first: it loads the config-dir .env, which may set PORT.
const server = await createPodcastServer();
const port = Number(process.env.PORT || "4173");
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be an integer from 1 to 65535.");

server.listen(port, host, () => {
  console.log(`apupod: http://${host}:${port}`);
});
