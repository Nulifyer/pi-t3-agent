/** A question tool. T3 Code shows Pi's dialogs in its composer, so the answer comes from the user. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function ask(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "Ask user",
    description: "Ask the user one question and wait for the answer. Give options when the choice is between known alternatives; omit them for a free-text answer. Use it only when a decision is the user's to make.",
    parameters: Type.Object({
      question: Type.String({ minLength: 1 }),
      options: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 2, maxItems: 8 })),
    }),
    // Not callable from scripts: it blocks on a person.
    exposure: "model-only",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) throw new Error("No interactive client is attached, so the question cannot be shown.");
      const answer = params.options
        ? await ctx.ui.select(params.question, params.options, { signal })
        : await ctx.ui.input(params.question, undefined, { signal });
      return {
        content: [{ type: "text", text: answer === undefined ? "The user dismissed the question without answering." : answer }],
        details: { answer: answer ?? null },
      };
    },
  });
}
