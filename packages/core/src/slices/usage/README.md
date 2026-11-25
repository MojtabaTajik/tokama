# usage

Usage reports from recorded agent calls: tokens and estimated cost by day, workflow and item, and which reading of each AI CLI's plan windows to show.
- Costs are estimates: a local model costs nothing, else the CLI's own figure, else the dated price table in `prices.ts`. An unknown model stays unpriced; it is never matched to a near name.
- Plan windows come from the CLI's usage answer, then the rate-limit events of Tokama's calls, then the CLI's cache; the first fresh one wins, and a window past its reset time is dropped. Nothing known means "unknown", never a guess.
- Pure functions over records: it reads no files and starts no processes. The engine gives it the calls (from the SQLite index or the sample set) and the plan readings (from the adapters).
