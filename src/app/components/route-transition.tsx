'use client';
import {useEffect,useRef,useState} from 'react';
import {usePathname} from '@/lib/navigation';

export function RouteTransition(){
 const pathname=usePathname();
 const [transition,setTransition]=useState<{path:string;label:string;phase:'cover'|'reveal'}|null>(null);
 const began=useRef(0);
 useEffect(()=>{
  const begin=(event:Event)=>{
   const path=(event as CustomEvent<string>).detail;
   began.current=performance.now();
   setTransition({path,label:path==='/'?'The experience':path.slice(1),phase:'cover'});
  };
  window.addEventListener('arclite:navigate',begin);
  return()=>window.removeEventListener('arclite:navigate',begin);
 },[]);
 useEffect(()=>{
  window.scrollTo({top:0,left:0,behavior:'instant' as ScrollBehavior});
  if(document.scrollingElement)document.scrollingElement.scrollTop=0;
  document.body.scrollTop=0;
 },[pathname]);
 useEffect(()=>{
  if(!transition)return;
  if(transition.phase==='reveal'){
   const timer=setTimeout(()=>setTransition(null),700);return()=>clearTimeout(timer);
  }
  if(transition.path!==pathname)return;
  const timer=setTimeout(()=>setTransition(t=>t?{...t,phase:'reveal'}:null),Math.max(0,1300-(performance.now()-began.current)));
  return()=>clearTimeout(timer);
 },[pathname,transition]);
 return transition?<div className={'route-curtain '+transition.phase} aria-hidden="true"><img loading="eager" decoding="sync" src="/assets/sun.svg" alt=""/><span>{transition.label}</span></div>:null;
}
