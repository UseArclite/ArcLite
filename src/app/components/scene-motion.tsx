'use client';
import {useEffect} from 'react';
import {usePathname} from '@/lib/navigation';
export function SceneMotion(){
 const pathname=usePathname();
 useEffect(()=>{
  let disposed=false;let cleanup=()=>{};
  Promise.all([import('gsap'),import('gsap/ScrollTrigger')]).then(([{gsap},{ScrollTrigger}])=>{
   if(disposed)return;gsap.registerPlugin(ScrollTrigger);
   const mm=gsap.matchMedia();const listeners:Array<()=>void>=[];
   mm.add('(prefers-reduced-motion: no-preference)',()=>{
    const main=document.querySelector('main[data-route="'+pathname+'"]');if(!main)return;
    const hero=main.querySelector('.hero');
    if(hero){
     gsap.to(hero.querySelector('.hero-sky'),{scale:1.18,yPercent:8,ease:'none',scrollTrigger:{trigger:hero,start:'top top',end:'bottom top',scrub:1}});
     gsap.to(hero.querySelector('.hero-title'),{yPercent:-30,opacity:.15,ease:'none',scrollTrigger:{trigger:hero,start:'15% top',end:'bottom top',scrub:1}});
     const layer=hero.querySelector<HTMLElement>('.hero-art-layer');
     if(layer&&matchMedia('(pointer:fine)').matches){
      const x=gsap.quickTo(layer,'x',{duration:1,ease:'power3.out'});const y=gsap.quickTo(layer,'y',{duration:1,ease:'power3.out'});
      const move=(e:Event)=>{const p=e as PointerEvent;const box=hero.getBoundingClientRect();x((p.clientX-box.left-box.width/2)*.035);y((p.clientY-box.top-box.height/2)*.025)};
      const leave=()=>{x(0);y(0)};hero.addEventListener('pointermove',move);hero.addEventListener('pointerleave',leave);listeners.push(()=>{hero.removeEventListener('pointermove',move);hero.removeEventListener('pointerleave',leave)});
     }
    }
    const spread=main.querySelector('.comic-spread');if(spread){
     gsap.fromTo(spread.querySelector('.comic-hero'),{yPercent:10},{yPercent:-7,ease:'none',scrollTrigger:{trigger:spread,start:'top bottom',end:'bottom top',scrub:1.1}});
    }
    ScrollTrigger.refresh();
    return()=>{listeners.splice(0).forEach(fn=>fn())};
   });
   cleanup=()=>{listeners.splice(0).forEach(fn=>fn());mm.revert()};
  }).catch(()=>{});
  return()=>{disposed=true;cleanup()};
 },[pathname]);
 return null;
}
