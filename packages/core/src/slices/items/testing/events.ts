// Test helpers: build item events without repeating the envelope.
import {
  ITEM_EVENT_SCHEMA_VERSION,
  parseItemEvent,
  type HostId,
  type ItemEvent,
  type ItemEventBody,
  type ItemId,
  type RepoId,
  type StepId,
  type TemplateRef,
} from "../../../kernel/schemas/index.js";
import { templateSnapshot } from "../store.js";

export const HOST = "host_0190a000-0000-7000-8000-000000000001" as HostId;
export const OTHER_HOST = "host_0190a000-0000-7000-8000-000000000002" as HostId;
export const ITEM = "item_0190a000-0000-7000-8000-00000000000a" as ItemId;
export const DECISION = "decision_0190a000-0000-7000-8000-00000000000d";
export const T0 = Date.UTC(2026, 10, 24, 10, 0, 0);
export const BUILD = "build" as StepId;
export const REVIEW = "review" as StepId;
export const TEMPLATE_REF = "orders-api/quick-fix" as TemplateRef;
export const TEMPLATE = { schemaVersion: 1, ref: TEMPLATE_REF, name: "Quick fix", steps: [{ id: "build" }, { id: "review" }] };

export const created = (): ItemEventBody => ({
  type: "item_created",
  templateRef: TEMPLATE_REF,
  template: templateSnapshot(TEMPLATE),
  title: "Fix the checkout timeout",
  text: "Checkout times out after 30 s",
  repoIds: ["orders-api" as RepoId],
  steps: [{ id: BUILD }, { id: REVIEW }],
});

/** Wraps bodies in envelopes: seq from 0, one second apart, all from HOST unless given. */
export function events(bodies: readonly ItemEventBody[], options: { hostId?: HostId; itemId?: ItemId } = {}): ItemEvent[] {
  return bodies.map((body, seq) => {
    const parsed = parseItemEvent({
      ...body,
      schemaVersion: ITEM_EVENT_SCHEMA_VERSION,
      itemId: options.itemId ?? ITEM,
      seq,
      hostId: options.hostId ?? HOST,
      at: T0 + seq * 1000,
    });
    if (!parsed.ok) throw new Error(`bad test event ${body.type}: ${JSON.stringify(parsed.error.issues)}`);
    return parsed.value;
  });
}
