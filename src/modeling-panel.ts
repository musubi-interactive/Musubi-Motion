import { createMeshPrimitive, findMeshShape, meshEdges, setMeshVertexPositions, updateMeshAppearance, extrudeMeshFaces, deleteMeshFaces } from "./mesh-modeling.ts";
import type { MeshShapeNode, Vec3 } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";
import { mergeMeshVerticesToCenter } from "./mesh-merge.ts";
import { deleteMeshEdges } from "./mesh-edge-delete.ts";
import { reverseMeshNormals } from "./mesh-normals.ts";
import { commitMeshBevel, MAX_BEVEL_SEGMENTS, prepareMeshBevel, type MeshBevelResult } from "./mesh-bevel.ts";
import { commitMeshBridge, expandBridgeBoundaryEdges, MAX_BRIDGE_SEGMENTS, prepareMeshBridge, type MeshBridgeResult } from "./mesh-bridge.ts";
import { propertyInteraction } from "./property-interaction.ts";

export type MeshComponentMode = "vertex" | "edge" | "face";
export type TopologyPreview = { shapeId: string; shape?: MeshShapeNode; edgeIds: readonly string[] };
type TopologySession = { edgeIds: string[] } & (
  { kind: "bevel"; prepared: ReturnType<typeof prepareMeshBevel>; result?: MeshBevelResult } |
  { kind: "bridge"; prepared: ReturnType<typeof prepareMeshBridge>; result?: MeshBridgeResult }
);
type Options = {
  available: () => boolean;
  /** Keep the active component request while a viewport drag temporarily disables edits. */
  keepComponentMode?: () => boolean;
  getSelection: () => string[];
  onSelectObject: (id: string) => void;
  onComponentMode: (request: { shapeId: string; mode: MeshComponentMode } | undefined) => void;
  onComponentSelection: (shapeId: string, mode: MeshComponentMode, ids: string[]) => void;
  onTopologyPreview: (preview: TopologyPreview | undefined) => void;
};

/** Modeling UI uses the same validated commands as viewport tools. Selection is runtime state. */
export function createModelingPanel(store: SceneStore, options: Options) {
  const element = document.createElement("section"); element.className = "modeling-panel"; element.setAttribute("aria-label", "Polygon Modeling");
  const style = document.createElement("style");
  style.textContent = `.modeling-panel{height:100%;overflow:auto;padding:12px;font-size:12px;background:var(--panel);color:var(--text)}
    .modeling-panel p{line-height:1.5;color:var(--muted)}.modeling-panel fieldset{margin:0 0 12px;padding:10px;min-width:0;border:1px solid var(--line)}.modeling-panel legend{padding:0 5px}
    .modeling-panel label{display:grid;gap:5px;margin:8px 0}.modeling-panel input,.modeling-panel select,.modeling-panel textarea,.modeling-panel button{font:inherit;padding:6px;min-width:0;border:1px solid var(--line);border-radius:3px;background:var(--bg);color:var(--text);box-sizing:border-box}
    .modeling-panel input:not([type=checkbox]),.modeling-panel select,.modeling-panel textarea{width:100%}.modeling-panel textarea{font:11px monospace;resize:vertical}.modeling-panel button{cursor:pointer}.modeling-panel button:hover:not(:disabled){background:var(--hover)}.modeling-panel :disabled{opacity:.45;cursor:default}
    .modeling-panel :focus-visible{outline:1px solid var(--strong)}.modeling-panel .modeling-xyz{display:grid;grid-template-columns:repeat(3,minmax(40px,1fr));gap:6px}.modeling-panel .modeling-actions{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
    .modeling-panel .modeling-check{display:flex;gap:7px;align-items:center}.modeling-panel .modeling-status{min-height:20px;overflow-wrap:anywhere}.modeling-panel .modeling-status[data-error=true]{color:#ce756a}
    .modeling-panel details{margin:8px 0 12px}.modeling-panel summary{cursor:pointer;padding:5px 0;color:var(--text);font-weight:600}.modeling-panel details>fieldset{margin-top:6px}
    .modeling-panel .topology-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}.modeling-panel .topology-fields input{text-align:right}`;
  function label(text: string, control: HTMLElement) { const node = document.createElement("label"); node.append(document.createTextNode(text), control); return node; }
  function group(text: string) { const node = document.createElement("fieldset"), legend = document.createElement("legend"); legend.textContent = text; node.append(legend); return node; }
  function select(name: string) { const node = document.createElement("select"); node.setAttribute("aria-label", name); return node; }
  function number(name: string, value = "0") { const node = document.createElement("input"); node.type = "number"; node.step = "any"; node.value = value; node.setAttribute("aria-label", name); return node; }
  function button(text: string, action: () => void) { const node = document.createElement("button"); node.type = "button"; node.textContent = text; node.onclick = action; return node; }
  function axes(title: string) {
    const row = document.createElement("div"); row.className = "modeling-xyz";
    const inputs = ["X", "Y", "Z"].map(axis => number(`${title} ${axis}`)); inputs.forEach((input, index) => row.append(label("XYZ"[index], input))); return { row, inputs };
  }
  const status = document.createElement("p"); status.className = "modeling-status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  let shapeId = "", selectedIds: string[] = [], selectionSignature = "", objectSignature = "", componentSignature = "", modeSignature = "", emittedSelection = "", displayedVertex = "";
  let primitiveSize = 1, primitiveName = "", offset: Vec3 = [0, 0, 0], extrudeDistance = 0.25;
  let hadMeshes: boolean | undefined;
  let cachedShape: MeshShapeNode | undefined;
  let cachedEdges: ReturnType<typeof meshEdges> = [];
  let cachedRows: Record<MeshComponentMode, { id: string; text: string }[]> = { vertex: [], edge: [], face: [] };
  let preview: TopologySession | undefined;
  let previewFrame: number | undefined;
  const creation = group("Create Primitive"), primitive = select("Mesh primitive");
  const creationDetails = document.createElement("details"), creationSummary = document.createElement("summary"); creationSummary.textContent = "Create Primitive";
  creation.querySelector("legend")!.hidden = true; creation.setAttribute("aria-label", "Create Primitive"); creationDetails.append(creationSummary, creation);
  for (const value of ["cube", "plane", "sphere", "cylinder"]) primitive.add(new Option(value[0].toUpperCase() + value.slice(1), value));
  const name = document.createElement("input"); name.type = "text"; name.maxLength = 100; name.value = primitiveName; name.placeholder = "Use primitive name"; name.setAttribute("aria-label", "New mesh name");
  const size = number("Mesh primitive size", "1"); size.min = "0.000001"; size.max = "1000000";
  const create = button("Create mesh primitive", () => run(() => {
    const id = createMeshPrimitive(store, primitive.value as "cube" | "plane" | "sphere" | "cylinder", { name: primitiveName || undefined, size: primitiveSize });
    const shape = findMeshShape(store.getState().document, id); stopEditing(); shapeId = shape?.id ?? ""; options.onSelectObject(id);
  }, "Mesh created at the origin."));
  creation.append(label("Primitive", primitive), label("Name", name), label("Size", size), create);
  const objects = select("Editable mesh object"), empty = document.createElement("p"); empty.textContent = "Create a polygon mesh or select one in the Outliner.";
  const components = group("Components"), mode = select("Mesh selection mode");
  for (const value of ["object", "vertex", "edge", "face"]) mode.add(new Option(value[0].toUpperCase() + value.slice(1), value));
  const summary = document.createElement("p"), picker = select("Mesh component");
  const replace = button("Select component", () => choose(false)), add = button("Add component", () => choose(true));
  const clear = button("Clear component selection", () => run(() => { selectedIds = []; }));
  const selectionActions = document.createElement("div"); selectionActions.className = "modeling-actions"; selectionActions.append(replace, add, clear);
  const ids = document.createElement("textarea"); ids.rows = 3; ids.readOnly = true; ids.setAttribute("aria-label", "Selected mesh component IDs");
  const idDetails = document.createElement("details"), idSummary = document.createElement("summary"); idSummary.textContent = "Component IDs"; idDetails.append(idSummary, ids);
  const cap = document.createElement("p");
  const absolute = axes("Vertex local position"), absoluteGroup = document.createElement("div"), absoluteTitle = document.createElement("p"); absoluteTitle.textContent = "Single vertex · absolute local position"; absoluteGroup.append(absoluteTitle, absolute.row);
  const delta = axes("Component local offset");
  const offsetDetails = document.createElement("details"), offsetSummary = document.createElement("summary"); offsetSummary.textContent = "Local component offset"; offsetDetails.append(offsetSummary);
  const applyOffset = button("Apply offset", () => run(() => {
    const shape = requiredShape(), affected = selectedVertices(shape);
    if (!affected.size) throw Error("Select vertices, edges, or faces before applying an offset.");
    setMeshVertexPositions(store, shape.id, shape.vertices.filter(vertex => affected.has(vertex.id)).map(vertex => ({ id: vertex.id, position: vertex.position.map((value, axis) => value + offset[axis]) as Vec3 })));
  }, "Offset applied to each selected vertex once."));
  const distance = number("Face extrusion distance", "0.25"), faceActions = document.createElement("div"); distance.min = "-1000000"; distance.max = "1000000";
  const extrude = button("Extrude selected faces", () => run(() => {
    const shape = requiredShape(); requireFaces(); const next = extrudeMeshFaces(store, shape.id, [...selectedIds], extrudeDistance); selectedIds = [...next];
  }, "Faces extruded. New top faces selected."));
  const remove = button("Delete selected faces", () => deleteSelectedComponents());
  const faceButtons = document.createElement("div"); faceButtons.className = "modeling-actions"; faceButtons.append(extrude, remove);
  const extrusionHelp = document.createElement("p"); extrusionHelp.textContent = "Extrude one edge-connected face region along its average local normal.";
  extrusionHelp.title = "Use a nonzero distance within ±1,000,000. A closed whole-mesh selection has no boundary and cannot be extruded. Invalid topology is rejected without a partial edit.";
  faceActions.append(label("Extrude distance · local units", distance), faceButtons, extrusionHelp);
  const componentHelp = document.createElement("p"); componentHelp.textContent = "Choose a component mode to edit in the viewport or select IDs here. Offsets move the unique vertices belonging to the selected components in mesh-local coordinates. Topology and position edits use undo and save with the scene; component selection is temporary.";
  offsetDetails.append(delta.row, applyOffset, componentHelp);
  const gizmoHelp = document.createElement("p"); gizmoHelp.textContent = "W Move · E Rotate · R Scale. Drag to preview; release to apply. Escape cancels the drag, then exits component mode.";
  gizmoHelp.title = "Gizmos use world axes and the center of the selected vertices. Each drag creates one undo step. Numeric fields below use local axes.";
  components.append(label("Mode", mode), gizmoHelp, summary, label("Component", picker), selectionActions, cap, idDetails, absoluteGroup, offsetDetails);
  const topology = group("Edit Topology");
  const merge = button("Merge to center", () => run(() => {
    const shape = requiredShape(), survivor = mergeMeshVerticesToCenter(store, shape.id, [...selectedVertices(shape)]);
    mode.value = "vertex"; selectedIds = [survivor];
  }, "Vertices welded to their average position. The surviving vertex is selected."));
  merge.title = "Weld the vertices of the selected components to their average local position. Invalid topology is rejected.";
  const edgeActions = document.createElement("div"), removeEdges = button("Delete selected edges", () => deleteSelectedComponents());
  const edgeHelp = document.createElement("p"); edgeHelp.textContent = "Delete dissolves interior edges into polygon faces and keeps their vertices. Delete faces to remove border edges.";
  const bevelStart = button("Bevel", () => startBevel());
  bevelStart.title = "Bevel selected edges on closed convex polygon shells";
  const bevelControls = group("Bevel"), bevelFields = document.createElement("div");
  bevelFields.className = "topology-fields";
  const bevelWidth = number("Bevel Width", "0.25");
  bevelWidth.min = "0"; bevelWidth.max = "1"; bevelWidth.step = "0.01";
  const bevelSegments = number("Bevel Segments", "1");
  bevelSegments.min = "1"; bevelSegments.max = String(MAX_BEVEL_SEGMENTS); bevelSegments.step = "1";
  const widthLabel = label("Width (fraction)", bevelWidth), segmentsLabel = label("Segments", bevelSegments);
  bevelFields.append(widthLabel, segmentsLabel);
  const bevelApply = button("Apply Bevel", applyTopologyPreview), bevelCancel = button("Cancel Bevel", () => cancelTopologyPreview(true));
  const bevelActions = document.createElement("div"); bevelActions.className = "modeling-actions";
  bevelActions.append(bevelApply, bevelCancel);
  const bevelStatus = document.createElement("p"); bevelStatus.className = "modeling-status";
  bevelStatus.setAttribute("role", "status");
  bevelControls.append(bevelFields, bevelActions, bevelStatus);
  const selectBoundaries = button("Select Boundary Loops", () => run(() => {
    const shape = requiredShape();
    setComponentSelection(shape.id, "edge", expandBridgeBoundaryEdges(shape, selectedIds));
  }, "Boundary loops selected."));
  selectBoundaries.title = "Pick a boundary edge on each loop, then expand the edge selection to the complete loops";
  const bridgeStart = button("Bridge", () => startBridge());
  bridgeStart.title = "Bridge two equal, convex boundary loops in separated parallel planes";
  const bridgeControls = group("Bridge"), bridgeFields = document.createElement("div");
  bridgeFields.className = "topology-fields";
  const bridgeDirection = select("Bridge Direction");
  bridgeDirection.add(new Option("Automatic", "auto"));
  bridgeDirection.add(new Option("Forward", "forward"));
  bridgeDirection.add(new Option("Reverse", "reverse"));
  const bridgeOffset = number("Bridge Offset"), bridgeSegments = number("Bridge Segments", "1");
  bridgeOffset.min = "0"; bridgeOffset.step = "1";
  bridgeSegments.min = "1"; bridgeSegments.max = String(MAX_BRIDGE_SEGMENTS); bridgeSegments.step = "1";
  const bridgeOffsetLabel = label("Offset", bridgeOffset), bridgeSegmentsLabel = label("Segments", bridgeSegments);
  bridgeFields.append(bridgeOffsetLabel, bridgeSegmentsLabel);
  const bridgeApply = button("Apply Bridge", applyTopologyPreview), bridgeCancel = button("Cancel Bridge", () => cancelTopologyPreview(true));
  const bridgeActions = document.createElement("div"); bridgeActions.className = "modeling-actions"; bridgeActions.append(bridgeApply, bridgeCancel);
  const bridgeStatus = document.createElement("p"); bridgeStatus.className = "modeling-status"; bridgeStatus.setAttribute("role", "status");
  bridgeControls.append(label("Direction", bridgeDirection), bridgeFields, bridgeActions, bridgeStatus);
  bridgeDirection.addEventListener("change", scheduleTopologyPreview);
  const edgeButtons = document.createElement("div"); edgeButtons.className = "modeling-actions";
  edgeButtons.append(bevelStart, selectBoundaries, bridgeStart, removeEdges);
  edgeActions.append(edgeButtons, bevelControls, bridgeControls, edgeHelp); topology.append(merge, edgeActions, faceActions);
  const appearance = group("Appearance"), color = document.createElement("input"); color.type = "color"; color.setAttribute("aria-label", "Mesh color");
  const shading = select("Mesh shading"); shading.add(new Option("Flat", "flat")); shading.add(new Option("Smooth", "smooth"));
  const wireframe = document.createElement("input"); wireframe.type = "checkbox"; const wireframeLabel = label("Wireframe", wireframe); wireframeLabel.className = "modeling-check";
  const reverseAll = button("Reverse all normals", () => run(() => { reverseMeshNormals(store, requiredShape().id); }, "All face normals reversed."));
  const reverseShells = button("Reverse selected shell normals", () => run(() => {
    const shape = requiredShape(); requireFaces(); reverseMeshNormals(store, shape.id, [...selectedIds]);
  }, "Normals reversed on the connected shells of the selected faces."));
  reverseAll.title = reverseShells.title = "Reverse face winding. Double-sided shading may look unchanged.";
  const normalActions = document.createElement("div"); normalActions.className = "modeling-actions"; normalActions.append(reverseAll, reverseShells);
  appearance.append(label("Color", color), label("Shading", shading), wireframeLabel, normalActions);
  element.append(style, creationDetails, label("Mesh object", objects), empty, components, topology, appearance, status);

  const topologyLocks = ([[bevelWidth, widthLabel], [bevelSegments, segmentsLabel], [bridgeOffset, bridgeOffsetLabel], [bridgeSegments, bridgeSegmentsLabel]] as const).map(([input, handle]) => {
    const refreshLock = propertyInteraction(input, () => `topology/${preview?.kind}/${shapeId}/${input.getAttribute("aria-label")}`, handle, () => ({
      update: scheduleTopologyPreview,
      end: scheduleTopologyPreview,
    }));
    input.addEventListener("input", scheduleTopologyPreview);
    input.addEventListener("change", scheduleTopologyPreview);
    input.addEventListener("keydown", event => {
      if (event.key !== "Enter" || !preview) return;
      event.preventDefault(); event.stopPropagation();
      applyTopologyPreview();
    });
    return refreshLock;
  });

  function startBevel() {
    if (preview) return;
    run(() => {
      if (componentMode() !== "edge") throw Error("Select mesh edges before using Bevel.");
      const shape = requiredShape(), edgeIds = [...selectedIds];
      preview = { kind: "bevel", prepared: prepareMeshBevel(shape, edgeIds), edgeIds };
      bevelWidth.value = "0.25";
      bevelSegments.value = "1";
      topologyLocks.forEach(refreshLock => refreshLock());
      updateTopologyPreview();
    });
    if (!bevelControls.hidden) {
      bevelControls.scrollIntoView({ block: "nearest" });
      bevelWidth.focus({ preventScroll: true });
    }
  }

  function startBridge() {
    if (preview) return;
    run(() => {
      if (componentMode() !== "edge") throw Error("Select two boundary loops before using Bridge.");
      const shape = requiredShape(), edgeIds = [...selectedIds];
      const prepared = prepareMeshBridge(shape, edgeIds);
      preview = { kind: "bridge", prepared, edgeIds };
      bridgeDirection.value = "auto";
      bridgeDirection.options[0].text = `Automatic (${prepared.direction})`;
      bridgeOffset.max = String(prepared.maxOffset); bridgeOffset.value = "0"; bridgeSegments.value = "1";
      topologyLocks.forEach(refreshLock => refreshLock());
      updateTopologyPreview();
    });
    if (!bridgeControls.hidden) {
      bridgeControls.scrollIntoView({ block: "nearest" });
      bridgeOffset.focus({ preventScroll: true });
    }
  }

  function scheduleTopologyPreview() {
    if (preview && previewFrame === undefined) previewFrame = requestAnimationFrame(updateTopologyPreview);
  }

  function updateTopologyPreview() {
    if (previewFrame !== undefined) cancelAnimationFrame(previewFrame);
    previewFrame = undefined;
    const session = preview;
    if (!session) return;
    const source = session.prepared.source;
    const baseline: TopologyPreview = { shapeId: source.id, edgeIds: session.edgeIds };
    const status = session.kind === "bevel" ? bevelStatus : bridgeStatus;
    const apply = session.kind === "bevel" ? bevelApply : bridgeApply;
    status.dataset.error = "false";
    try {
      if (session.kind === "bevel") {
        const result = session.prepared.evaluate({ width: bevelWidth.valueAsNumber, segments: bevelSegments.valueAsNumber });
        options.onTopologyPreview(result.shape === source ? baseline : {
          ...baseline, shape: result.shape, edgeIds: session.edgeIds.flatMap(id => result.edgeMap.get(id) ?? []),
        });
        session.result = result.shape === source ? undefined : result;
        status.textContent = session.result
          ? `${session.edgeIds.length} selected ${session.edgeIds.length === 1 ? "edge" : "edges"} · ${result.shape.faces.length} preview faces`
          : "Width 0 keeps the original mesh.";
      } else {
        const result = session.prepared.evaluate({ direction: bridgeDirection.value as "auto" | "forward" | "reverse",
          offset: bridgeOffset.valueAsNumber, segments: bridgeSegments.valueAsNumber });
        options.onTopologyPreview({ ...baseline, shape: result.shape });
        session.result = result;
        status.textContent = `${result.faceIds.length} preview faces`;
      }
    } catch (error) {
      session.result = undefined;
      options.onTopologyPreview(baseline);
      status.dataset.error = "true";
      status.textContent = error instanceof Error ? error.message : String(error);
    }
    apply.disabled = !session.result;
  }

  function clearTopologyPreview() {
    if (!preview) return;
    preview = undefined;
    if (previewFrame !== undefined) cancelAnimationFrame(previewFrame);
    previewFrame = undefined;
    options.onTopologyPreview(undefined);
  }

  function cancelTopologyPreview(focus = false): boolean {
    if (!preview) return false;
    const start = preview.kind === "bevel" ? bevelStart : bridgeStart;
    clearTopologyPreview();
    refresh();
    if (focus) start.focus();
    return true;
  }

  function applyTopologyPreview() {
    if (previewFrame !== undefined) updateTopologyPreview();
    const session = preview;
    if (!options.available()) return;
    if (session?.kind === "bevel" && session.result) {
      const { prepared, result, edgeIds } = session;
      clearTopologyPreview();
      run(() => {
        commitMeshBevel(store, prepared.source, result);
        selectedIds = [...new Set(edgeIds.flatMap(id => result.edgeMap.get(id) ?? []))];
      }, "Edges beveled. Bevel rails selected.");
      bevelStart.focus();
    } else if (session?.kind === "bridge" && session.result) {
      const { prepared, result } = session;
      clearTopologyPreview();
      run(() => commitMeshBridge(store, prepared.source, result), "Boundary loops bridged.");
      bridgeStart.focus();
    }
  }

  function requiredShape(): MeshShapeNode {
    const shape = findMeshShape(store.getState().document, shapeId); if (!shape) throw Error("Choose an editable mesh first."); return shape;
  }
  function componentMode(): MeshComponentMode | undefined { return mode.value === "object" ? undefined : mode.value as MeshComponentMode; }
  function componentRows(shape: MeshShapeNode, kind: MeshComponentMode) {
    if (cachedShape !== shape) {
      cachedShape = shape; cachedEdges = meshEdges(shape);
      const vertexNumbers = new Map(shape.vertices.map((vertex, index) => [vertex.id, index + 1]));
      cachedRows = {
        vertex: shape.vertices.map((vertex, index) => ({ id: vertex.id, text: `Vertex ${index + 1}` })),
        face: shape.faces.map((face, index) => ({ id: face.id, text: `Face ${index + 1} (${face.vertices.length} vertices)` })),
        edge: cachedEdges.map((edge, index) => ({ id: edge.id, text: `Edge ${index + 1} (Vertex ${vertexNumbers.get(edge.vertices[0])}–Vertex ${vertexNumbers.get(edge.vertices[1])})` })),
      };
    }
    return cachedRows[kind];
  }
  function selectedVertices(shape: MeshShapeNode) {
    const selected = new Set(selectedIds), kind = componentMode();
    if (kind === "vertex") return selected;
    if (kind === "edge") return new Set(meshEdges(shape).filter(edge => selected.has(edge.id)).flatMap(edge => edge.vertices));
    if (kind === "face") return new Set(shape.faces.filter(face => selected.has(face.id)).flatMap(face => face.vertices));
    return new Set<string>();
  }
  function requireFaces() { if (componentMode() !== "face" || !selectedIds.length) throw Error("Select faces before using this operation."); }
  function deleteSelectedComponents(): boolean {
    if (preview) return true;
    const kind = componentMode();
    if (kind === "face") {
      run(() => { const shape = requiredShape(); requireFaces(); deleteMeshFaces(store, shape.id, [...selectedIds]); selectedIds = []; }, "Selected faces deleted.");
      return true;
    }
    if (kind === "edge") {
      run(() => { const shape = requiredShape(); const faces = deleteMeshEdges(store, shape.id, [...selectedIds]); mode.value = "face"; selectedIds = faces; }, "Edges dissolved. Resulting faces selected.");
      return true;
    }
    return false;
  }
  function run(action: () => void, message = "") {
    if (!options.available()) { status.textContent = "Pause playback and finish the current operation before editing meshes."; status.dataset.error = "true"; return; }
    try { action(); status.textContent = message; status.dataset.error = "false"; }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); status.dataset.error = "true"; }
    refresh();
  }
  function finite(input: HTMLInputElement) { const value = input.valueAsNumber; if (!input.value.trim() || !Number.isFinite(value)) throw Error(`${input.getAttribute("aria-label")} must be a finite number.`); return value; }
  function commit(input: HTMLInputElement, action: () => void) {
    let cancel = false;
    input.addEventListener("blur", () => { if (!cancel) run(action); cancel = false; refresh(); });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); input.blur(); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel = true; input.blur(); }
    });
  }
  commit(size, () => { const next = finite(size); if (next < 0.000001 || next > 1000000) throw Error("Primitive size must be between 0.000001 and 1000000."); primitiveSize = next; });
  commit(name, () => { primitiveName = name.value.trim(); });
  delta.inputs.forEach((input, axis) => commit(input, () => { offset[axis] = finite(input); }));
  commit(distance, () => { extrudeDistance = finite(distance); });
  absolute.inputs.forEach(input => commit(input, () => {
    const shape = requiredShape(); if (componentMode() !== "vertex" || selectedIds.length !== 1) throw Error("Select exactly one vertex to edit its absolute position.");
    setMeshVertexPositions(store, shape.id, [{ id: selectedIds[0], position: absolute.inputs.map(finite) as Vec3 }]);
  }));
  color.onchange = () => run(() => updateMeshAppearance(store, requiredShape().id, { color: color.value }));
  shading.onchange = () => run(() => updateMeshAppearance(store, requiredShape().id, { shading: shading.value as "flat" | "smooth" }));
  wireframe.onchange = () => run(() => updateMeshAppearance(store, requiredShape().id, { wireframe: wireframe.checked }));
  objects.onchange = () => { const next = objects.value; run(() => { stopEditing(); shapeId = next; if (shapeId) options.onSelectObject(requiredShape().parentId); }); };
  mode.onchange = () => run(() => { selectedIds = []; });
  function choose(append: boolean) { run(() => {
    const kind = componentMode(); if (!picker.value || !kind) throw Error("Choose a component first.");
    setComponentSelection(shapeId, kind, append ? [...selectedIds, picker.value] : [picker.value]);
  }); }
  function stopEditing() {
    clearTopologyPreview();
    const oldMode = componentMode(), oldShape = shapeId; mode.value = "object"; selectedIds = [];
    if (modeSignature) { modeSignature = ""; options.onComponentMode(undefined); }
    if (oldMode && oldShape) { emittedSelection = JSON.stringify([oldShape, oldMode, []]); options.onComponentSelection(oldShape, oldMode, []); }
    refresh();
  }
  function resetScene() {
    stopEditing(); shapeId = ""; selectionSignature = JSON.stringify(options.getSelection()); selectedIds = []; componentSignature = ""; displayedVertex = ""; emittedSelection = "";
    hadMeshes = undefined; offset = [0, 0, 0]; status.textContent = ""; status.dataset.error = "false"; refresh();
  }
  function setComponentSelection(targetShapeId: string, kind: MeshComponentMode, nextIds: string[]) {
    if (!["vertex", "edge", "face"].includes(kind)) throw Error("Unknown mesh component mode.");
    const shape = findMeshShape(store.getState().document, targetShapeId); if (!shape) throw Error("The editable mesh no longer exists.");
    const validIds = new Set(componentRows(shape, kind).map(row => row.id));
    const unique = [...new Set(nextIds)];
    if (unique.length > 20_000) throw Error("Select at most 20,000 mesh components. The previous selection was kept.");
    if (unique.some(id => !validIds.has(id))) throw Error("The component selection is stale. Select components again.");
    shapeId = shape.id; mode.value = kind; selectedIds = unique; refresh();
  }
  function setValue(input: HTMLInputElement, value: string, force = false) { if (force || document.activeElement !== input) input.value = value; }
  function refresh() {
    const doc = store.getState().document, available = options.available(), selection = options.getSelection(), selectionKey = JSON.stringify(selection);
    const shapes = Object.values(doc.nodes).filter((node): node is MeshShapeNode => node.type === "meshShape");
    const hasMeshes = shapes.length > 0;
    if (hadMeshes !== hasMeshes) { hadMeshes = hasMeshes; creationDetails.open = !hasMeshes; }
    if (selectionKey !== selectionSignature) {
      selectionSignature = selectionKey; const selected = selection.length === 1 ? findMeshShape(doc, selection[0]) : undefined;
      if (shapeId !== (selected?.id ?? "")) { shapeId = selected?.id ?? ""; selectedIds = []; mode.value = "object"; }
    }
    const objectKey = JSON.stringify(shapes.map(shape => [shape.id, doc.nodes[shape.parentId]?.name ?? shape.name]));
    if (objectKey !== objectSignature) { objectSignature = objectKey; objects.replaceChildren(new Option("Choose an editable mesh", ""), ...shapes.map(shape => new Option(doc.nodes[shape.parentId]?.name ?? shape.name, shape.id))); }
    const shape = shapes.find(candidate => candidate.id === shapeId);
    if (!shape) { shapeId = ""; selectedIds = []; mode.value = "object"; }
    if (preview && (!available || shape !== preview.prepared.source || componentMode() !== "edge" ||
      selectedIds.length !== preview.edgeIds.length || selectedIds.some((id, index) => id !== preview?.edgeIds[index]))) clearTopologyPreview();
    objects.value = shapeId; empty.hidden = !!shape; components.hidden = appearance.hidden = !shape;
    for (const control of Array.from(element.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button"))) control.disabled = !available;
    objects.disabled = !available || !shapes.length;
    setValue(name, primitiveName); setValue(size, String(primitiveSize)); setValue(distance, String(extrudeDistance)); delta.inputs.forEach((input, axis) => setValue(input, String(offset[axis])));
    const kind = componentMode(), rows = shape && kind ? componentRows(shape, kind) : [], validIds = new Set(rows.map(row => row.id));
    selectedIds = selectedIds.filter(id => validIds.has(id));
    const nextComponents = JSON.stringify([shapeId, kind, rows]);
    if (nextComponents !== componentSignature) { componentSignature = nextComponents; const previous = picker.value; picker.replaceChildren(...rows.slice(0, 5000).map(row => new Option(row.text, row.id))); if (rows.slice(0, 5000).some(row => row.id === previous)) picker.value = previous; }
    picker.disabled = replace.disabled = add.disabled = !available || !rows.length;
    clear.disabled = !available || !selectedIds.length; ids.value = selectedIds.join("\n");
    cap.textContent = rows.length > 5000 ? "The component menu lists the first 5,000 components. Viewport selection can select other IDs." : "";
    summary.textContent = shape ? `${shape.vertices.length} vertices · ${componentRows(shape, "edge").length} edges · ${shape.faces.length} faces · ${selectedIds.length} selected` : "";
    const singleVertex = shape && kind === "vertex" && selectedIds.length === 1 ? shape.vertices.find(vertex => vertex.id === selectedIds[0]) : undefined;
    absoluteGroup.hidden = !singleVertex;
    const vertexKey = singleVertex ? `${shapeId}/${singleVertex.id}` : "", force = vertexKey !== displayedVertex; displayedVertex = vertexKey;
    absolute.inputs.forEach((input, axis) => { input.disabled = !available || !singleVertex; if (singleVertex) setValue(input, String(singleVertex.position[axis]), force); });
    for (const input of delta.inputs) input.disabled = !available || !kind || !selectedIds.length;
    applyOffset.disabled = !available || !kind || !selectedIds.length;
    topology.hidden = !shape || !kind;
    merge.disabled = !available || !kind || !selectedIds.length || (kind === "vertex" && selectedIds.length < 2);
    edgeActions.hidden = kind !== "edge"; removeEdges.disabled = !available || kind !== "edge" || !selectedIds.length;
    faceActions.hidden = kind !== "face"; extrude.disabled = remove.disabled = !available || kind !== "face" || !selectedIds.length;
    reverseAll.disabled = !available || !shape?.faces.length;
    reverseShells.hidden = kind !== "face"; reverseShells.disabled = !available || kind !== "face" || !selectedIds.length;
    if (shape) { setValue(color, shape.color); shading.value = shape.shading; wireframe.checked = shape.wireframe; }
    const requestedMode = shape && kind ? JSON.stringify([shape.id, kind]) : "";
    const retainActiveMode = !!requestedMode && requestedMode === modeSignature && options.keepComponentMode?.();
    const nextMode = available || retainActiveMode ? requestedMode : "";
    if (nextMode !== modeSignature) { modeSignature = nextMode; options.onComponentMode(nextMode ? { shapeId: shape!.id, mode: kind! } : undefined); }
    const nextSelection = shape && kind ? JSON.stringify([shape.id, kind, selectedIds]) : "";
    if (nextSelection !== emittedSelection) { emittedSelection = nextSelection; if (shape && kind) options.onComponentSelection(shape.id, kind, [...selectedIds]); }
    bevelControls.hidden = preview?.kind !== "bevel";
    bridgeControls.hidden = preview?.kind !== "bridge";
    bevelStart.disabled = bridgeStart.disabled = selectBoundaries.disabled = !available || kind !== "edge" || !selectedIds.length;
    edgeButtons.hidden = !!preview;
    if (preview) {
      const controls = preview.kind === "bevel" ? bevelControls : bridgeControls;
      for (const control of Array.from(element.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input,select,button"))) {
        if (!controls.contains(control)) control.disabled = true;
      }
      (preview.kind === "bevel" ? bevelApply : bridgeApply).disabled = !preview.result;
    }
  }
  store.subscribe(() => refresh()); refresh();
  return { element, refresh, resetScene, stopEditing, setComponentSelection, deleteSelectedComponents, cancelTopologyPreview };
}
