// The run limits a template's words name: the engine's round-trip cap and the attempts phrase.

/** How often a step may send the work back to an earlier step before Tokama asks you: the engine's limit. */
export const ROUND_TRIPS = 3;

export const attempts = (count: number): string => (count === 1 ? "1 attempt" : `${count} attempts`);
