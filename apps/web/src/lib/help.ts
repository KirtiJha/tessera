/**
 * How each number is worked out, in one place so a figure explains itself the
 * same way on the session page, Analytics, a team's page and the summary card.
 */
export const HELP = {
  cost: "Tokens priced at your organisation's model prices (Model prices), per model, for the session and every agent it ran, cache reads and writes included. An estimate: the provider's invoice is the bill.",
  tokens: "Input, output, cache-read and cache-write tokens of the session and its agents, as Claude Code's transcript records them.",
  context: "How full the context window is: the size of the latest request against the model's window. With the Tessera mod it is Claude Code's own figure. A blowout is the window filling up and Claude Code compacting the conversation, which loses detail.",
  cacheShare: "The share of input tokens read from the prompt cache rather than sent fresh. Cache reads cost about a tenth of fresh input, so a higher share is cheaper.",
  change: "Against the period of the same length just before this one. Amber means spend rose, teal that it fell; new means there was no spend before.",
  forecast: "This month's spend so far, plus the average day of the last seven full days for each day left in the month (UTC).",
  answeredHere: "Prompts that waited on a person and were answered in Tessera (the console, a phone, or Slack) rather than in the terminal. Mean wait is from the prompt appearing to its answer, wherever it came from.",
  waited: "The median time a prompt in these sessions waited for a person, from appearing to being answered or closed.",
  answered: "Prompts in anyone's sessions that this person or team answered in Tessera, and the median time they took.",
  spendDays: "Estimated spend per UTC day, rolled up from per-minute samples. A marked day spent more than three standard deviations above the two weeks before it.",
} as const;
