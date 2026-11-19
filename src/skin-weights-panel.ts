import { createWeightCleanupPanel } from "./skin-weight-cleanup-panel.ts";
import type { CleanupContext } from "./skin-weight-smoothing.ts";
import { addSkinInfluence, removeSkinInfluence } from "./skin-influences.ts";
import { editSkinWeight, resetSkinWeights, MAX_WEIGHT_EDIT_COMPONENTS, type SkinInfluence } from "./skin-weights.ts";
import type { SplatShapeNode } from "./scene-document.ts";
import type { SceneStore } from "./scene-store.ts";

type Components = { count: number; getWeights: (index: number) => SkinInfluence[] };
type Preview = { values?: number[]; shapeId: string; indices: number[]; jointId: string };
type Options = {
  getCleanupContext?: (id: string) => CleanupContext | undefined;
  available: () => boolean;
  getSelection: () => string[];
  getComponents: (shapeId: string) => Components | undefined;
  getInfluenceRestMatrix?: (shapeId: string, jointId: string) => number[];
  onPreview: (preview: Preview | undefined) => void;
  onPickMode: (shapeId: string | undefined) => void;
};
const EDIT_LIMIT = MAX_WEIGHT_EDIT_COMPONENTS, PREVIEW_LIMIT = 5000;

/** Component-index skin editing; preview is runtime-only and never enters history. */
export function createSkinWeightsPanel(store: SceneStore, options: Options) {
  const element=document.createElement("section");element.className="skin-weights-panel";element.setAttribute("aria-label","Skin Weights");
  const style=document.createElement("style");
  style.textContent=`.skin-weights-panel{height:100%;overflow:auto;padding:12px;font-size:12px;background:var(--panel);color:var(--text)}
    .skin-weights-panel p{color:var(--muted);line-height:1.5}.skin-weights-panel fieldset{border:1px solid var(--line);padding:10px;margin:0 0 12px;min-width:0}.skin-weights-panel legend{padding:0 5px}
    .skin-weights-panel label{display:grid;gap:5px;margin:8px 0}.skin-weights-panel input,.skin-weights-panel select,.skin-weights-panel button{font:inherit;color:var(--text);background:var(--bg);border:1px solid var(--line);border-radius:3px;padding:6px;min-width:0}
    .skin-weights-panel input:not([type=checkbox]),.skin-weights-panel select{width:100%}.skin-weights-panel :disabled{opacity:.45;cursor:default}.skin-weights-panel button{cursor:pointer}.skin-weights-panel button:hover:not(:disabled){background:var(--hover)}
    .skin-weights-panel input:focus-visible,.skin-weights-panel select:focus-visible,.skin-weights-panel button:focus-visible{outline:1px solid var(--strong)}.skin-weights-panel .weight-range{display:grid;grid-template-columns:1fr 1fr;gap:8px}.skin-weights-panel .weight-range label{min-width:0}
    .skin-weights-panel .weight-actions{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.skin-weights-panel .weight-check{display:flex;align-items:center;gap:7px}.skin-weights-panel .weight-status{min-height:20px;overflow-wrap:anywhere}.skin-weights-panel .weight-status[data-error=true]{color:#ce756a}
    .skin-weights-panel table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}.skin-weights-panel th,.skin-weights-panel td{padding:5px;text-align:left;border-bottom:1px solid var(--line)}.skin-weights-panel th{color:var(--muted);font-size:10px}.skin-weights-panel td:last-child{text-align:right}.skin-weights-panel h3{font-size:12px;margin:12px 0 7px}
    .skin-weights-panel details{margin:9px 0}.skin-weights-panel summary{cursor:pointer;color:var(--muted)}.skin-weights-panel textarea{box-sizing:border-box;width:100%;resize:vertical;margin-top:6px;padding:6px;border:1px solid var(--line);border-radius:3px;background:var(--bg);color:var(--text);font:11px monospace}`;
  element.append(style);
  function label(text:string,control:HTMLElement){const node=document.createElement("label");node.append(document.createTextNode(text),control);return node;}
  function button(text:string,action:()=>void){const node=document.createElement("button");node.type="button";node.textContent=text;node.onclick=action;return node;}
  function number(name:string,value:string){const node=document.createElement("input");node.type="number";node.value=value;node.setAttribute("aria-label",name);return node;}
  function group(title:string){const node=document.createElement("fieldset"),legend=document.createElement("legend");legend.textContent=title;node.append(legend);return node;}
  const intro=document.createElement("p");intro.textContent="Edit normalized joint weights by splat component index. Each component supports up to four active influences. Edits preserve the proportions of its other influences.";element.append(intro);
  const objects=document.createElement("select");objects.setAttribute("aria-label","Bound splat object");element.append(label("Bound splat object",objects));
  const empty=document.createElement("p");empty.textContent="Bind a splat object to joints, then select it here or in the Outliner.";element.append(empty);
  const palette = group("Bound joint influences");
  const addJoint = document.createElement("select"); addJoint.setAttribute("aria-label", "Joint to add as influence");
  const removeJoint = document.createElement("select"); removeJoint.setAttribute("aria-label", "Influence to remove");
  const replacement = document.createElement("select"); replacement.setAttribute("aria-label", "Sole influence replacement");
  const addInfluence = button("Add influence with zero weight", () => run(() => {
    const shape = current(), context = requiredContext();
    if (!options.getInfluenceRestMatrix) throw Error("Current joint bind matrices are unavailable.");
    stopPicking(); clearPreview(true);
    addSkinInfluence(store, shape.id, addJoint.value, options.getInfluenceRestMatrix(shape.id, addJoint.value), context);
  }, "Influence added with zero weight. Existing effective weights are preserved; assign weights using numeric editing or painting."));
  const removeInfluence = button("Remove bound influence", () => run(() => {
    const shape = current(), context = requiredContext(); stopPicking(); clearPreview(true);
    removeSkinInfluence(store, shape.id, removeJoint.value, context, replacement.value || undefined);
  }, "Influence removed. Remaining weights were normalized proportionally; sole-influence rows use the chosen replacement."));
  const paletteHelp = document.createElement("p");
  paletteHelp.textContent = "Palette edits preserve effective weights by storing every component row (up to 200,000 components). Add starts at zero weight. Remove normalizes surviving weights; components weighted only to the removed joint require an explicit replacement. Reset to automatic later recomputes weights from the edited palette.";
  palette.append(label("Unbound joint", addJoint), addInfluence, label("Remove influence", removeJoint), label("Replacement for sole-influence components", replacement), removeInfluence, paletteHelp);
  element.append(palette);
  let paletteSignature = "";
  removeJoint.onchange = () => { paletteSignature = ""; refresh(); };
  const details=group("Component weights");
  const summary=document.createElement("p");details.append(summary);
  const mode=document.createElement("select");mode.setAttribute("aria-label","Component selection mode");mode.add(new Option("Range","range"));mode.add(new Option("Viewport selection","viewport"));details.append(label("Selection mode",mode));
  const pickDepth=document.createElement("select");pickDepth.setAttribute("aria-label","Skin selection depth");
  for (const [name,id] of [["Scene visible","scene-visible"],["Front centers","front-centers"],["Through","through"]]) pickDepth.add(new Option(name,id));
  details.append(label("Selection depth",pickDepth));
  pickDepth.onchange = () => {stopPicking(); refresh();};
  const picking=document.createElement("input");picking.type="checkbox";
  const pickLabel=label("Select components in viewport",picking);pickLabel.className="weight-check";details.append(pickLabel);
  const pickGuide=document.createElement("p");pickGuide.textContent="Click the nearest component center or drag a box using the selected depth mode. Shift adds; Ctrl subtracts; Escape cancels picking. Each selection supports up to 20,000 indices.";details.append(pickGuide);
  const clearSelection=button("Clear component selection",()=>run(()=>{mode.value="viewport";stopPicking();replaceSelection([]);},"Viewport component selection cleared."));details.append(clearSelection);
  const indexDetails=document.createElement("details"),indexSummary=document.createElement("summary");indexSummary.textContent="Selected component indices";
  const indexList=document.createElement("textarea");indexList.rows=4;indexList.readOnly=true;indexList.setAttribute("aria-label","Selected viewport component indices");indexDetails.append(indexSummary,indexList);details.append(indexDetails);
  const range=document.createElement("div");range.className="weight-range";
  const first=number("First component index","0"),last=number("Last component index","0");
  for(const input of [first,last]){input.step="1";input.min="0";}
  range.append(label("First index · inclusive",first),label("Last index · inclusive",last));details.append(range);
  const rangeSummary=document.createElement("p");details.append(rangeSummary);
  const previous=button("Previous component",()=>run(()=>{
    const context=requiredContext(),currentIndex=mode.value==="viewport"?(componentSelection[0]??rangeStart):rangeStart;
    setRange(Math.max(0,currentIndex-1),Math.max(0,currentIndex-1),context.count);
  }));
  const next=button("Next component",()=>run(()=>{
    const context=requiredContext(),currentIndex=mode.value==="viewport"?(componentSelection[0]??rangeStart):rangeStart,index=Math.min(context.count-1,currentIndex+1);setRange(index,index,context.count);
  }));
  previous.title=next.title="Switch to Range mode and select one adjacent component.";
  first.title=last.title="Editing this index switches to Range mode.";
  const navigation=document.createElement("div");navigation.className="weight-actions";navigation.append(previous,next);details.append(navigation);
  const influence=document.createElement("select");influence.setAttribute("aria-label","Skin joint influence");details.append(label("Joint influence",influence));
  const value=number("Influence weight","1");value.step="0.01";value.min="0";value.max="1";details.append(label("Weight · 0 to 1",value));
  const apply=button("Apply influence weight",()=>run(()=>{
    const shape=current(),context=requiredContext(),indices=editIndices(context.count);
    editSkinWeight(store,shape.id,indices,influence.value,requestedWeight,context);
  },"Influence weight applied to the exact component selection. Undo restores the previous weights."));
  const resetSelected=button("Reset selected to automatic",()=>run(()=>{
    const shape=current(),context=requiredContext(),indices=editIndices(context.count);
    stopPicking();clearPreview(true);resetSkinWeights(store,shape.id,indices);
  },"Selected components now use their automatic distance weights."));
  const resetAll=button("Reset all overrides",()=>run(()=>{
    const shape=current();stopPicking();clearPreview(true);resetSkinWeights(store,shape.id,null);
  },"All authored weight overrides removed. The binding now uses automatic weights."));
  const actions=document.createElement("div");actions.className="weight-actions";actions.append(apply,resetSelected,resetAll);details.append(actions);
  const show=document.createElement("input");show.type="checkbox";
  const showLabel=label("Show weights in viewport",show);showLabel.className="weight-check";details.append(showLabel);
  const previewNote=document.createElement("p");details.append(previewNote);
  const inspectHeading=document.createElement("h3");details.append(inspectHeading);
  const table=document.createElement("table");table.setAttribute("aria-label","Inspected component influences");
  const head=document.createElement("thead"),headRow=document.createElement("tr");
  for(const text of ["Joint","Normalized weight"]){const cell=document.createElement("th");cell.scope="col";cell.textContent=text;headRow.append(cell);}head.append(headRow);table.append(head);
  const weightsBody=document.createElement("tbody");table.append(weightsBody);details.append(table);
  const total=document.createElement("p");details.append(total);
  const limits=document.createElement("p");limits.textContent="Edits affect every selected index, up to 20,000 components per operation. Range uses every index between its endpoints; Viewport selection uses only the selected indices and never falls back to a range. Viewport display samples at most 5,000 selected indices. The paused preview uses X-ray points visible through surfaces; it hides during playback, manipulation, or when Gizmos are hidden. Component selection and preview never change scene history. Weight 1 makes the selected joint the sole influence; unsupported fifth influences and invalid normalization are rejected.";
  const status=document.createElement("p");status.className="weight-status";status.setAttribute("role","status");status.setAttribute("aria-live","polite");
  const cleanup = createWeightCleanupPanel(store, {shape:current, context:id=>options.getCleanupContext?.(id), targets:editIndices, joint:()=>influence.value, available:options.available, show:options.onPreview});
  element.append(details,cleanup.element,status,limits);
  let shapeId="",rangeStart=0,rangeEnd=0,requestedWeight=1;
  let selectionSignature="",objectSignature="",influenceSignature="",inspectionSignature="",previewSignature="";
  let previousBinding:SplatShapeNode["binding"],previewBinding:SplatShapeNode["binding"];
  let overrideBinding:SplatShapeNode["binding"],overrideCount=0;
  let componentSelection:number[]=[],selectionRevision=0,activePickShape:string|undefined;

  function current():SplatShapeNode{
    const shape=store.getState().document.nodes[shapeId];
    if(shape?.type!=="splatShape"||!shape.binding)throw Error("Select a bound splat object first.");
    return shape;
  }
  function requiredContext():Components{
    current();const context=options.getComponents(shapeId);
    if(!context||!Number.isSafeInteger(context.count)||context.count<=0)throw Error("The selected binding has no available components. Wait for the splat asset to load.");
    return context;
  }
  function validateRange(start:number,end:number,count:number){
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>=count)
      throw Error(`Use whole component indices from 0 to ${Math.max(0,count-1)}, with the first index no greater than the last.`);
  }
  function setRange(start:number,end:number,count:number){validateRange(start,end,count);rangeStart=start;rangeEnd=end;mode.value="range";stopPicking();}
  function editIndices(count:number){
    if(mode.value==="viewport"){
      if(!componentSelection.length)throw Error("Select components in the viewport before editing their weights, or switch to Range mode.");
      if(componentSelection.some(index=>!Number.isSafeInteger(index)||index<0||index>=count))throw Error("The component selection is stale. Select components again.");
      return [...componentSelection];
    }
    validateRange(rangeStart,rangeEnd,count);const size=rangeEnd-rangeStart+1;
    if(size>EDIT_LIMIT)throw Error("Choose at most 20,000 components for one edit. The viewport sample does not limit which components are edited.");
    return Array.from({length:size},(_,index)=>rangeStart+index);
  }
  function clearPreview(uncheck=false){
    if(uncheck)show.checked=false;
    if(previewSignature){options.onPreview(undefined);previewSignature="";previewBinding=undefined;}
  }
  function stopPicking(){
    picking.checked=false;
    if(activePickShape!==undefined){activePickShape=undefined;options.onPickMode(undefined);}
  }
  function replaceSelection(indices:number[]){componentSelection=indices;selectionRevision++;inspectionSignature="";indexList.value=indices.join(", ");}
  function resetScene(){
    stopPicking();clearPreview(true);replaceSelection([]);
    shapeId="";rangeStart=rangeEnd=0;requestedWeight=1;mode.value="range";
    selectionSignature="";inspectionSignature="";previousBinding=undefined;overrideBinding=undefined;overrideCount=0;
    status.textContent="";status.dataset.error="false";refresh();
  }
  function setComponentSelection(targetShapeId:string,indices:number[],operation:"replace"|"add"|"subtract"){
    try{
      if(!options.available())throw Error("Pause playback and finish the current operation before selecting components.");
      if(targetShapeId!==shapeId)throw Error("The bound object changed. Select components again on the current object.");
      const context=requiredContext();
      if(!["replace","add","subtract"].includes(operation))throw Error("Unknown component selection operation.");
      const incoming=new Set<number>();
      for(const index of indices){
        if(!Number.isSafeInteger(index)||index<0||index>=context.count)throw Error(`Component indices must be whole numbers from 0 to ${context.count-1}.`);
        incoming.add(index);if(incoming.size>EDIT_LIMIT)throw Error("The selection exceeds 20,000 components. Choose a smaller box.");
      }
      const merged=operation==="replace"?incoming:new Set(componentSelection);
      if(operation==="add")for(const index of incoming)merged.add(index);
      if(operation==="subtract")for(const index of incoming)merged.delete(index);
      if(merged.size>EDIT_LIMIT)throw Error("Adding these components would exceed 20,000 selected indices. The previous selection was kept.");
      if([...merged].some(index=>!Number.isSafeInteger(index)||index<0||index>=context.count))throw Error("The existing selection is stale. Replace it with a new component selection.");
      const selected=[...merged].sort((a,b)=>a-b);
      mode.value="viewport";replaceSelection(selected);if(selected.length)show.checked=true;
      status.textContent=`${selected.length.toLocaleString()} viewport components selected.`;status.dataset.error="false";refresh();
    }catch(error){status.textContent=error instanceof Error?error.message:String(error);status.dataset.error="true";throw error;}
  }
  function run(action:()=>void,message=""){
    if(!options.available()){status.textContent="Pause playback and finish the current operation before editing skin weights.";status.dataset.error="true";return;}
    try{action();status.textContent=message;status.dataset.error="false";refresh();}
    catch(error){status.textContent=error instanceof Error?error.message:String(error);status.dataset.error="true";refresh();}
  }
  function onCommit(input:HTMLInputElement,action:()=>void){
    let cancel=false;
    input.addEventListener("blur",()=>{if(!cancel)run(action);cancel=false;refresh();});
    input.addEventListener("keydown",event=>{
      if(event.key==="Enter"){event.preventDefault();input.blur();}
      else if(event.key==="Escape"){event.preventDefault();cancel=true;input.blur();refresh();}
    });
  }
  function readNumber(input:HTMLInputElement){if(!input.value.trim()||!Number.isFinite(input.valueAsNumber))throw Error(`${input.getAttribute("aria-label")} must be a finite number.`);return input.valueAsNumber;}
  onCommit(first,()=>{const context=requiredContext(),start=readNumber(first);setRange(start,Math.max(start,rangeEnd),context.count);});
  onCommit(last,()=>{const context=requiredContext(),end=readNumber(last);setRange(Math.min(rangeStart,end),end,context.count);});
  onCommit(value,()=>{const number=readNumber(value);if(number<0||number>1)throw Error("Influence weight must be between 0 and 1.");requestedWeight=number;});
  objects.onchange=()=>{stopPicking();clearPreview(true);if(shapeId!==objects.value)replaceSelection([]);shapeId=objects.value;rangeStart=rangeEnd=0;inspectionSignature="";status.textContent="";refresh();};
  influence.onchange=()=>{inspectionSignature="";status.textContent="";refresh();};
  show.onchange=()=>{if(!show.checked)clearPreview();refresh();};
  mode.onchange=()=>{if(mode.value==="range")stopPicking();inspectionSignature="";refresh();};
  picking.onchange=()=>{if(picking.checked)mode.value="viewport";else stopPicking();refresh();};

  function refresh(){
    const doc=store.getState().document,selection=options.getSelection(),selectionKey=selection.join("|"),available=options.available();
    const shapes=Object.values(doc.nodes).filter((node):node is SplatShapeNode=>node.type==="splatShape"&&!!node.binding);
    if(selectionKey!==selectionSignature){
      selectionSignature=selectionKey;stopPicking();clearPreview(true);status.textContent="";
      const selected=selection.length===1?shapes.find(shape=>shape.parentId===selection[0]||shape.id===selection[0]):undefined;
      if(shapeId!==(selected?.id??""))replaceSelection([]);
      shapeId=selected?.id??"";rangeStart=rangeEnd=0;inspectionSignature="";
    }
    const nextObjectSignature=JSON.stringify(shapes.map(shape=>[shape.id,doc.nodes[shape.parentId]?.name??shape.name]));
    if(nextObjectSignature!==objectSignature){
      objectSignature=nextObjectSignature;objects.replaceChildren(new Option("Choose a bound splat object",""),...shapes.map(shape=>new Option(doc.nodes[shape.parentId]?.name??shape.name,shape.id)));
    }
    const shape=shapes.find(shape=>shape.id===shapeId);
    if(!shape){shapeId="";stopPicking();if(componentSelection.length)replaceSelection([]);clearPreview(true);}
    objects.value=shapeId;palette.hidden=details.hidden=!shape;empty.hidden=!!shape;
    for(const control of Array.from(element.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>("input,select,button")))if (!cleanup.element.contains(control)) control.disabled=!available;
    objects.disabled=!available||!shapes.length;
    if(!available)stopPicking();
    if(!shape){previousBinding=undefined;cleanup.refresh();return;}
    if(previousBinding&&previousBinding!==shape.binding&&!shape.binding!.weights&&previousBinding.weights){stopPicking();clearPreview(true);}
    previousBinding=shape.binding;
    const nextInfluenceSignature=JSON.stringify([shape.id,shape.binding!.jointIds.map(id=>[id,doc.joints?.find(joint=>joint.id===id)?.name??id])]);
    if(nextInfluenceSignature!==influenceSignature){
      influenceSignature=nextInfluenceSignature;const before=influence.value;
      influence.replaceChildren(...shape.binding!.jointIds.map(id=>new Option(doc.joints?.find(joint=>joint.id===id)?.name??id,id)));
      if(shape.binding!.jointIds.includes(before))influence.value=before;
      inspectionSignature="";
    }
    const nextPaletteSignature = JSON.stringify([shape.id, shape.binding!.jointIds, doc.joints?.map(joint => [joint.id, joint.name]), removeJoint.value]);
    if (nextPaletteSignature !== paletteSignature) {
      const oldAdd = addJoint.value, oldRemove = removeJoint.value, oldReplacement = replacement.value;
      const bound = new Set(shape.binding!.jointIds), names = new Map(doc.joints?.map(joint => [joint.id, joint.name]));
      addJoint.replaceChildren(...(doc.joints ?? []).filter(joint => !bound.has(joint.id)).map(joint => new Option(joint.name, joint.id)));
      if (Array.from(addJoint.options).some(option => option.value === oldAdd)) addJoint.value = oldAdd;
      removeJoint.replaceChildren(...shape.binding!.jointIds.map(id => new Option(names.get(id) ?? id, id)));
      if (bound.has(oldRemove)) removeJoint.value = oldRemove;
      replacement.replaceChildren(new Option("Reject if any component has no surviving weight", ""), ...shape.binding!.jointIds.filter(id => id !== removeJoint.value).map(id => new Option(names.get(id) ?? id, id)));
      if (oldReplacement !== removeJoint.value && bound.has(oldReplacement)) replacement.value = oldReplacement;
      paletteSignature = JSON.stringify([shape.id, shape.binding!.jointIds, doc.joints?.map(joint => [joint.id, joint.name]), removeJoint.value]);
    }
    const context=options.getComponents(shape.id),count=context?.count??0;
    const validContext=!!context&&Number.isSafeInteger(count)&&count>0;
    const paletteAvailable = available && validContext && count <= 200000;
    addJoint.disabled = addInfluence.disabled = !paletteAvailable || !addJoint.value || !options.getInfluenceRestMatrix || shape.binding!.jointIds.length >= 256;
    removeJoint.disabled = replacement.disabled = removeInfluence.disabled = !paletteAvailable || shape.binding!.jointIds.length <= 1;
    if(validContext){
      rangeStart=Math.min(Math.max(0,rangeStart),count-1);rangeEnd=Math.min(Math.max(rangeStart,rangeEnd),count-1);
      if(componentSelection.some(index=>index>=count)){replaceSelection(componentSelection.filter(index=>index<count));stopPicking();}
    }else{rangeStart=rangeEnd=0;stopPicking();clearPreview(true);if(context?.count===0&&componentSelection.length)replaceSelection([]);}
    if(document.activeElement!==first)first.value=String(rangeStart);
    if(document.activeElement!==last)last.value=String(rangeEnd);
    first.max=last.max=String(Math.max(0,count-1));
    if(overrideBinding!==shape.binding){overrideBinding=shape.binding;overrideCount=Object.keys(shape.binding!.weights?.overrides??{}).length;}
    summary.textContent=validContext?`${count.toLocaleString()} components · ${overrideCount.toLocaleString()} authored overrides` : "Waiting for the binding's component data. Empty assets have no editable components.";
    const viewportSelection=mode.value==="viewport",selectedCount=validContext?(viewportSelection?componentSelection.length:rangeEnd-rangeStart+1):0;
    const inspectIndex=viewportSelection?componentSelection[0]:rangeStart;
    rangeSummary.textContent=`${selectedCount.toLocaleString()} components selected in ${viewportSelection?"Viewport selection":"Range"} mode${selectedCount>EDIT_LIMIT?" · exceeds the 20,000-component edit limit":""}. Edits apply to every selected index, including indices omitted from the preview.`;
    for(const control of [first,last,influence,mode,picking])control.disabled=!available||!validContext||!influence.value;
    for(const control of [value,show])control.disabled=!available||!validContext||!influence.value||!selectedCount;
    clearSelection.disabled=!available||!validContext||!componentSelection.length;
    apply.disabled=!available||!validContext||!influence.value||!selectedCount||selectedCount>EDIT_LIMIT;
    resetSelected.disabled=!available||!validContext||!overrideCount||!selectedCount||selectedCount>EDIT_LIMIT;
    resetAll.disabled=!available||!overrideCount||(viewportSelection&&!selectedCount);
    const navigationIndex=inspectIndex??rangeStart;
    previous.disabled=!available||!validContext||navigationIndex===0;
    next.disabled=!available||!validContext||navigationIndex>=count-1;
    if(validContext&&selectedCount){
      try{
        const weights=context!.getWeights(inspectIndex).filter(entry=>entry.weight>0);
        const inspectionKey=JSON.stringify([shape.id,inspectIndex,influence.value,weights,doc.joints?.map(joint=>[joint.id,joint.name]),!!shape.binding!.weights?.overrides[String(inspectIndex)]]);
        if(inspectionKey!==inspectionSignature){
          inspectionSignature=inspectionKey;weightsBody.replaceChildren();
          for(const entry of weights){const row=document.createElement("tr"),joint=document.createElement("td"),amount=document.createElement("td");joint.textContent=doc.joints?.find(item=>item.id===entry.jointId)?.name??entry.jointId;amount.textContent=entry.weight.toFixed(6);row.append(joint,amount);weightsBody.append(row);}
          if(document.activeElement!==value)requestedWeight=weights.find(entry=>entry.jointId===influence.value)?.weight??0;
          total.textContent=`Normalized total: ${weights.reduce((sum,entry)=>sum+entry.weight,0).toFixed(6)} · ${weights.length} active influences`;
        }
        inspectHeading.textContent=`Component ${inspectIndex} · ${shape.binding!.weights?.overrides[String(inspectIndex)]?"authored override":"automatic weights"}`;
      }catch(error){inspectHeading.textContent="Component weights unavailable";weightsBody.replaceChildren();total.textContent=error instanceof Error?error.message:String(error);clearPreview(true);apply.disabled=show.disabled=true;}
    }else{weightsBody.replaceChildren();inspectHeading.textContent=validContext?"No components selected":"Component weights unavailable";total.textContent="";inspectionSignature="";}
    if(document.activeElement!==value)value.value=String(Number(requestedWeight.toFixed(6)));
    const samples=Math.min(PREVIEW_LIMIT,selectedCount);
    previewNote.textContent=`Paused X-ray preview: blue = 0, orange = 1 influence weight. ${samples.toLocaleString()}${samples<selectedCount?` evenly sampled indices of ${selectedCount.toLocaleString()}`:" component indices"}; the full component selection remains unchanged.`;
    cleanup.refresh(shape, JSON.stringify([rangeStart,rangeEnd,mode.value,selectionRevision]));
    if(cleanup.active) return;
    if(show.checked&&available&&validContext&&influence.value&&selectedCount){
      const signature=`${shape.id}/${mode.value}/${rangeStart}/${rangeEnd}/${selectionRevision}/${influence.value}`;
      if(signature!==previewSignature||previewBinding!==shape.binding){
        const indices=Array.from({length:samples},(_,index)=>viewportSelection?componentSelection[samples===1?0:Math.round(index*(selectedCount-1)/(samples-1))]:samples===1?rangeStart:Math.round(rangeStart+(rangeEnd-rangeStart)*(index/(samples-1))));
        options.onPreview({shapeId:shape.id,indices,jointId:influence.value});previewSignature=signature;previewBinding=shape.binding;
      }
    }else clearPreview();
    if(picking.checked&&viewportSelection&&available&&validContext){
      if(activePickShape!==shape.id){activePickShape=shape.id;options.onPickMode(shape.id);}
    }else stopPicking();
  }
  store.subscribe((state,previous)=>{
    if(state.document!==previous.document){
      if(state.editLabel==="Reset skin weights"){stopPicking();clearPreview(true);}
    }refresh();
  });
  refresh();
  return {element,refresh,getPickDepth:()=>pickDepth.value as import("./splat-component-selection.ts").SplatSelectionDepth,setComponentSelection,getComponentSelection:()=>mode.value==="viewport"?[...componentSelection]:[],stopPicking,resetScene};
}
