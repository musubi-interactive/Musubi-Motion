import { useRef, useState, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useStoreApi,
  type Connection, type Edge, type Node, type NodeProps,
} from "@xyflow/react";
import {
  connectGraphPorts, disconnectGraphPort, editGraphNode, GRAPH_KINDS, GRAPH_LIMITS,
  inputPorts, outputPorts, portKey, validateProceduralGraph,
  type GraphNode, type PortRef, type ProceduralGraph,
} from "./procedural-graph.ts";
import type { SceneDocument } from "./scene-document.ts";
import "@xyflow/react/dist/style.css";

export const GRAPH_NODE_WIDTH = 156;
export type GraphSelection = { node: string } | { wire: PortRef };
type Props = {
  graph: ProceduralGraph;
  assets: SceneDocument["textureAssets"];
  available: boolean;
  selected?: GraphSelection;
  choose(selection?: GraphSelection): void;
  report(message: string): void;
  edit(label: string, change: (graph: ProceduralGraph) => ProceduralGraph): boolean;
};
type Port = {
  name: string;
  types: string;
  direction: "source" | "target";
  compatibility: "neutral" | "compatible" | "incompatible";
};
type TextureNode = Node<{ node: GraphNode; ports: Port[]; select(): void }, "textureNode">;
type TextureEdge = Edge<{ input: PortRef }>;
type Endpoint = { nodeId: string | null; handleId: string | null; handleType: "source" | "target" | null };

const portLabel = (name: string) => {
  if (name === "normalizedAge") return "Normalized Age";
  return name.charAt(0).toUpperCase() + name.slice(1);
};
const typeLabel = (types: readonly string[]) => [...new Set(types)].join(" / ");
const portTitle = (node: GraphNode, port: string) =>
  node.kind === "time" && port === "value" ? "Seconds" : portLabel(port);

function TextureGraphNode({ data, selected, isConnectable }: NodeProps<TextureNode>) {
  const { node, ports, select } = data;
  return (
    <div className="ptg-node">
      <button className="ptg-title" type="button" aria-pressed={selected} onClick={select}>
        {GRAPH_KINDS[node.kind]}
      </button>
      <div className="ptg-ports">
        {ports.map(({ name, types, direction, compatibility }) => {
          const input = direction === "target";
          const label = portTitle(node, name);
          const description = GRAPH_KINDS[node.kind] + " " + label + (input ? " input" : " output") + " (" + types + ")";
          return (
            <div key={direction + name} className={`ptg-port-row ${direction} ${compatibility}`}>
              <Handle
                id={name} type={direction} position={input ? Position.Left : Position.Right}
                isConnectable={isConnectable} isConnectableStart={isConnectable && !input}
                tabIndex={isConnectable ? 0 : -1} role="button" aria-label={description} title={description}
                onKeyDown={event => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.currentTarget.click();
                  }
                }}
              />
              <span>{label} <span className="ptg-port-type">({types})</span></span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const nodeTypes = { textureNode: TextureGraphNode };

function candidate(graph: ProceduralGraph, connection: Connection, previous?: PortRef) {
  const { source, sourceHandle, target, targetHandle } = connection;
  const from = { node: source, port: sourceHandle ?? "" };
  const to = { node: target, port: targetHandle ?? "" };
  const sourceNode = graph.nodes.find(node => node.id === from.node);
  const targetNode = graph.nodes.find(node => node.id === to.node);
  const output = sourceNode && outputPorts(sourceNode).find(port => port.name === from.port);
  const input = targetNode && inputPorts(targetNode).find(port => port.name === to.port);
  if (!sourceNode || !targetNode || !output || !input) throw new Error("Choose an output and an input port.");
  if (!input.types.includes(output.type)) {
    throw new Error(`Cannot connect ${portTitle(sourceNode, from.port)} (${output.type}) to ${GRAPH_KINDS[targetNode.kind]} ${portTitle(targetNode, to.port)} (${typeLabel(input.types)}).`);
  }
  if (previous && portKey(previous) !== portKey(to)) graph = disconnectGraphPort(graph, previous);
  return connectGraphPorts(graph, from, to);
}

function GraphCanvas({ graph, assets, available, selected, choose, report, edit }: Props) {
  const flow = useStoreApi<TextureNode, TextureEdge>();
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<ProceduralGraph | null>(null);
  const connectingGraph = useRef<ProceduralGraph>(undefined);
  const [measurements, setMeasurements] = useState<Map<string, TextureNode["measured"]>>(() => new Map());
  const [position, setPosition] = useState<{ graph: ProceduralGraph; id: string; x: number; y: number }>();
  const [active, setActive] = useState<{ graph: ProceduralGraph; endpoint: Endpoint }>();
  const reconnect = useRef<PortRef>(undefined);
  const rejection = useRef("");
  const cancelled = useRef(false);

  function connectionError(connection: Connection, previous = reconnect.current) {
    try {
      validateProceduralGraph(candidate(graph, connection, previous), assets);
      return "";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  function startConnection(endpoint: Endpoint, focus: boolean) {
    if (!available) return;
    cancelled.current = false;
    connectingGraph.current = graph;
    rejection.current = "";
    setActive({ graph, endpoint });
    report("Connect to a compatible port. Escape cancels.");
    if (focus) container.current?.focus({ preventScroll: true });
  }

  function finishConnection() {
    connectingGraph.current = undefined;
    setActive(undefined);
    if (cancelled.current) return;
    report(rejection.current);
  }

  function cancelConnection() {
    cancelled.current = true;
    connectingGraph.current = undefined;
    reconnect.current = undefined;
    setActive(undefined);
    flow.getState().cancelConnection();
    flow.setState({ connectionClickStartHandle: null });
  }

  function applyConnection(connection: Connection, previous?: PortRef) {
    if (cancelled.current || !available || connectingGraph.current !== graph) return;
    if (edit(previous ? "Reconnect texture ports" : "Connect texture ports", value =>
      value === graph ? candidate(value, connection, previous) : value)) {
      choose({ wire: { node: connection.target, port: connection.targetHandle! } });
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Escape" || (!connectingGraph.current && !drag.current)) return;
    event.preventDefault();
    event.stopPropagation();
    cancelConnection();
    drag.current = null;
    setPosition(undefined);
    report("");
  }

  function compatibility(node: string, port: string, direction: Port["direction"]): Port["compatibility"] {
    if (active?.graph !== graph) return "neutral";
    const start = active.endpoint;
    if (!start.nodeId || !start.handleId || start.handleType === direction) return "neutral";
    const connection = direction === "target"
      ? { source: start.nodeId, sourceHandle: start.handleId, target: node, targetHandle: port }
      : { source: node, sourceHandle: port, target: start.nodeId, targetHandle: start.handleId };
    return connectionError(connection) ? "incompatible" : "compatible";
  }

  const nodes: TextureNode[] = graph.nodes.map(node => ({
    id: node.id,
    type: "textureNode",
    measured: measurements.get(node.id),
    position: position?.graph === graph && position.id === node.id ? { x: position.x, y: position.y } : { x: node.x, y: node.y },
    selected: !!selected && "node" in selected && selected.node === node.id,
    dragHandle: ".ptg-title",
    data: {
      node,
      select: () => choose({ node: node.id }),
      ports: [
        ...inputPorts(node).map(port => ({
          name: port.name, types: typeLabel(port.types), direction: "target" as const,
          compatibility: compatibility(node.id, port.name, "target"),
        })),
        ...outputPorts(node).map(port => ({
          name: port.name, types: port.type, direction: "source" as const,
          compatibility: compatibility(node.id, port.name, "source"),
        })),
      ],
    },
  }));
  const edges: TextureEdge[] = graph.edges.map(({ from, to }) => ({
    id: portKey(to), source: from.node, sourceHandle: from.port, target: to.node, targetHandle: to.port,
    selected: !!selected && "wire" in selected && portKey(selected.wire) === portKey(to),
    ariaLabel: `Connection from ${portLabel(from.port)} to ${portLabel(to.port)}`,
    data: { input: to },
  }));

  return (
    <div className="ptg-flow" ref={container} tabIndex={-1} onKeyDownCapture={onKeyDown}>
      <ReactFlow<TextureNode, TextureEdge>
        nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        fitView fitViewOptions={{ padding: 0.12, maxZoom: 1 }} minZoom={0.2} maxZoom={2}
        nodesDraggable={available} nodesConnectable={available} edgesReconnectable={available}
        nodeExtent={[[0, 0], [GRAPH_LIMITS.layout + GRAPH_NODE_WIDTH, GRAPH_LIMITS.layout + 160]]}
        nodesFocusable={false} deleteKeyCode={null} multiSelectionKeyCode={null} selectionKeyCode={null}
        panOnDrag={[0, 1]} autoPanOnConnect={false} reconnectRadius={7}
        onPaneClick={() => { cancelConnection(); choose(); report(""); }}
        onNodeClick={(_event, node) => choose({ node: node.id })}
        onEdgeClick={(_event, edge) => { if (edge.data) choose({ wire: edge.data.input }); }}
        onEdgesChange={changes => {
          const change = changes.find(item => item.type === "select" && item.selected);
          if (change?.type === "select") {
            const edge = edges.find(item => item.id === change.id);
            if (edge?.data) choose({ wire: edge.data.input });
          } else if (selected && "wire" in selected && changes.some(item =>
            item.type === "select" && !item.selected && item.id === portKey(selected.wire))) {
            choose();
          }
        }}
        onNodeDragStart={(_event, node) => {
          drag.current = graph;
          choose({ node: node.id });
          container.current?.focus({ preventScroll: true });
        }}
        onNodesChange={changes => {
          const dimensions = changes.filter(change => change.type === "dimensions");
          if (dimensions.length) setMeasurements(previous => {
            const next = new Map(graph.nodes.map(node => [node.id, previous.get(node.id)]));
            let changed = next.size !== previous.size;
            for (const { id, dimensions: size } of dimensions) {
              const before = next.get(id);
              if (next.has(id) && size && (before?.width !== size.width || before?.height !== size.height)) {
                next.set(id, size);
                changed = true;
              }
            }
            return changed ? next : previous;
          });
          const change = changes.find(item => item.type === "position" && item.dragging && item.position);
          if (drag.current === graph && change?.type === "position" && change.position) {
            setPosition({ graph, id: change.id, ...change.position });
          }
        }}
        onNodeDragStop={(_event, node) => {
          const current = drag.current;
          drag.current = null;
          setPosition(undefined);
          if (current !== graph || !available) return;
          const clamp = (value: number) => Math.max(0, Math.min(GRAPH_LIMITS.layout, Math.round(value)));
          const x = clamp(node.position.x), y = clamp(node.position.y);
          edit("Move texture node", value => value === graph ? editGraphNode(value, node.id, item =>
            item.x === x && item.y === y ? item : { ...item, x, y }) : value);
        }}
        isValidConnection={connection => {
          rejection.current = connectionError({
            ...connection, sourceHandle: connection.sourceHandle ?? null, targetHandle: connection.targetHandle ?? null,
          });
          return available && !cancelled.current && !rejection.current;
        }}
        onConnectStart={(_event, endpoint) => startConnection(endpoint, true)}
        onConnect={connection => applyConnection(connection)}
        onConnectEnd={(_event, state) => {
          if (!state.toHandle) rejection.current = "";
          finishConnection();
        }}
        onClickConnectStart={(_event, endpoint) => startConnection(endpoint, false)}
        onClickConnectEnd={finishConnection}
        onReconnectStart={(_event, edge) => { reconnect.current = edge.data?.input; }}
        onReconnect={(edge, connection) => applyConnection(connection, edge.data?.input)}
        onReconnectEnd={() => { reconnect.current = undefined; }}
      >
        <Background gap={16} size={1} color="var(--line)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

export function createGraphCanvas(host: HTMLElement) {
  const root = createRoot(host);
  return ({ graph, ...props }: Omit<Props, "graph"> & { graph?: ProceduralGraph }) => {
    root.render(graph ? <ReactFlowProvider><GraphCanvas graph={graph} {...props} /></ReactFlowProvider> : null);
  };
}
