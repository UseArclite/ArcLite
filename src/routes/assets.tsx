import {createFileRoute} from '@tanstack/react-router';
import Page from '../app/assets/page';
export const Route=createFileRoute('/assets')({head:()=>({meta:[{title:"Real-World Assets \u2014 ArcLite"}]}),component:Page});
