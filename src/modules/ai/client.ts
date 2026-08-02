import Anthropic from "@anthropic-ai/sdk";

import { env } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export class AiUnavailableError extends AppError {
  constructor() {
    super("AI features are not configured for this deployment.");
  }
}

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!env.ANTHROPIC_API_KEY) throw new AiUnavailableError();
  // Bound the request: the SDK default is a 10-minute timeout, and these
  // calls run inside a user-triggered server action holding a DB
  // connection. A stalled generation must fail fast, not pin a
  // connection from the small pool for minutes.
  cachedClient ??= new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    timeout: 60_000,
    maxRetries: 1,
  });
  return cachedClient;
}

export const AI_MODEL = "claude-opus-4-8";

/**
 * One completion, text out. Adaptive thinking with medium effort: these
 * are drafting tasks where a few seconds matter more than squeezing out
 * the last percent of quality.
 */
export async function generateText(options: {
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<string> {
  const client = getClient();

  try {
    const response = await client.messages.create({
      model: AI_MODEL,
      max_tokens: options.maxTokens ?? 4096,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: options.system,
      messages: [{ role: "user", content: options.prompt }],
    });

    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!text) throw new AppError("The model returned an empty draft.");
    return text;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Anthropic.RateLimitError) {
      throw new AppError(
        "AI is briefly over capacity, try again in a minute.",
      );
    }
    if (error instanceof Anthropic.APIError) {
      logger.error({ err: error, status: error.status }, "anthropic api error");
      throw new AppError("AI generation failed. Please try again.");
    }
    throw error;
  }
}
