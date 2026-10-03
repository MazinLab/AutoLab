import { Link } from "react-router-dom";

import type { LineageEdge, LineageGraph, LineageNode } from "../api/client";
import { entityRoute } from "../pages/entity/entityRoute";
import "./LineageGraph.css";

const NODE_WIDTH = 168;
const NODE_HEIGHT = 62;
const COLUMN_GAP = 86;
const ROW_GAP = 34;
const PADDING = 28;

export interface PositionedLineageNode extends LineageNode {
  x: number;
  y: number;
}

export interface LineageLayout {
  width: number;
  height: number;
  nodes: PositionedLineageNode[];
}

export function layoutLineageGraph(nodes: LineageNode[]): LineageLayout {
  if (nodes.length === 0) {
    return { width: 0, height: 0, nodes: [] };
  }

  const depths = [...new Set(nodes.map((node) => node.depth))].sort(
    (left, right) => left - right,
  );
  const minimumDepth = depths[0];
  const maximumDepth = depths.at(-1) ?? minimumDepth;
  const nodesByDepth = new Map<number, LineageNode[]>();

  nodes.forEach((node) => {
    const column = nodesByDepth.get(node.depth) ?? [];
    column.push(node);
    nodesByDepth.set(node.depth, column);
  });
  nodesByDepth.forEach((column) =>
    column.sort((left, right) => left.accession.localeCompare(right.accession)),
  );

  const largestColumn = Math.max(
    ...Array.from(nodesByDepth.values(), (column) => column.length),
  );
  const height =
    PADDING * 2 + largestColumn * NODE_HEIGHT + (largestColumn - 1) * ROW_GAP;
  const width =
    PADDING * 2 +
    (maximumDepth - minimumDepth + 1) * NODE_WIDTH +
    (maximumDepth - minimumDepth) * COLUMN_GAP;
  const positionedNodes: PositionedLineageNode[] = [];

  depths.forEach((depth) => {
    const column = nodesByDepth.get(depth) ?? [];
    const columnHeight =
      column.length * NODE_HEIGHT + Math.max(0, column.length - 1) * ROW_GAP;
    const startY = (height - columnHeight) / 2;
    column.forEach((node, index) => {
      positionedNodes.push({
        ...node,
        x: PADDING + (depth - minimumDepth) * (NODE_WIDTH + COLUMN_GAP),
        y: startY + index * (NODE_HEIGHT + ROW_GAP),
      });
    });
  });

  return { width, height, nodes: positionedNodes };
}

interface LineageGraphProps {
  graph: LineageGraph;
  focusId: string;
}

function edgeKey(edge: LineageEdge): string {
  return `${edge.src_id}:${edge.relation}:${edge.dst_id}`;
}

export function LineageGraph({ graph, focusId }: LineageGraphProps) {
  const layout = layoutLineageGraph(graph.nodes);
  const positionedNodes = new Map(layout.nodes.map((node) => [node.id, node]));

  if (layout.nodes.length === 0) {
    return <p className="empty-state">No lineage is recorded for this entity.</p>;
  }

  return (
    <div className="lineage-viewport">
      <svg
        aria-label="Entity lineage graph"
        className="lineage-graph"
        height={layout.height}
        role="group"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        width={layout.width}
      >
        <g className="lineage-edges">
          {graph.edges.map((edge) => {
            const source = positionedNodes.get(edge.src_id);
            const destination = positionedNodes.get(edge.dst_id);
            if (!source || !destination) {
              return null;
            }
            const sourceX = source.x + NODE_WIDTH / 2;
            const sourceY = source.y + NODE_HEIGHT / 2;
            const destinationX = destination.x + NODE_WIDTH / 2;
            const destinationY = destination.y + NODE_HEIGHT / 2;
            return (
              <g key={edgeKey(edge)}>
                <line
                  x1={sourceX}
                  x2={destinationX}
                  y1={sourceY}
                  y2={destinationY}
                />
                <text
                  className="lineage-edge-label"
                  x={(sourceX + destinationX) / 2}
                  y={(sourceY + destinationY) / 2 - 6}
                >
                  {edge.relation}
                </text>
              </g>
            );
          })}
        </g>
        <g className="lineage-nodes">
          {layout.nodes.map((node) => (
            <g
              data-depth={node.depth}
              data-node-id={node.id}
              key={node.id}
              transform={`translate(${node.x} ${node.y})`}
            >
              <Link
                aria-label={`Open ${node.accession}`}
                to={entityRoute(node.id)}
              >
                <rect
                  className={
                    node.id === focusId ? "lineage-node--focus" : undefined
                  }
                  height={NODE_HEIGHT}
                  rx="12"
                  width={NODE_WIDTH}
                />
                <text className="lineage-node-accession" x="14" y="26">
                  {node.accession}
                </text>
                <text className="lineage-node-type" x="14" y="47">
                  {node.entity_type.replaceAll("_", " ")}
                </text>
              </Link>
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
