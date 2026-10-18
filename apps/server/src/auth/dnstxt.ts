import { promises as dns } from "node:dns";

/** TXT lookups, behind an object so tests can answer them without real DNS. */
export const txt = {
  resolve: (name: string): Promise<string[][]> => dns.resolveTxt(name),
};
