import { createDockview } from "dockview";
import "dockview/dist/styles/dockview.css";

// Keep each existing content element alive, including the WebGL canvas, through layout changes.
export function mountWorkspace(riggingContent: HTMLElement, terminalContent: HTMLElement) {
  const host = document.getElementById("workspace")!;
  const parking = document.createElement("div");
  parking.hidden = true;
  document.body.append(parking);
  const contents = new Map(
    ["viewport", "outliner-panel", "properties", "timeline-panel"].map((id) => [
      id,
      document.getElementById(id)!,
    ]),
  );
  contents.set("rigging", riggingContent);
  contents.set("terminal", terminalContent);
  const animationPanels: Record<string, string> = { graph: "Graph Editor", "dope-sheet": "Dope Sheet", "driven-keys": "Set Driven Key", "ik-handles": "IK Handles", "ik-bake": "Bake IK to FK", constraints: "Constraints", controllers: "Curve Controls", "skin-weights": "Skin Weights", "paint-skin-weights": "Paint Skin Weights", modeling: "Mesh Tools", particles: "Particle Emitters" };
  animationPanels["splat-components"] = "Splat Components";
  animationPanels["splat-masks"] = "Splat Sets and Masks";
  animationPanels["texture-assets"] = "Texture Assets";
  animationPanels["texture-graph"] = "Texture Graph";
  animationPanels["joint-settings"] = "Joint Settings";
  animationPanels["rotation-curves"] = "Rotation Curves";
  animationPanels["animation-layers"] = "Animation Layers";
  animationPanels["joint-mirror"] = "Mirror Joints / Pose";
  for (const id of Object.keys(animationPanels)) {
    const wrapper = document.createElement("div"); wrapper.className = "animation-dock-host";
    contents.set(id, wrapper);
  }
  const api = createDockview(host, {
    theme: { name: "musubi", className: "dockview-theme-musubi", gap: 4 },
    disableFloatingGroups: true,
    disableDnd: false,
    createComponent(options) {
      const element = contents.get(options.name);
      if (!element) throw Error(`Unknown panel: ${options.name}`);
      return { element, init() {}, dispose() { parking.append(element); } };
    },
    createTabComponent() {
      const element = document.createElement("span");
      element.className = "panel-tab";
      element.title = "Drag to dock beside another panel or combine as tabs";
      return {
        element,
        init(parameters) {
          element.textContent = parameters.title;
          const close = document.createElement("button");
          close.className = "panel-close";
          close.textContent = "×";
          close.title = `Close ${parameters.title}`;
          close.setAttribute("aria-label", close.title);
          close.addEventListener("pointerdown", (event) => event.stopPropagation());
          close.addEventListener("click", (event) => {
            event.stopPropagation();
            customized = true;
            parameters.api.close();
          });
          element.append(close);
        },
      };
    },
  });
  let compact = host.clientWidth < 760;
  let customized = false;
  function arrange() {
    api.clear();
    api.addPanel({
      id: "viewport",
      component: "viewport",
      title: "Viewport",
      tabComponent: "label",
      renderer: "always",
      minimumWidth: 220,
      minimumHeight: 180,
    });
    api.addPanel({
      id: "timeline",
      component: "timeline-panel",
      title: "Timeline",
      tabComponent: "label",
      renderer: "always",
      position: { direction: "below" },
      initialHeight: 156,
      minimumHeight: 140,
      minimumWidth: 220,
    });
    api.addPanel({
      id: "outliner",
      component: "outliner-panel",
      title: "Outliner",
      tabComponent: "label",
      renderer: "always",
      position: {
        referencePanel: "viewport",
        direction: compact ? "below" : "right",
      },
      initialWidth: 290,
      initialHeight: compact ? 260 : 200,
      minimumWidth: 240,
      minimumHeight: 100,
    });
    api.addPanel({
      id: "properties",
      component: "properties",
      title: "Properties",
      tabComponent: "label",
      renderer: "always",
      position: {
        referencePanel: "outliner",
        direction: "within",
      },
      minimumWidth: 240,
      minimumHeight: 220,
    });
    api.getPanel("timeline")!.api.setSize({ height: 156 });
    api
      .getPanel("outliner")!
      .api.setSize(compact ? { height: 260 } : { width: 240 });
    if (!compact) api.getPanel("properties")!.api.setSize({ width: Math.max(290, host.clientWidth * 0.16) });
    api.getPanel("properties")!.api.setActive();
  }
  const layoutKey = "musubi-workspace-v1";
  const presetControl = document.getElementById("workspace-preset") as HTMLSelectElement;
  const presetKey = "musubi-workspace-preset-v1";
  let restored = false;
  try {
    const saved = localStorage.getItem(layoutKey);
    if (saved) {
      api.fromJSON(JSON.parse(saved)); restored = true; customized = true;
      const preset = localStorage.getItem(presetKey);
      if (preset && Array.from(presetControl.options).some(option => option.value === preset)) presetControl.value = preset;
    }
  } catch { /* Fall back to the default if storage is unavailable or incompatible. */ }
  if (!restored) arrange();
  // Keep closed content mounted so scene updates can still find its elements.
  for (const content of contents.values()) {
    if (!host.contains(content)) parking.append(content);
  }
  function saveLayout() {
    try { localStorage.setItem(layoutKey, JSON.stringify(api.toJSON())); localStorage.setItem(presetKey, presetControl.value); }
    catch { /* Restricted storage must not interrupt editing. */ }
  }
  api.onDidLayoutChange(() => { customized = true; saveLayout(); });
  window.addEventListener("pagehide", saveLayout);
  saveLayout();
  api.onDidMovePanel(() => {
    customized = true;
  });
  new ResizeObserver(() => {
    api.layout(host.clientWidth, host.clientHeight);
    const next = host.clientWidth < 760;
    if (next !== compact) {
      compact = next;
      if (!customized) arrange();
    }
  }).observe(host);
  document.getElementById("panel-staging")!.remove();
  const panels = {
    terminal: { component: "terminal", title: "Terminal" },
    properties: { component: "properties", title: "Properties" },
    outliner: { component: "outliner-panel", title: "Outliner" },
    viewport: { component: "viewport", title: "Viewport" },
    timeline: { component: "timeline-panel", title: "Timeline" },
  };
  for (const [id, config] of Object.entries(panels)) {
    document.getElementById(`view-${id}`)!.addEventListener("click", () => {
      customized = true;
      const existing = api.getPanel(id);
      if (existing) { existing.api.setActive(); return; }
      api.addPanel({ id, ...config, tabComponent: "label", renderer: "always",
        minimumWidth: 220, minimumHeight: 100,
        position: api.panels.length ? { direction: id === "timeline" || id === "terminal" ? "below" : "right" } : undefined,
      }).api.setActive();
    });
  }
  function showAnimationPanel(id: string) {
    const title = animationPanels[id];
    if (!title) return;
    customized = true;
    const existing = api.getPanel(id);
    if (existing) { existing.api.setActive(); return; }
    const attributeIds = ["driven-keys", "ik-handles", "ik-bake", "constraints", "controllers", "skin-weights", "paint-skin-weights", "modeling", "particles"];
    attributeIds.push("splat-components");
    attributeIds.push("splat-masks");
    attributeIds.push("texture-assets");
    attributeIds.push("joint-settings");
    attributeIds.push("rotation-curves");
    attributeIds.push("animation-layers");
    attributeIds.push("joint-mirror");
    const attribute = attributeIds.includes(id);
    const sidePanel = attribute ? ["properties", "outliner", "rigging", ...attributeIds].find(candidate => api.getPanel(candidate)) : undefined;
    const reference = sidePanel ?? (api.getPanel("viewport") ? "viewport" : api.panels[0]?.id);
    api.addPanel({ id, component: id, title, tabComponent: "label", renderer: "always",
      minimumWidth: attribute ? 300 : 440, minimumHeight: attribute ? 180 : 260,
      ...(attribute ? sidePanel ? {} : { initialWidth: 340 } : { initialHeight: 330 }),
      position: reference ? { referencePanel: reference, direction: attribute ? sidePanel ? "within" : "right" : "below" } : undefined,
    }).api.setActive();
  }
  for (const id of Object.keys(animationPanels)) document.getElementById(`view-${id}`)!.addEventListener("click", () => showAnimationPanel(id));
  document.getElementById("workspace-preset")!.addEventListener("change", event => {
    const preset = (event.target as HTMLSelectElement).value;
    arrange();
    if (preset === "animation") showAnimationPanel("graph");
    if (preset === "rigging") document.getElementById("rigging-open")!.click();
    if (preset === "modeling") showAnimationPanel("modeling");
    if (preset === "fx") showAnimationPanel("particles");
    saveLayout();
  });
  return {
    registerPanel(id: string, _title: string, content: HTMLElement) {
      const wrapper = contents.get(id);
      if (!wrapper) throw Error(`Unknown panel: ${id}`);
      wrapper.replaceChildren(content);
    },
    showRigging() {
      customized = true;
      const existing = api.getPanel("rigging");
      if (existing) { existing.api.setActive(); return; }
      api.addPanel({
        id: "rigging", component: "rigging", title: "Rigging", tabComponent: "label",
        renderer: "always", minimumWidth: 240, minimumHeight: 180,
        position: api.getPanel("properties") ? { referencePanel: "properties", direction: "within" }
          : api.panels.length ? { direction: "right" } : undefined,
      }).api.setActive();
    },
    hideRigging() {
      const panel = api.getPanel("rigging");
      if (panel) api.removePanel(panel);
    },
  };
}
