import { graphTextureReferences } from "./procedural-graph.ts";
import { particleMapReferences } from "./particle-map-emission.ts";
import type { SceneStore } from "./scene-store.ts";
import { addTexture, commitTextureCommand, prepareTexture, relinkTexture, removeTexture, replaceTexture, setTextureRole, textureReferences, type TextureAsset, type TextureRole } from "./texture-assets.ts";
import "./texture-assets.css";

export function createTextureAssetsPanel(store: SceneStore, options: {available:()=>boolean; onStatus?:(text:string)=>void}) {
  const element=document.createElement("section"); element.className="texture-assets-panel"; element.setAttribute("aria-label","Texture Assets");
  const tools=document.createElement("div"); tools.className="texture-actions";
  const heading=document.createElement("p"); heading.textContent="Reusable images · Color (sRGB) or Data (Raw)";
  const list=document.createElement("div"); list.className="texture-grid"; list.setAttribute("aria-label","Imported textures");
  const details=document.createElement("div"); details.className="texture-details";
  const preview=document.createElement("div"); preview.className="texture-preview"; preview.hidden=true;
  const status=document.createElement("p"); status.setAttribute("role","status"); status.setAttribute("aria-live","polite");
  const input=document.createElement("input"); input.type="file"; input.accept=".png,.jpg,.jpeg,.webp"; input.hidden=true; input.setAttribute("aria-label","Texture image file");
  let selected="", pending: {asset:TextureAsset;replace?:string;document:object}|undefined, mode: "import"|"replace"="import", working=false, generation=0;
  const makeButton=(text:string,action:()=>void)=>{const b=document.createElement("button"); b.type="button";b.textContent=text;b.onclick=action;return b;};
  const available=()=>options.available()&&!working;
  function report(text:string){status.textContent=text;options.onStatus?.(text);}
  function run(action:()=>void){if(!available())return;try{action();refresh();}catch(e){report(e instanceof Error?e.message:String(e));}}
  const importButton=makeButton("Import image…",()=>{if(available()){mode="import";input.click();}});
  const replaceButton=makeButton("Replace image…",()=>{if(available()&&selected){mode="replace";input.click();}});
  const removeButton=makeButton("Delete unused",()=>run(()=>{commitTextureCommand(store,"Delete texture",doc=>removeTexture(doc,selected));report("Unused texture deleted. Undo restores it.");}));
  tools.append(importButton,replaceButton,removeButton);
  const label=(text:string,control:HTMLElement)=>{const l=document.createElement("label");l.append(document.createTextNode(text),control);return l;};
  const role=document.createElement("select"); role.setAttribute("aria-label","Texture role");role.add(new Option("Color (sRGB)","color"));role.add(new Option("Data (Raw)","data"));
  role.onchange=()=>run(()=>{commitTextureCommand(store,"Set texture role",doc=>setTextureRole(doc,selected,role.value as TextureRole));report("Default image role updated. Existing material slots retain their color/data interpretation.");});
  const metadata=document.createElement("p");metadata.className="texture-metadata";
  const references=document.createElement("p");
  const target=document.createElement("select");target.setAttribute("aria-label","Relink destination texture");
  const relink=makeButton("Relink material references",()=>run(()=>{commitTextureCommand(store,"Relink texture",doc=>relinkTexture(doc,selected,target.value));report("References relinked. The unused source can now be deleted.");}));
  details.append(metadata,label("Default role",role),references,label("Relink references to",target),relink);
  const pendingImage=document.createElement("img");pendingImage.alt="Pending texture preview";
  const pendingText=document.createElement("p");
  const apply=makeButton("Apply image",()=>run(()=>{
    if(!pending)return;
    const draft=pending;
    if(store.getState().document!==draft.document){cancel();report("Scene changed while previewing. Choose the image again.");return;}
    commitTextureCommand(store,draft.replace?"Replace texture":"Import texture",doc=>draft.replace?replaceTexture(doc,draft.replace,draft.asset):addTexture(doc,draft.asset));
    selected=draft.asset.id; pending=undefined;preview.hidden=true;pendingImage.removeAttribute("src");report("Image applied. Undo restores the previous scene.");
  }));
  function cancel(){generation++;pending=undefined;preview.hidden=true;pendingImage.removeAttribute("src");refresh();}
  const cancelButton=makeButton("Cancel preview",()=>{cancel();report("Texture preview cancelled. Scene unchanged.");});
  preview.append(pendingImage,pendingText,apply,cancelButton);
  preview.addEventListener("keydown",event=>{if(event.key==="Escape"){event.stopPropagation();cancel();report("Texture preview cancelled. Scene unchanged.");}});
  element.append(heading,tools,list,details,preview,status,input);
  async function stage(file:File,replace?:string){
    if(!available())return;
    const ticket=++generation,document=store.getState().document; working=true;refresh();report("Reading texture image…");
    try {
      const asset=await prepareTexture(file);
      if(ticket!==generation)return;
      if(store.getState().document!==document)throw Error("Scene changed while reading. Choose the image again.");
      pending={asset,replace,document};pendingImage.src=asset.thumbnail;pendingText.textContent=`${replace?"Replace with":"Import"} ${asset.name} · ${asset.width} × ${asset.height} · ${asset.alpha?"Alpha":"Opaque"}`;
      preview.hidden=false;report("Preview ready. Apply image to commit, or Cancel preview.");
    }catch(e){report(e instanceof Error?e.message:String(e));}
    finally{working=false;refresh();}
  }
  input.onchange=()=>{const file=input.files?.[0];input.value="";if(file)void stage(file,mode==="replace"?selected:undefined);};
  let shown: object|undefined;
  function refresh(){
    const doc=store.getState().document,assets=Object.values(doc.textureAssets??{});
    if(pending&&pending.document!==doc){pending=undefined;preview.hidden=true;pendingImage.removeAttribute("src");}
    if(!doc.textureAssets?.[selected])selected=assets[0]?.id??"";
    if(shown!==doc){
      shown=doc;list.replaceChildren();
      if(!assets.length){const empty=document.createElement("p");empty.textContent="Import a PNG, JPEG, or WebP image. FBX material images appear here too.";list.append(empty);}
      for(const asset of assets){
        const b=makeButton(asset.name,()=>{selected=asset.id;refresh();});b.dataset.textureId=asset.id;b.title=`${asset.name} · ${asset.width} × ${asset.height}`;
        const image=document.createElement("img");image.alt="";image.loading="lazy";image.src=asset.thumbnail;
        const name=document.createElement("span");name.textContent=asset.name;b.replaceChildren(image,name);list.append(b);
      }
    }
    for(const row of Array.from(list.querySelectorAll<HTMLButtonElement>("button"))){row.setAttribute("aria-pressed",String(row.dataset.textureId===selected));row.disabled=!available()||!!pending;}
    const asset=doc.textureAssets?.[selected], refs=asset?textureReferences(doc,selected):[];
    const graphRefs=asset?graphTextureReferences(doc.proceduralGraph,selected):[];
    const particleRefs=asset?particleMapReferences(doc,selected):[];
    const referenced=refs.length+graphRefs.length+particleRefs.length>0;
    relink.textContent=graphRefs.length||particleRefs.length?"Relink references":"Relink material references";
    importButton.disabled=!available()||!!pending;replaceButton.disabled=!asset||!available()||!!pending;removeButton.disabled=!asset||!available()||!!pending||referenced;
    removeButton.title=referenced?"Referenced textures must be relinked before deletion":"Delete this unreferenced image";
    details.hidden=!asset;
    if(asset){metadata.textContent=`${asset.name}\n${asset.width} × ${asset.height} · ${asset.mime.replace("image/","").toUpperCase()} · ${(asset.byteLength/1024).toFixed(1)} KiB · ${asset.alpha?"Has alpha":"Opaque"}\n${asset.id}`;role.value=asset.role;}
    role.disabled=!available()||!!pending;
    references.textContent=`${refs.length} material reference${refs.length===1?"":"s"}${refs.length?": "+refs.map(r=>`${doc.nodes[r.shapeId].name} / ${r.slot}`).join(", "):""}${graphRefs.length?` · ${graphRefs.length} texture graph ${graphRefs.length===1?"node":"nodes"}`:""}`;
    if (particleRefs.length) references.textContent += ` · ${particleRefs.length} particle emission ${particleRefs.length === 1 ? "map" : "maps"}`;
    const previous=target.value;target.replaceChildren();for(const a of assets)if(a.id!==selected)target.add(new Option(a.name,a.id));if(Array.from(target.options).some(o=>o.value===previous))target.value=previous;
    target.disabled=!available()||!!pending||!target.options.length;relink.disabled=target.disabled||!referenced;
    apply.disabled=!available();cancelButton.disabled=working;
  }
  store.subscribe(refresh);refresh();
  return {element,refresh,stage:(file:File)=>stage(file),open:()=>{if(available()){mode="import";input.click();}}};
}
