import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  pi.registerTool(defineTool({
    name: "ask_user", label: "Ask user",
    description: "Ask the user a question with selectable choices through the T3 composer. Use when a user preference or clarification is needed.",
    parameters: Type.Object({question: Type.String(), choices: Type.Array(Type.String(), {minItems: 2, maxItems: 8})}),
    async execute(_id, params, signal, _update, ctx) {
      if (!ctx.hasUI) return {content: [{type: "text", text: "An interactive client is required to answer this question."}], isError: true};
      const answer = await ctx.ui.select(params.question, params.choices, {signal});
      return {content: [{type: "text", text: answer === undefined ? "Question cancelled." : answer}], details: {answer: answer ?? null}};
    }
  }));
}
