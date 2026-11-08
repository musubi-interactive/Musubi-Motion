// Shared inspector behavior. Locks are per object/field for this editor session.
const locks=new Set<string>();
let menu:HTMLElement|undefined;
export function propertyInteraction(input:any,key:()=>string,handle?:HTMLElement,beginPreview?:()=>{update:(value:number)=>void;end:()=>void}|undefined,lockState?:{get:()=>boolean;toggle:()=>void}) {
  const isLocked=()=>lockState?lockState.get():locks.has(key());
  const refresh=()=>{input.readOnly=isLocked();input.readonly=input.readOnly;input.toggleAttribute("data-locked",input.readOnly);};
  input.addEventListener("contextmenu",(event:MouseEvent)=>{
    event.preventDefault();menu?.remove();refresh();
    const popup=document.createElement("div");popup.className="property-context";popup.setAttribute("role","menu");
    const button=document.createElement("button");button.textContent=input.readOnly?"Unlock":"Lock";button.setAttribute("role","menuitem");
    button.onclick=()=>{const id=key();if(lockState)lockState.toggle();else if(locks.has(id))locks.delete(id);else locks.add(id);refresh();popup.remove();};
    popup.append(button);document.body.append(popup);popup.style.left=`${Math.min(event.clientX,innerWidth-110)}px`;popup.style.top=`${Math.min(event.clientY,innerHeight-45)}px`;menu=popup;button.focus();
    const close=(e:Event)=>{if(!popup.contains(e.target as Node)){popup.remove();document.removeEventListener("pointerdown",close,true);}};
    document.addEventListener("pointerdown",close,true);popup.onkeydown=e=>{if(e.key==="Escape"){popup.remove();input.focus();}};
  });
  // Numeric attributes scrub by default, on the field and any supplied label.
  // Text attributes (such as Name) retain their normal editing behavior.
  if(input.type==="number") for(const surface of new Set<HTMLElement>([input,...(handle?[handle]:[])])) {
    if(!surface.title)surface.title="Middle-drag left/right to adjust";
    surface.addEventListener("pointerdown",e=>{
      if(e.button!==1||isLocked()||input.disabled)return;
      e.preventDefault();e.stopPropagation();
      const start=e.clientX,value=Number(input.value),id=key();
      if(!Number.isFinite(value))return;
      const step=Number(input.step)>0?Number(input.step):.1;
      const bound=(raw:unknown,fallback:number)=>raw==null||raw===""?fallback:Number(raw);
      const min=bound(input.min,-Infinity),max=bound(input.max,Infinity);
      surface.setPointerCapture(e.pointerId);
      const preview=beginPreview?.();
      let finished=false;
      const move=(m:PointerEvent)=>{
        if(key()!==id||isLocked())return;
        const ticks=Math.round((m.clientX-start)/10);
        input.value=String(Math.min(max,Math.max(min,Number((value+ticks*step).toFixed(6)))));
        preview?.update(Number(input.value));
      };
      const finish=(cancel:boolean)=>{
        if(finished)return;finished=true;
        surface.removeEventListener("pointermove",move);surface.removeEventListener("pointerup",end);surface.removeEventListener("pointercancel",cancelled);surface.removeEventListener("lostpointercapture",cancelled);document.removeEventListener("keydown",escape,{capture:true});
        if(surface.hasPointerCapture(e.pointerId))surface.releasePointerCapture(e.pointerId);
        const finalValue=input.value;
        preview?.end();
        if(key()!==id)return;
        input.value=finalValue;
        if(cancel||isLocked())input.value=String(value);
        else if(Number(input.value)!==value)input.dispatchEvent(new Event("change",{bubbles:true}));
      };
      const end=()=>finish(false),cancelled=()=>finish(true);
      const escape=(event:KeyboardEvent)=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();finish(true);}};
      surface.addEventListener("pointermove",move);surface.addEventListener("pointerup",end);surface.addEventListener("pointercancel",cancelled);surface.addEventListener("lostpointercapture",cancelled);document.addEventListener("keydown",escape,{capture:true});
    });
    surface.addEventListener("auxclick",e=>{if(e.button===1)e.preventDefault();});
  }
  return refresh;
}
