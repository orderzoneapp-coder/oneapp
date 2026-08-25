import assert from 'node:assert/strict';
import { attachSituationUi } from '../orderq/situation-ui.js';

class Button {
  constructor(){this.dataset={};this.listeners={};this.disabled=false;this.title='';}
  addEventListener(type,listener){this.listeners[type]=listener;}
  async click(){if(this.disabled)return false;await this.listeners.click();return true;}
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const summary={textContent:''},alerts={innerHTML:''},rows={innerHTML:''},button=new Button(),messages=[];
let ready=false,runs=0,renders=0;
attachSituationUi({button,summary,alerts,rows,message:(...args)=>messages.push(args),capabilityProvider:async()=>ready,
  runtimeProvider:async()=>({frozen:true}),runProvider:async runtime=>{assert.equal(runtime.frozen,true);runs+=1;return{businessDate:'2026-08-25',productWarehouseRows:[],orderRows:[],issueRows:[]};},onRendered:()=>{renders+=1;}});
await tick();assert.equal(button.disabled,true);assert.equal(await button.click(),false);assert.equal(runs,0);
ready=true;button.disabled=!(await (async()=>ready)());assert.equal(await button.click(),true);assert.equal(runs,1);assert.equal(renders,1);assert.match(summary.textContent,/현재상황/);assert.equal(messages.at(-1)[0],'현재상황을 불러왔습니다.');assert.equal(button.disabled,false);
ready=false;await button.click();assert.equal(button.disabled,true);
console.log('PASS stage5 deployed capability gate click E2E');
