import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSync } from 'esbuild'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { JSDOM } from 'jsdom'

const require=createRequire(import.meta.url)
const source=buildSync({entryPoints:['src/client/components/resizable-split.ts'],bundle:true,write:false,format:'cjs',platform:'node',external:['react']}).outputFiles[0].text
const module={exports:{}}
runInNewContext(source,{module,exports:module.exports,require})
const {attachResizableSplit}=module.exports
const storageKey='dsh-ai-recruiter:candidate-split-ratio:v1'

function fixture(saved,blocked=false){
 const dom=new JSDOM('<div id="root"><div id="handle"></div></div>',{url:'https://recruiter.example'})
 const {window}=dom,root=window.document.getElementById('root'),handle=window.document.getElementById('handle')
 if(saved!==undefined)window.localStorage.setItem(storageKey,saved)
 if(blocked)Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked')}})
 let width=1000,observer,disconnected=false,captured,frameId=0
 const frames=new Map()
 window.requestAnimationFrame=callback=>{frames.set(++frameId,callback);return frameId}
 window.cancelAnimationFrame=id=>frames.delete(id)
 window.ResizeObserver=class{constructor(callback){observer=callback}observe(){}disconnect(){disconnected=true}}
 Object.defineProperty(root,'clientWidth',{get:()=>width})
 Object.defineProperty(root,'clientLeft',{value:1})
 root.getBoundingClientRect=()=>({left:100})
 const left=()=>Number.parseFloat(root.style.getPropertyValue('--air-list-width'))
 handle.getBoundingClientRect=()=>({left:101+left()-4})
 handle.setPointerCapture=id=>{captured=id}
 handle.hasPointerCapture=id=>captured===id
 handle.releasePointerCapture=id=>{if(captured===id){captured=undefined;pointer('lostpointercapture',0,id)}}
 window.document.body.style.cursor='text';window.document.body.style.userSelect='text'
 const pointer=(type,x,id=1)=>{
  const event=new window.MouseEvent(type,{clientX:x,button:0,bubbles:true,cancelable:true})
  Object.defineProperty(event,'pointerId',{value:id});handle.dispatchEvent(event)
 }
 const flush=()=>{const pending=[...frames.values()];frames.clear();pending.forEach(callback=>callback())}
 const key=(key,shiftKey=false)=>handle.dispatchEvent(new window.KeyboardEvent('keydown',{key,shiftKey,bubbles:true,cancelable:true}))
 const dispose=attachResizableSplit(root,handle)
 return {window,root,handle,left,pointer,flush,key,dispose,captured:()=>captured,frames:()=>frames.size,
  saved:()=>window.localStorage.getItem(storageKey),resize:value=>{width=value;observer()},disconnected:()=>disconnected}
}

test('dragging is frame-batched and clamps both panes without changing the captured grab offset',()=>{
 const f=fixture(),initial=f.left()
 f.pointer('pointerdown',101+initial-3)
 assert.equal(f.captured(),1);assert.equal(f.left(),initial)
 f.pointer('pointermove',10000);f.pointer('pointermove',11000)
 assert.equal(f.frames(),1);assert.equal(f.left(),initial,'pointer moves must not synchronously render the resume')
 f.flush();assert.equal(f.left(),680,'the overlapping handle must not subtract layout width from either pane')
 f.pointer('pointermove',-100);f.flush();assert.equal(f.left(),380)
 f.pointer('pointermove',598);f.pointer('pointerup',598)
 assert.equal(f.left(),500,'release flushes the latest queued position')
 assert.equal(f.captured(),undefined);assert.equal(f.frames(),0)
 assert.equal(f.root.classList.contains('is-resizing'),false)
 assert.equal(f.window.document.body.style.cursor,'text');assert.equal(f.window.document.body.style.userSelect,'text')
 assert.equal(Number(f.saved()),0.5)
 assert.equal(f.handle.getAttribute('aria-valuenow'),'500')
 f.dispose();f.window.close()
})

test('resize clamps the rendered width but preserves the user ratio for growing and remounting',()=>{
 const f=fixture('0.6')
 assert.ok(Math.abs(f.left()-600)<0.001)
 f.resize(700);assert.equal(f.left(),380)
 f.resize(1000);assert.ok(Math.abs(f.left()-600)<0.001)
 assert.equal(f.saved(),'0.6')
 f.key('Home');assert.equal(f.left(),380)
 f.key('ArrowRight',true);assert.equal(f.left(),430)
 const saved=f.saved();f.dispose();f.window.close()
 const restored=fixture(saved);assert.ok(Math.abs(restored.left()-430)<0.001)
 restored.key('End');assert.equal(restored.left(),680)
 restored.dispose();restored.window.close()
})

test('cancellation, window blur and unmount restore global styles and release capture without persisting a partial drag',()=>{
 for(const action of ['pointercancel','blur','dispose']){
  const f=fixture('0.6'),initial=f.left()
  f.pointer('pointerdown',101+initial+4);f.pointer('pointermove',600);f.flush()
  if(action==='blur')f.window.dispatchEvent(new f.window.Event('blur'))
  else if(action==='dispose')f.dispose()
  else f.pointer(action,600)
  assert.equal(f.captured(),undefined);assert.equal(f.saved(),'0.6')
  assert.equal(f.window.document.body.style.cursor,'text');assert.equal(f.window.document.body.style.userSelect,'text')
  assert.equal(f.frames(),0)
  if(action==='dispose'){
   assert.equal(f.disconnected(),true)
   assert.equal(f.root.style.getPropertyValue('--air-list-width'),'')
   f.pointer('pointerdown',600);assert.equal(f.captured(),undefined)
  }else{assert.ok(Math.abs(f.left()-initial)<0.001);f.dispose()}
  f.window.close()
 }
})

test('invalid or unavailable saved preferences do not prevent dragging, keyboard control or cleanup',()=>{
 for(const f of [fixture('not-a-ratio'),fixture(undefined,true)]){
  assert.ok(f.left()>=380&&f.left()<=680)
  f.key('Home');assert.equal(f.left(),380)
  f.key('ArrowLeft');assert.equal(f.left(),380)
  f.dispose();f.window.close()
 }
})
