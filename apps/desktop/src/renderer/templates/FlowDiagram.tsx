// Draws a template's flow (flow.ts): nodes as boxes, the arrows and loop lines in one SVG layer
// under them. The picture is one image to screen readers, named by the flow in words. It scrolls
// sideways when the template has more steps than the page is wide.
import type { Flow } from "./flow.js";
import { AgentDotMark } from "../ui/agent.js";

export function FlowDiagram({ flow }: { readonly flow: Flow }) {
  const { width, height, top, nodes, arrows, loops, description } = flow;
  return (
    <div className="tp-flow-scroll" tabIndex={0} aria-label="Flow diagram">
      <div className="tp-flow" role="img" aria-label={description} style={{ width, height }}>
        <svg className="tp-flow-lines" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          {arrows.map((arrow) => (
            <g key={arrow.x1} className="tp-arrow">
              <line x1={arrow.x1 + 2} y1={arrow.y} x2={arrow.x2 - 3} y2={arrow.y} />
              <path d={`M${arrow.x2 - 8} ${arrow.y - 4} L${arrow.x2 - 3} ${arrow.y} L${arrow.x2 - 8} ${arrow.y + 4}`} />
            </g>
          ))}
          {loops.map((loop) => (
            <g key={`${loop.kind}-${loop.from}-${loop.to}-${loop.label}`} className="tp-loop" data-kind={loop.kind}>
              <path d={loop.path} />
              <path d={loop.head} />
            </g>
          ))}
        </svg>
        {loops.map((loop) => (
          <span key={`label-${loop.kind}-${loop.from}-${loop.to}-${loop.label}`} className="tp-loop-label mono" style={{ left: loop.labelX, top: loop.labelY }} aria-hidden="true">
            {loop.label}
          </span>
        ))}
        {nodes.map((node) => (
          <div key={node.key} className="tp-node" data-kind={node.kind} style={{ left: node.x, top, width: node.width }} aria-hidden="true">
            {node.dot !== undefined && <AgentDotMark dot={node.dot} />}
            <span className="tp-node-name">{node.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
