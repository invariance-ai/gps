import Anthropic from "@anthropic-ai/sdk";

/**
 * Thin wrapper around the Anthropic SDK so we can centralize:
 *   - model defaults (claude-opus-4-7 for analysis tasks)
 *   - adaptive thinking
 *   - streaming + finalMessage
 *   - dry-run mode (no API call; returns the prompt for inspection)
 */

export interface GpsLlmOptions {
  apiKey?: string;
  model?: string;
  /** Return the rendered prompt without making an API call. */
  dryRun?: boolean;
}

export interface CompletionResult {
  text: string;
  /** Populated when dryRun is true. */
  dry_run_prompt?: { system: string; user: string };
  usage?: { input_tokens: number; output_tokens: number };
}

const DEFAULT_MODEL = "claude-opus-4-7";

export class GpsLlm {
  private readonly client: Anthropic | null;
  private readonly model: string;
  private readonly dryRun: boolean;

  constructor(opts: GpsLlmOptions = {}) {
    this.dryRun = opts.dryRun === true;
    this.model = opts.model ?? DEFAULT_MODEL;
    if (this.dryRun) {
      this.client = null;
    } else {
      const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error(
          "ANTHROPIC_API_KEY not set. Either export it, pass --api-key, or run with --dry-run.",
        );
      }
      this.client = new Anthropic({ apiKey });
    }
  }

  /**
   * One-shot completion. Streams to avoid HTTP timeouts on long responses;
   * returns the assembled final message.
   */
  async complete(args: {
    system: string;
    user: string;
    maxTokens?: number;
  }): Promise<CompletionResult> {
    if (this.dryRun || !this.client) {
      return {
        text: "[dry-run]",
        dry_run_prompt: { system: args.system, user: args.user },
      };
    }

    try {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: args.maxTokens ?? 16000,
        thinking: { type: "adaptive" },
        system: args.system,
        messages: [{ role: "user", content: args.user }],
      });

      const message = await stream.finalMessage();
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");

      return {
        text,
        usage: {
          input_tokens: message.usage.input_tokens,
          output_tokens: message.usage.output_tokens,
        },
      };
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new Error("Anthropic API key invalid. Check ANTHROPIC_API_KEY.");
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new Error("Anthropic rate limited. Retry shortly.");
      }
      if (err instanceof Anthropic.APIError) {
        throw new Error(`Anthropic API error ${err.status}: ${err.message}`);
      }
      throw err;
    }
  }
}
