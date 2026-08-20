// Step-2 gate: prove the Agent SDK completes a real turn using the existing
// Claude Code login, with NO ANTHROPIC_API_KEY set. If this needs a key, the
// whole "runs on my Claude account" premise is wrong and we stop here.
import { query } from "@anthropic-ai/claude-agent-sdk";

console.log("[gate] ANTHROPIC_API_KEY set?", Boolean(process.env.ANTHROPIC_API_KEY));
console.log("[gate] starting query()...\n");

try {
  for await (const message of query({
    prompt: "Reply with exactly one short sentence confirming you are running. Do not use any tools.",
    options: { allowedTools: [] },
  })) {
    if (message.type === "system" && message.subtype === "init") {
      console.log("[gate] session init:", message.session_id, "model:", (message as any).model);
    } else if (message.type === "assistant") {
      const text = message.message.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
      if (text) console.log("[gate] assistant:", text);
    } else if (message.type === "result") {
      console.log("\n[gate] RESULT subtype:", message.subtype);
      if ("result" in message) console.log("[gate] result text:", (message as any).result);
      console.log("[gate] cost usd:", (message as any).total_cost_usd);
    }
  }
  console.log("\n[gate] PASS — completed a turn without an API key.");
} catch (err) {
  console.error("\n[gate] FAIL —", err);
  process.exit(1);
}
