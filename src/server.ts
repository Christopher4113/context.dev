import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { answersCached } from "./context.ts";
import { Credits, groundcheck } from "./groundcheck.ts";

try {
  process.loadEnvFile();
} catch {}

const PORT = Number(process.env.PORT ?? 3000);
const BUDGET = Number(process.env.GROUNDCHECK_REQUEST_BUDGET ?? 200); // Context.dev credits per request
// When set (do this on any public deployment), only visitors with the passcode can run new questions on your API keys.
// Everyone else can replay cached questions, like the example chips, for free.
const PASSCODE = process.env.DEMO_PASSCODE;

function authorized(req: IncomingMessage): boolean {
  if (!PASSCODE) return true;
  const given = Buffer.from(String(req.headers["x-demo-passcode"] ?? ""));
  const want = Buffer.from(PASSCODE);
  return given.length === want.length && timingSafeEqual(given, want);
}

createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(await readFile("web/index.html"));
  }
  if (req.method === "POST" && req.url === "/api/check") {
    let body: { question?: unknown; schema?: unknown };
    try {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 50_000) throw new Error("too large");
      }
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end("Invalid JSON body");
      return;
    }
    const { question, schema } = body;
    if (typeof question !== "string" || !question.trim() || question.length > 1000 || (schema != null && (typeof schema !== "object" || Array.isArray(schema)))) {
      res.writeHead(400).end("Expected { question: string, schema?: object }");
      return;
    }
    const live = authorized(req);
    // ponytail: gate is "Answers response already cached"; a cached question whose judge prompt changed would still call the LLM.
    if (!live && !(schema && (await answersCached(question.trim(), schema as Record<string, unknown>)))) {
      res.writeHead(401, { "content-type": "text/plain" }).end("New questions need the demo passcode. The example questions work without one.");
      return;
    }
    // Stream one JSON event per line so fields light up as they are judged.
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
    try {
      await groundcheck(question.trim(), (schema ?? undefined) as Record<string, unknown> | undefined, {
        credits: new Credits(live ? BUDGET : 0), // without the passcode, any cache miss stops instead of spending
        onEvent: (e) => res.write(JSON.stringify(e) + "\n"),
      });
    } catch (e: any) {
      res.write(JSON.stringify({ type: "error", message: String(e?.message ?? e) }) + "\n");
    }
    return res.end();
  }
  res.writeHead(404).end("Not found");
}).listen(PORT, () => console.log(`Groundcheck demo on http://localhost:${PORT}`));
