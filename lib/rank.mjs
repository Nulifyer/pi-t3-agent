// A small ranker for the tool shelf. Pi's own BM25 ranker is not exported to extensions.
const terms = (text) =>
  String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)
    .filter((term) => term.length > 1)
    .map((term) => (term.length > 3 && term.endsWith('s') && !term.endsWith('ss') ? term.slice(0, -1) : term));

/**
 * The best `limit` tools for a query. A query word in the tool's own name counts three times a word
 * in its description or parameter names, and a query that is exactly a tool's name ranks it first.
 */
export function rankTools(query, tools, limit) {
  const wanted = [...new Set(terms(query))];
  const exact = String(query).trim().toLowerCase();
  return tools
    .map((tool) => {
      const local = tool.name.split('__').at(-1);
      const inName = new Set(terms(local));
      const inText = new Set(terms(`${tool.description ?? ''} ${Object.keys(tool.parameters?.properties ?? {}).join(' ')}`));
      let score = exact === local.toLowerCase() || exact === tool.name.toLowerCase() ? 100 : 0;
      for (const term of wanted) score += (inName.has(term) ? 3 : 0) + (inText.has(term) ? 1 : 0);
      return { tool, score };
    })
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((match) => match.tool);
}
