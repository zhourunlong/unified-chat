export { createSseParser } from "../../shared/sse.js";

export function writeSseEvent(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function endSse(response) {
  response.write("data: [DONE]\n\n");
  response.end();
}
