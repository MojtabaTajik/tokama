// The read-only flow diagram of a template: Start, the steps, Finish, in one row, with a line for
// each loop. A retry loops over its own step (drawn above); a `back:` goes back to an earlier step
// (drawn below, one level deeper per loop so the lines do not cross). Pure geometry, tested
// without React; the component only draws it.
import type { TemplateStepView, TemplateView } from "@tokama/core";

export const SLOT = 128;
export const NODE_HEIGHT = 48;
const GAP = 24;
const SELF_ROOM = 52;
const BACK_ROOM = 44;
const BACK_STEP = 26;

export type Dot = 1 | 2 | 3 | "neutral";

export interface FlowNode {
  readonly key: string;
  readonly label: string;
  readonly kind: "start" | "step" | "finish";
  /** The agent's identity dot; steps only. */
  readonly dot?: Dot;
  readonly x: number;
  readonly width: number;
}

export interface FlowLoop {
  readonly kind: "self" | "back";
  /** Node indexes: Start is 0, the first step 1. */
  readonly from: number;
  readonly to: number;
  readonly label: string;
  /** SVG path of the line, and of its arrow head at `to`. */
  readonly path: string;
  readonly head: string;
  /** The label's centre. */
  readonly labelX: number;
  readonly labelY: number;
}

export interface Flow {
  readonly width: number;
  readonly height: number;
  /** The top of the node row. */
  readonly top: number;
  readonly nodes: readonly FlowNode[];
  /** Arrows between neighbours: from x1 to x2 at the row's middle. */
  readonly arrows: readonly { readonly x1: number; readonly x2: number; readonly y: number }[];
  readonly loops: readonly FlowLoop[];
  /** The whole diagram in words, for screen readers. */
  readonly description: string;
}

/** The agent's dot by its join order, as on the board: 1 to 3, then neutral. */
export function dotOf(agentId: string, agents: readonly { readonly id: string }[]): Dot {
  const index = agents.findIndex((agent) => agent.id === agentId);
  return index >= 0 && index < 3 ? ((index + 1) as 1 | 2 | 3) : "neutral";
}

interface LoopSpec {
  readonly kind: "self" | "back";
  readonly from: number;
  readonly to: number;
  readonly label: string;
  readonly words: string;
}

const upTo = (count: number) => `up to ${count}`;

function loopsOf(steps: readonly TemplateStepView[]): LoopSpec[] {
  const index = (id: string) => steps.findIndex((step) => step.id === id) + 1;
  const loops: LoopSpec[] = [];
  steps.forEach((step, i) => {
    const at = i + 1;
    const failing = step.doneWhen === "checks pass" ? "checks fail" : "fails";
    const whenFailing = step.doneWhen === "checks pass" ? "when its checks fail" : "when it fails";
    if (step.ifFailed.action === "retry") {
      loops.push({ kind: "self", from: at, to: at, label: `${failing} · retry, ${upTo(step.maxAttempts)}`, words: `${step.name} tries again ${whenFailing}, ${upTo(step.maxAttempts)} attempts` });
    } else if (step.ifFailed.action === "back") {
      const to = index(step.ifFailed.stepId);
      const target = steps[to - 1]?.name ?? step.ifFailed.stepId;
      loops.push({ kind: to === at ? "self" : "back", from: at, to, label: `${failing} · back to ${target}`, words: `${step.name} goes back to ${target} ${whenFailing}, ${upTo(step.maxAttempts)} attempts` });
    }
    if (step.ifChangesRequested?.action === "back") {
      const to = index(step.ifChangesRequested.stepId);
      const target = steps[to - 1]?.name ?? step.ifChangesRequested.stepId;
      loops.push({ kind: to === at ? "self" : "back", from: at, to, label: `changes · back to ${target}`, words: `${step.name} goes back to ${target} when it asks for changes, ${upTo(step.maxAttempts)} times` });
    }
  });
  return loops;
}

export function flowOf(template: Pick<TemplateView, "steps">, agents: readonly { readonly id: string }[]): Flow {
  const specs = loopsOf(template.steps);
  const selfAbove = specs.some((loop) => loop.kind === "self");
  const backs = specs.filter((loop) => loop.kind === "back").length;
  const top = selfAbove ? SELF_ROOM : 12;
  const bottom = top + NODE_HEIGHT;
  const middle = top + NODE_HEIGHT / 2;
  const width = SLOT * (template.steps.length + 2);
  const nodeWidth = SLOT - GAP;
  const x = (i: number) => i * SLOT + GAP / 2;
  const centre = (i: number) => x(i) + nodeWidth / 2;

  const nodes: FlowNode[] = [
    { key: "start", label: "Start", kind: "start", x: x(0), width: nodeWidth },
    ...template.steps.map((step, i): FlowNode => ({ key: `step:${step.id}`, label: step.name, kind: "step", dot: dotOf(step.agentId, agents), x: x(i + 1), width: nodeWidth })),
    { key: "finish", label: "Finish", kind: "finish", x: x(template.steps.length + 1), width: nodeWidth },
  ];
  const arrows = nodes.slice(1).map((_, i) => ({ x1: x(i) + nodeWidth, x2: x(i + 1), y: middle }));

  let depth = 0;
  const loops = specs.map((spec): FlowLoop => {
    const line = { kind: spec.kind, from: spec.from, to: spec.to, label: spec.label };
    if (spec.kind === "self") {
      const c = centre(spec.from);
      const a = c + 16;
      const b = c - 16;
      const lift = top - 40;
      return {
        ...line,
        path: `M${a} ${top} C${a + 26} ${lift} ${b - 26} ${lift} ${b} ${top}`,
        head: `M${b - 5} ${top - 7} L${b} ${top} L${b + 5} ${top - 6}`,
        labelX: c,
        labelY: 10,
      };
    }
    const drop = bottom + BACK_ROOM - 10 + depth * BACK_STEP;
    depth += 1;
    const fx = centre(spec.from);
    const tx = centre(spec.to);
    return {
      ...line,
      path: `M${fx} ${bottom} C${fx} ${drop} ${tx} ${drop} ${tx} ${bottom}`,
      head: `M${tx - 5} ${bottom + 7} L${tx} ${bottom} L${tx + 5} ${bottom + 7}`,
      labelX: (fx + tx) / 2,
      labelY: drop - 4,
    };
  });

  const height = bottom + (backs > 0 ? BACK_ROOM + (backs - 1) * BACK_STEP + 12 : 12);
  const path = nodes.map((node) => node.label).join(" → ");
  const description = specs.length === 0 ? `${path}. No loops.` : `${path}. Loops: ${specs.map((loop) => loop.words).join("; ")}.`;
  return { width, height, top, nodes, arrows, loops, description };
}
