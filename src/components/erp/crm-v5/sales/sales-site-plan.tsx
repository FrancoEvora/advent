"use client";

import {useMemo,useRef,useState} from "react";
import type {KeyboardEvent,PointerEvent,WheelEvent} from "react";
import type {InventoryUnit} from "./types";
import {brl,statusLabel} from "./utils";

type Point={x:number;y:number};
type RectGeometry={kind:"rect";x:number;y:number;width:number;height:number;cx:number;cy:number};
type PolygonGeometry={kind:"polygon";points:Point[];cx:number;cy:number};
type Geometry=RectGeometry|PolygonGeometry;
type PositionedLot={unit:InventoryUnit;geometry:Geometry};
type BlockFrame={code:string;x:number;y:number;width:number;height:number;units:number};
type ViewState={scale:number;x:number;y:number};

interface SalesSitePlanProps{
 units:InventoryUnit[];
 selectedId:string|null;
 visibleIds?:ReadonlySet<string>;
 backgroundUrl?:string|null;
 onSelect:(unit:InventoryUnit)=>void;
}

const MIN_ZOOM=.65;
const MAX_ZOOM=3.4;

function finite(value:unknown):number|null{const number=Number(value);return Number.isFinite(number)?number:null;}
function clamp(value:number,min:number,max:number){return Math.min(max,Math.max(min,value));}

function point(value:unknown):Point|null{
 if(Array.isArray(value)&&value.length>=2){const x=finite(value[0]),y=finite(value[1]);return x===null||y===null?null:{x,y};}
 if(value&&typeof value==="object"){
  const candidate=value as Record<string,unknown>,x=finite(candidate.x),y=finite(candidate.y);
  return x===null||y===null?null:{x,y};
 }
 return null;
}

function configuredGeometry(unit:InventoryUnit):Geometry|null{
 const points=Array.isArray(unit.polygon)?unit.polygon.map(point).filter((item):item is Point=>Boolean(item)):[];
 if(points.length>=3){
  const cx=points.reduce((sum,item)=>sum+item.x,0)/points.length;
  const cy=points.reduce((sum,item)=>sum+item.y,0)/points.length;
  return{kind:"polygon",points,cx,cy};
 }
 const x=finite(unit.map_x),y=finite(unit.map_y),width=finite(unit.map_width),height=finite(unit.map_height);
 if(x!==null&&y!==null&&width!==null&&height!==null&&width>0&&height>0)return{kind:"rect",x,y,width,height,cx:x+width/2,cy:y+height/2};
 return null;
}

function geometryBounds(geometry:Geometry){
 if(geometry.kind==="rect")return{x1:geometry.x,y1:geometry.y,x2:geometry.x+geometry.width,y2:geometry.y+geometry.height};
 return{x1:Math.min(...geometry.points.map(item=>item.x)),y1:Math.min(...geometry.points.map(item=>item.y)),x2:Math.max(...geometry.points.map(item=>item.x)),y2:Math.max(...geometry.points.map(item=>item.y))};
}

function configuredLayout(units:InventoryUnit[],geometries:Geometry[]){
 const bounds=geometries.map(geometryBounds),x1=Math.min(...bounds.map(item=>item.x1)),y1=Math.min(...bounds.map(item=>item.y1)),x2=Math.max(...bounds.map(item=>item.x2)),y2=Math.max(...bounds.map(item=>item.y2));
 const width=Math.max(100,x2-x1),height=Math.max(100,y2-y1),padding=Math.max(width,height)*.07;
 return{mode:"configured" as const,viewBox:{x:x1-padding,y:y1-padding,width:width+padding*2,height:height+padding*2},lots:units.map((unit,index)=>({unit,geometry:geometries[index]})),blocks:[] as BlockFrame[]};
}

function schematicLayout(units:InventoryUnit[]){
 const groups=[...new Set(units.map(unit=>unit.block_code||"Sem quadra"))].sort((a,b)=>a.localeCompare(b,"pt-BR",{numeric:true})).map(code=>({code,units:units.filter(unit=>(unit.block_code||"Sem quadra")===code).sort((a,b)=>String(a.lot_number).localeCompare(String(b.lot_number),"pt-BR",{numeric:true}))}));
 const canvasWidth=1280,columnWidth=550,gap=60,left=60,top=72,columnHeights=[top,top],lots:PositionedLot[]=[],blocks:BlockFrame[]=[];
 for(const group of groups){
  const column=columnHeights[0]<=columnHeights[1]?0:1,columns=Math.min(12,Math.max(2,Math.ceil(Math.sqrt(group.units.length*1.7)))),rows=Math.max(1,Math.ceil(group.units.length/columns));
  const x=left+column*(columnWidth+gap),y=columnHeights[column],lotGap=5,innerWidth=columnWidth-38,lotWidth=(innerWidth-(columns-1)*lotGap)/columns,lotHeight=58,headerHeight=54,height=headerHeight+rows*(lotHeight+lotGap)+18;
  blocks.push({code:group.code,x,y,width:columnWidth,height,units:group.units.length});
  group.units.forEach((unit,index)=>{
   const row=Math.floor(index/columns),col=index%columns,unitX=x+19+col*(lotWidth+lotGap),unitY=y+headerHeight+row*(lotHeight+lotGap);
   lots.push({unit,geometry:{kind:"rect",x:unitX,y:unitY,width:lotWidth,height:lotHeight,cx:unitX+lotWidth/2,cy:unitY+lotHeight/2}});
  });
  columnHeights[column]=y+height+66;
 }
 const canvasHeight=Math.max(520,...columnHeights)+10;
 return{mode:"schematic" as const,viewBox:{x:0,y:0,width:canvasWidth,height:canvasHeight},lots,blocks};
}

function buildLayout(units:InventoryUnit[]){
 const geometries=units.map(configuredGeometry);
 return units.length>0&&geometries.every((geometry):geometry is Geometry=>Boolean(geometry))?configuredLayout(units,geometries):schematicLayout(units);
}

function geometryElement(geometry:Geometry){
 if(geometry.kind==="polygon")return <polygon className="sales-plan-unit-shape" points={geometry.points.map(item=>`${item.x},${item.y}`).join(" ")}/>;
 return <rect className="sales-plan-unit-shape" x={geometry.x} y={geometry.y} width={geometry.width} height={geometry.height} rx={Math.min(5,geometry.width*.08)}/>;
}

export function SalesSitePlan({units,selectedId,visibleIds,backgroundUrl,onSelect}:SalesSitePlanProps){
 const layout=useMemo(()=>buildLayout(units),[units]);
 const[view,setView]=useState<ViewState>({scale:1,x:0,y:0});
 const[dragging,setDragging]=useState(false);
 const svg=useRef<SVGSVGElement>(null),lastPointer=useRef<Point|null>(null);
 const zoomLabel=Math.round(view.scale*100);

 function reset(){setView({scale:1,x:0,y:0});}
 function setZoom(next:number){setView(current=>({...current,scale:clamp(next,MIN_ZOOM,MAX_ZOOM)}));}
 function wheel(event:WheelEvent<SVGSVGElement>){
  event.preventDefault();
  const rect=svg.current?.getBoundingClientRect();if(!rect)return;
  const factor=event.deltaY<0?1.13:.88,next=clamp(view.scale*factor,MIN_ZOOM,MAX_ZOOM);
  const cursorX=layout.viewBox.x+(event.clientX-rect.left)*layout.viewBox.width/rect.width,cursorY=layout.viewBox.y+(event.clientY-rect.top)*layout.viewBox.height/rect.height;
  const contentX=(cursorX-view.x)/view.scale,contentY=(cursorY-view.y)/view.scale;
  setView({scale:next,x:cursorX-contentX*next,y:cursorY-contentY*next});
 }
 function pointerDown(event:PointerEvent<SVGSVGElement>){event.currentTarget.setPointerCapture(event.pointerId);lastPointer.current={x:event.clientX,y:event.clientY};setDragging(true);}
 function pointerMove(event:PointerEvent<SVGSVGElement>){
  if(!dragging||!lastPointer.current)return;const rect=svg.current?.getBoundingClientRect();if(!rect)return;
  const dx=(event.clientX-lastPointer.current.x)*layout.viewBox.width/rect.width,dy=(event.clientY-lastPointer.current.y)*layout.viewBox.height/rect.height;
  lastPointer.current={x:event.clientX,y:event.clientY};setView(current=>({...current,x:current.x+dx,y:current.y+dy}));
 }
 function pointerEnd(event:PointerEvent<SVGSVGElement>){if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);lastPointer.current=null;setDragging(false);}
 function keySelect(event:KeyboardEvent<SVGGElement>,unit:InventoryUnit){if(event.key==="Enter"||event.key===" "){event.preventDefault();onSelect(unit);}}

 return <section className="sales-site-plan" aria-label="Mapa interativo de vendas">
  <header className="sales-site-plan-head">
   <div><small>{layout.mode==="configured"?"PLANTA COMERCIAL INTERATIVA":"MAPA ESQUEMÁTICO INTERATIVO"}</small><strong>{units.length} unidade{units.length===1?"":"s"}</strong></div>
   <div className="sales-plan-zoom" aria-label="Controles do mapa">
    <button type="button" onClick={()=>setZoom(view.scale/1.2)} aria-label="Reduzir zoom">−</button>
    <span>{zoomLabel}%</span>
    <button type="button" onClick={()=>setZoom(view.scale*1.2)} aria-label="Aumentar zoom">+</button>
    <button type="button" onClick={reset}>Centralizar</button>
   </div>
  </header>
  {layout.mode==="schematic"&&<p className="sales-plan-mode-note"><b>Visão esquemática.</b> Os lotes estão organizados por quadra até a planta urbanística ser posicionada.</p>}
  <div className="sales-plan-stage">
   <svg ref={svg} className={dragging?"sales-plan-svg dragging":"sales-plan-svg"} viewBox={`${layout.viewBox.x} ${layout.viewBox.y} ${layout.viewBox.width} ${layout.viewBox.height}`} role="img" aria-label="Planta com unidades comerciais" onWheel={wheel} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerEnd}>
    <defs><pattern id="sales-map-grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M 32 0 L 0 0 0 32" fill="none" stroke="currentColor" strokeWidth="1"/></pattern><filter id="sales-map-selected" x="-35%" y="-35%" width="170%" height="170%"><feDropShadow dx="0" dy="3" stdDeviation="5" floodOpacity=".42"/></filter></defs>
    <rect className="sales-plan-ground" x={layout.viewBox.x} y={layout.viewBox.y} width={layout.viewBox.width} height={layout.viewBox.height}/>
    <rect className="sales-plan-grid" x={layout.viewBox.x} y={layout.viewBox.y} width={layout.viewBox.width} height={layout.viewBox.height} fill="url(#sales-map-grid)"/>
    <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
     {backgroundUrl&&<image href={backgroundUrl} x={layout.viewBox.x} y={layout.viewBox.y} width={layout.viewBox.width} height={layout.viewBox.height} preserveAspectRatio="xMidYMid meet"/>}
     {layout.blocks.map(block=><g className="sales-plan-block" key={block.code}><rect x={block.x} y={block.y} width={block.width} height={block.height} rx="18"/><text x={block.x+20} y={block.y+31}>QUADRA {block.code}</text><text className="sales-plan-block-count" x={block.x+block.width-20} y={block.y+31} textAnchor="end">{block.units} lotes</text></g>)}
     {layout.lots.map(({unit,geometry})=>{const visible=!visibleIds||visibleIds.has(unit.id),selected=selectedId===unit.id;return <g key={unit.id} role="button" tabIndex={visible?0:-1} aria-label={`${unit.unit_code}, ${statusLabel[unit.status]}, ${unit.area} metros quadrados, ${brl.format(Number(unit.list_price))}`} className={`sales-plan-unit${selected?" selected":""}${visible?"":" filtered"}`} data-status={unit.status} onPointerDown={event=>event.stopPropagation()} onClick={()=>visible&&onSelect(unit)} onKeyDown={event=>visible&&keySelect(event,unit)}>
      <title>{unit.unit_code} · {statusLabel[unit.status]} · {unit.area} m² · {brl.format(Number(unit.list_price))}</title>
      {geometryElement(geometry)}
      <text className="sales-plan-lot-number" x={geometry.cx} y={geometry.cy-2} textAnchor="middle" dominantBaseline="middle">{unit.lot_number}</text>
      <text className="sales-plan-lot-area" x={geometry.cx} y={geometry.cy+13} textAnchor="middle" dominantBaseline="middle">{unit.area} m²</text>
     </g>})}
    </g>
   </svg>
   <span className="sales-plan-drag-hint">Arraste para mover · use a rolagem para ampliar</span>
  </div>
 </section>;
}
