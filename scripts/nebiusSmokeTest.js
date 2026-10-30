require("dotenv").config({ quiet: true });

const { createNebiusClient } = require("../services/llm/nebiusClient");

async function main() {
  const client = createNebiusClient();
  const result = await client.generateChatCompletion({
    systemPrompt: "Reply with the single word READY.",
    userPrompt: "Respond now.",
    temperature: 0,
    maxTokens: 8,
  });

  console.log(
    JSON.stringify({
      provider: result.provider,
      model: result.model,
      finishReason: result.finishReason,
      usage: result.usage,
      requestId: result.requestId,
      latencyMs: result.latencyMs,
      responseReceived: result.content.length > 0,
    }),
  );
}

main().catch((error) => {
  const safeError = typeof error.toJSON === "function"
    ? error.toJSON()
    : {
        code: "UNKNOWN_PROVIDER_ERROR",
        message: "Nebius smoke test failed.",
      };
  console.error(JSON.stringify(safeError));
  process.exitCode = 1;
});
