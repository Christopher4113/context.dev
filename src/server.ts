import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Credits, groundcheck } from "./groundcheck.ts";

try {
  process.loadEnvFile();
} catch {}

const PORT = Number(process.env.PORT ?? 3000);
const BUDGET = Number(process.env.GROUNDCHECK_REQUEST_BUDGET ?? 200); // Context.dev credits per request

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
    // Stream one JSON event per line so fields light up as they are judged.
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
    try {
      await groundcheck(question.trim(), (schema ?? undefined) as Record<string, unknown> | undefined, {
        credits: new Credits(BUDGET),
        onEvent: (e) => res.write(JSON.stringify(e) + "\n"),
      });
    } catch (e: any) {
      res.write(JSON.stringify({ type: "error", message: String(e?.message ?? e) }) + "\n");
    }
    return res.end();
  }
  res.writeHead(404).end("Not found");
}).listen(PORT, () => console.log(`Groundcheck demo on http://localhost:${PORT}`));
