import {createFileRoute} from '@tanstack/react-router';
import Page from '../app/proofs/page';
export const Route=createFileRoute('/proofs')({head:()=>({meta:[{title:"Public Proofs \u2014 ArcLite"}]}),component:Page});
