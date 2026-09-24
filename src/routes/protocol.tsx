import {createFileRoute} from '@tanstack/react-router';
import Page from '../app/protocol/page';
export const Route=createFileRoute('/protocol')({head:()=>({meta:[{title:"The Protocol \u2014 ArcLite"}]}),component:Page});
