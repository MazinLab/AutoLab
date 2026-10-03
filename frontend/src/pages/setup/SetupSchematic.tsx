import type { DragEvent, ReactElement } from "react";

import type { Layout, LayoutPart, RfPart } from "../../api/client";
import { layoutGeometry, type SchematicGeometry } from "./rfLayout";

interface SetupSchematicProps {
  layout: Layout;
  library: Map<string, RfPart>;
  // Device display names by feedline label (bound devices).
  deviceNames?: Record<string, string>;
  selectedPartId?: string | null;
  onSelectPart?: (partId: string | null) => void;
  // Drop a library part type onto a (chain, stage) cell; chainId is null
  // for the optical column.
  onDropPart?: (
    typeId: string,
    chainId: string | null,
    stageId: string,
  ) => void;
  dragTypeId?: string | null;
}

const GLYPH = 14;

function Glyph({
  symbol,
  x,
  y,
}: {
  symbol: string;
  x: number;
  y: number;
}): ReactElement {
  switch (symbol) {
    case "attenuator":
      // Inline two port drawn along the wire: a tall box with a vertical
      // zigzag, so it reads as spliced into the line.
      return (
        <g>
          <rect
            className="rf-glyph"
            height={GLYPH * 2}
            width={GLYPH * 1.4}
            x={x - GLYPH * 0.7}
            y={y - GLYPH}
          />
          <polyline
            className="rf-glyph-line"
            points={`${x},${y - GLYPH * 0.7} ${x - 5},${y - GLYPH * 0.4} ${x + 5},${y} ${x - 5},${y + GLYPH * 0.4} ${x},${y + GLYPH * 0.7}`}
          />
        </g>
      );
    case "amplifier":
      // Amplifiers live on output chains, where the signal travels up.
      return (
        <polygon
          className="rf-glyph"
          points={`${x - GLYPH},${y + GLYPH} ${x},${y - GLYPH} ${x + GLYPH},${y + GLYPH}`}
        />
      );
    case "isolator":
    case "circulator":
      return (
        <g>
          <circle className="rf-glyph" cx={x} cy={y} r={GLYPH} />
          <path
            className="rf-glyph-line"
            d={`M ${x - 7} ${y + 4} A 8 8 0 1 1 ${x + 7} ${y + 4}`}
          />
          {symbol === "isolator" ? (
            <line
              className="rf-glyph-line"
              x1={x + 4}
              x2={x + 9}
              y1={y + 1}
              y2={y + 4}
            />
          ) : null}
        </g>
      );
    case "switch":
      return (
        <g>
          <rect
            className="rf-glyph"
            height={GLYPH * 1.6}
            rx={3}
            width={GLYPH * 2.2}
            x={x - GLYPH * 1.1}
            y={y - GLYPH * 0.8}
          />
          <line
            className="rf-glyph-line"
            x1={x - 8}
            x2={x + 6}
            y1={y + 5}
            y2={y - 5}
          />
          <circle className="rf-glyph-dot" cx={x - 8} cy={y + 5} r={2} />
        </g>
      );
    case "coax":
      return (
        <g>
          <rect
            className="rf-glyph rf-glyph--coax"
            height={GLYPH * 2}
            width={8}
            x={x - 4}
            y={y - GLYPH}
          />
        </g>
      );
    case "filter":
      return (
        <g>
          <rect
            className="rf-glyph"
            height={GLYPH * 2}
            width={GLYPH * 1.4}
            x={x - GLYPH * 0.7}
            y={y - GLYPH}
          />
          <path
            className="rf-glyph-line"
            d={`M ${x - 3} ${y - 9} q 8 4 -2 9 q -6 5 3 9`}
          />
        </g>
      );
    case "fiber":
      return (
        <path
          className="rf-glyph-line rf-glyph--optical"
          d={`M ${x} ${y - GLYPH} q 8 7 0 14 q -8 7 0 14`}
        />
      );
    case "window":
      return (
        <rect
          className="rf-glyph rf-glyph--optical"
          height={GLYPH * 1.6}
          width={6}
          x={x - 3}
          y={y - GLYPH * 0.8}
        />
      );
    default:
      return (
        <rect
          className="rf-glyph"
          height={GLYPH * 1.4}
          width={GLYPH * 1.4}
          x={x - GLYPH * 0.7}
          y={y - GLYPH * 0.7}
        />
      );
  }
}

// Short names for the schematic; the library label is the full part name.
const AMPLIFIER_LABELS: Record<string, string> = {
  hemt: "HEMT",
  paramp: "Paramp",
  amp_zva: "ZVA",
};

function partLabel(part: LayoutPart, library: Map<string, RfPart>): string {
  const spec = library.get(part.type);
  if (!spec) {
    return part.type;
  }
  if (spec.category === "attenuator") {
    return spec.label.replace(" attenuator", "").replace(" (thru)", "");
  }
  if (spec.category === "amplifier") {
    return AMPLIFIER_LABELS[spec.id] ?? spec.label.split(" ")[0];
  }
  if (spec.category === "coax") {
    return spec.label.replace(" coax", "");
  }
  if (spec.category === "switch") {
    return `SW${part.selected_port ?? "-"}`;
  }
  return spec.label.split(" ")[0];
}

export function SetupSchematic({
  layout,
  library,
  selectedPartId = null,
  onSelectPart,
  onDropPart,
  dragTypeId = null,
  deviceNames = {},
}: SetupSchematicProps): ReactElement {
  const feedlineText = (label: string, compact: boolean): string => {
    const name = deviceNames[label];
    if (!name) {
      return label;
    }
    const limit = compact ? 8 : 16;
    return name.length > limit ? `${name.slice(0, limit - 1)}…` : name;
  };
  const geometry: SchematicGeometry = layoutGeometry(layout, library);
  const partsById = new Map<string, LayoutPart>();
  for (const chain of layout.chains) {
    for (const part of chain.parts) {
      partsById.set(part.id, part);
    }
  }
  for (const part of layout.optical) {
    partsById.set(part.id, part);
  }
  const editable = Boolean(onDropPart);
  const dragSpec = dragTypeId ? library.get(dragTypeId) : null;

  function dropHandler(chainId: string | null, stageId: string) {
    return (event: DragEvent<SVGElement>) => {
      event.preventDefault();
      const typeId = event.dataTransfer.getData("text/rf-part") || dragTypeId;
      if (typeId && onDropPart) {
        onDropPart(typeId, chainId, stageId);
      }
    };
  }

  function cellAccepts(chainId: string | null): boolean {
    if (!dragSpec) {
      return true;
    }
    if (chainId === null) {
      return dragSpec.category === "optical";
    }
    const chain = layout.chains.find((candidate) => candidate.id === chainId);
    return Boolean(chain && dragSpec.directions.includes(chain.direction));
  }

  return (
    <svg
      aria-label="Setup schematic"
      className="setup-schematic"
      role="img"
      // Fill the canvas, but never blow a two chain drawing up past
      // 1.6x its natural size.
      style={{ maxWidth: geometry.width * 1.6 }}
      viewBox={`0 0 ${geometry.width} ${geometry.height}`}
    >
      {geometry.bands.map((band, index) => (
        <g className="rf-band" key={band.id}>
          <rect
            className={
              index % 2 === 0
                ? "rf-band-fill rf-band-fill--even"
                : "rf-band-fill"
            }
            height={band.height}
            width={geometry.width}
            x={0}
            y={band.y}
          />
          <text className="rf-band-label" x={12} y={band.y + 18}>
            {band.label}
          </text>
        </g>
      ))}
      {editable
        ? geometry.bands.flatMap((band) =>
            [
              ...geometry.chains.map((chain) => ({
                id: chain.id as string | null,
                x: chain.x,
                // A chain and its branches share a column; each only
                // accepts drops on its own side of the switch.
                top: Math.max(band.y + 1, chain.dropTopY),
                bottom: Math.min(band.y + band.height - 1, chain.dropBottomY),
              })),
              ...(geometry.opticalX !== null
                ? [
                    {
                      id: null,
                      x: geometry.opticalX,
                      top: band.y + 1,
                      bottom: band.y + band.height - 1,
                    },
                  ]
                : []),
            ]
              .filter((cell) => cell.bottom > cell.top)
              .map((cell) => (
                <rect
                  aria-label={`Drop target ${cell.id ?? "optical"} ${band.label}`}
                  className={
                    dragTypeId && cellAccepts(cell.id)
                      ? "rf-drop rf-drop--armed"
                      : "rf-drop"
                  }
                  data-chain={cell.id ?? "optical"}
                  data-stage={band.id}
                  height={cell.bottom - cell.top}
                  key={`${cell.id ?? "optical"}-${band.id}`}
                  onDragOver={(event) => {
                    if (cellAccepts(cell.id)) {
                      event.preventDefault();
                    }
                  }}
                  onDrop={dropHandler(cell.id, band.id)}
                  width={50}
                  x={cell.x - 25}
                  y={cell.top}
                />
              )),
          )
        : null}
      {geometry.chains.map((chain) => (
        <g
          className={chain.active ? "rf-chain" : "rf-chain rf-chain--inactive"}
          key={chain.id}
        >
          <line
            className="rf-line"
            x1={chain.x}
            x2={chain.x}
            y1={chain.topY}
            y2={chain.bottomY}
          />
          {!geometry.fans.some((fan) => fan.toChainId === chain.id) ? (
            <text
              className="rf-chain-label"
              textAnchor="middle"
              x={chain.x}
              y={14}
            >
              {layout.chains.find((candidate) => candidate.id === chain.id)
                ?.label ?? chain.id}
              {chain.direction === "input" ? " ↓" : " ↑"}
            </text>
          ) : null}
          {chain.leaf && chain.feedline ? (
            <text
              className={
                deviceNames[chain.feedline]
                  ? "rf-feedline-label rf-feedline-label--device"
                  : "rf-feedline-label"
              }
              textAnchor="middle"
              x={chain.x}
              y={chain.bottomY + 18}
            >
              <title>
                {chain.feedline}
                {deviceNames[chain.feedline]
                  ? `: ${deviceNames[chain.feedline]}`
                  : ""}
              </title>
              {feedlineText(chain.feedline, chain.compact)}
            </text>
          ) : null}
        </g>
      ))}
      {geometry.fans.map((fan) => (
        <g className="rf-fan" key={`${fan.fromPartId}-${fan.toChainId}`}>
          <line
            className="rf-line rf-line--fan"
            x1={fan.x1}
            x2={fan.x2}
            y1={fan.y1}
            y2={fan.y2}
          />
          {/* Beside the branch stub, not on it: the stub can be only a
              couple of dozen pixels tall when the switch sits on the
              coldest stage. */}
          <text
            className="rf-port-label"
            textAnchor="start"
            x={fan.x2 + 5}
            y={fan.y2 + 10}
          >
            {fan.port}
          </text>
        </g>
      ))}
      {geometry.fibers.map((fiber) => (
        <line
          className="rf-line rf-line--optical"
          key={fiber.partId}
          x1={fiber.x}
          x2={fiber.x}
          y1={fiber.topY}
          y2={fiber.bottomY}
        />
      ))}
      {geometry.opticalX !== null ? (
        <line
          className="rf-line rf-line--optical"
          x1={geometry.opticalX}
          x2={geometry.opticalX}
          y1={geometry.bands[0]?.y ?? 0}
          y2={geometry.deviceY ?? geometry.height}
        />
      ) : null}
      {geometry.devices.length > 0 ? (
        <g className="rf-device">
          {geometry.devices.map((bar, index) => (
            <rect
              data-feedline={bar.feedline}
              height={10}
              key={`${bar.feedline}-${index}`}
              rx={3}
              width={bar.x2 - bar.x1}
              x={bar.x1}
              y={bar.y - 5}
            >
              <title>{deviceNames[bar.feedline] ?? bar.feedline}</title>
            </rect>
          ))}
          <text
            textAnchor="end"
            x={geometry.devices[0].x1 - 8}
            y={geometry.devices[0].y + 4}
          >
            {geometry.devices.length > 1 ? "devices" : "device"}
          </text>
        </g>
      ) : null}
      {geometry.parts.map((placement) => {
        const part = partsById.get(placement.id);
        if (!part) {
          return null;
        }
        const spec = library.get(part.type);
        const selected = placement.id === selectedPartId;
        return (
          <g
            aria-label={`${spec?.label ?? part.type} at ${part.stage}`}
            className={selected ? "rf-part rf-part--selected" : "rf-part"}
            data-part-id={part.id}
            key={part.id}
            onClick={() => onSelectPart?.(part.id)}
            // A part covers most of its cell's drop target, so a drop on
            // the part lands in the same cell: stages hold many parts.
            onDragOver={
              editable && cellAccepts(placement.chainId)
                ? (event) => event.preventDefault()
                : undefined
            }
            onDrop={
              editable ? dropHandler(placement.chainId, part.stage) : undefined
            }
            role={onSelectPart ? "button" : undefined}
            tabIndex={onSelectPart ? 0 : undefined}
            onKeyDown={(event) => {
              if (
                onSelectPart &&
                (event.key === "Enter" || event.key === " ")
              ) {
                event.preventDefault();
                onSelectPart(part.id);
              }
            }}
          >
            <rect
              className="rf-part-hit"
              height={36}
              width={44}
              x={placement.x - 22}
              y={placement.y - 18}
            />
            <Glyph
              symbol={spec?.symbol ?? "generic"}
              x={placement.x}
              y={placement.y}
            />
            <title>
              {spec?.label ?? part.type}
              {part.instrument_id ? " (bound)" : ""}
            </title>
            {placement.compact ? null : spec?.ports ? (
              // Switch labels sit under the glyph so the port fan lines
              // leaving to the right stay clear.
              <text
                className="rf-part-label"
                textAnchor="middle"
                x={placement.x}
                y={placement.y + 26}
              >
                {partLabel(part, library)}
              </text>
            ) : (
              <text
                className="rf-part-label"
                textAnchor="start"
                x={placement.x + 20}
                y={placement.y + 4}
              >
                {partLabel(part, library)}
                {part.instrument_id ? " •" : ""}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
