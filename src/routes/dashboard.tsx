import {createFileRoute} from '@tanstack/react-router';
import Page from '../app/dashboard/page';
export const Route=createFileRoute('/dashboard')({head:()=>({meta:[{title:"Dashboard \u2014 ArcLite"}]}),component:Page});
