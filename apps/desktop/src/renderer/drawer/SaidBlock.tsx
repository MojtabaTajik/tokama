// What a step's agent said about its own work, as plain text: "{Agent} says" with the headline and
// its tag on a question card, "In short" with the headline and points above the reader. The words
// are the agent's own, never shortened here (the engine cut them to their caps), and are rendered
// as React text only.
import type { Said } from "@tokama/core";
import { readTag } from "../../shared/item-said.js";
import { Pill } from "../ui/Pill.js";

const TEXT = {
  says: (agent: string) => `${agent} says`,
  inShort: "In short",
  morePoints: (count: number) => `+${count} more in the output`,
} as const;

/** The headline, after "{Agent} says", with the read time when the reply is a must-read. */
export function SaidLine({ said, agent }: { readonly said: Said; readonly agent: string | undefined }) {
  const tag = readTag(said);
  return (
    <p className="said-line">
      <span className="said-who">{TEXT.says(agent ?? "The agent")}</span>
      <span className="said-headline">{said.headline}</span>
      {tag !== undefined && <Pill>{tag}</Pill>}
    </p>
  );
}

/** "In short": the headline and the points the agent wrote; nothing for first lines the agent did not write as a headline. */
export function InShort({ said }: { readonly said: Said }) {
  if (said.source !== "headline") return null;
  return (
    <section className="said-short" aria-label={TEXT.inShort}>
      <h3 className="said-short-title">{TEXT.inShort}</h3>
      <p className="said-headline">{said.headline}</p>
      {said.points.length > 0 && (
        <ul className="said-points">
          {said.points.map((point, index) => (
            <li key={index}>{point}</li>
          ))}
        </ul>
      )}
      {said.morePoints > 0 && <p className="said-more">{TEXT.morePoints(said.morePoints)}</p>}
    </section>
  );
}
