import {
  animatedNoiseGraph, commitGraphCommand, createGraphNode, createProceduralGraph,
  deleteGraphNode, disconnectGraphPort, editGraphNode, GRAPH_KINDS, GRAPH_LIMITS,
  PORT_TYPES, portKey, type GraphNode, type NodeKind,
  type PortRef, type ProceduralGraph,
} from "./procedural-graph.ts";
import { compileGraph, createGraphPreview, type GraphProgram } from "./procedural-graph-runtime.ts";
import { propertyInteraction } from "./property-interaction.ts";
import type { SceneDocument } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";
import { createGraphCanvas, GRAPH_NODE_WIDTH, type GraphSelection } from "./procedural-graph-canvas.tsx";
import "./procedural-graph.css";

type Options = { available(): boolean; time(): { frame: number; fps: number }; onDraft?: () => void };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const portLabel = (name: string) => name.length === 1 ? name.toUpperCase() : name[0].toUpperCase() + name.slice(1);
function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}
function button(label: string, action: () => void) {
  const node = element("button", undefined, label);
  node.type = "button";
  node.onclick = action;
  return node;
}
function fieldLabel(label: string, input: HTMLElement) {
  const row = element("label", "ptg-field");
  row.append(element("span", undefined, label), input);
  input.setAttribute("aria-label", label);
  return row;
}

export function createProceduralGraphPanel(store: SceneStore, options: Options) {
  const root = element("section", "ptg");
  root.setAttribute("aria-label", "Texture Graph");
  const toolbar = element("div", "ptg-toolbar");
  const empty = element("p", "ptg-empty", "Create a graph to connect procedural nodes and embedded images.");
  const work = element("div", "ptg-work");
  const graphView = element("div", "ptg-graph");
  const stage = element("div", "ptg-stage");
  stage.tabIndex = 0;
  stage.setAttribute("aria-label", "Graph work area. Press Tab to create a node.");
  const flow = createGraphCanvas(stage);
  graphView.append(stage);
  const sidebar = element("aside", "ptg-side");
  const preview = element("div", "ptg-preview");
  const canvas = element("canvas");
  canvas.setAttribute("aria-label", "Texture output preview");
  canvas.setAttribute("role", "img");
  const previewMessage = element("p", "ptg-preview-status");
  previewMessage.setAttribute("aria-live", "polite");
  preview.append(element("h3", undefined, "Output Preview"), canvas, previewMessage);
  const inspector = element("div", "ptg-inspector");
  inspector.setAttribute("aria-label", "Node properties");
  sidebar.append(preview, inspector);
  work.append(graphView, sidebar);
  const status = element("p", "ptg-status");
  status.setAttribute("role", "status");
  root.append(toolbar, empty, work, status);

  const picker = element("div", "ptg-picker");
  picker.hidden = true;
  picker.setAttribute("role", "group");
  picker.setAttribute("aria-label", "Create node");
  const search = element("input");
  search.type = "search";
  search.placeholder = "Find a node…";
  search.setAttribute("aria-label", "Find a node");
  const choices = element("div", "ptg-choices");
  picker.append(search, choices);
  graphView.append(picker);
  const newGraph = button("New Graph", () => command("Create texture graph", () => createProceduralGraph()));
  const example = button("Create Animated Example", () => command("Create animated texture graph", () => animatedNoiseGraph()));
  const add = button("Add Node…", showPicker);
  const remove = button("Delete Selected", removeSelection);
  const count = element("span", "ptg-count");
  toolbar.append(newGraph, example, add, remove, count);

  const doc = () => store.getState().document;
  const graph = () => doc().proceduralGraph;
  let selected: GraphSelection | undefined;
  let draft: { doc: SceneDocument; graph: ProceduralGraph } | undefined;
  function setDraft(next: typeof draft) {
    if (draft === next) return;
    draft = next;
    options.onDraft?.();
  }
  let propertiesKey = "", propertiesAssets: SceneDocument["textureAssets"];
  let controls: { refresh(node: GraphNode): void }[] = [];
  let visible = false, queued = false, rendering = false, contextLost = false;
  let renderer: ReturnType<typeof createGraphPreview> | undefined;
  let compiled: { graph: ProceduralGraph; assets: SceneDocument["textureAssets"]; plan: GraphProgram } | undefined;
  let rendered: { graph: ProceduralGraph; assets: SceneDocument["textureAssets"]; frame: number; fps: number } | undefined;
  let failed: { graph: ProceduralGraph; assets: SceneDocument["textureAssets"] } | undefined;

  const selectedNode = () => selected && "node" in selected ? graph()?.nodes.find(node => node.id === selectedNodeId()) : undefined;
  const selectedNodeId = () => selected && "node" in selected ? selected.node : "";
  const report = (message: string) => { status.textContent = message; };
  function command(name: string, edit: (value: ProceduralGraph | undefined) => ProceduralGraph | undefined) {
    if (!options.available()) return false;
    try {
      commitGraphCommand(store, name, edit);
      report("");
      refresh();
      return true;
    } catch (error) { report(errorText(error)); return false; }
  }
  function withGraph(name: string, edit: (value: ProceduralGraph) => ProceduralGraph) {
    return command(name, value => value && edit(value));
  }
  function choose(selection?: GraphSelection) {
    selected = selection;
    setDraft(undefined);
    syncCanvas();
    syncInspector();
  }
  function removeSelection() {
    const item = selected;
    if (!item) return;
    const changed = "node" in item
      ? withGraph("Delete texture node", value => deleteGraphNode(value, item.node))
      : withGraph("Disconnect texture ports", value => disconnectGraphPort(value, item.wire));
    if (changed) { choose(); stage.focus(); }
  }

  for (const [kind, name] of Object.entries(GRAPH_KINDS)) {
    if (kind === "output") continue;
    choices.append(button(name, () => addNode(kind as NodeKind)));
  }
  function filterPicker() {
    const query = search.value.trim().toLowerCase();
    for (const item of Array.from(choices.querySelectorAll<HTMLButtonElement>("button")))
      item.hidden = !item.textContent!.toLowerCase().includes(query);
  }
  function showPicker() {
    if (!graph() || !options.available()) return;
    picker.hidden = false;
    search.value = "";
    filterPicker();
    search.focus();
  }
  function hidePicker() {
    if (picker.hidden) return;
    picker.hidden = true;
    stage.focus();
  }
  search.oninput = filterPicker;
  search.onkeydown = event => {
    if (event.key === "Enter") {
      event.preventDefault();
      choices.querySelector<HTMLButtonElement>("button:not([hidden])")?.click();
    }
  };
  picker.addEventListener("focusout", event => {
    if (!picker.contains(event.relatedTarget as Node | null)) picker.hidden = true;
  });
  function addNode(kind: NodeKind) {
    const current = graph();
    if (!current) return;
    const id = crypto.randomUUID();
    let slot = 0, x: number, y: number;
    do {
      x = 18 + (slot % 5) * (GRAPH_NODE_WIDTH + 25);
      y = 24 + Math.floor(slot++ / 5) * 136;
    } while (current.nodes.some(node => Math.abs(node.x - x) < GRAPH_NODE_WIDTH && Math.abs(node.y - y) < 112));
    if (withGraph("Create " + GRAPH_KINDS[kind], value => ({ ...value, nodes: [...value.nodes, createGraphNode(kind, id, x, y)] }))) {
      hidePicker();
      choose({ node: id });
    }
  }

  function syncCanvas() {
    const scene = doc();
    flow({
      graph: scene.proceduralGraph,
      assets: scene.textureAssets,
      available: options.available(),
      selected,
      choose,
      report,
      edit: withGraph,
    });
    remove.disabled = !options.available() || !selected || selectedNode()?.kind === "output";
  }

  function syncInspector() {
    const node = selectedNode();
    const library = doc().textureAssets;
    const connected = new Set(graph()?.edges.filter(edge => edge.to.node === node?.id).map(edge => edge.to.port));
    const key = node ? node.id + ":" + node.kind + ":" + [...connected].join(",") : "";
    if (propertiesKey !== key || propertiesAssets !== library || !inspector.firstChild) {
      propertiesKey = key;
      propertiesAssets = library;
      controls = [];
      inspector.replaceChildren(element("h3", undefined, node ? GRAPH_KINDS[node.kind] : "Node Properties"));
      if (node) buildInspector(node, connected);
      else inspector.append(element("p", undefined, "Select a node to edit its properties."));
    }
    if (node) for (const control of controls) control.refresh(node);
  }
  function buildInspector(node: GraphNode, connected: Set<string>) {
    const update = (name: string, edit: (value: GraphNode) => GraphNode) =>
      withGraph(name, value => editGraphNode(value, node.id, edit));
    const select = (name: string, entries: [string, string][], read: (value: GraphNode) => string, write: (value: GraphNode, next: string) => GraphNode) => {
      const input = element("select");
      for (const [label, value] of entries) input.add(new Option(label, value));
      input.onchange = () => {
        update("Set " + name, value => read(value) === input.value ? value : write(value, input.value));
        controls.forEach(control => { const actual = selectedNode(); if (actual) control.refresh(actual); });
      };
      controls.push({ refresh(value) { input.value = read(value); input.disabled = !options.available(); } });
      inspector.append(fieldLabel(name, input));
    };
    const number = (name: string, read: (value: GraphNode) => number, write: (value: GraphNode, next: number) => GraphNode,
      min: number, max: number, step: number, inputPort?: string) => {
      const input = element("input");
      input.type = "number";
      input.min = String(min); input.max = String(max); input.step = String(step);
      const row = fieldLabel(name, input);
      if (inputPort && connected.has(inputPort)) row.title = "Driven by " + portLabel(inputPort) + " input";
      const change = (value: GraphNode, next: number) => read(value) === next ? value : write(value, next);
      const draftValue = (value: number) => {
        const scene = doc();
        if (!options.available() || !scene.proceduralGraph || !Number.isFinite(value) || value < min || value > max || step === 1 && !Number.isInteger(value)) return;
        setDraft({ doc: scene, graph: editGraphNode(scene.proceduralGraph, node.id, current => change(current, value)) });
        queuePreview();
      };
      const restore = () => {
        setDraft(undefined);
        const current = selectedNode();
        if (current?.id === node.id) input.value = String(read(current));
        queuePreview();
      };
      input.oninput = () => draftValue(input.valueAsNumber);
      input.onchange = () => {
        const value = input.valueAsNumber;
        setDraft(undefined);
        if (Number.isFinite(value)) update("Set " + name, current => change(current, value));
        else report("Enter a number for " + name + ".");
        restore();
      };
      input.onkeydown = event => {
        if (event.key === "Enter") { event.preventDefault(); input.blur(); }
        if (event.key === "Escape" && draft) {
          event.preventDefault();
          // During middle-drag, the shared interaction also handles pointer capture cleanup.
          restore();
        }
      };
      row.addEventListener("pointerdown", event => { if (event.button === 1 && !input.disabled) input.focus(); }, true);
      const refreshLock = propertyInteraction(input, () => "texture-graph:" + node.id + ":" + name, row, () => ({
        update: draftValue,
        end() { setDraft(undefined); queuePreview(); },
      }));
      controls.push({ refresh(value) {
        if (document.activeElement !== input && !draft) input.value = String(read(value));
        input.disabled = !options.available() || !!inputPort && connected.has(inputPort);
        refreshLock();
      } });
      inspector.append(row);
    };
    const scalar = (key: string, min: number, max: number, step: number, inputPort?: string) => {
      const read = (current: GraphNode) => (current.params as Record<string, number>)[key];
      const write = (current: GraphNode, value: number) => ({ ...current, params: { ...current.params, [key]: value } }) as GraphNode;
      number(portLabel(key), read, write, min, max, step, inputPort);
    };
    if (node.kind === "texture") {
      select("Image asset", [["No image", ""], ...Object.values(doc().textureAssets ?? {}).map(asset =>
        [asset.name + " · " + (asset.role === "color" ? "sRGB" : "Raw"), asset.id] as [string, string])],
      current => current.kind === "texture" ? current.params.assetId : "",
      (current, assetId) => current.kind === "texture" ? { ...current, params: { assetId } } : current);
      inspector.append(element("p", undefined, "Uses the image role from Texture Assets. Alpha remains linear."));
    }
    if (node.kind === "noise") {
      scalar("seed", 0, 65535, 1); scalar("scale", 0.01, 128, 0.1); scalar("speed", -16, 16, 0.1);
    }
    if (node.kind === "gradient") {
      for (const endpoint of ["start", "end"] as const) for (const [index, channel] of ["R", "G", "B"].entries()) {
        number(portLabel(endpoint) + " " + channel, current => current.kind === "gradient" ? current.params[endpoint][index] : 0,
          (current, value) => {
            if (current.kind !== "gradient") return current;
            const color = [...current.params[endpoint]] as [number, number, number];
            color[index] = value;
            return { ...current, params: { ...current.params, [endpoint]: color } };
          }, 0, 1, 0.01);
      }
      inspector.append(element("p", undefined, "Linear RGB · Factor defaults to U."));
    }
    if (node.kind === "add" || node.kind === "multiply" || node.kind === "clamp") {
      const isMath = (current: GraphNode): current is Extract<GraphNode, { kind: "add" | "multiply" | "clamp" }> =>
        current.kind === "add" || current.kind === "multiply" || current.kind === "clamp";
      select("Value type", PORT_TYPES.map(type => [type, type]), current => isMath(current) ? current.params.type : "",
        (current, type) => isMath(current) ? { ...current, params: { ...current.params, type } } as GraphNode : current);
      for (const key of node.kind === "clamp" ? ["value", "min", "max"] : ["a", "b"]) scalar(key, -1024, 1024, 0.1, key);
    }
    if (node.kind === "output") {
      scalar("alpha", 0, 1, 0.01, "alpha");
      inspector.append(element("p", undefined, "Particles use Size as a diameter multiplier and Field as a signed XYZ vector."));
    }
    if (node.kind === "time") inspector.append(element("p", undefined, "Seconds = timeline frame ÷ FPS. Particle fields use historical simulation steps."));
    if (node.kind === "uv") inspector.append(element("p", undefined, "Normalized UV. The origin is at the lower left."));
    if (node.kind === "position") inspector.append(element("p", undefined, "Preview plane position is (U, V, 0)."));
    if (node.kind === "particle") inspector.append(element("p", undefined, "Age and Lifetime are seconds. Normalized Age runs from 0 to 1. Preview uses a one-second ramp across U."));
    if (node.kind === "vector") inspector.append(element("p", undefined, "Combine signed scalar X, Y and Z values into a 3D vector."));
  }

  root.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement;
    const editable = target.matches("input, select, textarea");
    if (event.key === "Escape" && !picker.hidden) {
      event.preventDefault(); event.stopPropagation();
      hidePicker();
    } else if (!editable && ["Delete", "Backspace"].includes(event.key) && graphView.contains(target)) {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) removeSelection();
    } else if (target === stage && event.key === "Tab" && !event.shiftKey && options.available()) {
      event.preventDefault(); showPicker();
    }
  });

  function queuePreview() {
    if (!visible || queued || rendering || contextLost) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; void paint(); });
  }
  function previewGraph(scene: SceneDocument) { return draft?.doc === scene ? draft.graph : scene.proceduralGraph; }
  function previewFailure(message: string) {
    const last = rendered ? "Showing last valid preview from frame " + rendered.frame + " at " + rendered.fps + " FPS. " : "";
    return last + message.replaceAll("\0", "").trim();
  }
  async function paint() {
    if (!visible || contextLost) return;
    const scene = doc(), value = previewGraph(scene), assets = scene.textureAssets;
    if (!value) {
      if (rendered) renderer?.clear();
      rendered = undefined; compiled = undefined; failed = undefined;
      return;
    }
    if (failed?.graph === value && failed.assets === assets) return;
    const { frame, fps } = options.time();
    const current = () => visible && previewGraph(doc()) === value && doc().textureAssets === assets;
    rendering = true;
    try {
      if (!compiled || compiled.graph !== value || compiled.assets !== assets)
        compiled = { graph: value, assets, plan: compileGraph(value, assets) };
      const { plan } = compiled;
      const changed = rendered?.graph !== value || rendered?.assets !== assets;
      if (!changed && (!plan.animated || rendered?.frame === frame && rendered.fps === fps)) {
        previewMessage.textContent = "";
        return;
      }
      renderer ??= createGraphPreview(canvas, lost => {
        contextLost = lost;
        if (lost) previewMessage.textContent = previewFailure("Graphics context lost.");
        else { rendered = undefined; failed = undefined; queuePreview(); }
      });
      if (await renderer.render(plan, frame, fps, current)) {
        rendered = { graph: value, assets, frame, fps };
        previewMessage.textContent = "";
        canvas.dataset.frame = String(frame);
        canvas.dataset.fps = String(fps);
      }
    } catch (error) {
      if (current()) {
        failed = { graph: value, assets };
        previewMessage.textContent = previewFailure(errorText(error));
      }
    } finally {
      rendering = false;
      const now = options.time();
      if (!current() || compiled?.plan.animated && (now.frame !== frame || now.fps !== fps)) queuePreview();
    }
  }
  new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting);
    if (visible) queuePreview();
    else setDraft(undefined);
  }).observe(root);

  let lastDoc: SceneDocument | undefined, lastAvailable: boolean | undefined;
  function refresh() {
    const scene = doc(), value = graph(), available = options.available();
    if (lastDoc !== scene || lastAvailable !== available) {
      setDraft(undefined);
      if (selected) {
        const item = selected;
        const exists = "node" in item
          ? value?.nodes.some(node => node.id === item.node)
          : value?.edges.some(edge => portKey(edge.to) === portKey(item.wire));
        if (!exists) selected = undefined;
      }
      if (!available) picker.hidden = true;
      newGraph.hidden = example.hidden = !!value;
      add.hidden = remove.hidden = work.hidden = !value;
      empty.hidden = !!value;
      newGraph.disabled = example.disabled = add.disabled = !available;
      count.textContent = value ? value.nodes.length + " / " + GRAPH_LIMITS.nodes + " nodes" : "";
      syncCanvas();
      syncInspector();
      lastDoc = scene; lastAvailable = available;
    }
    queuePreview();
  }
  refresh();
  return { element: root, refresh, previewGraph };
}
